// Unit tests for the bound structured logger.
// Run with: npm test (node --test, type stripping)
import test from "node:test";
import assert from "node:assert/strict";
import { createLogger, UNKNOWN_USER_ID } from "../src/logging.ts";

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
