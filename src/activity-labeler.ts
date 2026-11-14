// Activity-interval auto-labeler (issue #163).
//
// Pure derivation: a stored structured workout JSON + the activity's
// streams -> a label spec built directly from the plan. No I/O; the tool
// handler in intervals.ts does the fetching and the one bulk write.
//
// Design: labels describe intent, not execution — the plan is the
// authority for (type, label). The spec is the plan's steps resolved to
// exact time windows through the streams (distance steps via the distance
// stream, duration steps cumulative), so it does not depend on the
// activity having detected intervals at all. Work windows are checked
// against their target power zone (warning only — a stale CP must never
// block labeling); time past the plan is classified from executed power
// (Extra Work / Extra Recovery). Adjacent same-type steps are merged into
// one interval labeled with the last plan step's label, because Intervals
// merges adjacent same-type blocks on write.

// Type-only import (erased at runtime): this module imports no values, so
// it stays unit-testable under node --test type stripping, like
// activity-intervals.ts and hevy-routine-prescription.ts. The caller
// expands the stored workout (expandSteps) and passes the steps in.
import type { ExpandedStep } from "./workout-render.js";

const MI_TO_M = 1609.34;

// A stored interval as returned by GET /activity/{id}/intervals.
// Fields are read defensively — the API returns plain JSON.
export type DetectedInterval = Record<string, unknown>;

export interface LabelSpecEntry {
  start_index: number;
  end_index: number;
  type: "WORK" | "RECOVERY";
  label: string;
  // Set on intervals beyond the plan (classified from executed power).
  extra?: true;
}

export interface StreamSet {
  time: Array<number | null>;
  distance: Array<number | null>;
  watts: Array<number | null>;
}

export type LabelDerivation =
  | {
      status: "ok";
      spec: LabelSpecEntry[];
      planSteps: number;
      extraCount: number;
      warnings: string[];
    }
  | {
      status: "aborted";
      reason: "sparse_streams" | "alignment_mismatch" | "no_power_zones";
      detail: Record<string, unknown>;
    };

export interface DeriveInput {
  // Expanded plan steps (expandSteps: repeats unfolded, {n} labels
  // resolved, types defaulted by normalizeWorkout).
  steps: ExpandedStep[];
  eventName?: string | null;
  streams: StreamSet;
  // Activity moving_time (seconds), for the coverage gate.
  movingTime?: number | null;
  // Athlete's critical power in watts for the activity's sport; null when
  // unresolvable. Needed to classify time past the plan.
  cp?: number | null;
  // Power-zone upper-bound percentages from sport settings, e.g.
  // [80, 90, 100, 115, 999]. Null when unavailable — the zone check is
  // then skipped.
  zones?: Array<number> | null;
  // The workout's target_metric ('power' | 'hr' | 'pace'). The zone check
  // only runs for power plans.
  targetMetric?: string | null;
}

// ---------------------------------------------------------------------------
// Field readers
// ---------------------------------------------------------------------------

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

// Session label for all-easy sessions, from the event name — same rule as
// the critique script's session_label.
export function sessionLabel(eventName?: string | null): string {
  const n = (eventName ?? "").toLowerCase();
  if (n.includes("recover")) return "Recovery";
  if (n.includes("long")) return "Long Run";
  return "Easy";
}

// ---------------------------------------------------------------------------
// Streams
// ---------------------------------------------------------------------------

// Unwrap GET /activity/{id}/streams into the three arrays the labeler
// needs. The endpoint returns an array of {type, data} objects; a keyed
// object is accepted defensively. Nulls are kept (index alignment matters
// — the lookup helpers skip them).
export function extractStreams(data: unknown): StreamSet {
  const byType = new Map<string, unknown[]>();
  if (Array.isArray(data)) {
    for (const s of data) {
      if (
        s !== null &&
        typeof s === "object" &&
        typeof (s as Record<string, unknown>).type === "string" &&
        Array.isArray((s as Record<string, unknown>).data)
      ) {
        byType.set(
          (s as Record<string, unknown>).type as string,
          (s as Record<string, unknown>).data as unknown[],
        );
      }
    }
  } else if (data !== null && typeof data === "object") {
    for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
      if (Array.isArray(v)) byType.set(k, v);
    }
  }
  const samples = (arr: unknown[] | undefined): Array<number | null> =>
    (arr ?? []).map((v) => (typeof v === "number" && Number.isFinite(v) ? v : null));
  return {
    time: samples(byType.get("time")),
    distance: samples(byType.get("distance")),
    watts: samples(byType.get("watts")),
  };
}

