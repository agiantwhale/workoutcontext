// Unit tests for the per-muscle-group load split (issue #169, Part 2).
// Run with: npm test   (node --test, type stripping — no build step)
import test from "node:test";
import assert from "node:assert/strict";
import {
  computePerMuscleLoad,
  formatSet,
  renderMuscleLoadSection,
  type HevyLoadExercise,
  type HevyLoadSet,
  type HevyLoadTemplate,
} from "../src/hevy-muscle-load.ts";

const TEMPLATES: Record<string, HevyLoadTemplate> = {
  "tpl-smith-squat": {
    muscle_group: "quadriceps",
    other_muscles: ["glutes", "hamstrings"],
  },
  "tpl-bench-db": {
    muscle_group: "chest",
    other_muscles: ["triceps", "shoulders"],
  },
  "tpl-lunge": {
    muscle_group: "quadriceps",
    other_muscles: ["glutes", "hamstrings"],
  },
  "tpl-plank": {
    muscle_group: "abdominals",
    other_muscles: [],
  },
};

function set(partial: Partial<HevyLoadSet>): HevyLoadSet {
  return {
    type: "normal",
    weight_kg: null,
    reps: null,
    distance_meters: null,
    duration_seconds: null,
    rpe: null,
    ...partial,
  };
}

test("computePerMuscleLoad splits 70% primary / 30% shared across secondaries", () => {
  // Smith Squat 3x8 @ 40.8 kg -> tonnage 979.2; Bench 3x10 @ 31.75 kg -> 952.5.
  const exercises: HevyLoadExercise[] = [
    {
      exercise_template_id: "tpl-smith-squat",
      sets: [
        set({ weight_kg: 40.8, reps: 8 }),
        set({ weight_kg: 40.8, reps: 8 }),
        set({ weight_kg: 40.8, reps: 8 }),
      ],
    },
    {
      exercise_template_id: "tpl-bench-db",
      sets: [
        set({ weight_kg: 31.75, reps: 10 }),
        set({ weight_kg: 31.75, reps: 10 }),
        set({ weight_kg: 31.75, reps: 10 }),
      ],
    },
  ];
  const out = computePerMuscleLoad(exercises, TEMPLATES, 40);
  assert.notEqual(out, null);
  // Squat share = 979.2 / 1931.7 ~= 0.5069 -> ~20.3 load; bench ~= 19.7.
  // Squat: quadriceps 70% ~= 14, glutes 15% ~= 3, hamstrings 15% ~= 3.
  // Bench: chest 70% ~= 14, triceps 15% ~= 3, shoulders 15% ~= 3.
  const byMuscle = Object.fromEntries(out!.map((r) => [r.muscle, r.load]));
  assert.equal(byMuscle.quadriceps, 14);
  assert.equal(byMuscle.glutes, 3);
  assert.equal(byMuscle.hamstrings, 3);
  assert.equal(byMuscle.chest, 14);
  assert.equal(byMuscle.triceps, 3);
  assert.equal(byMuscle.shoulders, 3);
  // The split stays close to the session load (rounding may drift +/-1).
  const total = out!.reduce((s, r) => s + r.load, 0);
  assert.ok(Math.abs(total - 40) <= 1, `total ${total} should be within 1 of 40`);
  // Sorted by load desc, then muscle name (chest before quadriceps on the tie).
  assert.deepEqual(
    out!.map((r) => r.muscle),
    ["chest", "quadriceps", "glutes", "hamstrings", "shoulders", "triceps"],
  );
});

test("computePerMuscleLoad gives the primary 100% when there are no secondaries", () => {
  const exercises: HevyLoadExercise[] = [
    {
      exercise_template_id: "tpl-plank",
      sets: [set({ duration_seconds: 60 }), set({ duration_seconds: 60 })],
    },
  ];
  assert.deepEqual(computePerMuscleLoad(exercises, TEMPLATES, 10), [
    { muscle: "abdominals", load: 10 },
  ]);
});

