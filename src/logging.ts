// Bound structured logger: every line it emits carries the WorkoutContext
// user id, so per-user log queries never need a second hop to attribute a
// line. Structured log lines go through this and never through a bare
// console.log — see test/logging-guard.test.ts, which enforces that
// (grandfathering a few pre-existing sites that don't have a user id in
// scope; new sites must use the logger).
//
// Format: `[<prefix>] userId=<uuid> key=value key=value [note]`
// Field values are single tokens (ids, kinds, numbers, short statuses).
// Anything carrying a secret or personal payload — notably the Intervals
// webhook delivery body — must never be passed as a field or note: log
// only its shape (type, athlete id), never the payload.

export interface Logger {
  readonly userId: string;
  info(
    prefix: string,
    fields?: Record<string, string | number | boolean | null | undefined>,
    note?: string,
  ): void;
}

export function createLogger(userId: string): Logger {
  return {
    userId,
    info(prefix, fields, note) {
      const parts = [`[${prefix}]`, `userId=${userId}`];
      for (const [key, value] of Object.entries(fields ?? {})) {
        if (value === undefined || value === null) continue;
        parts.push(`${key}=${String(value)}`);
      }
      if (note !== undefined && note !== "") parts.push(note);
      console.log(parts.join(" "));
    },
  };
}

// For entry points where the user is unknown (e.g. a webhook delivery
// from an athlete id with no mapped user): the line is still emitted,
// with the placeholder, so the gap is visible rather than silently
// unattributed.
export const UNKNOWN_USER_ID = "<unmapped>";
