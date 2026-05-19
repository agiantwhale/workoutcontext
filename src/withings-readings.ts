// Shared Withings body-composition data pipeline used by every
// "Withings → <dest>" sync helper. Owns the API call, response decoding,
// timezone resolution, and date-bucketing logic — so each destination
// helper only owns its own format-and-write code.
//
// The five measure types here (1/6/76/77/88) are the body-composition
// set emitted on a single weigh-in by Body+ / Body Cardio / Body Scan.
// Keep this aligned with WANTED_TYPES in the upstream withings_get_measurements
// tool descriptor — divergence would mean a Withings webhook arrives, the
// helper fetches a narrower slice, and the destination silently misses fields.

import type { Env } from "./index.js";
import { getCred, setCred } from "./storage.js";
import { WITHINGS_OAUTH } from "./withings.js";
import { makeAccessTokenGetter } from "./oauth.js";

const WITHINGS_API = "https://wbsapi.withings.net";

export const TYPE_WEIGHT = 1;
export const TYPE_FAT_RATIO = 6;
export const TYPE_MUSCLE_KG = 76;
export const TYPE_HYDRATION_KG = 77;
export const TYPE_BONE_KG = 88;

export const WANTED_TYPES = [
  TYPE_WEIGHT,
  TYPE_FAT_RATIO,
  TYPE_MUSCLE_KG,
  TYPE_HYDRATION_KG,
  TYPE_BONE_KG,
] as const;

// Final fallback if Withings's response carries no timezone AND
// WITHINGS_DEFAULT_TZ isn't set. Matches the intervals-sync default.
const TZ_HARD_FALLBACK = "America/New_York";

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

// A decoded reading keyed by Withings measure-type id. Missing entries
// mean "not present in this group" — destinations decide whether each
// type is required or optional.
export type WithingsReading = Record<number, number>;

export interface ReadingsByDate {
  // YYYY-MM-DD in the user's resolved TZ → latest reading on that day.
  byDate: Map<string, WithingsReading>;
  tzUsed: string;
}

function decodeMeasure(m: WithingsMeasure): number {
  return m.value * Math.pow(10, m.unit);
}

function readingFromGroup(group: WithingsMeasureGroup): WithingsReading {
  const out: WithingsReading = {};
  for (const m of group.measures || []) {
    if ((WANTED_TYPES as readonly number[]).includes(m.type)) {
      out[m.type] = decodeMeasure(m);
    }
  }
  return out;
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

export function round(n: number, digits: number): number {
  const m = Math.pow(10, digits);
  return Math.round(n * m) / m;
}

export function withingsAccessTokenGetter(
  env: Env,
  userId: string,
): () => Promise<string> {
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

// One Withings API call + a bucket-by-local-date pass. Last write wins per
// day (groups are sorted ascending first, so iteration order is oldest →
// newest and Map#set leaves the latest reading as the kept value).
export async function fetchWithingsReadingsByDate(
  env: Env,
  userId: string,
  startUnix: number,
  endUnix: number,
): Promise<ReadingsByDate> {
  if (!Number.isFinite(startUnix) || !Number.isFinite(endUnix) || endUnix <= startUnix) {
    throw new Error(`Invalid sync window: [${startUnix}, ${endUnix}]`);
  }
  const getWithingsToken = withingsAccessTokenGetter(env, userId);
  const accessToken = await getWithingsToken();
  const measureBody = await fetchWithingsMeasurements(accessToken, startUnix, endUnix);

  const tzUsed =
    measureBody.timezone?.trim() ||
    env.WITHINGS_DEFAULT_TZ?.trim() ||
    TZ_HARD_FALLBACK;

  const byDate = new Map<string, WithingsReading>();
  const groups = (measureBody.measuregrps ?? [])
    .slice()
    .sort((a, b) => a.date - b.date);
  for (const g of groups) {
    byDate.set(dateKeyInTz(g.date, tzUsed), readingFromGroup(g));
  }
  return { byDate, tzUsed };
}

// Shared SyncResult shape used by every Withings-sourced sync helper.
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
