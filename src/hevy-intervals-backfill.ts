// Backfill all Hevy workouts → Intervals.icu.
//
// Iterates through the user's full Hevy workout history (newest-first,
// paginated) and runs the same syncHevyWorkoutToIntervals used by the
// live webhook path. Each sync is idempotent (keyed on external_id), so
// re-running the backfill is safe — already-synced workouts become cheap
// no-op updates.
//
// Exposed to users via POST /settings/hevy/backfill (session-gated) and
// to operators via the existing admin single-workout replay endpoint.

import type { Env } from "./index.js";
import { getCred } from "./storage.js";
import { syncHevyWorkoutToIntervals } from "./hevy-intervals-sync.js";

const HEVY_BASE = "https://api.hevyapp.com/v1";
const PAGE_SIZE = 10; // Hevy API max per page

interface HevyWorkoutSummary {
  id: string;
  title?: string;
  start_time: string;
}

interface HevyListResponse {
  workouts: HevyWorkoutSummary[];
  page_count: number;
  page: number;
}

export interface BackfillResult {
  total: number;
  synced: number;
  created: number;
  updated: number;
  errors: Array<{ workoutId: string; error: string }>;
}

export async function backfillHevyToIntervals(
  env: Env,
  userId: string,
): Promise<BackfillResult> {
  const cred = await getCred(env.OAUTH_KV, userId, "hevy");
  if (!cred) throw new Error("Hevy is not connected");

  const intervalsCred = await getCred(env.OAUTH_KV, userId, "intervals");
  if (!intervalsCred) throw new Error("Intervals.icu is not connected");

  const result: BackfillResult = {
    total: 0,
    synced: 0,
    created: 0,
    updated: 0,
    errors: [],
  };

  let page = 1;
  let pageCount = 1;

  while (page <= pageCount) {
    const res = await fetch(
      `${HEVY_BASE}/workouts?page=${page}&pageSize=${PAGE_SIZE}`,
      { headers: { "api-key": cred.apiKey, Accept: "application/json" } },
    );
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Hevy GET /workouts?page=${page} → ${res.status}: ${text}`);
    }
    const data = (await res.json()) as HevyListResponse;
    pageCount = data.page_count;

    for (const workout of data.workouts) {
      result.total++;
      try {
        const syncResult = await syncHevyWorkoutToIntervals(env, userId, workout.id);
        result.synced++;
        if (syncResult.created) {
          result.created++;
        } else {
          result.updated++;
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(
          `[hevy/backfill] userId=${userId} workoutId=${workout.id} failed:`,
          msg,
        );
        result.errors.push({ workoutId: workout.id, error: msg });
      }
    }

    page++;
  }

  return result;
}
