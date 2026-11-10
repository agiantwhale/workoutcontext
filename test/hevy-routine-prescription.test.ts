// Unit tests for the Hevy-routine prescription path (issue #169, Part 1).
// Run with: npm test   (node --test, type stripping — no build step)
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildHevyRoutinePrescription,
  extractHevyRoutineId,
  extractHevyRoutinePrescription,
  formatWeight,
  perSetMeasure,
  renderHevyRoutineDescription,
  verifyHevyRoutineEvent,
  weightCell,
  type HevyRoutineInput,
  type HevyRoutinePrescription,
  type HevyTemplateInput,
} from "../src/hevy-routine-prescription.ts";

// 90 lb in kg (Hevy stores kg; 90 × 0.453592 = 40.82328).
const KG_90LB = 40.82328;
const KG_70LB = 31.75144;
const KG_20LB = 9.07184;

const TEMPLATES: Record<string, HevyTemplateInput> = {
  "tpl-smith-squat": {
    id: "tpl-smith-squat",
    title: "Smith Squat",
    muscle_group: "quadriceps",
    other_muscles: ["glutes", "hamstrings"],
  },
  "tpl-bench-db": {
    id: "tpl-bench-db",
    title: "Bench Press (Dumbbell)",
    muscle_group: "chest",
    other_muscles: ["triceps", "shoulders"],
  },
  "tpl-lunge": {
    id: "tpl-lunge",
    title: "Lunge (Walking)",
    muscle_group: "quadriceps",
    other_muscles: ["glutes", "hamstrings"],
  },
  "tpl-plank": {
    id: "tpl-plank",
    title: "Plank",
    muscle_group: "abdominals",
    other_muscles: [],
  },
};

const ROUTINE_A: HevyRoutineInput = {
  id: "3947898f-146d-49f9-9274-ed7b510a2bdd",
  title: "A - Squat Day",
  exercises: [
    {
      exercise_template_id: "tpl-smith-squat",
      rest_seconds: 120,
      sets: [
        { type: "normal", weight_kg: KG_90LB, reps: 8 },
        { type: "normal", weight_kg: KG_90LB, reps: 8 },
        { type: "normal", weight_kg: KG_90LB, reps: 8 },
      ],
    },
    {
      exercise_template_id: "tpl-bench-db",
      rest_seconds: 90,
      sets: [
        { type: "normal", weight_kg: KG_70LB, reps: 12 },
        { type: "normal", weight_kg: KG_70LB, reps: 8 },
        { type: "normal", weight_kg: KG_70LB, reps: 8 },
      ],
    },
    {
      exercise_template_id: "tpl-lunge",
      rest_seconds: 90,
      sets: [
        { type: "normal", weight_kg: KG_20LB, distance_meters: 20 },
        { type: "normal", weight_kg: KG_20LB, distance_meters: 20 },
        { type: "normal", weight_kg: KG_20LB, distance_meters: 20 },
      ],
    },
    {
      exercise_template_id: "tpl-plank",
      rest_seconds: 60,
      sets: [
        { type: "normal", duration_seconds: 60 },
        { type: "normal", duration_seconds: 60 },
        { type: "normal", duration_seconds: 60 },
      ],
    },
  ],
};

function buildPrescription(): HevyRoutinePrescription {
  return buildHevyRoutinePrescription(ROUTINE_A, TEMPLATES);
}

test("buildHevyRoutinePrescription stores the full prescription in kg", () => {
  const p = buildPrescription();
  assert.equal(p.version, 1);
  assert.equal(p.kind, "hevy_routine");
  assert.equal(p.routine_id, "3947898f-146d-49f9-9274-ed7b510a2bdd");
  assert.equal(p.routine_title, "A - Squat Day");
  assert.equal(p.exercises.length, 4);
  const squat = p.exercises[0];
  assert.equal(squat.template_id, "tpl-smith-squat");
  assert.equal(squat.title, "Smith Squat");
  assert.equal(squat.muscle_group, "quadriceps");
  assert.deepEqual(squat.other_muscles, ["glutes", "hamstrings"]);
  assert.equal(squat.rest_seconds, 120);
  assert.equal(squat.sets.length, 3);
  // JSON stores kg (Hevy native), not the display unit.
  assert.equal(squat.sets[0].weight_kg, KG_90LB);
  assert.equal(squat.sets[0].reps, 8);
});

test("buildHevyRoutinePrescription falls back to other/Exercise when the template is missing", () => {
  const p = buildHevyRoutinePrescription(ROUTINE_A, {});
  assert.equal(p.exercises[0].title, "Exercise");
  assert.equal(p.exercises[0].muscle_group, "other");
  assert.deepEqual(p.exercises[0].other_muscles, []);
});

test("formatWeight converts kg to the user's preferred unit", () => {
  assert.equal(formatWeight(KG_90LB, "lbs"), "90 lb");
  assert.equal(formatWeight(KG_70LB, "lbs"), "70 lb");
  assert.equal(formatWeight(KG_90LB, "kg"), "40.82 kg");
  assert.equal(formatWeight(KG_90LB, "LB"), "90 lb");
});

test("perSetMeasure shows reps, distance, or duration with its unit", () => {
  const p = buildPrescription();
  // All three squat sets are 8 reps → shown once.
  assert.equal(perSetMeasure(p.exercises[0].sets), "8");
  // Varying reps are joined with "/".
  assert.equal(perSetMeasure(p.exercises[1].sets), "12/8/8");
  // Distance-based (walking Lunge) → "20m".
  assert.equal(perSetMeasure(p.exercises[2].sets), "20m");
  // Duration-based (Plank) → "60s".
  assert.equal(perSetMeasure(p.exercises[3].sets), "60s");
  assert.equal(perSetMeasure([]), "—");
  assert.equal(perSetMeasure(null), "—");
});

