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
//
// Exception (Jae's call, Nov 18, 2026, staging debugging): a failed tool
// call's log line DOES carry the call's arguments (see
// toolCallErrorNote below). Arguments can hold personal data, so this
// stays an error-line-only exception — success lines stay argument-free.

// Format the trailing note for a failed tool call: the full error message
// plus the call's arguments, so a failure can be debugged from the log
// alone. Before Nov 18, 2026 the wrapper truncated the message to 200
// chars and never logged arguments, which hid the detail of errors like
// WORKOUT_VERIFY_MISMATCH (whose failed-check list lives in the message's
// detail JSON). The message is flattened to one line; JSON.stringify
// output is already single-line, so the args need no flattening. The
// log-insights parser scans lines for `key=` tokens, and JSON uses colons,
// so the args can only collide with its fields if a string value literally
// contains `name=` / `status=` / `ms=` / `userId=`.
export function toolCallErrorNote(error: unknown, args: unknown): string {
  const msg = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ");
  let argsJson: string;
  try {
    argsJson = JSON.stringify(args ?? null) ?? "null";
  } catch {
    argsJson = '"<unserializable>"';
  }
  return `error=${msg} args=${argsJson}`;
}

// Format the note for a verify-refetch hit: the first verify failed on
// missing data only (the Intervals parse race), so the server waited and
// re-fetched once. Same shape as a tool-call error line — full error
// message, the call's arguments, plus the stack trace — so a hit can be
// debugged from the log alone. Arguments can hold personal data, so like
// toolCallErrorNote this stays a failure-path-only exception (Jae's call,
// Nov 24, 2026): it fires only when the first verify already failed, never
// on the success path. The line goes through the bound logger at info
// level, so it is queryable in stored logs but does not trip the error
// watch (the create ultimately succeeds).
export function verifyRefetchNote(error: unknown, args: unknown): string {
  const err = error instanceof Error ? error : new Error(String(error));
  const msg = err.message.replace(/\s+/g, " ");
  const stack = (err.stack ?? "").replace(/\s+/g, " ");
  let argsJson: string;
  try {
    argsJson = JSON.stringify(args ?? null) ?? "null";
  } catch {
    argsJson = '"<unserializable>"';
  }
  return `error=${msg} args=${argsJson} stack=${stack}`;
}

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
