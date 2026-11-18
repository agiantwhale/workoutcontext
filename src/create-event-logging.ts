// Pure classification for intervals_create_event usage logging — no
// imports, so it is unit-testable under node --test (see
// test/create-event-logging.test.ts).
//
// The create handler calls this on its legacy fast path (no `workout`
// JSON, no `hevy_routine_id`) after a successful create and logs one
// line per returned event. It only ever *counts* usage: the DSL
// heuristic below is approximate by design — a false positive or
// negative only skews the count, never changes behavior. No arg values
// are ever logged, only the event kind (the tools/call no-args rule
// from PR #192 stays intact).

export type CreateUsageEvent =
  | "old_structured_dsl" // description carries a structured workout as raw DSL
  | "old_workout_doc" // manual steps via the legacy workout_doc param
  | "strength_no_hevy_template"; // WeightTraining event while Hevy is connected, without hevy_routine_id

export function classifyIntervalsCreateCall(input: {
  description?: unknown;
  workout_doc?: unknown;
  workout?: unknown;
  hevy_routine_id?: unknown;
  type?: unknown;
  hevyConnected: boolean;
}): CreateUsageEvent[] {
  const events: CreateUsageEvent[] = [];
  // The new paths never reach the fast path, but stay defensive: a
  // structured-JSON or Hevy-routine create is not an old-path event.
  if (input.workout !== undefined || input.hevy_routine_id !== undefined)
    return events;
  if (input.workout_doc !== undefined) events.push("old_workout_doc");
  if (
    typeof input.description === "string" &&
    looksLikeStructuredDsl(input.description)
  ) {
    events.push("old_structured_dsl");
  }
  if (
    input.hevyConnected &&
    typeof input.type === "string" &&
    input.type.toLowerCase() === "weighttraining"
  ) {
    events.push("strength_no_hevy_template");
  }
  return events;
}

// A description line counts as a structured-workout DSL step when it
// pairs a quantity with a training zone ("4mi Z1", "20min Z2"), is a
// repeat block ("6x (0.1km Z5 / 0.2km Z1)"), or is a repeat with a
// unit ("4x400m", "2x20min"). Strength prose matches none of these:
// "Bench 3x8 @ 70" has no zone and no parenthesised repeat, and "3x8"
// has no unit after the second number.
function looksLikeStructuredDsl(description: string): boolean {
  return description.split("\n").some((line) => {
    const step = line.trim();
    // Quantity + zone, e.g. "Warmup 4mi Z1".
    if (
      /\d+(?:\.\d+)?\s*(?:mi|km|m|min|mins|sec|secs|s)\b[^Z\n]*\bZ[1-7]\b/i.test(
        step,
      )
    )
      return true;
    // Repeat block, e.g. "Strides 6x (0.1km Z5 / 0.2km Z1)".
    if (/\b\d+\s*x\s*\(/.test(step)) return true;
    // Repeat with a unit, e.g. "4x400m", "2x20min".
    if (
      /\b\d+\s*x\s*\d+(?:\.\d+)?\s*(?:mi|km|m|min|mins|sec|secs|s)\b/i.test(
        step,
      )
    )
      return true;
    return false;
  });
}