test("weightCell shows the weight or Bodyweight", () => {
  const p = buildPrescription();
  assert.equal(weightCell(p.exercises[0].sets, "lbs"), "90 lb");
  assert.equal(weightCell(p.exercises[1].sets, "lbs"), "70 lb");
  assert.equal(weightCell(p.exercises[2].sets, "lbs"), "20 lb");
  assert.equal(weightCell(p.exercises[3].sets, "lbs"), "Bodyweight");
  assert.equal(weightCell(p.exercises[0].sets, "kg"), "40.82 kg");
  // Varying weights are joined with "/" (e.g. `70 lb/90 lb`).
  assert.equal(
    weightCell(
      [
        { type: "normal", weight_kg: KG_70LB, reps: 12 },
        { type: "normal", weight_kg: KG_90LB, reps: 8 },
      ],
      "lbs",
    ),
    "70 lb/90 lb",
  );
});

test("renderHevyRoutineDescription produces prose + table + comment", () => {
  const p = buildPrescription();
  const { description, stored } = renderHevyRoutineDescription(p, "lbs");
  assert.equal(stored, p);
  const lines = description.split("\n");
  assert.equal(lines[0], "Hevy A - Squat Day routine.");
  assert.ok(lines.includes("| Exercise | Sets | Per Set | Weight | Muscles |"));
  assert.ok(lines.includes("| --- | --- | --- | --- | --- |"));
  assert.ok(
    lines.includes("| Smith Squat | 3 | 8 | 90 lb | Quadriceps (+ Glutes, Hamstrings) |"),
  );
  assert.ok(
    lines.includes("| Bench Press (Dumbbell) | 3 | 12/8/8 | 70 lb | Chest (+ Triceps, Shoulders) |"),
  );
  assert.ok(
    lines.includes("| Lunge (Walking) | 3 | 20m | 20 lb | Quadriceps (+ Glutes, Hamstrings) |"),
  );
  assert.ok(lines.includes("| Plank | 3 | 60s | Bodyweight | Abdominals |"));
  // The comment carries the full prescription JSON.
  const comment = lines[lines.length - 1];
  assert.ok(comment.startsWith("<!-- workoutcontext: "));
  assert.ok(comment.endsWith(" -->"));
  assert.ok(comment.includes('"kind":"hevy_routine"'));
  assert.ok(comment.includes('"routine_id":"3947898f-146d-49f9-9274-ed7b510a2bdd"'));
});

test("renderHevyRoutineDescription uses the caption as prose when given", () => {
  const p = buildPrescription();
  const { description } = renderHevyRoutineDescription(p, "lbs", "Log RPE on every set.");
  assert.ok(description.startsWith("Log RPE on every set.\n"));
});

test("renderHevyRoutineDescription renders kg when the user prefers kg", () => {
  const p = buildPrescription();
  const { description } = renderHevyRoutineDescription(p, "kg");
  assert.ok(description.includes("| Smith Squat | 3 | 8 | 40.82 kg | Quadriceps (+ Glutes, Hamstrings) |"));
});

test("extractHevyRoutinePrescription round-trips the rendered description", () => {
  const p = buildPrescription();
  const { description } = renderHevyRoutineDescription(p, "lbs");
  const back = extractHevyRoutinePrescription(description);
  assert.notEqual(back, null);
  assert.deepEqual(back, p);
});

test("extractHevyRoutinePrescription returns null for other JSON and garbage", () => {
  assert.equal(extractHevyRoutinePrescription("no comment here"), null);
  assert.equal(extractHevyRoutinePrescription(null), null);
  // A structured-workout comment (kind is not hevy_routine) does not parse.
  assert.equal(
    extractHevyRoutinePrescription(
      '<!-- workoutcontext: {"version":1,"sport":"Run","target_metric":"power","sections":[]} -->',
    ),
    null,
  );
});

test("extractHevyRoutineId accepts a plain id or a share URL", () => {
  const id = "3947898f-146d-49f9-9274-ed7b510a2bdd";
  assert.equal(extractHevyRoutineId(id), id);
  assert.equal(extractHevyRoutineId(`https://hevy.com/routine/${id}`), id);
  assert.equal(extractHevyRoutineId(`  ${id}  `), id);
});

test("verifyHevyRoutineEvent accepts a matching re-fetched event", () => {
  const p = buildPrescription();
  const { description } = renderHevyRoutineDescription(p, "lbs");
  const out = verifyHevyRoutineEvent(
    { id: 123, workout_doc: { steps: [] }, description },
    p,
    123,
  );
  assert.deepEqual(out, {
    comment_round_trip: true,
    table_present: true,
    steps_empty: true,
  });
});

test("verifyHevyRoutineEvent throws when the comment does not round-trip", () => {
  const p = buildPrescription();
  assert.throws(
    () =>
      verifyHevyRoutineEvent(
        { id: 123, workout_doc: { steps: [] }, description: "no comment" },
        p,
        123,
      ),
    /comment round-trip failed/,
  );
});

test("verifyHevyRoutineEvent throws when the table is missing", () => {
  const p = buildPrescription();
  const { description } = renderHevyRoutineDescription(p, "lbs");
  // Strip every table row (lines starting with "| ") but keep the prose
  // and the comment, so only the table check fails.
  const noTable = description
    .split("\n")
    .filter((line) => !line.startsWith("| "))
    .join("\n");
  assert.throws(
    () =>
      verifyHevyRoutineEvent(
        { id: 123, workout_doc: { steps: [] }, description: noTable },
        p,
        123,
      ),
    /prescription table missing/,
  );
});
