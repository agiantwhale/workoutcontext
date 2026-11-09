// Unit tests for activity-interval write validation and sequencing
// (issue #163 constraints). Run with: npm test (node --test, type stripping)
import test from "node:test";
import assert from "node:assert/strict";
import {
  findIntervalByPosition,
  intervalError,
  planBulkWrite,
  planSingleWrite,
  resolveIntervalPosition,
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

test("validateActivityIntervalWrites accepts 'type' items (sequenced, not rejected)", () => {
  assert.doesNotThrow(() =>
    validateActivityIntervalWrites([
      { start_index: 0, end_index: 100, label: "Warmup", type: "WORK" },
      { start_index: 100, end_index: 200, label: "Rest 1", type: "RECOVERY" },
    ]),
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

test("validateActivityIntervalWrites rejects 'name' even when 'type' is present", () => {
  assert.throws(
    () =>
      validateActivityIntervalWrites([
        { start_index: 0, end_index: 100, label: "x", type: "WORK", name: "x" },
      ]),
    /\[INTERVAL_USE_LABEL\]/,
  );
});

test("planSingleWrite splits type+label into two steps, type first", () => {
  assert.deepEqual(planSingleWrite({ type: "RECOVERY", label: "Rest 1" }), [
    { type: "RECOVERY" },
    { label: "Rest 1" },
  ]);
});

test("planSingleWrite keeps type-only, label-only and boundary-only as one step", () => {
  assert.deepEqual(planSingleWrite({ type: "RECOVERY" }), [{ type: "RECOVERY" }]);
  assert.deepEqual(planSingleWrite({ label: "Rep 1" }), [{ label: "Rep 1" }]);
  const body = { start_index: 0, end_index: 100 };
  assert.deepEqual(planSingleWrite(body), [body]);
});

test("planBulkWrite without type is a single bulk call (hasType false)", () => {
  const items = [
    { id: 1, start_index: 0, end_index: 100, label: "Warmup" },
    { id: 2, start_index: 100, end_index: 200, label: "Rep 1" },
  ];
  const plan = planBulkWrite(items);
  assert.equal(plan.hasType, false);
  assert.deepEqual(plan.flips, []);
  assert.deepEqual(plan.labels, []);
});

test("planBulkWrite with type splits into structure, flips, labels last", () => {
  const plan = planBulkWrite([
    { id: 1, start_index: 0, end_index: 100, label: "Warmup", type: "WORK" },
    { id: 2, start_index: 100, end_index: 200, label: "Rest 1", type: "RECOVERY" },
    { id: 3, start_index: 200, end_index: 300, label: "Rep 1", type: "WORK" },
  ]);
  assert.equal(plan.hasType, true);
  // Structure: no type, no label.
  assert.deepEqual(plan.structure, [
    { id: 1, start_index: 0, end_index: 100 },
    { id: 2, start_index: 100, end_index: 200 },
    { id: 3, start_index: 200, end_index: 300 },
  ]);
  // Flips: one per typed item, in order.
  assert.deepEqual(plan.flips, [
    { start_index: 0, end_index: 100, type: "WORK" },
    { start_index: 100, end_index: 200, type: "RECOVERY" },
    { start_index: 200, end_index: 300, type: "WORK" },
  ]);
  // Labels: last, keyed by position.
  assert.deepEqual(plan.labels, [
    { start_index: 0, end_index: 100, label: "Warmup" },
    { start_index: 100, end_index: 200, label: "Rest 1" },
    { start_index: 200, end_index: 300, label: "Rep 1" },
  ]);
});

test("planBulkWrite throws when a typed item lacks start/end", () => {
  assert.throws(
    () =>
      planBulkWrite([
        { id: 1, start_index: 0, end_index: 100, label: "Warmup" },
        { id: 2, type: "RECOVERY", label: "Rest 1" },
      ]),
    (e: unknown) => {
      assert.ok(e instanceof Error);
      assert.match(e.message, /^\[INTERVAL_NEEDS_POSITION\]/);
      assert.match(e.message, /"index":1/);
      assert.match(e.message, /"field":"type"/);
      return true;
    },
  );
});

test("planBulkWrite throws when a labeled item lacks start/end and a type is present", () => {
  assert.throws(
    () =>
      planBulkWrite([
        { id: 1, start_index: 0, end_index: 100, type: "WORK" },
        { id: 2, label: "Rest 1" },
      ]),
    /\[INTERVAL_NEEDS_POSITION\]/,
  );
});

test("findIntervalByPosition matches on start/end and returns undefined otherwise", () => {
  const intervals = [
    { id: 11, start_index: 0, end_index: 100 },
    { id: 22, start_index: 100, end_index: 200 },
  ];
  assert.deepEqual(findIntervalByPosition(intervals, 100, 200), intervals[1]);
  assert.equal(findIntervalByPosition(intervals, 0, 200), undefined);
});

test("resolveIntervalPosition prefers the body's own start/end", () => {
  const intervals = [{ id: 5, start_index: 0, end_index: 100 }];
  assert.deepEqual(
    resolveIntervalPosition({ start_index: 50, end_index: 150 }, 5, intervals),
    { start_index: 50, end_index: 150 },
  );
});

test("resolveIntervalPosition falls back to the fetched list by intervalId", () => {
  const intervals = [
    { id: 5, start_index: 0, end_index: 100 },
    { id: 9, start_index: 100, end_index: 200 },
  ];
  assert.deepEqual(resolveIntervalPosition({}, 9, intervals), {
    start_index: 100,
    end_index: 200,
  });
});

test("resolveIntervalPosition throws when the interval is not in the list", () => {
  assert.throws(
    () => resolveIntervalPosition({}, 42, [{ id: 5, start_index: 0, end_index: 100 }]),
    /\[INTERVAL_NOT_FOUND_AFTER_WRITE\]/,
  );
});
