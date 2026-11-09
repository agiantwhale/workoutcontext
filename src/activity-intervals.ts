// Activity-interval write validation (label-only edits).
//
// Pure logic, no I/O: the two update tools in intervals.ts call
// validateActivityIntervalWrites before any PUT, so a bad field fails loudly
// with a specific code instead of being silently ignored or dropped by
// Intervals.icu. Same `[CODE] summary / detail / hint` shape as workoutError
// (issue #164), with interval-specific codes so the workout helper stays
// untouched.

export type IntervalErrorCode =
  | "INTERVAL_TYPE_NOT_WRITABLE"
  | "INTERVAL_USE_LABEL";

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

// Activity-interval writes are label-only. `type` is assigned solely by
// Intervals' auto-analysis: every write stores WORK, and a `type` write on
// the single-interval endpoint can trigger server-side re-analysis that
// collapses the whole interval set. The naming field is `label`, not `name`
// (the server rejects `name` with 422 on full-stream activities and silently
// drops it on sparse ones). Reject both before any PUT. Validates every item
// first, so a bulk call fails as a whole and nothing is written.
export function validateActivityIntervalWrites(
  items: Array<Record<string, unknown>>,
): void {
  items.forEach((item, index) => {
    if (item.type !== undefined) {
      throw intervalError(
        "INTERVAL_TYPE_NOT_WRITABLE",
        "Interval 'type' cannot be written — it is assigned only by Intervals' auto-analysis.",
        { index, type: item.type },
        "Drop 'type' and send a label-only edit.",
      );
    }
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