// ---------------------------------------------------------------------------
// Plan steps: expand + derive (type, label)
// ---------------------------------------------------------------------------

interface PlanStep {
  section: string;
  type: "work" | "recovery";
  label: string;
  // Exactly one of these is set (schema guarantees one of
  // distance/duration per step).
  lengthMeters: number | null;
  lengthSeconds: number | null;
  // The step's target zone (number, [lo, hi], or "SS"), for the zone check.
  zone: unknown;
  // Easy if it is recovery, or targets zone 1-2 (power/HR zones). Pace
  // targets carry no zone, so a pace-targeted easy step is not recognized
  // here.
  easy: boolean;
}

function stepLengthMeters(step: {
  distance?: { mi?: number; km?: number; m?: number };
}): number | null {
  const d = step.distance;
  if (!d) return null;
  if (d.mi !== undefined) return d.mi * MI_TO_M;
  if (d.km !== undefined) return d.km * 1000;
  if (d.m !== undefined) return d.m;
  return null;
}

function stepLengthSeconds(step: {
  duration?: { minutes?: number; seconds?: number; hours?: number };
}): number | null {
  const d = step.duration;
  if (!d) return null;
  if (d.minutes !== undefined) return d.minutes * 60;
  if (d.seconds !== undefined) return d.seconds;
  if (d.hours !== undefined) return d.hours * 3600;
  return null;
}

function isEasyZone(zone: unknown): boolean {
  if (typeof zone === "number") return zone <= 2;
  if (Array.isArray(zone) && zone.length === 2) {
    return (
      typeof zone[0] === "number" &&
      typeof zone[1] === "number" &&
      zone[1] <= 2
    );
  }
  return false;
}

// Derive each expanded step's (type, label). Label rules: an explicit
// step label wins; otherwise Warmup/Cooldown sections label themselves,
// stride sections get Stride N / Easy, threshold/rep/interval sections
// get Rep N / Rest N, and anything else falls back to the section name
// (work) or Easy (recovery).
function derivePlanSteps(expanded: ExpandedStep[]): PlanStep[] {
  let repN = 0;
  let strideN = 0;
  let restN = 0;
  return expanded.map((es) => {
    const step = es.step;
    const type = step.type === "recovery" ? "recovery" : "work";
    const sectionLower = es.section.toLowerCase();
    let label: string;
    if (step.label !== undefined) {
      label = step.label;
    } else if (sectionLower === "warmup") {
      label = "Warmup";
    } else if (sectionLower === "cooldown") {
      label = "Cooldown";
    } else if (sectionLower.includes("stride")) {
      if (type === "work") {
        strideN += 1;
        label = `Stride ${strideN}`;
      } else {
        label = "Easy";
      }
    } else if (
      sectionLower.includes("threshold") ||
      sectionLower.includes("rep") ||
      sectionLower.includes("interval")
    ) {
      if (type === "work") {
        repN += 1;
        label = `Rep ${repN}`;
      } else {
        restN += 1;
        label = `Rest ${restN}`;
      }
    } else if (type === "work") {
      label = es.section;
    } else {
      label = "Easy";
    }
    return {
      section: es.section,
      type,
      label,
      lengthMeters: stepLengthMeters(step),
      lengthSeconds: stepLengthSeconds(step),
      zone: step.target.zone,
      easy: type === "recovery" || isEasyZone(step.target.zone),
    };
  });
}

// ---------------------------------------------------------------------------
// Windows + stream lookups
// ---------------------------------------------------------------------------

interface PlanWindow {
  start: number;
  // Null when the plan's distance runs past the recorded data (athlete
  // stopped early) — the window is then open-ended.
  end: number | null;
}

