import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ok } from "./util.js";

// Phase 1 of the compute/analysis tool layer (see
// goals/workoutcontext-issue-sweep/files/workoutcontext-compute-layer-spec.md).
//
// Deterministic server-side analyzers over Intervals.icu data. The server
// calculates; the model interprets. Terse by default — aggregates, not
// dumps. Read-only: no write/delete surface.

const INTERVALS_BASE = "https://intervals.icu/api/v1";

const COMPUTE_VERSION = "compute_v1";

interface IntervalsActivity {
  id?: string | number;
  name?: string;
  type?: string;
  start_date_local?: string;
  moving_time?: number;
  distance?: number;
  icu_training_load?: number | null;
}

const DateRangeArgs = {
  oldest: z.string().describe("YYYY-MM-DD start date (inclusive)"),
  newest: z.string().describe("YYYY-MM-DD end date (inclusive)"),
};

export function parseRange(
  oldest: string,
  newest: string,
  maxDays = 93,
): { oldest: string; newest: string; days: number } {
  const iso = /^\d{4}-\d{2}-\d{2}$/;
  if (!iso.test(oldest) || !iso.test(newest)) {
    throw new Error(`oldest/newest must be YYYY-MM-DD (got "${oldest}" / "${newest}")`);
  }
  const o = Date.parse(oldest + "T00:00:00Z");
  const n = Date.parse(newest + "T00:00:00Z");
  if (n < o) throw new Error(`newest (${newest}) is before oldest (${oldest})`);
  const days = Math.round((n - o) / 86400000) + 1;
  if (days > maxDays) {
    throw new Error(`range too wide (${days} days) — keep this computation to ${maxDays} days or less`);
  }
  return { oldest, newest, days };
}

const r1 = (n: number) => Math.round(n * 10) / 10;

type SummaryBucket = { sessions: number; moving_sec: number; distance_m: number; training_load: number };

const shapeBucket = (s: SummaryBucket) => ({
  sessions: s.sessions,
  hours: r1(s.moving_sec / 3600),
  distance_km: r1(s.distance_m / 1000),
  training_load: Math.round(s.training_load),
});

/** Pure aggregation — exported for fixture testing. */
export function summarizeActivities(  activities: IntervalsActivity[],
  range: { oldest: string; newest: string; days: number },
  sport: string | undefined,
  includeDetail: boolean,
) {
  const filtered = sport
    ? activities.filter((a) => (a.type ?? "").toLowerCase().includes(sport.toLowerCase()))
    : activities;

  const totals: SummaryBucket = { sessions: 0, moving_sec: 0, distance_m: 0, training_load: 0 };
  const bySport: Record<string, SummaryBucket> = {};
  const warnings: string[] = [];
  let loadless = 0;
  const detail: Array<Record<string, unknown>> = [];

  for (const a of filtered) {
    const type = a.type ?? "Unknown";
    totals.sessions += 1;
    totals.moving_sec += a.moving_time ?? 0;
    totals.distance_m += a.distance ?? 0;
    const b = (bySport[type] ??= { sessions: 0, moving_sec: 0, distance_m: 0, training_load: 0 });
    b.sessions += 1;
    b.moving_sec += a.moving_time ?? 0;
    b.distance_m += a.distance ?? 0;
    if (typeof a.icu_training_load === "number") {
      totals.training_load += a.icu_training_load;
      b.training_load += a.icu_training_load;
    } else {
      loadless += 1;
    }
    if (includeDetail) {
      detail.push({
        id: a.id,
        name: a.name,
        date: (a.start_date_local ?? "").slice(0, 10),
        type,
        training_load: a.icu_training_load ?? null,
        moving_sec: a.moving_time ?? 0,
        distance_m: r1(a.distance ?? 0),
      });
    }
  }
  if (loadless > 0) {
    warnings.push(
      `${loadless} of ${filtered.length} activities had no icu_training_load (e.g. strength without HR/power) and were excluded from the load total`,
    );
  }

  const bySportOut: Record<string, ReturnType<typeof shapeBucket>> = {};
  for (const [k, v] of Object.entries(bySport)) bySportOut[k] = shapeBucket(v);

  return {
    result: {
      range: { oldest: range.oldest, newest: range.newest, days: range.days, sport_filter: sport ?? null },
      totals: shapeBucket(totals),
      daily_avg: {
        hours: r1(totals.moving_sec / 3600 / range.days),
        distance_km: r1(totals.distance_m / 1000 / range.days),
        training_load: Math.round(totals.training_load / range.days),
      },
      by_sport: bySportOut,
      ...(includeDetail ? { detail } : {}),
    },
    _meta: {
      computation: "training_summary_v1",
      version: COMPUTE_VERSION,
      sources: { activities: filtered.length },
      warnings,
    },
  };
}

