// Cross-provider sync: Withings body-composition measurements → Intervals.icu
// wellness records. Direct port of the polling logic in
// ~/Projects/intervals-sync/sync_withings.py (Python cron job that hits the
// fitness-mcp worker every 15 minutes), reworked for in-worker invocation so
// the Withings `appli=1` webhook can write to Intervals in real time.
//
// V1 entry points:
//   - Webhook handler   (src/auth-handler.ts handleWithingsNotify, appli=1)
//   - Admin debug route (POST /admin/users/<id>/withings/sync)
//
// Both call syncWithingsMeasurementsToIntervals(env, userId, start, end).
// The webhook path is gated by a per-user toggle in a follow-up PR; this
// file only contains the unconditional sync pipeline.

import type { Env } from "./index.js";
import { getCred, setCred } from "./storage.js";
import { INTERVALS_OAUTH } from "./intervals.js";
import { WITHINGS_OAUTH } from "./withings.js";
import { makeAccessTokenGetter } from "./oauth.js";

const WITHINGS_API = "https://wbsapi.withings.net";
const INTERVALS_BASE = "https://intervals.icu/api/v1";

// Withings measure type ids — see withings_get_measurements tool docs and the
// upstream API reference. The five types below are the body-composition set
// that Body+ / Body Cardio / Body Scan emit on a single weigh-in.
const TYPE_WEIGHT = 1;
const TYPE_FAT_RATIO = 6;
const TYPE_MUSCLE_KG = 76;
const TYPE_HYDRATION_KG = 77;
const TYPE_BONE_KG = 88;

const WANTED_TYPES = [
  TYPE_WEIGHT,
  TYPE_FAT_RATIO,
  TYPE_MUSCLE_KG,
  TYPE_HYDRATION_KG,
  TYPE_BONE_KG,
] as const;

const KG_TO_LB = 2.2046226218;

// Final fallback if Withings's response carries no timezone AND
// WITHINGS_DEFAULT_TZ isn't set. Matches the intervals-sync default.
const TZ_HARD_FALLBACK = "America/New_York";

export interface SyncResult {
  daysSynced: number;
  daysSkipped: number;
  daysFailed: number;
  perDay: Array<{
    date: string;
    status: "synced" | "skipped" | "failed";
    fields?: string[];
    reason?: string;
  }>;
  tzUsed: string;
}

// === Helpers =================================================================

interface WithingsResponse<T = unknown> {
  status: number;
  body?: T;
  error?: string;
}

interface WithingsMeasure {
  type: number;
  value: number;
  unit: number; // multiplier exponent: actual = value * 10^unit
}

interface WithingsMeasureGroup {
  grpid: number;
  date: number; // unix seconds (UTC)
  category?: number;
  measures: WithingsMeasure[];
}

interface WithingsGetMeasResponseBody {
  updatetime?: number;
  timezone?: string;
  measuregrps?: WithingsMeasureGroup[];
}

function decodeMeasure(m: WithingsMeasure): number {
  return m.value * Math.pow(10, m.unit);
}

function readingFromGroup(group: WithingsMeasureGroup): Record<number, number> {
  const out: Record<number, number> = {};
  for (const m of group.measures || []) {
    if ((WANTED_TYPES as readonly number[]).includes(m.type)) {
      out[m.type] = decodeMeasure(m);
    }
  }
  return out;
}

function toWellnessBody(
  reading: Record<number, number>,
): Record<string, number> | null {
  const weight_kg = reading[TYPE_WEIGHT];
  if (weight_kg == null || weight_kg <= 0) return null;
  const body: Record<string, number> = {
    weight: round(weight_kg, 3),
  };
  if (reading[TYPE_FAT_RATIO] != null) {
    body.bodyFat = round(reading[TYPE_FAT_RATIO], 2);
  }
  if (reading[TYPE_HYDRATION_KG] != null) {
    // Intervals stores `BodyWater` as a % of body weight; Withings emits kg.
    body.BodyWater = round((reading[TYPE_HYDRATION_KG] / weight_kg) * 100, 2);
  }
  if (reading[TYPE_MUSCLE_KG] != null) {
    body.MuscleMassLB = round(reading[TYPE_MUSCLE_KG] * KG_TO_LB, 2);
  }
  if (reading[TYPE_BONE_KG] != null) {
    body.BoneMassLB = round(reading[TYPE_BONE_KG] * KG_TO_LB, 2);
  }
  return body;
}

function round(n: number, digits: number): number {
  const m = Math.pow(10, digits);
  return Math.round(n * m) / m;
}

// Bucket a UTC unix timestamp into a YYYY-MM-DD in the given IANA TZ.
function dateKeyInTz(unixSeconds: number, tz: string): string {
  // en-CA's default short format is YYYY-MM-DD, which avoids manual padding.
  // If the TZ is unknown to the Workers runtime, fall back to UTC bucketing
  // rather than throwing — keeps a partial sync working.
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(unixSeconds * 1000));
  } catch {
    return new Date(unixSeconds * 1000).toISOString().slice(0, 10);
  }
}

// === Withings ================================================================