// Time (seconds) when the cumulative distance first reaches `meters`;
// null when the activity never reaches it.
function timeAtDistance(
  times: Array<number | null>,
  distances: Array<number | null>,
  meters: number,
): number | null {
  for (let i = 0; i < distances.length; i++) {
    const d = distances[i];
    if (d !== null && d >= meters) {
      const t = times[i];
      return t !== null ? t : i;
    }
  }
  return null;
}

// Cumulative [start, end) windows in activity seconds, one per plan step.
// Distance steps convert through the distance stream; duration steps are
// cumulative seconds. A window whose end cannot be resolved (plan distance
// beyond the recorded data) is open-ended.
function buildWindows(
  steps: PlanStep[],
  streams: StreamSet,
): PlanWindow[] {
  const windows: PlanWindow[] = [];
  let cumSeconds = 0;
  let cumMeters = 0;
  for (const step of steps) {
    const start = cumSeconds;
    if (step.lengthMeters !== null) {
      cumMeters += step.lengthMeters;
      const end = timeAtDistance(streams.time, streams.distance, cumMeters);
      windows.push({ start, end });
      // Keep the duration cursor in sync so a later duration step starts
      // from the right time: the window end is the step's end in seconds.
      if (end !== null) cumSeconds = end;
    } else if (step.lengthSeconds !== null) {
      cumSeconds += step.lengthSeconds;
      windows.push({ start, end: cumSeconds });
    } else {
      // No length at all (should not happen — the schema requires exactly
      // one of distance/duration). Open-ended so the caller can abort
      // cleanly instead of guessing.
      windows.push({ start, end: null });
    }
  }
  return windows;
}

// First stream index whose time is at or past `seconds` (nulls skipped).
// Returns times.length when the stream ends before then — the exclusive
// end index of the activity.
function indexAtTime(
  times: Array<number | null>,
  seconds: number,
): number {
  for (let i = 0; i < times.length; i++) {
    const t = times[i];
    if (t !== null && t >= seconds) return i;
  }
  return times.length;
}

// Mean watts over the half-open index range [startIdx, endIdx); null when
// there are no usable samples.
function windowAverageWatts(
  watts: Array<number | null>,
  startIdx: number,
  endIdx: number,
): number | null {
  let sum = 0;
  let n = 0;
  for (let i = startIdx; i < endIdx && i < watts.length; i++) {
    const w = watts[i];
    if (w !== null) {
      sum += w;
      n += 1;
    }
  }
  return n > 0 ? sum / n : null;
}

// Lower bound of a target zone as a fraction of CP, from the sport's zone
// table (upper-bound percentages, e.g. [80, 90, 100, 115, 999]). Null
// when the zone cannot be mapped.
function zoneLowerFraction(zone: unknown, zones: number[]): number | null {
  let lowerPct: number | null = null;
  if (typeof zone === "number") {
    const z = Math.max(1, Math.min(Math.floor(zone), zones.length));
    lowerPct = z === 1 ? 0 : zones[z - 2];
  } else if (
    Array.isArray(zone) &&
    zone.length >= 1 &&
    typeof zone[0] === "number"
  ) {
    const z = Math.max(1, Math.min(Math.floor(zone[0]), zones.length));
    lowerPct = z === 1 ? 0 : zones[z - 2];
  } else if (zone === "SS") {
    lowerPct = 88; // sweet spot ≈ 88–94% FTP
  } else {
    return null;
  }
  return Number.isFinite(lowerPct) ? lowerPct / 100 : null;
}

function zoneDisplay(zone: unknown): string {
  if (typeof zone === "number") return `Z${zone}`;
  if (Array.isArray(zone) && zone.length >= 2)
    return `Z${zone[0]}–${zone[1]}`;
  if (zone === "SS") return "sweet spot";
  return "target zone";
}

// A work window's average power must clear 80% of its target zone's
// lower bound; below that the step was not executed as planned.
const ZONE_FLOOR_FACTOR = 0.8;

// Extra time past the plan is work when its average power clears 80% CP.
const Z1_Z2_BOUNDARY_CP = 0.8;

// ---------------------------------------------------------------------------
// Derivation
// ---------------------------------------------------------------------------

