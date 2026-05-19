import { z } from "zod";
import { GIT_COMMIT_SHORT } from "./generated/commit.js";

// Date-param schema accepted in either form: an ISO date string
// ('YYYY-MM-DD' or full ISO 8601) OR Unix epoch SECONDS. Resolves to
// epoch seconds for downstream API callers. Use this on any tool input
// that historically demanded raw Unix seconds.
//
// Motivation (debug-trace feedback#2 on workoutcontext-feedback):
// LLMs hand-computing epoch seconds in-context regularly produce
// wrong-year timestamps, silently retrieving year-old data and
// presenting it as current. Accepting ISO dates removes the math
// failure mode entirely while staying backward-compatible with any
// caller that already passes integers.
export const isoOrUnixSeconds = z
  .union([z.number().int(), z.string().min(4)])
  .transform((val, ctx) => {
    if (typeof val === "number") return val;
    const ms = Date.parse(val);
    if (Number.isNaN(ms)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Could not parse "${val}" as ISO date or Unix epoch seconds`,
      });
      return z.NEVER;
    }
    return Math.floor(ms / 1000);
  });

// Standard description text reused across migrated tools. Per-tool
// descriptions can still customize semantics ("inclusive", "exclusive",
// etc.) by composing this base.
export const ISO_OR_UNIX_DESC =
  "ISO date 'YYYY-MM-DD' (e.g. '2026-04-01') or Unix epoch seconds. Prefer ISO — easier to get right than computing epoch math.";

// Compresses MCP tool JSON responses to save tokens.
//
// Rules:
//   1. No pretty-print indent — pure whitespace, no info loss.
//   2. Inside array elements, drop fields whose value is null. The schema
//      repeats N times across N items, so the first item is enough discovery
//      and the rest is noise.
//   3. At the response root (single-object getters), keep nulls. They double
//      as schema documentation: "this field exists but isn't set on this
//      record" tells the model the field is askable.
//
// Net effect: getters preserve discovery; lists/searches compress.
function stripNullsInArrays(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(compactArrayElement);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = stripNullsInArrays(v);
    }
    return out;
  }
  return value;
}

function compactArrayElement(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(compactArrayElement);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === null) continue;
      out[k] = compactArrayElement(v);
    }
    return out;
  }
  return value;
}

export function ok(data: unknown) {
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(stripNullsInArrays(data)) },
    ],
    // Build hash on every tool response so the LLM can compare against the
    // baseline it received in the session's `instructions`. See
    // SERVER_INSTRUCTIONS in src/index.ts — a mismatch signals the worker
    // was redeployed mid-session and the cached tool schemas may be stale.
    // Complements the `notifications/tools/list_changed` mechanism in
    // WorkoutContextMCP.init/onStart for clients that don't act on the
    // notification.
    _meta: { server_build: GIT_COMMIT_SHORT },
  };
}