async function fetchWithingsMeasurements(
  accessToken: string,
  startUnix: number,
  endUnix: number,
): Promise<WithingsGetMeasResponseBody> {
  const qs = new URLSearchParams({
    action: "getmeas",
    meastypes: WANTED_TYPES.join(","),
    startdate: String(startUnix),
    enddate: String(endUnix),
    category: "1", // 1=real (device), 2=user-objective. We only care about real.
  });
  const res = await fetch(`${WITHINGS_API}/measure?${qs}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const json = (await res.json()) as WithingsResponse<WithingsGetMeasResponseBody>;
  if (json.status !== 0) {
    throw new Error(
      `Withings /measure → status=${json.status} ${json.error ?? JSON.stringify(json.body ?? null)}`,
    );
  }
  return json.body ?? {};
}

// === Intervals.icu ===========================================================

async function putIntervalsWellness(
  accessToken: string,
  date: string,
  body: Record<string, number>,
): Promise<void> {
  // athlete id "0" means "the athlete the bearer token belongs to" — matches
  // the convention used elsewhere in src/intervals.ts.
  const res = await fetch(
    `${INTERVALS_BASE}/athlete/0/wellness/${encodeURIComponent(date)}`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ id: date, ...body }),
    },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Intervals PUT /wellness/${date} → ${res.status}: ${text}`);
  }
}

// === Token getters ===========================================================
//
// makeAccessTokenGetter handles refresh-on-expiry, but it needs load/save
// closures into our KV layout plus a per-call lock object. Both providers'
// cred rows share the OAuth-shaped {tokens: {accessToken, refreshToken,
// expiresAt}} payload, so the load/save closures are identical except for
// the provider key.

function withingsAccessTokenGetter(env: Env, userId: string): () => Promise<string> {
  return makeAccessTokenGetter(
    WITHINGS_OAUTH,
    env.WITHINGS_CLIENT_ID,
    env.WITHINGS_CLIENT_SECRET,
    async () => {
      const cred = await getCred(env.OAUTH_KV, userId, "withings");
      return cred ? cred.tokens : null;
    },
    async (tokens) => {
      const cred = await getCred(env.OAUTH_KV, userId, "withings");
      if (!cred) return;
      await setCred(env.OAUTH_KV, userId, "withings", { ...cred, tokens });
    },
    { pending: null },
  );
}

function intervalsAccessTokenGetter(env: Env, userId: string): () => Promise<string> {
  return makeAccessTokenGetter(
    INTERVALS_OAUTH,
    env.INTERVALS_CLIENT_ID,
    env.INTERVALS_CLIENT_SECRET,
    async () => {
      const cred = await getCred(env.OAUTH_KV, userId, "intervals");
      return cred?.tokens ?? null;
    },
    async (tokens) => {
      const cred = await getCred(env.OAUTH_KV, userId, "intervals");
      if (!cred) return;
      await setCred(env.OAUTH_KV, userId, "intervals", { ...cred, tokens });
    },
    { pending: null },
  );
}

// === Main entry point ========================================================

export async function syncWithingsMeasurementsToIntervals(
  env: Env,
  userId: string,
  startUnix: number,
  endUnix: number,
): Promise<SyncResult> {
  if (!Number.isFinite(startUnix) || !Number.isFinite(endUnix) || endUnix <= startUnix) {
    throw new Error(`Invalid sync window: [${startUnix}, ${endUnix}]`);
  }

  const getWithingsToken = withingsAccessTokenGetter(env, userId);
  const getIntervalsToken = intervalsAccessTokenGetter(env, userId);

  const withingsToken = await getWithingsToken();
  const measureBody = await fetchWithingsMeasurements(withingsToken, startUnix, endUnix);

  const tz =
    measureBody.timezone?.trim() ||
    env.WITHINGS_DEFAULT_TZ?.trim() ||
    TZ_HARD_FALLBACK;

  const groups = measureBody.measuregrps ?? [];
  if (groups.length === 0) {
    return { daysSynced: 0, daysSkipped: 0, daysFailed: 0, perDay: [], tzUsed: tz };
  }

  // Bucket by local date; later (higher `date`) reading wins. Sort ascending
  // first so iteration order is "oldest first" — last write wins per day.
  const byDate = new Map<string, WithingsMeasureGroup>();
  for (const g of groups.slice().sort((a, b) => a.date - b.date)) {
    byDate.set(dateKeyInTz(g.date, tz), g);
  }

  const perDay: SyncResult["perDay"] = [];
  let daysSynced = 0;
  let daysSkipped = 0;
  let daysFailed = 0;

  // Resolve the Intervals token once per call (refresh-on-expiry inside the
  // getter handles staleness across the day loop below).
  const intervalsToken = await getIntervalsToken();

  for (const [date, group] of Array.from(byDate.entries()).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )) {
    const reading = readingFromGroup(group);
    const body = toWellnessBody(reading);
    if (!body) {
      daysSkipped++;
      perDay.push({ date, status: "skipped", reason: "no weight reading in group" });
      continue;
    }
    try {
      await putIntervalsWellness(intervalsToken, date, body);
      daysSynced++;
      perDay.push({ date, status: "synced", fields: Object.keys(body) });
    } catch (e) {
      daysFailed++;
      perDay.push({
        date,
        status: "failed",
        reason: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return { daysSynced, daysSkipped, daysFailed, perDay, tzUsed: tz };
}
