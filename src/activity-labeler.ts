// Activity-interval auto-labeler (issue #163).
//
// Pure derivation + alignment: a stored structured workout JSON + the
// activity's detected intervals and streams -> a label spec. No I/O; the
// tool handler in intervals.ts does the fetching and the one bulk write.
//
// Design (see the #163 design proposal): labels describe intent, not
// execution — the plan is the authority for (type, label). Alignment is a
// strict count gate after fragment merging; anything ambiguous aborts
// instead of guessing. The one exception is intervals beyond the plan:
// the plan says nothing about them, so they are labeled from their
// executed average zone (Extra Work / Extra Recovery).

// Type-only import (erased at runtime): this module imports no values, so
// it stays unit-testable under node --test type stripping, like
// activity-intervals.ts and hevy-routine-prescription.ts. The caller
// expands the stored workout (expandSteps) and passes the steps in.
import type { ExpandedStep } from "./workout-render.js";

const MI_TO_M = 1609.34;

// A detected interval as returned by GET /activity/{id}/intervals.
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
      maxBoundaryDeviationSec: number;
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
  detected: DetectedInterval[];
  streams: StreamSet;
  // Activity moving_time (seconds), for the sparse-streams gate.
  movingTime?: number | null;
  // Athlete's critical power in watts for the activity's sport; null when
  // unresolvable. Only needed when extra intervals exist.
  cp?: number | null;
}

// ---------------------------------------------------------------------------
// Field readers + glitch rule (mirrors the critique script exactly)
// ---------------------------------------------------------------------------

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

// 0W dropout block, or a sliver too short to be a real interval (e.g. a
// trailing 7s block from the watch stopping). Same rule as the critique
// script's is_glitch.
export function isGlitch(iv: DetectedInterval): boolean {
  const avg = num(iv.average_watts) ?? 0;
  const mt = num(iv.moving_time) ?? 0;
  return (avg < 50 && mt < 120) || mt < 10;
}

// Session label for easy sessions, from the event name — same rule as the
// critique script's session_label.
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
// — the lookup helpers skip them), so all three arrays stay 1 Hz-aligned
// with the interval start_index/end_index positions.
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
  // Easy if it is recovery, or targets zone 1-2 (power/HR zones). Pace
  // targets carry no zone, so a pace-targeted easy step is not recognized
  // here and falls through to window alignment instead.
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

// Time (seconds) at a stream index; falls back to the index itself (1 Hz
// assumption) when the time stream has no value there.
function timeAtIndex(times: Array<number | null>, index: number): number {
  const t = times[index];
  return t !== null && t !== undefined ? t : index;
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
      // one of distance/duration). Open-ended so the count gate fails
      // cleanly instead of guessing.
      windows.push({ start, end: null });
    }
  }
  return windows;
}

// Average watts over a detected interval: the server's average_watts when
// present, otherwise the mean of the watts stream over the interval's
// indices (null samples skipped). Null when neither is available.
function intervalAverageWatts(
  iv: DetectedInterval,
  watts: Array<number | null>,
): number | null {
  const recorded = num(iv.average_watts);
  if (recorded !== null) return recorded;
  const start = num(iv.start_index);
  const end = num(iv.end_index);
  if (start === null || end === null) return null;
  let sum = 0;
  let n = 0;
  for (let i = start; i <= end && i < watts.length; i++) {
    const w = watts[i];
    if (w !== null) {
      sum += w;
      n += 1;
    }
  }
  return n > 0 ? sum / n : null;
}

// ---------------------------------------------------------------------------
// Derivation
// ---------------------------------------------------------------------------

// An interval straddles two plan windows when its span covers an internal
// plan boundary — a window end/start other than the plan's own start/end —
// by more than STRADDLE_TOL_SEC on both sides. Boundaries are never exact
// to the second, so a few seconds of grace is allowed; an interval that
// merely runs past the plan's end does not straddle (it spans one step
// plus extra time, and is handled by the extra rule).
const STRADDLE_TOL_SEC = 5;

