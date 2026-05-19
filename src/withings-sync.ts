// Cross-provider sync: Withings body-composition measurements → Intervals.icu
// wellness records.
//
// Entry points:
//   - Webhook handler   (src/auth-handler.ts handleWithingsWeight, appli=1)
//   - Admin debug route (POST /admin/users/<id>/withings/sync?dest=intervals)
//
// The shared Withings fetch + day-bucket pipeline lives in withings-readings.ts;
// this file just formats the per-day reading into an Intervals wellness body
// and PUTs it.

import type { Env } from "./index.js";
import { getCred, setCred } from "./storage.js";
import { INTERVALS_OAUTH } from "./intervals.js";
import { makeAccessTokenGetter } from "./oauth.js";
import {
  fetchWithingsReadingsByDate,
  round,
  TYPE_BONE_KG,
  TYPE_FAT_RATIO,
  TYPE_HYDRATION_KG,
  TYPE_MUSCLE_KG,
  TYPE_WEIGHT,
  type SyncResult,
  type WithingsReading,
} from "./withings-readings.js";

const INTERVALS_BASE = "https://intervals.icu/api/v1";
const KG_TO_LB = 2.2046226218;

function toWellnessBody(reading: WithingsReading): Record<string, number> | null {
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

export async function syncWithingsMeasurementsToIntervals(
  env: Env,
  userId: string,
  startUnix: number,
  endUnix: number,
): Promise<SyncResult> {
  const { byDate, tzUsed } = await fetchWithingsReadingsByDate(env, userId, startUnix, endUnix);

  if (byDate.size === 0) {
    return { daysSynced: 0, daysSkipped: 0, daysFailed: 0, perDay: [], tzUsed };
  }

  const perDay: SyncResult["perDay"] = [];
  let daysSynced = 0;
  let daysSkipped = 0;
  let daysFailed = 0;

  // Resolve the Intervals token once per call (refresh-on-expiry inside the
  // getter handles staleness across the day loop below).
  const getIntervalsToken = intervalsAccessTokenGetter(env, userId);
  const intervalsToken = await getIntervalsToken();

  for (const [date, reading] of Array.from(byDate.entries()).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )) {
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

  return { daysSynced, daysSkipped, daysFailed, perDay, tzUsed };
}
