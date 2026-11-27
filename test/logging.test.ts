// Unit tests for the bound structured logger.
// Run with: npm test (node --test, type stripping)
import test from "node:test";
import assert from "node:assert/strict";
import { createLogger, flattenStack, toolCallErrorNote, verifyRefetchNote, UNKNOWN_USER_ID } from "../src/logging.ts";

function capture(fn: () => void): string[] {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    fn();
  } finally {
    console.log = orig;
  }
  return lines;
}

test("logger prefixes every line with userId", () => {
  const log = createLogger("user-123");
  assert.deepEqual(
    capture(() => log.info("tools/call", { name: "check_server_version", ms: 3, status: "ok" })),
    ["[tools/call] userId=user-123 name=check_server_version ms=3 status=ok"],
  );
});

test("logger skips null and undefined fields, appends a note", () => {
  const log = createLogger("user-123");
  assert.deepEqual(
    capture(() =>
      log.info(
        "intervals/webhook",
        { type: "ACTIVITY_UPLOADED", athleteId: "i596923", reason: null, eventId: undefined },
        "already labeled (tag present), skipping",
      ),
    ),
    [
      "[intervals/webhook] userId=user-123 type=ACTIVITY_UPLOADED athleteId=i596923 already labeled (tag present), skipping",
    ],
  );
});

test("logger with no fields emits prefix and userId only", () => {
  const log = createLogger("user-123");
  assert.deepEqual(capture(() => log.info("events/create")), [
    "[events/create] userId=user-123",
  ]);
});

test("UNKNOWN_USER_ID is the unmapped placeholder", () => {
  assert.equal(UNKNOWN_USER_ID, "<unmapped>");
  const log = createLogger(UNKNOWN_USER_ID);
  assert.deepEqual(capture(() => log.info("intervals/webhook", { type: "ACTIVITY_UPLOADED" })), [
    "[intervals/webhook] userId=<unmapped> type=ACTIVITY_UPLOADED",
  ]);
});

test("toolCallErrorNote keeps the full error message (no 200-char cut)", () => {
  const long = `[WORKOUT_VERIFY_MISMATCH] Created/updated event 157686027 does not match the workout JSON (2 failed checks). detail: {"event_id":157686027,"expected":{"steps":9,"duration_seconds":3780,"distance_meters":0},"actual":{"steps":9,"duration_seconds":3780,"distance_meters":0},"failed_checks":["a".repeat(50),"b".repeat(50)]}`;
  assert.ok(long.length > 200);
  const note = toolCallErrorNote(new Error(long), { eventId: "1" });
  assert.ok(note.includes(long), "full message must survive intact");
  assert.ok(note.startsWith("error="));
});

test("toolCallErrorNote appends the call arguments as JSON", () => {
  const note = toolCallErrorNote(new Error("[WORKOUT_VALIDATION] nope"), {
    eventId: "157686027",
    workout: { version: 1, sport: "Run" },
    moving_time: 3780,
  });
  assert.ok(note.includes('args={"eventId":"157686027","workout":{"version":1,"sport":"Run"},"moving_time":3780}'));
});

test("toolCallErrorNote flattens newlines in the message and handles missing args", () => {
  const note = toolCallErrorNote(new Error("line one\nline two"), undefined);
  assert.ok(note.startsWith("error=line one line two args=null stack="));
  assert.ok(!note.includes("\n"), "log lines stay single-line");
});

test("toolCallErrorNote carries a flattened stack (Nov 25, 2026)", () => {
  const err = new Error("[WORKOUT_VALIDATION] nope");
  err.stack = "Error: nope\n    at foo (/a/b.ts:1:1)\n    at bar (/a/b.ts:2:2)";
  const note = toolCallErrorNote(err, { eventId: "1" });
  assert.ok(note.includes("stack=Error: nope at foo (/a/b.ts:1:1) at bar (/a/b.ts:2:2)"));
  assert.ok(!note.includes("\n"), "log lines stay single-line");
});

test("toolCallErrorNote handles a non-Error with an empty stack", () => {
  const note = toolCallErrorNote("boom", undefined);
  assert.ok(note.startsWith("error=boom args=null stack="));
});

test("flattenStack returns an empty string for non-Errors and flattens newlines", () => {
  assert.equal(flattenStack("boom"), "");
  assert.equal(flattenStack(undefined), "");
  const err = new Error("x");
  err.stack = "Error: x\n    at foo (/a/b.ts:1:1)";
  assert.equal(flattenStack(err), "Error: x at foo (/a/b.ts:1:1)");
});

test("toolCallErrorNote falls back on unserializable args", () => {
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  const note = toolCallErrorNote(new Error("boom"), circular);
  assert.ok(note.includes('args="<unserializable>"'));
});

test("verifyRefetchNote carries the error, the full input, and a flattened stack", () => {
  const err = new Error("[WORKOUT_VERIFY_MISMATCH] x\ndetail: {}");
  err.stack = "Error: x\n    at foo (/a/b.ts:1:1)\n    at bar (/a/b.ts:2:2)";
  const note = verifyRefetchNote(err, { name: "Test", workout: { version: 1 } });
  assert.ok(note.startsWith("error=[WORKOUT_VERIFY_MISMATCH] x detail: {}"));
  assert.ok(note.includes('args={"name":"Test","workout":{"version":1}}'));
  assert.ok(note.includes("stack=Error: x at foo (/a/b.ts:1:1) at bar (/a/b.ts:2:2)"));
  assert.ok(!note.includes("\n"), "log lines stay single-line");
});

test("verifyRefetchNote handles a non-Error and unserializable args", () => {
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  const note = verifyRefetchNote("boom", circular);
  assert.ok(note.startsWith("error=boom"));
  assert.ok(note.includes('args="<unserializable>"'));
  assert.ok(note.includes("stack="));
});