export function registerComputeTools(
  server: McpServer,
  getAccessToken: () => Promise<string>,
  athleteId?: string,
) {
  // Same current-athlete placeholder convention as intervals.ts.
  const resolvedAthleteId = athleteId && athleteId !== "" ? athleteId : "0";
  const athlete = () => resolvedAthleteId;

  async function intervalsFetch(path: string, init: RequestInit = {}): Promise<unknown> {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${await getAccessToken()}`);
    headers.set("Accept", "application/json");
    if (init.body) headers.set("Content-Type", "application/json");
    const res = await fetch(`${INTERVALS_BASE}${path}`, { ...init, headers });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`Intervals ${init.method ?? "GET"} ${path} → ${res.status}: ${text}`);
    }
    return text ? JSON.parse(text) : null;
  }

  async function listActivities(oldest: string, newest: string): Promise<IntervalsActivity[]> {
    const data = await intervalsFetch(
      `/athlete/${encodeURIComponent(athlete())}/activities?oldest=${oldest}&newest=${newest}`,
    );
    if (!Array.isArray(data)) throw new Error("Intervals activities endpoint returned non-array");
    return data as IntervalsActivity[];
  }

  server.tool(
    "compute_training_summary",
    "Deterministic training-load/volume summary over a date range — sessions, hours, distance, and training load, totals plus per-sport breakdown and daily averages. " +
      "Use this instead of fetching activities and summing in chat: the server aggregates, so the numbers are exact and the response stays small. " +
      "Read-only. Intervals.icu data only in this phase.",
    {
      ...DateRangeArgs,
      sport: z
        .string()
        .optional()
        .describe(
          "Filter to one sport, e.g. 'Run', 'Ride', 'WeightTraining'. Case-insensitive substring match on the activity type.",
        ),
      include_detail: z
        .boolean()
        .default(false)
        .describe("Include per-activity rows (id, name, date, type, load, time, distance). Default false — aggregates only."),
    },
    async ({ oldest, newest, sport, include_detail }) => {
      const range = parseRange(oldest, newest);
      const activities = await listActivities(range.oldest, range.newest);
      return ok(summarizeActivities(activities, range, sport, include_detail));
    },
  );

  server.tool(
    "compute_zone_distribution",
    "Deterministic time-in-zone aggregation over a date range — per-zone seconds, hours, and share, plus a polarized (80/20) check. " +
      "Reads Intervals.icu's precomputed per-activity zone times (no stream math in chat, no estimating zones by hand). " +
      "Use this for polarized-training checks and intensity-distribution questions. Read-only.",
    {
      ...DateRangeArgs,
      sport: z
        .string()
        .describe("Sport to analyze, e.g. 'Run' or 'Ride'. Case-insensitive substring match on the activity type."),
      metric: z
        .enum(["hr", "power", "pace"])
        .describe("Which zone system to aggregate. Availability depends on the activity recording that metric."),
      include_detail: z
        .boolean()
        .default(false)
        .describe("Include per-activity zone rows. Default false — aggregates only."),
    },
    async ({ oldest, newest, sport, metric, include_detail }) => {
      // Per-activity detail fetches: keep the range tight and fan out in
      // small batches to stay well under intervals.icu's rate limits.
      const range = parseRange(oldest, newest, 31);
      const needle = sport.toLowerCase();
      const activities = (await listActivities(range.oldest, range.newest)).filter((a) =>
        (a.type ?? "").toLowerCase().includes(needle),
      );

      const zoneFields = aggregateZoneTimes(
        await mapBatched(activities, 6, async (a) => {
          if (a.id === undefined) return { activity: a, zoneSecs: null as number[] | null, field: null as string | null };
          try {
            const detail = (await intervalsFetch(
              `/activity/${encodeURIComponent(String(a.id))}`,
            )) as Record<string, unknown>;
            const { seconds, field } = extractZoneTimes(detail, metric);
            return { activity: a, zoneSecs: seconds, field };
          } catch {
            return { activity: a, zoneSecs: null as number[] | null, field: null as string | null };
          }
        }),
        { oldest: range.oldest, newest: range.newest, days: range.days, sport, metric },
        include_detail,
      );

      return ok(zoneFields);
    },
  );
}

/** Run async fn over items in batches of `size` (rate-limit friendly). */
async function mapBatched<T, R>(items: T[], size: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
  }
  return out;
}

const ZONE_FIELD_CANDIDATES: Record<string, string[]> = {
  hr: ["icu_hr_zone_times", "icu_zone_times", "icu_hr_zones"],
  power: ["icu_power_zone_times", "icu_zone_times", "icu_power_zones"],
  pace: ["icu_pace_zone_times", "icu_zone_times", "icu_pace_zones"],
};

/**
 * Pull per-zone seconds out of an activity detail record. Handles the
 * shapes intervals.icu has used: number[] (positional, zone 1 first),
 * {secs|seconds}[] objects, and {"1": secs} maps. Returns null when the
 * record carries no zone-time data for the metric.
 */
export function extractZoneTimes(
  detail: Record<string, unknown>,
  metric: string,
): { seconds: number[] | null; field: string | null } {
  for (const key of ZONE_FIELD_CANDIDATES[metric] ?? []) {
    const v = detail[key];
    if (v == null) continue;
    if (Array.isArray(v) && v.length > 0) {
      if (typeof v[0] === "number") {
        const secs = (v as unknown[]).map(Number);
        if (secs.every((s) => Number.isFinite(s))) return { seconds: secs, field: key };
        continue;
      }
      if (typeof v[0] === "object" && v[0] !== null) {
        const rows = v as Array<Record<string, unknown>>;
        const secs = rows.map((e) => e.secs ?? e.seconds ?? e.time);
        if (secs.every((s) => typeof s === "number")) {
          // Explicit zone numbers win over position when present.
          const zones = rows.map((e) => e.zone ?? e.zone_index);
          if (zones.every((z) => typeof z === "number")) {
            const max = Math.max(...(zones as number[]));
            const out = new Array(max).fill(0);
            rows.forEach((e, i) => {
              out[(zones[i] as number) - 1] = secs[i] as number;
            });
            return { seconds: out, field: key };
          }
          return { seconds: secs as number[], field: key };
        }
        continue;
      }
    }
    if (typeof v === "object") {
      const entries = Object.entries(v as Record<string, unknown>)
        .map(([k, val]) => [parseInt(k.replace(/\D/g, ""), 10), val] as const)
        .filter(([k, val]) => Number.isInteger(k) && typeof val === "number");
      if (entries.length > 0) {
        const max = Math.max(...entries.map(([k]) => k));
        const out = new Array(max).fill(0);
        for (const [k, val] of entries) out[k - 1] = val as number;
        return { seconds: out, field: key };
      }
    }
  }
  return { seconds: null, field: null };
}

interface ZoneRow {
  activity: IntervalsActivity;
  zoneSecs: number[] | null;
  field: string | null;
}

/** Pure aggregation over per-activity zone rows — exported for fixture testing. */
export function aggregateZoneTimes(
  rows: ZoneRow[],
  ctx: { oldest: string; newest: string; days: number; sport: string; metric: string },
  includeDetail: boolean,
) {
  const withData = rows.filter((r) => r.zoneSecs && r.zoneSecs.length > 0);
  const withoutData = rows.length - withData.length;

  const fieldCounts: Record<string, number> = {};
  let zoneCount = 0;
  for (const r of withData) {
    if (r.field) fieldCounts[r.field] = (fieldCounts[r.field] ?? 0) + 1;
    zoneCount = Math.max(zoneCount, r.zoneSecs!.length);
  }
  const totals = new Array(zoneCount).fill(0);
  const detail: Array<Record<string, unknown>> = [];
  const warnings: string[] = [];

  for (const r of withData) {
    const secs = r.zoneSecs!;
    if (secs.length !== zoneCount) {
      warnings.push(
        `activity ${String(r.activity.id ?? "?")} reported ${secs.length} zones vs ${zoneCount} elsewhere — summed positionally, verify zone models match`,
      );
    }
    secs.forEach((s, i) => {
      totals[i] += s;
    });
    detail.push({
      id: r.activity.id,
      name: r.activity.name,
      date: (r.activity.start_date_local ?? "").slice(0, 10),
      zones: secs.map((s) => Math.round(s)),
    });
  }
  if (withoutData > 0) {
    warnings.push(
      `${withoutData} of ${rows.length} activities had no zone-time data for this metric and were excluded`,
    );
  }

  const totalSeconds = totals.reduce((a, b) => a + b, 0);
  const zones = totals.map((s, i) => ({
    zone: i + 1,
    seconds: Math.round(s),
    hours: r1(s / 3600),
    pct: totalSeconds > 0 ? r1((s / totalSeconds) * 100) : 0,
  }));

  // Seiler polarized check: >=80% of time in Z1+Z2.
  let polarized_check: { z1_z2_pct: number; meets_80_20: boolean } | null = null;
  if (zones.length >= 2 && totalSeconds > 0) {
    const z1z2 = zones[0].pct + zones[1].pct;
    polarized_check = { z1_z2_pct: r1(z1z2), meets_80_20: z1z2 >= 80 };
  }

  return {
    result: {
      range: { oldest: ctx.oldest, newest: ctx.newest, days: ctx.days },
      sport: ctx.sport,
      metric: ctx.metric,
      zones,
      total_seconds: Math.round(totalSeconds),
      total_hours: r1(totalSeconds / 3600),
      activities_with_data: withData.length,
      activities_without_data: withoutData,
      polarized_check,
      ...(includeDetail ? { detail } : {}),
    },
    _meta: {
      computation: "zone_distribution_v1",
      version: COMPUTE_VERSION,
      sources: { activities: rows.length, zone_fields: fieldCounts },
      warnings,
    },
  };
}
