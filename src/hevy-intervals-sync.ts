// Cross-provider sync: Hevy strength workouts → Intervals.icu activity +
// paired planned event. Triggered by Hevy's webhook (single `workoutId`
// payload) via `POST /webhooks/hevy`, and by an admin replay route.
//
// Direct port of ~/Projects/intervals-sync/sync_hevy.py with one explicit
// deviation: when no matching Intervals activity exists for the workout
// (e.g. the user didn't wear an HR monitor during the lift), the Python
// script SKIPS. This worker CREATES a manual `WeightTraining` activity
// in Intervals so the session still shows up. The matching path is
// unchanged — if a wearable upload already paired an activity, we enrich
// it the same way the Python sync does.
//
// Idempotency comes from `external_id` on both the activity (`hevy-<id>`)
// and the paired event (`hevy-<id>` too — they're separate object types so
// the collision is fine). Re-firing the webhook is a no-op or update.

import type { Env } from "./index.js";
import { getCred, setCred } from "./storage.js";
import { INTERVALS_OAUTH } from "./intervals.js";
import { makeAccessTokenGetter } from "./oauth.js";

const HEVY_BASE = "https://api.hevyapp.com/v1";
const INTERVALS_BASE = "https://intervals.icu/api/v1";

// Match tolerance in seconds. Mirrors sync_hevy.py:activity_matches_workout.
const TIME_TOL_SEC = 120;

// === Text cleaning ==========================================================
//
// Intervals.icu's event API round-trips non-ASCII characters as mojibake
// (latin-1-encoded UTF-8 bytes), which breaks idempotency comparisons on
// subsequent syncs. We strip workout titles + descriptions to ASCII before
// writing — same approach as `_ascii_clean` in fitness_mcp.py.

const PUNCT_FOLD: Record<string, string> = {
  "–": "-", "—": "-",       // en/em dash
  "‘": "'", "’": "'",       // smart single quotes
  "“": '"', "”": '"',       // smart double quotes
  "×": "x", "•": "*", "·": "*",
};

function asciiClean(s: string | null | undefined): string {
  if (!s) return "";
  let out = s;
  for (const [k, v] of Object.entries(PUNCT_FOLD)) out = out.split(k).join(v);
  out = out.normalize("NFKD").replace(/\p{M}/gu, "");
  return out.replace(/[^\x00-\x7F]/g, "-");
}

// === Hevy types =============================================================

interface HevySet {
  set_type?: string;
  weight_kg?: number | null;
  reps?: number | null;
  duration_seconds?: number | null;
  distance_meters?: number | null;
  rpe?: number | null;
}

interface HevyExercise {
  title?: string;
  superset_id?: number | null;
  notes?: string | null;
  sets?: HevySet[];
}

interface HevyWorkout {
  id: string;
  title?: string;
  description?: string;
  start_time: string; // ISO 8601, typically with Z suffix
  end_time: string;
  exercises?: HevyExercise[];
}

// === Intervals types (just what we touch) ==================================

interface IntervalsActivity {
  id: string;
  name?: string | null;
  type?: string | null;
  start_date?: string | null;
  start_date_local?: string | null;
  elapsed_time?: number | null;
  external_id?: string | null;
  description?: string | null;
  paired_event_id?: number | null;
  kg_lifted?: number | null;
}

interface IntervalsEvent {
  id: number;
  name?: string | null;
  description?: string | null;
  external_id?: string | null;
  start_date_local?: string | null;
}

// === Workout formatting (mirrors sync_hevy.py) =============================

function normalizeTitle(s: string | null | undefined): string {
  return (s ?? "").toLowerCase().split(/\s+/).filter(Boolean).join(" ");
}

function workoutTitle(workout: HevyWorkout): string {
  return asciiClean((workout.title ?? "Strength Training").trim());
}

function calculateKgLifted(workout: HevyWorkout): number | null {
  let total = 0;
  for (const ex of workout.exercises ?? []) {
    for (const s of ex.sets ?? []) {
      const w = s.weight_kg;
      const r = s.reps;
      if (w == null || r == null) continue;
      total += w * r;
    }
  }
  return total > 0 ? Math.round(total * 1000) / 1000 : null;
}

function formatNumber(n: number): string {
  // Python's `:g` format: drop trailing zeros, no unnecessary decimals.
  return Number.isInteger(n) ? String(n) : String(parseFloat(n.toFixed(6)));
}