const Z1_Z2_BOUNDARY_CP = 0.8;

export function deriveLabelSpec(input: DeriveInput): LabelDerivation {
  const { steps: expanded, eventName, detected, streams, movingTime, cp } = input;
  const steps = derivePlanSteps(expanded);
  if (steps.length === 0) {
    return {
      status: "aborted",
      reason: "alignment_mismatch",
      detail: { plan_steps: 0, message: "The stored workout has no steps." },
    };
  }

  // Sparse-streams gate: without full-rate time/distance streams, writes
  // would be silently dropped (manual activities). Sample count must be
  // roughly the moving time (1 Hz recording).
  const { time, distance } = streams;
  if (time.length === 0 || distance.length === 0) {
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
  if (
    movingTime !== null &&
    movingTime !== undefined &&
    movingTime > 0 &&
    time.length < 0.5 * movingTime
  ) {
    return {
      status: "aborted",
      reason: "sparse_streams",
      detail: {
        time_samples: time.length,
        distance_samples: distance.length,
        moving_time: movingTime,
        message: "Too few time samples for the moving time — sparse streams.",
      },
    };
  }

  const nonGlitch = detected.filter((iv) => !isGlitch(iv));

  // Easy sessions mirror the critique script exactly: one session label
  // across all non-glitch intervals, keeping each interval's current type.
  // No windows, no count gate — a single easy/aerobic step has no internal
  // structure to align to.
  if (steps.every((s) => s.easy)) {
    const label = sessionLabel(eventName);
    const spec: LabelSpecEntry[] = [];
    for (const iv of nonGlitch) {
      const start = num(iv.start_index);
      const end = num(iv.end_index);
      if (start === null || end === null) continue;
      spec.push({
        start_index: start,
        end_index: end,
        type: str(iv.type) === "WORK" ? "WORK" : "RECOVERY",
        label,
      });
    }
    return {
      status: "ok",
      spec,
      planSteps: steps.length,
      extraCount: 0,
      maxBoundaryDeviationSec: 0,
      warnings: [],
    };
  }

  const windows = buildWindows(steps, streams);
  const lastEnd = windows[windows.length - 1].end;

  // Internal plan boundaries (window ends except the last) for the
  // straddle check.
  const internalBoundaries = windows
    .slice(0, -1)
    .map((w) => w.end)
    .filter((e): e is number => e !== null);

  // Assign each non-glitch interval to a plan window (by midpoint), or to
  // the extras when it starts after the plan ends.
  const assigned = new Map<number, DetectedInterval[]>();
  const extras: DetectedInterval[] = [];
  for (const iv of nonGlitch) {
    const startIdx = num(iv.start_index);
    const endIdx = num(iv.end_index);
    if (startIdx === null || endIdx === null) {
      return {
        status: "aborted",
        reason: "alignment_mismatch",
        detail: {
          message: "A detected interval is missing start_index/end_index.",
          interval: iv,
        },
      };
    }
    const startT = timeAtIndex(time, startIdx);
    const endT = timeAtIndex(time, endIdx);
    const midT = timeAtIndex(time, Math.floor((startIdx + endIdx) / 2));

    // Straddle: the interval covers an internal plan boundary.
    for (const b of internalBoundaries) {
      if (startT < b - STRADDLE_TOL_SEC && endT > b + STRADDLE_TOL_SEC) {
        return {
          status: "aborted",
          reason: "alignment_mismatch",
          detail: {
            message: "A detected interval straddles two plan windows.",
            start_index: startIdx,
            end_index: endIdx,
            boundary_sec: b,
          },
        };
      }
    }

    // Extra: starts at or after the plan's end.
    if (lastEnd !== null && startT >= lastEnd) {
      extras.push(iv);
      continue;
    }

    // Midpoint window (last window is inclusive of its end, and open-ended
    // when its end is null). An interval that starts inside the last
    // window and runs past its end belongs to that window.
    let win = -1;
    for (let i = 0; i < windows.length; i++) {
      const w = windows[i];
      const inWindow =
        midT >= w.start &&
        (w.end === null || midT < w.end || (i === windows.length - 1 && midT <= w.end));
      if (inWindow) {
        win = i;
        break;
      }
    }
    if (win === -1) {
      // Midpoint past the plan end but the interval started inside it
      // (last step ran long): it belongs to the last window.
      if (lastEnd !== null && startT < lastEnd) {
        win = windows.length - 1;
      } else {
        extras.push(iv);
        continue;
      }
    }
    const list = assigned.get(win) ?? [];
    list.push(iv);
    assigned.set(win, list);
  }

  // Strict count gate: every plan step must have exactly one merged entry.
  const unmatched = steps.map((_, i) => i).filter((i) => !assigned.has(i));
  if (unmatched.length > 0) {
    return {
      status: "aborted",
      reason: "alignment_mismatch",
      detail: {
        message: "Some plan steps have no detected interval.",
        unmatched_plan_steps: unmatched.map((i) => ({
          index: i,
          section: steps[i].section,
          label: steps[i].label,
        })),
        plan_steps: steps.length,
        detected_non_glitch: nonGlitch.length,
      },
    };
  }

  // Build the spec: one merged entry per plan step (fragments grouped),
  // then the extras classified by average zone.
  const spec: LabelSpecEntry[] = [];
  const warnings: string[] = [];
  let maxDeviation = 0;
  for (let i = 0; i < steps.length; i++) {
    const frags = assigned.get(i) as DetectedInterval[];
    const first = frags[0];
    const last = frags[frags.length - 1];
    const startIdx = num(first.start_index) as number;
    const endIdx = num(last.end_index) as number;
    spec.push({
      start_index: startIdx,
      end_index: endIdx,
      type: steps[i].type === "work" ? "WORK" : "RECOVERY",
      label: steps[i].label,
    });
    // Boundary verification (warning only): the merged entry's start
    // against the window's expected start.
    const w = windows[i];
    const actualStart = timeAtIndex(time, startIdx);
    const deviation = Math.abs(actualStart - w.start);
    maxDeviation = Math.max(maxDeviation, deviation);
    const windowLen =
      w.end !== null ? w.end - w.start : deviation;
    const tolerance = Math.max(60, 0.1 * windowLen);
    if (deviation > tolerance) {
      warnings.push(
        `Step ${i + 1} (${steps[i].label}) starts ${Math.round(deviation)}s from its expected window start (tolerance ${Math.round(tolerance)}s).`,
      );
    }
  }

  if (extras.length > 0) {
    if (cp === null || cp === undefined || cp <= 0) {
      return {
        status: "aborted",
        reason: "no_power_zones",
        detail: {
          message:
            "Extra intervals exist beyond the plan but the athlete's run CP could not be resolved.",
          extra_intervals: extras.length,
        },
      };
    }
    let workN = 0;
    let recoveryN = 0;
    for (const iv of extras) {
      const avg = intervalAverageWatts(iv, streams.watts);
      if (avg === null) {
        return {
          status: "aborted",
          reason: "alignment_mismatch",
          detail: {
            message: "An extra interval has no power data to classify it by.",
            start_index: iv.start_index,
            end_index: iv.end_index,
          },
        };
      }
      const startIdx = num(iv.start_index) as number;
      const endIdx = num(iv.end_index) as number;
      if (avg >= Z1_Z2_BOUNDARY_CP * cp) {
        workN += 1;
        spec.push({
          start_index: startIdx,
          end_index: endIdx,
          type: "WORK",
          label: `Extra Work ${workN}`,
          extra: true,
        });
      } else {
        recoveryN += 1;
        spec.push({
          start_index: startIdx,
          end_index: endIdx,
          type: "RECOVERY",
          label: `Extra Recovery ${recoveryN}`,
          extra: true,
        });
      }
    }
  }

  return {
    status: "ok",
    spec,
    planSteps: steps.length,
    extraCount: extras.length,
    maxBoundaryDeviationSec: Math.round(maxDeviation * 10) / 10,
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
