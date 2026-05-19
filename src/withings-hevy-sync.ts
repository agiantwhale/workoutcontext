// Cross-provider sync: Withings body-composition measurements → Hevy
// body_measurements entries.
//
// Entry points:
//   - Webhook handler   (src/auth-handler.ts handleWithingsWeight, appli=1)
//   - Admin debug route (POST /admin/users/<id>/withings/sync?dest=hevy)
//
// Hevy auth is an API key on HevyCred (not OAuth). Field mapping:
//
//   Withings type 1  (weight_kg)    → Hevy weight_kg     (direct)
//   Withings type 6  (fat_ratio %)  → Hevy fat_percent   (direct)
//   Withings type 76 (muscle_kg)    → Hevy lean_mass_kg  (Withings's bioimpedance
//                                                         "muscle mass" is treated
//                                                         as Hevy's "lean mass" —
//                                                         pragmatic given Hevy
//                                                         exposes no muscle field)
//   Withings type 77 (hydration_kg) → (dropped)          (no Hevy equivalent)
//   Withings type 88 (bone_kg)      → (dropped)          (no Hevy equivalent)
//
// Hevy POST /body_measurements returns 409 if an entry exists for that date,
// and PUT replaces with omitted-fields-set-to-null semantics. To avoid clobbering
// user-entered circumference/notes fields, we GET → merge → PUT on conflict.

import type { Env } from "./index.js";
import { getCred } from "./storage.js";
import {
  round,
  TYPE_FAT_RATIO,
  TYPE_MUSCLE_KG,
  TYPE_WEIGHT,
  type ReadingsByDate,
  type SyncResult,
  type WithingsReading,
} from "./withings-readings.js";

const HEVY_BASE = "https://api.hevyapp.com/v1";

interface HevyBodyMeasurementWritable {
  weight_kg?: number | null;
  lean_mass_kg?: number | null;
  fat_percent?: number | null;
  neck_cm?: number | null;
  shoulder_cm?: number | null;
  chest_cm?: number | null;
  left_bicep_cm?: number | null;
  right_bicep_cm?: number | null;
  left_forearm_cm?: number | null;
  right_forearm_cm?: number | null;
  abdomen?: number | null;
  waist?: number | null;
  hips?: number | null;
  left_thigh_cm?: number | null;
  right_thigh_cm?: number | null;
  left_calf_cm?: number | null;
  right_calf_cm?: number | null;
  notes?: string | null;
}

function toHevyBody(reading: WithingsReading): HevyBodyMeasurementWritable | null {
  const weight_kg = reading[TYPE_WEIGHT];
  if (weight_kg == null || weight_kg <= 0) return null;
  const body: HevyBodyMeasurementWritable = {
    weight_kg: round(weight_kg, 3),
  };
  if (reading[TYPE_FAT_RATIO] != null) {
    body.fat_percent = round(reading[TYPE_FAT_RATIO], 2);
  }
  if (reading[TYPE_MUSCLE_KG] != null) {
    body.lean_mass_kg = round(reading[TYPE_MUSCLE_KG], 3);
  }
  return body;
}

async function hevyAccessKey(env: Env, userId: string): Promise<string> {
  const cred = await getCred(env.OAUTH_KV, userId, "hevy");
  if (!cred) throw new Error("Hevy disconnected");
  return cred.apiKey;
}

async function hevyFetch(
  apiKey: string,
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; bodyText: string }> {
  const headers = new Headers(init.headers);
  headers.set("api-key", apiKey);
  headers.set("Accept", "application/json");
  if (init.body) headers.set("Content-Type", "application/json");

  const res = await fetch(`${HEVY_BASE}${path}`, { ...init, headers });
  const bodyText = await res.text();
  return { status: res.status, bodyText };
}

// POST first; on 409 (entry exists) merge into the existing entry and PUT.
// PUT replaces with null-on-omit semantics, so we GET the existing record and
// only overwrite the Withings-derived fields, preserving anything else the
// user typed manually (neck/chest/bicep/notes/etc.). Returns the field names
// that ended up persisted for the SyncResult report.
async function upsertHevyBodyMeasurement(
  apiKey: string,
  date: string,
  body: HevyBodyMeasurementWritable,
): Promise<string[]> {
  const post = await hevyFetch(apiKey, "/body_measurements", {
    method: "POST",
    body: JSON.stringify({ date, ...body }),
  });
  if (post.status < 300) {
    return Object.keys(body);
  }
  if (post.status !== 409) {
    throw new Error(
      `Hevy POST /body_measurements → ${post.status}: ${post.bodyText}`,
    );
  }

  // Conflict: an entry exists for this date. Fetch + merge + PUT.
  const get = await hevyFetch(apiKey, `/body_measurements/${encodeURIComponent(date)}`);
  if (get.status >= 300) {
    throw new Error(
      `Hevy GET /body_measurements/${date} → ${get.status}: ${get.bodyText}`,
    );
  }
  let existing: HevyBodyMeasurementWritable = {};
  try {
    existing = get.bodyText ? (JSON.parse(get.bodyText) as HevyBodyMeasurementWritable) : {};
  } catch (e) {
    throw new Error(`Hevy GET /body_measurements/${date}: invalid JSON: ${e}`);
  }
  // Strip the `date` field (and anything else Hevy echoes back that isn't
  // writable) before reusing as PUT input. Spread our values last so Withings
  // writes win for the fields we own.
  const merged: HevyBodyMeasurementWritable = { ...existing, ...body };
  // Hevy's response may include non-writable fields. Drop `date` defensively.
  delete (merged as Record<string, unknown>).date;

  const put = await hevyFetch(apiKey, `/body_measurements/${encodeURIComponent(date)}`, {
    method: "PUT",
    body: JSON.stringify(merged),
  });
  if (put.status >= 300) {
    throw new Error(
      `Hevy PUT /body_measurements/${date} → ${put.status}: ${put.bodyText}`,
    );
  }
  return Object.keys(body);
}

export async function syncWithingsMeasurementsToHevy(
  env: Env,
  userId: string,
  readings: ReadingsByDate,
): Promise<SyncResult> {
  const { byDate, tzUsed } = readings;

  if (byDate.size === 0) {
    return { daysSynced: 0, daysSkipped: 0, daysFailed: 0, perDay: [], tzUsed };
  }

  const apiKey = await hevyAccessKey(env, userId);

  const perDay: SyncResult["perDay"] = [];
  let daysSynced = 0;
  let daysSkipped = 0;
  let daysFailed = 0;

  for (const [date, reading] of Array.from(byDate.entries()).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )) {
    const body = toHevyBody(reading);
    if (!body) {
      daysSkipped++;
      perDay.push({ date, status: "skipped", reason: "no weight reading in group" });
      continue;
    }
    try {
      const fields = await upsertHevyBodyMeasurement(apiKey, date, body);
      daysSynced++;
      perDay.push({ date, status: "synced", fields });
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