export function deriveLabelSpec(input: DeriveInput): LabelDerivation {
  const { steps: expanded, eventName, streams, movingTime, cp, zones, targetMetric } = input;
  const steps = derivePlanSteps(expanded);
  if (steps.length === 0) {
    return {
      status: "aborted",
      reason: "alignment_mismatch",
      detail: { plan_steps: 0, message: "The stored workout has no steps." },
    };
  }

  const { time, distance, watts } = streams;
  const needsDistance = steps.some((s) => s.lengthMeters !== null);

  // Coverage gate (replaces the old 1 Hz density rule): the streams must
  // cover the activity at a sampling fine enough to locate the plan
  // windows, and must reach the activity's end. 3 s-sampled streams pass;
  // genuinely sparse or truncated streams do not.
  if (time.length === 0 || (needsDistance && distance.length === 0)) {
    return {
      status: "aborted",
      reason: "sparse_streams",
      detail: {
        time_samples: time.length,
        distance_samples: distance.length,
        moving_time: movingTime ?? null,
        message: "The activity has no usable time/distance streams.",
      },
    };
  }
  if (movingTime !== null && movingTime !== undefined && movingTime > 0) {
    // Average spacing no coarser than ~10 s, with an absolute floor so
    // short activities are not held to an impossible standard.
    const minSamples = Math.max(60, Math.ceil(movingTime / 10));
    if (time.length < minSamples) {
      return {
        status: "aborted",
        reason: "sparse_streams",
        detail: {
          time_samples: time.length,
          min_samples: minSamples,
          moving_time: movingTime,
          message: "Too few time samples for the moving time — sparse streams.",
        },
      };
    }
    let lastTime: number | null = null;
    for (let i = time.length - 1; i >= 0; i--) {
      if (time[i] !== null) {
        lastTime = time[i];
        break;
      }
    }
    if (lastTime === null || lastTime < movingTime - 10) {
      return {
        status: "aborted",
        reason: "sparse_streams",
        detail: {
          time_samples: time.length,
          last_time_sample: lastTime,
          moving_time: movingTime,
          message: "The time stream does not cover the activity — truncated streams.",
        },
      };
    }
  }
  if (needsDistance && distance.length < 60) {
    return {
      status: "aborted",
      reason: "sparse_streams",
      detail: {
        time_samples: time.length,
        distance_samples: distance.length,
        moving_time: movingTime ?? null,
        message: "Too few distance samples — sparse streams.",
      },
    };
  }
  if (needsDistance && !distance.some((d) => d !== null)) {
    return {
      status: "aborted",
      reason: "sparse_streams",
      detail: {
        time_samples: time.length,
        distance_samples: distance.length,
        moving_time: movingTime ?? null,
        message: "The distance stream has no usable samples.",
      },
    };
  }

  // Exclusive end index of the activity in stream-index units: the full
  // stream length. The spec must cover the whole stream — the bulk write
  // merges, it does not replace, so any tail the spec leaves uncovered
  // survives as a fragment and the first type flip's re-analysis absorbs
  // it into the last spec entry, shifting its boundary and collapsing
  // the set (Nov 9 As Is / Nov 13 ride, #182).
  const activityEndIndex = time.length;
  // The real activity end for classification: the first index at or past
  // the moving time. Time past the plan is only "extra" up to here — the
  // sample or two past it is the stream's trailing edge, not extra work,
  // so it folds into the last entry instead of becoming a phantom Extra.
  const planEndIndex =
    movingTime !== null && movingTime !== undefined
      ? indexAtTime(time, movingTime)
      : time.length;
  const windows = buildWindows(steps, streams);

  // All-easy plans: one interval for the whole activity, labeled with the
  // session label (mirrors the critique script). The plan has no internal
  // structure worth splitting, and Intervals would merge adjacent
  // same-type blocks anyway.
  if (steps.every((s) => s.easy)) {
    return {
      status: "ok",
      spec: [
        {
          start_index: 0,
          end_index: activityEndIndex,
          type: "RECOVERY",
          label: sessionLabel(eventName),
        },
      ],
      planSteps: steps.length,
      extraCount: 0,
      warnings: [],
    };
  }

  // Truncate at the first window whose end cannot be resolved (the
  // recorded data ends before the plan does). The first step failing
  // means the activity never reached the plan at all — abort.
  const firstUnresolved = windows.findIndex((w) => w.end === null);
  if (firstUnresolved === 0) {
    return {
      status: "aborted",
      reason: "alignment_mismatch",
      detail: {
        message: "The recorded data never reaches the first plan step.",
        plan_steps: steps.length,
      },
    };
  }
  const warnings: string[] = [];
  const included = firstUnresolved === -1 ? steps.length : firstUnresolved + 1;
  if (firstUnresolved !== -1) {
    const remaining = steps.length - included;
    if (firstUnresolved === steps.length - 1) {
      warnings.push(
        `Recorded data ends during "${steps[firstUnresolved].label}" — the final step runs to the end of the activity.`,
      );
    } else {
      warnings.push(
        `Recorded data ends during "${steps[firstUnresolved].label}" — ${remaining} later step${remaining === 1 ? "" : "s"} ${remaining === 1 ? "was" : "were"} not reached.`,
      );
    }
  }

  // One spec entry per included plan step, from the windows. Entries are
  // kept contiguous: each starts where the previous one ended, so a step
  // extended by one sample (below) shifts the next step's start rather
  // than overlapping it.
  interface RawEntry {
    start_index: number;
    end_index: number;
    type: "WORK" | "RECOVERY";
    label: string;
    extra?: true;
    stepIndex: number;
  }
  const raw: RawEntry[] = [];
  let cursor = 0;
  for (let i = 0; i < included; i++) {
    const w = windows[i];
    const startIdx = Math.max(indexAtTime(time, w.start), cursor);
    let endIdx =
      w.end === null ? activityEndIndex : indexAtTime(time, w.end);
    if (endIdx <= startIdx) {
      // Shorter than the stream sampling (or past the end of the data).
      endIdx = Math.min(startIdx + 1, activityEndIndex);
      if (endIdx <= startIdx) continue; // degenerate tail — drop it
      warnings.push(
        `Step "${steps[i].label}" is shorter than the stream sampling — interval extended by one sample.`,
      );
    }
    raw.push({
      start_index: startIdx,
      end_index: endIdx,
      type: steps[i].type === "work" ? "WORK" : "RECOVERY",
      label: steps[i].label,
      stepIndex: i,
    });
    cursor = endIdx;
  }
  if (raw.length === 0) {
    return {
      status: "aborted",
      reason: "alignment_mismatch",
      detail: {
        message: "No plan step could be resolved to stream indices.",
        plan_steps: steps.length,
      },
    };
  }

  // Zone sanity check (warning only): each work window's average power
  // against its target zone floor. A stale CP must never block labeling,
  // so a mismatch warns instead of aborting.
  const hasWork = raw.some((e) => e.type === "WORK");
  if (targetMetric === "power" && hasWork) {
    const canCheck =
      typeof cp === "number" &&
      cp > 0 &&
      Array.isArray(zones) &&
      zones.length > 0 &&
      watts.some((w) => w !== null);
    if (!canCheck) {
      warnings.push(
        "No power data or power zones — work windows were not checked against their target zones.",
      );
    } else {
      for (const e of raw) {
        if (e.type !== "WORK") continue;
        const zone = steps[e.stepIndex].zone;
        const floor = zoneLowerFraction(zone, zones as number[]);
        if (floor === null) continue;
        const floorWatts = ZONE_FLOOR_FACTOR * floor * (cp as number);
        const avg = windowAverageWatts(watts, e.start_index, e.end_index);
        if (avg === null) continue;
        if (avg < floorWatts) {
          warnings.push(
            `Step "${e.label}" averaged ${Math.round(avg)}W, below the ${zoneDisplay(zone)} floor of ${Math.round(floorWatts)}W — it may not have been executed as planned.`,
          );
        }
      }
    }
  }

  // Extra time past the plan (the last included window ends before the
  // activity does), classified from executed power. No extra when the plan
  // was truncated — the last entry already extends to the activity end.
  // The extra region runs only to the moving time; the trailing sample
  // or two past it folds into the last entry below.
  let extraCount = 0;
  const lastEnd = raw[raw.length - 1].end_index;
  if (firstUnresolved === -1 && lastEnd < planEndIndex) {
    if (cp === null || cp === undefined || cp <= 0) {
      return {
        status: "aborted",
        reason: "no_power_zones",
        detail: {
          message:
            "Time exists beyond the plan but the athlete's CP could not be resolved.",
          extra_seconds: planEndIndex - lastEnd,
        },
      };
    }
    const avg = windowAverageWatts(watts, lastEnd, planEndIndex);
    if (avg === null) {
      raw.push({
        start_index: lastEnd,
        end_index: planEndIndex,
        type: "RECOVERY",
        label: "Extra Recovery 1",
        extra: true,
        stepIndex: -1,
      });
      warnings.push(
        "No power data for the time past the plan — it was labeled Extra Recovery.",
      );
    } else if (avg >= Z1_Z2_BOUNDARY_CP * cp) {
      raw.push({
        start_index: lastEnd,
        end_index: planEndIndex,
        type: "WORK",
        label: "Extra Work 1",
        extra: true,
        stepIndex: -1,
      });
    } else {
      raw.push({
        start_index: lastEnd,
        end_index: planEndIndex,
        type: "RECOVERY",
        label: "Extra Recovery 1",
        extra: true,
        stepIndex: -1,
      });
    }
    extraCount = 1;
  }

  // The last entry extends to the full stream length so the spec covers
  // every sample (see activityEndIndex above). In the truncated case it
  // already does; here the plan's last entry / the extra absorbs the
  // trailing sample or two past the moving time.
  raw[raw.length - 1].end_index = activityEndIndex;

  // Merge adjacent same-type entries: Intervals merges adjacent
  // same-type blocks on write, so the spec must match what the server
  // will store. The merged label is the last plan step's label — an extra
  // absorbed into a plan step keeps the plan step's label.
  const spec: LabelSpecEntry[] = [];
  for (const e of raw) {
    const prev = spec[spec.length - 1];
    if (prev && prev.type === e.type && prev.end_index === e.start_index) {
      const prevLabel = prev.label;
      const mergedLabel = e.extra ? prevLabel : e.label;
      prev.end_index = e.end_index;
      prev.label = mergedLabel;
      delete prev.extra;
      warnings.push(
        `Steps "${prevLabel}" and "${e.label}" merged into one interval labeled "${mergedLabel}" (same type — Intervals merges adjacent same-type blocks).`,
      );
    } else {
      spec.push({
        start_index: e.start_index,
        end_index: e.end_index,
        type: e.type,
        label: e.label,
        ...(e.extra ? { extra: true as const } : {}),
      });
    }
  }

  return {
    status: "ok",
    spec,
    planSteps: steps.length,
    extraCount,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Verification / idempotency
// ---------------------------------------------------------------------------

export interface SpecVerification {
  matched: boolean;
  mismatches: Array<{
    start_index: number;
    end_index: number;
    expected: { type: string; label: string };
    actual: { type: string | null; label: string | null } | null;
  }>;
}

// Compare a fetched interval list against a spec, by position. Used both
// for the idempotency check (skip when the spec already holds) and for
// post-write verification.
export function verifySpec(
  current: DetectedInterval[],
  spec: LabelSpecEntry[],
): SpecVerification {
  const mismatches: SpecVerification["mismatches"] = [];
  for (const entry of spec) {
    const found = current.find(
      (iv) =>
        num(iv.start_index) === entry.start_index &&
        num(iv.end_index) === entry.end_index,
    );
    if (!found) {
      mismatches.push({
        start_index: entry.start_index,
        end_index: entry.end_index,
        expected: { type: entry.type, label: entry.label },
        actual: null,
      });
      continue;
    }
    const actualType = str(found.type);
    const actualLabel = str(found.label);
    if (actualType !== entry.type || actualLabel !== entry.label) {
      mismatches.push({
        start_index: entry.start_index,
        end_index: entry.end_index,
        expected: { type: entry.type, label: entry.label },
        actual: { type: actualType, label: actualLabel },
      });
    }
  }
  return { matched: mismatches.length === 0, mismatches };
}

// True when the spec already holds on the current intervals — the tool
// then skips the write (no-op).
export function isAlreadyLabeled(
  current: DetectedInterval[],
  spec: LabelSpecEntry[],
): boolean {
  return verifySpec(current, spec).matched;
}
