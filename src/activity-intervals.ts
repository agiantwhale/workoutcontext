// Activity-interval write sequencing (issue #163 constraints).
//
// Pure logic, no I/O: the two update tools in intervals.ts call into here
// before and between PUTs. Same `[CODE] summary / detail / hint` shape as
// workoutError (issue #164), with interval-specific codes so the workout
// helper stays untouched.
//
// Why sequencing lives here instead of rejection: the server's rules make a
// single combined write wrong in two ways — a bulk write ignores `type`
// (everything stores WORK, so RECOVERY must be set one interval at a time
// afterward), and a combined type+label write drops the label under a new
// id. So the tools split the work themselves:
//   - single interval: type first, re-fetch, then label (two PUTs);
//   - bulk: other fields in one bulk call, then each type one at a time,
//     then labels last, one interval at a time — a bulk label PUT resets
//     types to WORK, undoing the flips (verified live on staging, Nov 8,
//     2026). Flips that would change nothing are skipped — a no-op type
//     PUT can still trigger a full server re-analysis that collapses the
//     set (a bulk three-phase run collapsed 3 -> 2 on a no-op WORK flip).
// Every write reassigns interval ids, so position (start_index/end_index)
// is the stable key and `id` is only ever a per-step address, freshly
// fetched. The one field that is still rejected outright is `name`: the
// naming field is `label` (the server rejects `name` with 422 on full-stream
// activities and silently drops it on sparse ones).

export type IntervalErrorCode =
  | "INTERVAL_USE_LABEL"
  | "INTERVAL_NEEDS_POSITION"
  | "INTERVAL_SET_COLLAPSED"
  | "INTERVAL_NOT_FOUND_AFTER_WRITE";

export function intervalError(
  code: IntervalErrorCode,
  summary: string,
  detail: Record<string, unknown>,
  hint: string,
): Error {
  return new Error(
    `[${code}] ${summary}\ndetail: ${JSON.stringify(detail)}\nhint: ${hint}`,
  );
}

export type IntervalRecord = Record<string, unknown>;

function isInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

// The naming field is `label`, not `name`. Reject `name` on every item
// before any PUT, so a bulk call fails as a whole and nothing is written.
// `type` is NOT rejected here: it is sequenced by the planners below.
export function validateActivityIntervalWrites(
  items: Array<Record<string, unknown>>,
): void {
  items.forEach((item, index) => {
    if (item.name !== undefined) {
      throw intervalError(
        "INTERVAL_USE_LABEL",
        "Use 'label', not 'name', to name an interval.",
        { index, name: item.name },
        "Rename the 'name' field to 'label'.",
      );
    }
  });
}

// Single-interval write plan: the ordered bodies to PUT. A body carrying
// both `type` and `label` splits into two PUTs — type first, then label —
// because a combined write drops the label under a new id. Anything else
// (type-only, label-only, boundaries-only) is a single PUT as given.
export function planSingleWrite(
  body: Record<string, unknown>,
): Array<Record<string, unknown>> {
  if (body.type !== undefined && body.label !== undefined) {
    return [{ type: body.type }, { label: body.label }];
  }
  return [body];
}

export interface BulkWritePlan {
  hasType: boolean;
  // Items minus `type` and `label`: the one bulk call for the other fields.
  structure: Array<Record<string, unknown>>;
  // Type flips, in order, one single-interval PUT each.
  flips: Array<{ start_index: number; end_index: number; type: string }>;
  // Labels, written last one interval at a time (a bulk label PUT would
  // reset types to WORK, undoing the flips; labels are wiped by type flips).
  labels: Array<{ start_index: number; end_index: number; label: string }>;
}