function formatSet(s: HevySet): string {
  const parts: string[] = [];
  const setType = (s.set_type ?? "normal").toLowerCase();
  if (setType !== "normal") parts.push(setType.toUpperCase());
  if (s.reps != null) {
    if (s.weight_kg) parts.push(`${formatNumber(s.weight_kg)}kg x ${s.reps}`);
    else parts.push(`${s.reps} reps`);
  }
  if (s.duration_seconds) parts.push(`${s.duration_seconds}s`);
  if (s.distance_meters) parts.push(`${formatNumber(s.distance_meters)}m`);
  if (s.rpe) parts.push(`RPE ${formatNumber(s.rpe)}`);
  return parts.length ? "  - " + parts.join(", ") : "  - (empty set)";
}

function renderDescription(workout: HevyWorkout): string {
  const lines: string[] = [];
  for (const ex of workout.exercises ?? []) {
    const title = ex.title ?? "Exercise";
    let header = `### ${title}`;
    if (ex.superset_id != null) header += `  (superset ${ex.superset_id})`;
    lines.push(header);
    if (ex.notes) lines.push(ex.notes);
    for (const s of ex.sets ?? []) lines.push(formatSet(s));
    lines.push("");
  }
  if (workout.description) lines.push(workout.description);
  return asciiClean(lines.join("\n").trim());
}

function activityExternalId(workoutId: string): string {
  return `hevy-${workoutId}`;
}

function eventExternalId(workoutId: string): string {
  // Same shape as the activity external_id; they live on separate object
  // types so the value collision is fine and keeps the mental model simple.
  return `hevy-${workoutId}`;
}

// Pre-external_id sync runs stamped this marker into the event description
// for "is this our event" detection. Kept only as a fallback so existing
// paired events created by intervals-sync get recognized + migrated to
// external_id on the next sync.
function legacyEventMarker(workoutId: string): string {
  return `[hevy-event:${workoutId}]`;
}

// === Match logic ============================================================

const STRENGTH_TYPES = new Set([
  "weighttraining",
  "weight training",
  "strength",
  "strengthtraining",
  "strength training",
]);

function isStrengthActivity(a: IntervalsActivity): boolean {
  if (a.type == null) return true; // null type is permissive — Python does the same
  return STRENGTH_TYPES.has(normalizeTitle(a.type));
}

function activityMatchesWorkout(
  a: IntervalsActivity,
  startUtcMs: number,
  durationSec: number,
): boolean {
  if (!isStrengthActivity(a)) return false;
  if (!a.start_date) return false;
  const aStartMs = Date.parse(a.start_date);
  if (!Number.isFinite(aStartMs)) return false;
  const aDurationSec = a.elapsed_time ?? 0;
  const timeDiff = Math.abs((aStartMs - startUtcMs) / 1000);
  const durDiff = Math.abs(aDurationSec - durationSec);
  return timeDiff < TIME_TOL_SEC && durDiff < TIME_TOL_SEC;
}

function findMatchingActivity(
  activities: IntervalsActivity[],
  workout: HevyWorkout,
  extId: string,
  startUtcMs: number,
  durationSec: number,
): IntervalsActivity | null {
  // 1. external_id wins outright.
  const byExt = activities.find((a) => a.external_id === extId);
  if (byExt) return byExt;

  // 2. Fall back to time+duration window. If multiple candidates, prefer
  //    one whose name matches the workout title.
  const candidates = activities.filter((a) => activityMatchesWorkout(a, startUtcMs, durationSec));
  if (candidates.length === 0) return null;

  const wantTitle = normalizeTitle(workoutTitle(workout));
  const titled = candidates.find((a) => normalizeTitle(a.name) === wantTitle);
  return titled ?? candidates[0];
}

// === Token getters ==========================================================

