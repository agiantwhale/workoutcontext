// Unit tests for activity-interval write validation (label-only edits).
// Run with: npm test   (node --test, type stripping — no build step)
import test from "node:test";
import assert from "node:assert/strict";
import {
  intervalError,
  validateActivityIntervalWrites,
} from "../src/activity-intervals.ts";

test("intervalError formats as [CODE] summary, detail JSON, hint", () => {
  const e = intervalError(
    "INTERVAL_USE_LABEL",
    "Use 'label'.",
    { index: 0 },
    "Rename it.",
  );
  assert.match(e.message, /^\[INTERVAL_USE_LABEL\] Use 'label'\./);
  assert.match(e.message, /detail: \{"index":0\}/);
  assert.match(e.message, /hint: Rename it\./);
});

test("validateActivityIntervalWrites accepts label-only items", () => {
  assert.doesNotThrow(() =>
    validateActivityIntervalWrites([
      { start_index: 0, end_index: 100, label: "Warmup" },
      { id: 7, start_index: 100, end_index: 200, label: "Rep 1" },
    ]),
  );
});

test("validateActivityIntervalWrites rejects 'type' with the failing index", () => {
  assert.throws(
    () =>
      validateActivityIntervalWrites([
        { start_index: 0, end_index: 100, label: "Warmup" },
        { start_index: 100, end_index: 200, label: "Rep 1", type: "RECOVERY" },
      ]),
    (e: unknown) => {
      assert.ok(e instanceof Error);
      assert.match(e.message, /^\[INTERVAL_TYPE_NOT_WRITABLE\]/);
      assert.match(e.message, /"index":1/);
      assert.match(e.message, /"type":"RECOVERY"/);
      assert.match(e.message, /hint: Drop 'type'/);
      return true;
    },
  );
});

test("validateActivityIntervalWrites rejects 'name' even when 'label' is present", () => {
  assert.throws(
    () =>
      validateActivityIntervalWrites([
        { start_index: 0, end_index: 100, label: "Warmup", name: "Warmup" },
      ]),
    (e: unknown) => {
      assert.ok(e instanceof Error);
      assert.match(e.message, /^\[INTERVAL_USE_LABEL\]/);
      assert.match(e.message, /hint: Rename the 'name' field to 'label'/);
      return true;
    },
  );
});

test("validateActivityIntervalWrites rejects 'name' without 'label' (previous behavior)", () => {
  assert.throws(
    () =>
      validateActivityIntervalWrites([
        { start_index: 0, end_index: 100, name: "Warmup" },
      ]),
    /\[INTERVAL_USE_LABEL\]/,
  );
});

test("validateActivityIntervalWrites checks 'type' before 'name' on the same item", () => {
  assert.throws(
    () =>
      validateActivityIntervalWrites([
        { start_index: 0, end_index: 100, label: "x", type: "WORK", name: "x" },
      ]),
    /\[INTERVAL_TYPE_NOT_WRITABLE\]/,
  );
});