// Bulk write plan. When no item carries `type`, the caller does a single
// bulk PUT with the items as given (hasType false; structure/flips/labels
// unused). When any item carries `type`, the write splits into three
// phases: structure in one bulk call, each type flip one at a time, labels
// last. Flips and labels are located by position after each write reassigns
// ids, so an item carrying `type` or `label` must include numeric
// start_index/end_index — otherwise the plan throws before any PUT.
export function planBulkWrite(
  items: Array<Record<string, unknown>>,
): BulkWritePlan {
  const hasType = items.some((item) => item.type !== undefined);
  const structure: Array<Record<string, unknown>> = [];
  const flips: BulkWritePlan["flips"] = [];
  const labels: BulkWritePlan["labels"] = [];
  items.forEach((item, index) => {
    const { type, label, ...rest } = item;
    structure.push(rest);
    if (hasType) {
      const needsPosition = type !== undefined || label !== undefined;
      if (needsPosition && (!isInt(item.start_index) || !isInt(item.end_index))) {
        throw intervalError(
          "INTERVAL_NEEDS_POSITION",
          "An item carrying 'type' or 'label' must include numeric start_index and end_index.",
          { index, field: type !== undefined ? "type" : "label" },
          "Include start_index and end_index on the item so the write can be located by position after the bulk call reassigns ids.",
        );
      }
      if (type !== undefined) {
        flips.push({
          start_index: item.start_index as number,
          end_index: item.end_index as number,
          type: String(type),
        });
      }
      if (label !== undefined) {
        labels.push({
          start_index: item.start_index as number,
          end_index: item.end_index as number,
          label: String(label),
        });
      }
    }
  });
  return { hasType, structure, flips, labels };
}

// A type flip is a no-op when the interval already has the requested type.
// The bulk tool skips these: a PUT that changes nothing can still trigger
// a full server re-analysis that collapses the set. A missing `type` on the
// fetched record is NOT a no-op — the flip proceeds, so an interval the
// server reports without a type is never silently left alone.
export function isNoOpFlip(target: IntervalRecord, type: string): boolean {
  return target.type === type;
}

// Unwrap a GET /activity/{id}/intervals response into the interval list.
// The endpoint returns an object `{id, analyzed, icu_intervals: [...],
// icu_groups}`, not a bare array (verified live on staging, Nov 8, 2026).
// A bare array is still accepted defensively. Anything else is an error.
export function extractIntervalsList(data: unknown): Array<IntervalRecord> {
  if (Array.isArray(data)) {
    return data as Array<IntervalRecord>;
  }
  if (
    typeof data === "object" &&
    data !== null &&
    Array.isArray((data as Record<string, unknown>).icu_intervals)
  ) {
    return (data as Record<string, unknown>).icu_intervals as Array<IntervalRecord>;
  }
  throw new Error(
    "intervals_get_activity_intervals returned an unexpected shape (expected an array or an object with icu_intervals)",
  );
}

// Find a fetched interval by position (the stable key across writes that
// reassign ids). Returns undefined when nothing matches.
export function findIntervalByPosition(
  intervals: Array<IntervalRecord>,
  start_index: number,
  end_index: number,
): IntervalRecord | undefined {
  return intervals.find(
    (interval) =>
      interval.start_index === start_index && interval.end_index === end_index,
  );
}

// Resolve the position key for a single-interval write: prefer the body's
// own start_index/end_index when present, otherwise look the interval up by
// id in a freshly fetched list. Throws when the interval cannot be found.
export function resolveIntervalPosition(
  body: Record<string, unknown>,
  intervalId: number,
  intervals: Array<IntervalRecord>,
): { start_index: number; end_index: number } {
  if (isInt(body.start_index) && isInt(body.end_index)) {
    return { start_index: body.start_index, end_index: body.end_index };
  }
  const found = intervals.find((interval) => interval.id === intervalId);
  if (!found || !isInt(found.start_index) || !isInt(found.end_index)) {
    throw intervalError(
      "INTERVAL_NOT_FOUND_AFTER_WRITE",
      "Could not find the interval to write.",
      { intervalId },
      "Re-fetch the activity intervals and retry against the current id.",
    );
  }
  return {
    start_index: found.start_index as number,
    end_index: found.end_index as number,
  };
}
