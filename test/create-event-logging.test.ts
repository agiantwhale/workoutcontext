// Unit tests for the intervals_create_event usage classifier.
// Run with: npm test (node --test, type stripping)
import test from "node:test";
import assert from "node:assert/strict";
import {
  bulkCreateLogEntries,
  classifyIntervalsCreateCall,
} from "../src/create-event-logging.ts";

test("DSL description classifies as old_structured_dsl", () => {
  assert.deepEqual(
    classifyIntervalsCreateCall({
      description: "Warmup 4mi Z1\nStrides 6x (0.1km Z5 / 0.2km Z1)\nCooldown 0.3km Z1",
      hevyConnected: false,
    }),
    ["old_structured_dsl"],
  );
});

test("threshold DSL with repeats classifies as old_structured_dsl", () => {
  assert.deepEqual(
    classifyIntervalsCreateCall({
      description: "Threshold 2x20min Z4",
      hevyConnected: false,
    }),
    ["old_structured_dsl"],
  );
  assert.deepEqual(
    classifyIntervalsCreateCall({
      description: "Track 4x400m @ 5k pace",
      hevyConnected: false,
    }),
    ["old_structured_dsl"],
  );
});

test("workout_doc classifies as old_workout_doc", () => {
  assert.deepEqual(
    classifyIntervalsCreateCall({
      workout_doc: { steps: [] },
      hevyConnected: false,
    }),
    ["old_workout_doc"],
  );
});

test("plain prose descriptions classify as nothing", () => {
  assert.deepEqual(
    classifyIntervalsCreateCall({
      description: "As Is Run Club aerobic 6 in Z2. Steady and conversational, HR under 158.",
      hevyConnected: false,
    }),
    [],
  );
  assert.deepEqual(
    classifyIntervalsCreateCall({ description: "Just a note", hevyConnected: false }),
    [],
  );
  assert.deepEqual(classifyIntervalsCreateCall({ hevyConnected: false }), []);
});

test("strength prose does not false-positive as DSL", () => {
  assert.deepEqual(
    classifyIntervalsCreateCall({
      description: "Bench Press 3x8 @ 70 lb, rest 90s\nLat Pulldown 3x10 @ 85, rest 60s",
      type: "Run",
      hevyConnected: false,
    }),
    [],
  );
});

test("WeightTraining with Hevy connected and no routine classifies as strength_no_hevy_template", () => {
  assert.deepEqual(
    classifyIntervalsCreateCall({
      description: "Bench Press 3x8 @ 70 lb",
      type: "WeightTraining",
      hevyConnected: true,
    }),
    ["strength_no_hevy_template"],
  );
  // Case-insensitive type match.
  assert.deepEqual(
    classifyIntervalsCreateCall({
      type: "weighttraining",
      hevyConnected: true,
    }),
    ["strength_no_hevy_template"],
  );
});

test("strength without Hevy connected, or with a routine, classifies as nothing", () => {
  assert.deepEqual(
    classifyIntervalsCreateCall({
      type: "WeightTraining",
      hevyConnected: false,
    }),
    [],
  );
  assert.deepEqual(
    classifyIntervalsCreateCall({
      type: "WeightTraining",
      hevy_routine_id: "some-routine",
      hevyConnected: true,
    }),
    [],
  );
});

test("new-path creates classify as nothing", () => {
  assert.deepEqual(
    classifyIntervalsCreateCall({ workout: { version: 1 }, hevyConnected: false }),
    [],
  );
  assert.deepEqual(
    classifyIntervalsCreateCall({
      description: "Warmup 4mi Z1",
      workout: { version: 1 },
      hevyConnected: false,
    }),
    [],
  );
});

// --- bulkCreateLogEntries ---

const dslPayload = {
  description: "Warmup 4mi Z1\nCooldown 0.3km Z1",
  type: "Run",
};
const structuredPayload = { type: "Run" };

test("bulk: legacy DSL event logs with its created id matched by external_id", () => {
  assert.deepEqual(
    bulkCreateLogEntries({
      events: [
        { payload: { ...dslPayload, external_id: "plan-2026-11-23-mon" } },
        { payload: structuredPayload, workout: { version: 1 } },
      ],
      created: [
        { id: 111, external_id: "plan-2026-11-23-mon" },
        { id: 222, external_id: "wc-abc" },
      ],
      upsert: false,
      hevyConnected: false,
    }),
    [{ eventId: "111", kind: "old_structured_dsl" }],
  );
});

test("bulk: legacy workout_doc event logs old_workout_doc", () => {
  assert.deepEqual(
    bulkCreateLogEntries({
      events: [{ payload: { workout_doc: { steps: [] }, type: "Run" } }],
      created: [{ id: 333 }],
      upsert: false,
      hevyConnected: false,
    }),
    [{ eventId: "?", kind: "old_workout_doc" }],
  );
});

test("bulk: no external_id falls back to '?'", () => {
  assert.deepEqual(
    bulkCreateLogEntries({
      events: [{ payload: dslPayload }],
      created: [{ id: 444 }],
      upsert: false,
      hevyConnected: false,
    }),
    [{ eventId: "?", kind: "old_structured_dsl" }],
  );
});

test("bulk: structured events, Hevy-routine events, plain notes and upsert log nothing", () => {
  const structured = {
    events: [{ payload: structuredPayload, workout: { version: 1 } }],
    created: [{ id: 555, external_id: "wc-abc" }],
    upsert: false,
    hevyConnected: false,
  };
  assert.deepEqual(bulkCreateLogEntries(structured), []);
  assert.deepEqual(
    bulkCreateLogEntries({
      events: [
        {
          payload: { type: "WeightTraining", external_id: "hevy-abc" },
          hevyRoutine: { version: 1, kind: "hevy_routine" },
        },
      ],
      created: [{ id: 556, external_id: "hevy-abc" }],
      upsert: false,
      hevyConnected: true,
    }),
    [],
  );
  assert.deepEqual(
    bulkCreateLogEntries({
      events: [{ payload: { name: "Just a note", type: "Run" } }],
      created: [],
      upsert: false,
      hevyConnected: false,
    }),
    [],
  );
  assert.deepEqual(
    bulkCreateLogEntries({
      events: [{ payload: { ...dslPayload, external_id: "plan-x" } }],
      created: [{ id: 666, external_id: "plan-x" }],
      upsert: true,
      hevyConnected: false,
    }),
    [],
  );
});

test("bulk: non-array created response falls back to '?'", () => {
  assert.deepEqual(
    bulkCreateLogEntries({
      events: [{ payload: { ...dslPayload, external_id: "plan-x" } }],
      created: { unexpected: true },
      upsert: false,
      hevyConnected: false,
    }),
    [{ eventId: "?", kind: "old_structured_dsl" }],
  );
});