test("computePerMuscleLoad falls back to reps, then distance, then duration", () => {
  // A bodyweight Plank (no weight, no reps) falls back to duration; a
  // weighted Lunge falls back to tonnage (weight x distance is not
  // tonnage — tonnage only counts weight x reps, so a weighted distance
  // set contributes its distance, not a weight x distance product).
  // Here the Lunge has weight AND distance but no reps, so its tonnage
  // is 0 and it falls back to distance (40m).
  const exercises: HevyLoadExercise[] = [
    {
      exercise_template_id: "tpl-plank",
      sets: [set({ duration_seconds: 60 }), set({ duration_seconds: 60 })],
    },
    {
      exercise_template_id: "tpl-lunge",
      sets: [
        set({ weight_kg: 9.07, distance_meters: 20 }),
        set({ weight_kg: 9.07, distance_meters: 20 }),
      ],
    },
  ];
  const out = computePerMuscleLoad(exercises, TEMPLATES, 20);
  assert.notEqual(out, null);
  // Lunge distance = 40; plank duration = 120; total volume 160.
  // Lunge share = 40/160 = 0.25 -> 5 load; plank share = 0.75 -> 15.
  // Lunge: quadriceps 70% of 5 = 3.5 -> 4 (rounds half up), glutes 15% = 0.75 -> 1, hamstrings 1.
  // Plank: abdominals 15.
  const byMuscle = Object.fromEntries(out!.map((r) => [r.muscle, r.load]));
  assert.equal(byMuscle.quadriceps, 4);
  assert.equal(byMuscle.glutes, 1);
  assert.equal(byMuscle.hamstrings, 1);
  assert.equal(byMuscle.abdominals, 15);
  const total = out!.reduce((s, r) => s + r.load, 0);
  assert.ok(Math.abs(total - 20) <= 1, `total ${total} should be within 1 of 20`);
});

test("computePerMuscleLoad sends unresolvable templates to other", () => {
  const exercises: HevyLoadExercise[] = [
    {
      exercise_template_id: "tpl-unknown",
      sets: [set({ weight_kg: 20, reps: 10 })],
    },
  ];
  assert.deepEqual(computePerMuscleLoad(exercises, {}, 12), [
    { muscle: "other", load: 12 },
  ]);
});

test("computePerMuscleLoad ignores warmup sets", () => {
  const exercises: HevyLoadExercise[] = [
    {
      exercise_template_id: "tpl-smith-squat",
      sets: [
        set({ type: "warmup", weight_kg: 20, reps: 10 }),
        set({ type: "normal", weight_kg: 40.8, reps: 8 }),
      ],
    },
  ];
  const out = computePerMuscleLoad(exercises, TEMPLATES, 10);
  assert.notEqual(out, null);
  // Only the working set's tonnage (326.4) counts — it is the only
  // exercise, so it still takes the whole session load. 70/15/15 of 10
  // is 7 / 1.5 / 1.5, which rounds to 7 / 2 / 2 (sum 11, a +1 rounding
  // drift — documented in the module header).
  const byMuscle = Object.fromEntries(out!.map((r) => [r.muscle, r.load]));
  assert.equal(byMuscle.quadriceps, 7);
  assert.equal(byMuscle.glutes, 2);
  assert.equal(byMuscle.hamstrings, 2);
});

test("computePerMuscleLoad returns null when there is no load to split", () => {
  assert.equal(
    computePerMuscleLoad(
      [{ exercise_template_id: "tpl-smith-squat", sets: [set({ weight_kg: 40.8, reps: 8 })] }],
      TEMPLATES,
      null,
    ),
    null,
  );
  assert.equal(computePerMuscleLoad([], TEMPLATES, 10), null);
  assert.equal(
    computePerMuscleLoad(
      [{ exercise_template_id: "tpl-smith-squat", sets: [set({})] }],
      TEMPLATES,
      10,
    ),
    null,
  );
});

test("formatSet keeps the weight on weighted distance sets (sync blind spot)", () => {
  // The sync's old formatSet only rendered weight inside the reps
  // branch, dropping it for weighted distance sets (e.g. a 20m walking
  // Lunge with dumbbells). The fixed version renders the weight
  // whenever present, even without reps.
  assert.equal(formatSet(set({ weight_kg: 9.07, distance_meters: 20 })), "  - 9.07kg, 20m");
  // Reps and duration still render as before.
  assert.equal(formatSet(set({ weight_kg: 40.8, reps: 8 })), "  - 40.8kg x 8");
  assert.equal(formatSet(set({ duration_seconds: 60 })), "  - 60s");
  assert.equal(formatSet(set({ reps: 10 })), "  - 10 reps");
  assert.equal(formatSet(set({ weight_kg: 40.8, reps: 8, rpe: 8 })), "  - 40.8kg x 8, RPE 8");
  assert.equal(formatSet(set({ type: "warmup", weight_kg: 20, reps: 10 })), "  - WARMUP, 20kg x 10");
  assert.equal(formatSet(set({})), "  - (empty set)");
});

test("renderMuscleLoadSection renders a sorted, readable breakdown", () => {
  const lines = renderMuscleLoadSection([
    { muscle: "quadriceps", load: 14 },
    { muscle: "chest", load: 14 },
    { muscle: "glutes", load: 3 },
  ]);
  assert.deepEqual(lines, [
    "### Load by muscle group",
    "- Quadriceps: 14",
    "- Chest: 14",
    "- Glutes: 3",
  ]);
  assert.deepEqual(renderMuscleLoadSection([]), ["### Load by muscle group"]);
});
