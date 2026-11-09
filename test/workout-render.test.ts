// Renderer unit tests for the structured-workout JSON path (issue #164).
// Run with: npm test   (node --test, type stripping — no build step)
import test from "node:test";
import assert from "node:assert/strict";
import {
  applyWorkoutPatch,
  coerceWorkoutParam,
  expandSteps,
  expectedTotals,
  extractWorkoutFromDescription,
  normalizeWorkout,
  parseWorkoutJson,
  renderWorkoutDescription,
  stableExternalId,
  toIntervalsError,
  verifyWorkoutEvent,
  type StoredWorkoutJson,
} from "../src/workout-render.ts";

const CAPTION = "Threshold session — 3x1mi at threshold with half-mile recoveries.";

const THRESHOLD: Record<string, unknown> = {
  version: 1,
  sport: "Run",
  target_metric: "power",
  sections: [
    {
      name: "Warmup",
      steps: [{ distance: { mi: 2 }, target: { zone: 1 }, type: "recovery" }],
    },
    {
      name: "Main",
      repeat: 3,
      steps: [
        { distance: { mi: 1 }, target: { zone: 4 }, type: "work", label: "Rep {n}" },
        { distance: { mi: 0.5 }, target: { zone: 1 }, type: "recovery", label: "Rest {n}" },
      ],
    },
    {
      name: "Cooldown",
      steps: [{ distance: { mi: 1 }, target: { zone: 1 }, type: "recovery" }],
    },
  ],
  meta: { planned_load: 42, source: "base-week-2" },
};

function step(
  length: Record<string, number>,
  target: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const key = "mi" in length || "km" in length || "m" in length ? "distance" : "duration";
  return { [key]: length, target, ...extra };
}