async function hevyApiKey(env: Env, userId: string): Promise<string> {
  const cred = await getCred(env.OAUTH_KV, userId, "hevy");
  if (!cred) throw new Error("Hevy disconnected");
  return cred.apiKey;
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

// === HTTP wrappers ==========================================================

async function hevyFetch(apiKey: string, path: string): Promise<unknown> {
  const res = await fetch(`${HEVY_BASE}${path}`, {
    headers: { "api-key": apiKey, Accept: "application/json" },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Hevy GET ${path} → ${res.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

async function intervalsFetch(
  token: string,
  path: string,
  init: RequestInit = {},
): Promise<unknown> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  headers.set("Accept", "application/json");
  if (init.body) headers.set("Content-Type", "application/json");
  const res = await fetch(`${INTERVALS_BASE}${path}`, { ...init, headers });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Intervals ${init.method ?? "GET"} ${path} → ${res.status}: ${text}`);
  }
  return text ? JSON.parse(text) : null;
}

// Hevy returns `{ workout: {...} }` for a single get.
async function fetchHevyWorkout(apiKey: string, workoutId: string): Promise<HevyWorkout> {
  const raw = (await hevyFetch(apiKey, `/workouts/${encodeURIComponent(workoutId)}`)) as
    | { workout?: HevyWorkout }
    | HevyWorkout
    | null;
  if (!raw) throw new Error(`Hevy workout ${workoutId} not found`);
  const w = (raw as { workout?: HevyWorkout }).workout ?? (raw as HevyWorkout);
  if (!w?.id) throw new Error(`Hevy workout ${workoutId}: unexpected response shape`);
  return w;
}

async function listIntervalsActivities(
  token: string,
  oldest: string,
  newest: string,
): Promise<IntervalsActivity[]> {
  const data = (await intervalsFetch(
    token,
    `/athlete/0/activities?oldest=${oldest}&newest=${newest}`,
  )) as IntervalsActivity[] | null;
  return data ?? [];
}

async function getIntervalsEvent(token: string, eventId: number): Promise<IntervalsEvent | null> {
  try {
    return (await intervalsFetch(token, `/athlete/0/events/${eventId}`)) as IntervalsEvent;
  } catch (e) {
    console.error(`[hevy/sync] could not fetch paired event ${eventId}:`, e);
    return null;
  }
}

async function createIntervalsManualActivity(
  token: string,
  body: Record<string, unknown>,
): Promise<IntervalsActivity> {
  return (await intervalsFetch(token, `/athlete/0/activities/manual`, {
    method: "POST",
    body: JSON.stringify(body),
  })) as IntervalsActivity;
}

async function updateIntervalsActivity(
  token: string,
  activityId: string,
  body: Record<string, unknown>,
): Promise<void> {
  await intervalsFetch(token, `/activity/${encodeURIComponent(activityId)}`, {
    method: "PUT",
    body: JSON.stringify(body),
  });
}

async function createIntervalsEvent(
  token: string,
  body: Record<string, unknown>,
): Promise<IntervalsEvent> {
  return (await intervalsFetch(token, `/athlete/0/events`, {
    method: "POST",
    body: JSON.stringify(body),
  })) as IntervalsEvent;
}

async function updateIntervalsEvent(
  token: string,
  eventId: number,
  body: Record<string, unknown>,
): Promise<void> {
  await intervalsFetch(token, `/athlete/0/events/${eventId}`, {
    method: "PUT",
    body: JSON.stringify(body),
  });
}

// === Local-time conversion ==================================================
//
// Intervals expects `start_date_local` in the athlete's TZ, naive (no
// suffix), formatted YYYY-MM-DDTHH:MM:SS. Hevy gives us UTC ISO. We fetch
// the athlete profile once per sync, read its `timezone` field, and convert.

interface IntervalsAthlete {
  timezone?: string | null;
}

async function getIntervalsAthleteTimezone(token: string): Promise<string | null> {
  try {
    const data = (await intervalsFetch(token, `/athlete/0`)) as IntervalsAthlete | null;
    return data?.timezone ?? null;
  } catch (e) {
    console.error("[hevy/sync] could not fetch athlete timezone:", e);
    return null;
  }
}

// Returns `YYYY-MM-DDTHH:MM:SS` in the given IANA TZ. Falls back to UTC
// if the TZ is null or unknown to the runtime.
function utcMsToLocalNaive(utcMs: number, tz: string | null): string {
  const d = new Date(utcMs);
  if (!tz) return d.toISOString().slice(0, 19);
  try {
    const fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
    const parts = Object.fromEntries(fmt.formatToParts(d).map((p) => [p.type, p.value]));
    return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
  } catch {
    return d.toISOString().slice(0, 19);
  }
}

// === Main entry point =======================================================

export interface HevySyncResult {
  workoutId: string;
  activityId: string;
  eventId: number | null;
  created: boolean; // true if we minted a manual activity rather than enriching an existing one
}

export async function syncHevyWorkoutToIntervals(
  env: Env,
  userId: string,
  workoutId: string,
): Promise<HevySyncResult> {
  const apiKey = await hevyApiKey(env, userId);
  const workout = await fetchHevyWorkout(apiKey, workoutId);

  const startUtcMs = Date.parse(workout.start_time);
  const endUtcMs = Date.parse(workout.end_time);
  if (!Number.isFinite(startUtcMs) || !Number.isFinite(endUtcMs)) {
    throw new Error(
      `Hevy workout ${workoutId}: unparseable start/end (${workout.start_time}, ${workout.end_time})`,
    );
  }
  const durationSec = Math.max(Math.floor((endUtcMs - startUtcMs) / 1000), 0);

  const getIntervalsToken = intervalsAccessTokenGetter(env, userId);
  const intervalsToken = await getIntervalsToken();

  const extId = activityExternalId(workoutId);
  const title = workoutTitle(workout);
  const description = renderDescription(workout);
  const kgLifted = calculateKgLifted(workout);

  // Query a ±1-day window in case TZ math drifts the candidate set.
  const oldest = new Date(startUtcMs - 86400_000).toISOString().slice(0, 10);
  const newest = new Date(startUtcMs + 86400_000).toISOString().slice(0, 10);
  const activities = await listIntervalsActivities(intervalsToken, oldest, newest);

  let match = findMatchingActivity(activities, workout, extId, startUtcMs, durationSec);
  let created = false;

  if (!match) {
    const tz = await getIntervalsAthleteTimezone(intervalsToken);
    const startLocal = utcMsToLocalNaive(startUtcMs, tz);
    const createBody: Record<string, unknown> = {
      start_date_local: startLocal,
      type: "WeightTraining",
      name: title,
      external_id: extId,
      moving_time: durationSec,
      elapsed_time: durationSec,
    };
    if (kgLifted != null) createBody.kg_lifted = kgLifted;
    match = await createIntervalsManualActivity(intervalsToken, createBody);
    created = true;
    console.log(
      `[hevy/sync] created Intervals activity ${match.id} for workout=${workoutId} (no prior match)`,
    );
  }

  // ---- Paired event: create / update / leave-alone ------------------------

  const eventExtId = eventExternalId(workoutId);
  let pairedEvent: IntervalsEvent | null = null;
  if (match.paired_event_id) {
    pairedEvent = await getIntervalsEvent(intervalsToken, match.paired_event_id);
  }

  const pairedExt = pairedEvent?.external_id ?? "";
  const pairedDesc = pairedEvent?.description ?? "";
  const isOurEvent = !!pairedEvent && (
    pairedExt === eventExtId || pairedDesc.includes(legacyEventMarker(workoutId))
  );

  let resultEventId: number | null = pairedEvent?.id ?? null;

  if (isOurEvent && pairedEvent) {
    const needsUpdate =
      (pairedEvent.description ?? "").trim() !== description.trim()
      || pairedEvent.name !== title
      || pairedExt !== eventExtId; // migrate legacy marker → external_id
    if (needsUpdate) {
      await updateIntervalsEvent(intervalsToken, pairedEvent.id, {
        start_date_local: pairedEvent.start_date_local,
        name: title,
        description,
        external_id: eventExtId,
      });
      console.log(`[hevy/sync] updated event ${pairedEvent.id} for workout=${workoutId}`);
    }
  } else if (pairedEvent) {
    console.log(
      `[hevy/sync] activity ${match.id} paired to non-Hevy event ${pairedEvent.id}; leaving alone`,
    );
  } else {
    const startLocal = match.start_date_local ?? match.start_date;
    if (!startLocal) {
      throw new Error(
        `Intervals activity ${match.id} has no start_date_local / start_date; cannot create event`,
      );
    }
    const newEvent = await createIntervalsEvent(intervalsToken, {
      start_date_local: startLocal,
      category: "WORKOUT",
      type: "WeightTraining",
      name: title,
      description,
      moving_time: durationSec,
      external_id: eventExtId,
    });
    resultEventId = newEvent.id;
    await updateIntervalsActivity(intervalsToken, match.id, { paired_event_id: newEvent.id });
    console.log(
      `[hevy/sync] created event ${newEvent.id}, paired to activity ${match.id} for workout=${workoutId}`,
    );
  }

  // ---- Activity payload: clear description (lives on event), set name + kg_lifted + external_id

  const activityPayload: Record<string, unknown> = {
    name: title,
    external_id: extId,
    description: "",
  };
  if (kgLifted != null) activityPayload.kg_lifted = kgLifted;
  const needsActivityUpdate =
    match.name !== title
    || (match.description ?? "").trim() !== ""
    || match.external_id !== extId
    || (kgLifted != null && match.kg_lifted !== kgLifted);
  if (needsActivityUpdate) {
    await updateIntervalsActivity(intervalsToken, match.id, activityPayload);
  }

  return { workoutId, activityId: match.id, eventId: resultEventId, created };
}