function workout(
  steps: Record<string, unknown>[],
  metric: "power" | "hr" | "pace" = "power",
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    version: 1,
    sport: metric === "pace" ? "Run" : metric === "hr" ? "Run" : "Ride",
    target_metric: metric,
    sections: [{ name: "Main", steps }],
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// Golden render
// ---------------------------------------------------------------------------

test("golden: threshold workout renders exactly like the issue example", () => {
  const { description, stored } = renderWorkoutDescription(
    parseWorkoutJson(THRESHOLD),
    CAPTION,
  );
  const expectedDsl =
    `${CAPTION}\n\n` +
    "Warmup\n- 2mi Z1 Power\n\n" +
    "Main 3x\n- 1mi Z4 Power\n- 0.5mi Z1 Power\n\n" +
    "Cooldown\n- 1mi Z1 Power";
  assert.ok(description.startsWith(expectedDsl), "DSL part mismatch");
  assert.ok(
    description.startsWith(`${expectedDsl}\n\n<!-- workoutcontext: `),
    "comment must follow the DSL after a blank line",
  );
  assert.ok(description.endsWith(" -->"), "comment must close");
  // Round-trip: the comment parses back to the stored JSON.
  const extracted = extractWorkoutFromDescription(description);
  assert.deepEqual(extracted, stored);
  assert.equal(stored.caption, CAPTION);
  assert.equal(stored.meta?.planned_load, 42);
});

test("golden: no caption renders no first paragraph", () => {
  const { description } = renderWorkoutDescription(parseWorkoutJson(THRESHOLD));
  assert.ok(description.startsWith("Warmup\n- 2mi Z1 Power"));
  assert.equal(extractWorkoutFromDescription(description)?.caption, undefined);
});

// ---------------------------------------------------------------------------
// Target forms (issue #164 table)
// ---------------------------------------------------------------------------

const TARGET_CASES: {
  name: string;
  metric: "power" | "hr" | "pace";
  target: Record<string, unknown>;
  dsl: string;
}[] = [
  { name: "zone", metric: "power", target: { zone: 4 }, dsl: "Z4 Power" },
  { name: "zone hr", metric: "hr", target: { zone: 2 }, dsl: "Z2 HR" },
  { name: "zone pace", metric: "pace", target: { zone: 2 }, dsl: "Z2 Pace" },
  { name: "zone range", metric: "power", target: { zone: [3, 4] }, dsl: "Z3-Z4 Power" },
  { name: "sweet spot", metric: "power", target: { zone: "SS" }, dsl: "SS" },
  { name: "pct power", metric: "power", target: { pct: 90 }, dsl: "90%" },
  { name: "pct range power", metric: "power", target: { pct: [78, 82] }, dsl: "78-82%" },
  { name: "pct lthr", metric: "hr", target: { pct: 90 }, dsl: "90% LTHR" },
  { name: "pct lthr range", metric: "hr", target: { pct: [90, 95] }, dsl: "90-95% LTHR" },
  { name: "pct max hr", metric: "hr", target: { pct: 90, pct_of: "max" }, dsl: "90% HR" },
  { name: "pct pace", metric: "pace", target: { pct: 90 }, dsl: "90% Pace" },
  { name: "pct range pace", metric: "pace", target: { pct: [78, 82] }, dsl: "78-82% Pace" },
  { name: "watts", metric: "power", target: { watts: 250 }, dsl: "250w" },
  { name: "watts range", metric: "power", target: { watts: [200, 240] }, dsl: "200-240w" },
  { name: "pace", metric: "pace", target: { pace: "6:40/mi" }, dsl: "6:40/mi Pace" },
  { name: "pace km", metric: "pace", target: { pace: "4:07/km" }, dsl: "4:07/km Pace" },
  { name: "pace range", metric: "pace", target: { pace: ["7:15/mi", "7:00/mi"] }, dsl: "7:15-7:00 Pace" },
  {
    name: "ramp pct",
    metric: "power",
    target: { ramp: { from: { pct: 60 }, to: { pct: 80 } } },
    dsl: "ramp 60-80%",
  },
  {
    name: "ramp watts",
    metric: "power",
    target: { ramp: { from: { watts: 180 }, to: { watts: 260 } } },
    dsl: "ramp 180-260w",
  },
  {
    name: "ramp pct lthr",
    metric: "hr",
    target: { ramp: { from: { pct: 60 }, to: { pct: 80 } } },
    dsl: "ramp 60-80% LTHR",
  },
];

for (const c of TARGET_CASES) {
  test(`target form: ${c.name} -> ${c.dsl}`, () => {
    const { description } = renderWorkoutDescription(
      parseWorkoutJson(workout([step({ minutes: 10 }, c.target)], c.metric)),
    );
    assert.ok(
      description.includes(`- 10m ${c.dsl}\n`),
      `expected "- 10m ${c.dsl}" in:\n${description}`,
    );
  });
}

test("target form: cadence is secondary and appends after the target", () => {
  const { description } = renderWorkoutDescription(
    parseWorkoutJson(
      workout(
        [step({ minutes: 10 }, { pct: 85 }, { cadence: 90 })],
        "power",
      ),
    ),
  );
  assert.ok(description.includes("- 10m 85% 90rpm"));
  const { description: ranged } = renderWorkoutDescription(
    parseWorkoutJson(
      workout(
        [step({ minutes: 10 }, { pct: 85 }, { cadence: [90, 100] })],
        "power",
      ),
    ),
  );
  assert.ok(ranged.includes("- 10m 85% 90-100rpm"));
});

test("length forms: km, m (renders mtr), seconds, hours", () => {
  const { description } = renderWorkoutDescription(
    parseWorkoutJson(
      workout([
        step({ km: 1 }, { zone: 2 }),
        step({ m: 400 }, { zone: 4 }),
        step({ seconds: 30 }, { zone: 7 }),
        step({ hours: 1 }, { zone: 1 }),
      ]),
    ),
  );
  assert.ok(description.includes("- 1km Z2 Power"));
  assert.ok(description.includes("- 400mtr Z4 Power"));
  assert.ok(description.includes("- 30s Z7 Power"));
  assert.ok(description.includes("- 1h Z1 Power"));
});

// ---------------------------------------------------------------------------
// Type defaults + labels
// ---------------------------------------------------------------------------

test("type defaults: warmup/cooldown -> recovery, repeat first -> work, rest -> recovery, else work", () => {
  const w = parseWorkoutJson({
    version: 1,
    sport: "Run",
    target_metric: "power",
    sections: [
      { name: "Warmup", steps: [{ duration: { minutes: 10 }, target: { zone: 1 } }] },
      {
        name: "Main",
        repeat: 2,
        steps: [
          { duration: { minutes: 5 }, target: { zone: 4 } },
          { duration: { minutes: 2 }, target: { zone: 1 } },
        ],
      },
      { name: "Tempo", steps: [{ duration: { minutes: 20 }, target: { zone: 3 } }] },
      { name: "Cooldown", steps: [{ duration: { minutes: 5 }, target: { zone: 1 } }] },
    ],
  });
  const n = normalizeWorkout(w);
  assert.equal(n.sections[0].steps[0].type, "recovery");
  assert.equal(n.sections[1].steps[0].type, "work");
  assert.equal(n.sections[1].steps[1].type, "recovery");
  assert.equal(n.sections[2].steps[0].type, "work");
  assert.equal(n.sections[3].steps[0].type, "recovery");
  // Explicit type wins over the default.
  const w2 = parseWorkoutJson({
    version: 1,
    sport: "Run",
    target_metric: "power",
    sections: [
      { name: "Warmup", steps: [{ duration: { minutes: 10 }, target: { zone: 1 }, type: "work" }] },
    ],
  });
  assert.equal(normalizeWorkout(w2).sections[0].steps[0].type, "work");
});

test("label without {n} renders inline; label with {n} is comment-only", () => {
  const { description } = renderWorkoutDescription(
    parseWorkoutJson({
      version: 1,
      sport: "Run",
      target_metric: "power",
      sections: [
        {
          name: "Main",
          repeat: 2,
          steps: [
            { duration: { minutes: 5 }, target: { zone: 4 }, label: "Rep {n}" },
            { duration: { minutes: 5 }, target: { zone: 1 }, label: "Rest {n}" },
          ],
        },
        {
          name: "Tempo",
          steps: [{ duration: { minutes: 5 }, target: { zone: 4 }, label: "Float" }],
        },
      ],
    }),
  );
  assert.ok(description.includes("- Float 5m Z4 Power"));
  // No STEP LINE carries the {n} label (it lives only in the comment).
  assert.ok(!description.includes("- Rep {n}"), "a {n} label must not render into a DSL step line");
  assert.ok(!description.includes("- Rest {n}"), "a {n} label must not render into a DSL step line");
  assert.ok(description.includes("- 5m Z4 Power"));
  // The {n} labels survive in the stored comment for the labeler.
  assert.ok(description.includes('"label":"Rep {n}"'));
});

test("label validation: DSL tokens, {n} outside repeats, newlines, unknown placeholders", () => {
  const bad = (label: string, section: Record<string, unknown> = { name: "Main" }) =>
    assert.throws(
      () =>
        parseWorkoutJson({
          version: 1,
          sport: "Run",
          target_metric: "power",
          sections: [{ ...section, steps: [{ duration: { minutes: 5 }, target: { zone: 4 }, label }] }],
        }),
      /WORKOUT_VALIDATION/,
      `label ${JSON.stringify(label)} should be rejected`,
    );
  bad("400m repeats");
  bad("5 min easy");
  bad("Z4 effort");
  bad("90% effort");
  bad("6:40 pace");
  bad("Rep {n}"); // no repeat on the section
  bad("Line one\nLine two");
  bad("Rep {x}");
  // Bare numbers are fine.
  parseWorkoutJson({
    version: 1,
    sport: "Run",
    target_metric: "power",
    sections: [{ name: "Main", steps: [{ duration: { minutes: 5 }, target: { zone: 4 }, label: "Rep 1" }] }],
  });
});

// ---------------------------------------------------------------------------
// Validation errors
// ---------------------------------------------------------------------------

test("validation: version, shape, and metric mismatches fail with paths", () => {
  const cases: { input: unknown; pathSnippet: string }[] = [
    { input: { ...THRESHOLD, version: 2 }, pathSnippet: "version" },
    {
      input: workout([step({ mi: 1 }, { watts: 250 })], "pace"),
      pathSnippet: "target",
    },
    {
      input: workout([step({ mi: 1 }, { pace: "6:40/mi" })], "power"),
      pathSnippet: "target",
    },
    {
      input: workout([step({ mi: 1 }, { pct: 90, pct_of: "max" })], "power"),
      pathSnippet: "target",
    },
    {
      input: workout([step({ mi: 1 }, { zone: "SS" })], "pace"),
      pathSnippet: "target",
    },
    {
      input: workout([
        step({ mi: 1 }, { ramp: { from: { pct: 60 }, to: { watts: 200 } } }),
      ]),
      pathSnippet: "target",
    },
    {
      input: workout([step({ mi: 1, minutes: 5 }, { zone: 2 })]),
      pathSnippet: "",
    },
    {
      input: workout([
        { target: { zone: 2 } },
      ]),
      pathSnippet: "",
    },
    {
      input: { ...THRESHOLD, target_metric: "power", sections: [{ name: "Main", steps: [{ distance: { mi: 1 }, target: { bpm: 150 } }] }] },
      pathSnippet: "target",
    },
  ];
  for (const { input, pathSnippet } of cases) {
    assert.throws(
      () => parseWorkoutJson(input),
      (e: unknown) => {
        assert.ok(e instanceof Error && e.message.startsWith("[WORKOUT_VALIDATION]"), `expected WORKOUT_VALIDATION, got: ${e}`);
        if (pathSnippet) assert.ok(e.message.includes(pathSnippet), `expected path ${pathSnippet} in: ${e.message}`);
        return true;
      },
    );
  }
});

test("validation: '--' in the JSON is rejected at render", () => {
  assert.throws(
    () =>
      renderWorkoutDescription(
        parseWorkoutJson({
          ...THRESHOLD,
          meta: { planned_load: 42, source: "a--b" },
        }),
      ),
    /\[WORKOUT_RENDER\]/,
  );
});

test("coerceWorkoutParam: JSON string parses, bad string fails clearly", () => {
  const parsed = coerceWorkoutParam(JSON.stringify(THRESHOLD), "workout");
  assert.equal((parsed as Record<string, unknown>).version, 1);
  assert.throws(
    () => coerceWorkoutParam("{not json", "workout"),
    /\[WORKOUT_VALIDATION\]/,
  );
});

// ---------------------------------------------------------------------------
// Comment extraction
// ---------------------------------------------------------------------------

test("extractWorkoutFromDescription: null for missing/invalid comments, never throws", () => {
  assert.equal(extractWorkoutFromDescription("plain description"), null);
  assert.equal(extractWorkoutFromDescription(undefined), null);
  assert.equal(extractWorkoutFromDescription("<!-- workoutcontext: {bad json -->"), null);
  assert.equal(extractWorkoutFromDescription("<!-- workoutcontext: {\"version\": 2} -->"), null);
  assert.equal(extractWorkoutFromDescription(null), null);
});

// ---------------------------------------------------------------------------
// Patch merge
// ---------------------------------------------------------------------------

test("patch merge: zone change, meta change, section delete, step delete, append", () => {
  const stored = renderWorkoutDescription(parseWorkoutJson(THRESHOLD)).stored;
  const merged = applyWorkoutPatch(stored, {
    sections: [{}, { steps: [{ target: { zone: 5 } }] }],
    meta: { planned_load: 45 },
  }) as StoredWorkoutJson;
  assert.equal(merged.sections[1].steps[0].target.zone, 5);
  assert.equal(merged.meta?.planned_load, 45);
  assert.equal(merged.meta?.source, "base-week-2");
  assert.equal(merged.sections[0].steps[0].target.zone, 1);

  const deleted = applyWorkoutPatch(stored, { sections: [{}, {}, null] }) as StoredWorkoutJson;
  assert.equal(deleted.sections.length, 2);
  assert.equal(deleted.sections[1].name, "Main");

  const stepDeleted = applyWorkoutPatch(stored, {
    sections: [{}, { steps: [null] }],
  }) as StoredWorkoutJson;
  assert.equal(stepDeleted.sections[1].steps.length, 1);
  assert.equal(stepDeleted.sections[1].steps[0].target.zone, 1);

  const appended = applyWorkoutPatch(stored, {
    sections: [{}, { steps: [{}, {}, { distance: { mi: 1 }, target: { zone: 2 } }] }],
  }) as StoredWorkoutJson;
  assert.equal(appended.sections[1].steps.length, 3);
  assert.equal(appended.sections[1].steps[2].target.zone, 2);

  const keyDeleted = applyWorkoutPatch(stored, { meta: { source: null } }) as StoredWorkoutJson;
  assert.equal(keyDeleted.meta?.source, undefined);
  assert.equal(keyDeleted.meta?.planned_load, 42);
});

test("patch merge: out-of-range delete and shape mismatches are WORKOUT_PATCH", () => {
  const stored = renderWorkoutDescription(parseWorkoutJson(THRESHOLD)).stored;
  assert.throws(
    () => applyWorkoutPatch(stored, { sections: [{}, { steps: [{}, {}, null] }] }),
    /\[WORKOUT_PATCH\]/,
  );
  assert.throws(
    () => applyWorkoutPatch(stored, { sections: "nope" }),
    /\[WORKOUT_PATCH\]/,
  );
  assert.throws(() => applyWorkoutPatch(stored, [1, 2]), /\[WORKOUT_PATCH\]/);
});

// ---------------------------------------------------------------------------
// Expansion + totals
// ---------------------------------------------------------------------------

test("expandSteps: repeats expand in order with {n} substituted and types resolved", () => {
  const expanded = expandSteps(parseWorkoutJson(THRESHOLD) as StoredWorkoutJson);
  assert.equal(expanded.length, 8); // 1 + 3*2 + 1
  assert.deepEqual(
    expanded.map((s) => `${s.section}/${s.iteration}/${s.step.label ?? "-"}/${s.step.type}`),
    [
      "Warmup/1/-/recovery",
      "Main/1/Rep 1/work",
      "Main/1/Rest 1/recovery",
      "Main/2/Rep 2/work",
      "Main/2/Rest 2/recovery",
      "Main/3/Rep 3/work",
      "Main/3/Rest 3/recovery",
      "Cooldown/1/-/recovery",
    ],
  );
});

test("expectedTotals: steps/duration/distance with mixed flags", () => {
  const t = expectedTotals(parseWorkoutJson(THRESHOLD) as StoredWorkoutJson);
  assert.equal(t.steps, 8);
  assert.equal(t.durationSeconds, 0);
  assert.equal(t.distanceMeters, 7.5 * 1609.34);
  assert.equal(t.hasDistanceSteps, true);
  assert.equal(t.hasTimeSteps, false);

  const mixed = expectedTotals(
    parseWorkoutJson(
      workout([
        step({ minutes: 10 }, { zone: 2 }),
        step({ mi: 1 }, { zone: 4 }),
      ]),
    ) as StoredWorkoutJson,
  );
  assert.equal(mixed.steps, 2);
  assert.equal(mixed.durationSeconds, 600);
  assert.equal(mixed.distanceMeters, 1609.34);
  assert.equal(mixed.hasDistanceSteps, true);
  assert.equal(mixed.hasTimeSteps, true);
});

test("stableExternalId is deterministic for the same workout + date", () => {
  const stored = renderWorkoutDescription(parseWorkoutJson(THRESHOLD)).stored;
  assert.equal(
    stableExternalId(stored, "2027-06-01T00:00:00"),
    stableExternalId(stored, "2027-06-01T00:00:00"),
  );
  assert.notEqual(
    stableExternalId(stored, "2027-06-01T00:00:00"),
    stableExternalId(stored, "2027-06-02T00:00:00"),
  );
  assert.ok(stableExternalId(stored, "2027-06-01T00:00:00").startsWith("wc-"));
});

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

function serverEvent(
  workout: StoredWorkoutJson,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const totals = expectedTotals(workout);
  // Server workout_doc: repeat blocks stay nested ({reps, steps}).
  const steps: unknown[] = [];
  for (const s of workout.sections) {
    const inner = s.steps.map(() => ({
      duration: 0,
      distance: 0,
      power: { value: 1, units: "power_zone" },
    }));
    if (s.repeat !== undefined) steps.push({ reps: s.repeat, steps: inner });
    else steps.push(...inner);
  }
  return {
    id: 123,
    moving_time: totals.durationSeconds,
    description: renderWorkoutDescription(workout).description,
    workout_doc: {
      duration: totals.durationSeconds,
      distance: totals.distanceMeters,
      steps,
    },
    ...overrides,
  };
}

test("verifyWorkoutEvent: pure distance workout verifies exactly", () => {
  const stored = renderWorkoutDescription(parseWorkoutJson(THRESHOLD)).stored;
  const event = serverEvent(stored, {
    moving_time: 3594,
    workout_doc: {
      duration: 3594,
      distance: 12070.05,
      steps: [
        { duration: 958, distance: 3218.68, power: { value: 1, units: "power_zone" } },
        {
          reps: 3,
          steps: [
            { duration: 479, distance: 1609.34, power: { value: 4, units: "power_zone" } },
            { duration: 240, distance: 804.67, power: { value: 1, units: "power_zone" } },
          ],
        },
        { duration: 479, distance: 1609.34, power: { value: 1, units: "power_zone" } },
      ],
    },
  });
  const verified = verifyWorkoutEvent(event, stored, {
    eventId: 123,
    description: event.description as string,
  });
  assert.equal(verified.steps.expected, 8);
  assert.equal(verified.steps.actual, 8);
  assert.equal(verified.distance_meters.check, "exact");
  assert.equal(verified.comment_round_trip, true);
});

test("verifyWorkoutEvent: mismatches throw with expected vs actual", () => {
  const stored = renderWorkoutDescription(parseWorkoutJson(THRESHOLD)).stored;
  const base = serverEvent(stored, {
    moving_time: 3594,
    workout_doc: {
      duration: 3594,
      distance: 12070.05,
      steps: [{ duration: 958, distance: 3218.68 }],
    },
  });
  assert.throws(
    () => verifyWorkoutEvent(base, stored, { eventId: 123, description: base.description as string }),
    (e: unknown) => {
      assert.ok(e instanceof Error && e.message.startsWith("[WORKOUT_VERIFY_MISMATCH]"));
      assert.ok(e.message.includes("expected 8, got 1"));
      assert.ok(e.message.includes("left in place"));
      return true;
    },
  );
  // Comment round-trip failure.
  const tampered = {
    ...serverEvent(stored),
    description: "Warmup\n- 2mi Z1 Power",
    workout_doc: {
      duration: 0,
      distance: 12070.05,
      steps: [
        { duration: 958, distance: 3218.68 },
        { reps: 3, steps: [{ duration: 1, distance: 1 }, { duration: 1, distance: 1 }] },
        { duration: 479, distance: 1609.34 },
      ],
    },
  };
  assert.throws(
    () => verifyWorkoutEvent(tampered, stored, { eventId: 123, description: tampered.description as string }),
    /comment round-trip failed/,
  );
});

// ---------------------------------------------------------------------------
// Intervals error wrapping
// ---------------------------------------------------------------------------

test("toIntervalsError: HTTP errors carry status, step, retryability", () => {
  const err = toIntervalsError(
    {
      status: 429,
      method: "POST",
      path: "/athlete/0/events",
      body: "rate limited",
      message: "Intervals POST /athlete/0/events → 429: rate limited",
    },
    "create",
    123,
  );
  assert.ok(err.message.startsWith("[INTERVALS_HTTP_ERROR]"));
  assert.ok(err.message.includes('"retryable":true'));
  assert.ok(err.message.includes('"event_id":123'));

  const clientErr = toIntervalsError(
    {
      status: 400,
      method: "POST",
      path: "/athlete/0/events",
      body: "bad payload",
      message: "Intervals POST /athlete/0/events → 400: bad payload",
    },
    "create",
  );
  assert.ok(clientErr.message.includes('"retryable":false'));

  const netErr = toIntervalsError(new TypeError("fetch failed"), "verify re-fetch");
  assert.ok(netErr.message.includes('"retryable":true'));
  assert.ok(netErr.message.includes("no HTTP response"));

  // Workout errors pass through untouched.
  const w = new Error("[WORKOUT_VALIDATION] nope");
  assert.equal(toIntervalsError(w, "create"), w);
});
