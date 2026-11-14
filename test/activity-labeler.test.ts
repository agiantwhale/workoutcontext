// Unit tests for the activity-interval auto-labeler (issue #163).
// Run with: npm test (node --test, type stripping)
import test from "node:test";
import assert from "node:assert/strict";
import {
  deriveLabelSpec,
  extractStreams,
  isAlreadyLabeled,
  isGlitch,
  sessionLabel,
  verifySpec,
  type DetectedInterval,
  type LabelSpecEntry,
  type StreamSet,
} from "../src/activity-labeler.ts";
import {
  expandSteps,
  type StoredWorkoutJson,
} from "../src/workout-render.ts";

// --- Fixture builders -------------------------------------------------------

// 1 Hz streams: time[i] = i seconds, distance[i] = 3*i meters, watts from
// a per-second function. Total length totalSeconds + 1 (indices 0..total).
function makeStreams(
  totalSeconds: number,
  wattsAt: (t: number) => number,
): StreamSet {
  const time: Array<number | null> = [];
  const distance: Array<number | null> = [];
  const watts: Array<number | null> = [];
  for (let i = 0; i <= totalSeconds; i++) {
    time.push(i);
    distance.push(3 * i);
    watts.push(wattsAt(i));
  }
  return { time, distance, watts };
}

function iv(
  start: number,
  end: number,
  avgW: number,
  type = "WORK",
): DetectedInterval {
  return {
    id: start,
    start_index: start,
    end_index: end,
    moving_time: end - start,
    average_watts: avgW,
    type,
    label: null,
  };
}

// Warmup 4mi Z1 + 6x (0.1km Z5 / 0.2km Z1) + Cooldown 0.3km Z1.
// At 3 m/s the plan windows end at 2146, 2180, 2246, 2280, 2346, 2380,
// 2446, 2480, 2546, 2580, 2646, 2680, 2746, 2846 seconds.
const stridesPlan: StoredWorkoutJson = {
  version: 1,
  sport: "Run",
  target_metric: "power",
  sections: [
    { name: "Warmup", steps: [{ distance: { mi: 4 }, target: { zone: 1 } }] },
    {
      name: "Strides",
      repeat: 6,
      steps: [
        { distance: { km: 0.1 }, target: { zone: 5 }, label: "Stride {n}" },
        { distance: { km: 0.2 }, target: { zone: 1 } },
      ],
    },
    {
      name: "Cooldown",
      steps: [{ distance: { km: 0.3 }, target: { zone: 1 } }],
    },
  ],
};

const stridesIntervals: DetectedInterval[] = [
  iv(0, 2146, 200, "RECOVERY"),
  iv(2146, 2179, 350),
  iv(2179, 2246, 200, "RECOVERY"),
  iv(2246, 2279, 352),
  iv(2279, 2346, 198, "RECOVERY"),
  iv(2346, 2379, 348),
  iv(2379, 2446, 201, "RECOVERY"),
  iv(2446, 2479, 351),
  iv(2479, 2546, 199, "RECOVERY"),
  iv(2546, 2579, 349),
  iv(2579, 2646, 202, "RECOVERY"),
  iv(2646, 2679, 353),
  iv(2679, 2746, 197, "RECOVERY"),
  iv(2746, 2846, 190, "RECOVERY"),
];

function stridesWattsAt(t: number): number {
  for (const x of stridesIntervals) {
    if (
      typeof x.start_index === "number" &&
      typeof x.end_index === "number" &&
      t >= x.start_index &&
      t < x.end_index
    ) {
      return (x.average_watts as number) ?? 200;
    }
  }
  return 190;
}

// Flat threshold plan (a repeat would add a trailing rest — see the
// Nov 8 note in MEMORY.md). Flat steps carry explicit types: the
// normalizer would default every step in a non-repeat section to work.
const thresholdPlan: StoredWorkoutJson = {
  version: 1,
  sport: "Run",
  target_metric: "power",
  sections: [
    {
      name: "Warmup",
      steps: [{ duration: { minutes: 10 }, target: { zone: 1 } }],
    },
    {
      name: "Threshold",
      steps: [
        {
          duration: { minutes: 20 },
          target: { zone: 4 },
          type: "work",
          label: "Rep 1",
        },
        {
          duration: { minutes: 5 },
          target: { zone: 1 },
          type: "recovery",
          label: "Rest 1",
        },
        {
          duration: { minutes: 20 },
          target: { zone: 4 },
          type: "work",
          label: "Rep 2",
        },
      ],
    },
    {
      name: "Cooldown",
      steps: [{ duration: { minutes: 10 }, target: { zone: 1 } }],
    },
  ],
};

const thresholdIntervals: DetectedInterval[] = [
  iv(0, 600, 200, "RECOVERY"),
  iv(600, 1800, 290),
  iv(1800, 2100, 190, "RECOVERY"),
  iv(2100, 3300, 288),
  iv(3300, 3900, 185, "RECOVERY"),
];

const easyPlan: StoredWorkoutJson = {
  version: 1,
  sport: "Run",
  target_metric: "power",
  sections: [
    {
      name: "Easy",
      steps: [{ distance: { mi: 5 }, target: { zone: 1 } }],
    },
  ],
};

function labelsOf(spec: LabelSpecEntry[]): Array<[string, string]> {
  return spec.map((e) => [e.type, e.label]);
}

// --- Glitch + session label -------------------------------------------------

test("isGlitch mirrors the critique script rule", () => {
  assert.equal(isGlitch({ average_watts: 0, moving_time: 60 }), true);
  assert.equal(isGlitch({ average_watts: 49, moving_time: 119 }), true);
  assert.equal(isGlitch({ average_watts: 200, moving_time: 60 }), false);
  assert.equal(isGlitch({ average_watts: 40, moving_time: 200 }), false);
  assert.equal(isGlitch({ average_watts: 300, moving_time: 7 }), true);
  assert.equal(isGlitch({ average_watts: 300, moving_time: 10 }), false);
  assert.equal(isGlitch({}), true); // no data: 0W and 0s
});

test("sessionLabel mirrors the critique script rule", () => {
  assert.equal(sessionLabel("Recovery 4mi"), "Recovery");
  assert.equal(sessionLabel("Long 12mi"), "Long Run");
  assert.equal(sessionLabel("Easy 5mi"), "Easy");
  assert.equal(sessionLabel("As Is Aerobic 6mi"), "Easy");
  assert.equal(sessionLabel(undefined), "Easy");
});

// --- Streams ----------------------------------------------------------------

test("extractStreams unwraps the array form and keeps index alignment", () => {
  const s = extractStreams([
    { type: "time", data: [0, 1, 2] },
    { type: "distance", data: [0, 3, 6] },
    { type: "watts", data: [200, null, 210] },
  ]);
  assert.deepEqual(s.time, [0, 1, 2]);
  assert.deepEqual(s.distance, [0, 3, 6]);
  assert.deepEqual(s.watts, [200, null, 210]);
});

test("extractStreams accepts a keyed object defensively", () => {
  const s = extractStreams({ time: [0, 1], distance: [0, 3] });
  assert.deepEqual(s.time, [0, 1]);
  assert.deepEqual(s.distance, [0, 3]);
  assert.deepEqual(s.watts, []);
});

// --- Strides ----------------------------------------------------------------

test("strides run derives the plan spec (Warmup / Stride N / Easy / Cooldown)", () => {
  const r = deriveLabelSpec({
    steps: expandSteps(stridesPlan),
    eventName: "Easy 5mi + Strides",
    detected: stridesIntervals,
    streams: makeStreams(2846, stridesWattsAt),
    movingTime: 2846,
    cp: 278,
  });
  assert.equal(r.status, "ok");
  if (r.status !== "ok") return;
  assert.equal(r.planSteps, 14);
  assert.equal(r.extraCount, 0);
  assert.equal(r.warnings.length, 0);
  assert.ok(r.maxBoundaryDeviationSec <= 1);
  assert.deepEqual(labelsOf(r.spec), [
    ["RECOVERY", "Warmup"],
    ["WORK", "Stride 1"],
    ["RECOVERY", "Easy"],
    ["WORK", "Stride 2"],
    ["RECOVERY", "Easy"],
    ["WORK", "Stride 3"],
    ["RECOVERY", "Easy"],
    ["WORK", "Stride 4"],
    ["RECOVERY", "Easy"],
    ["WORK", "Stride 5"],
    ["RECOVERY", "Easy"],
    ["WORK", "Stride 6"],
    ["RECOVERY", "Easy"],
    ["RECOVERY", "Cooldown"],
  ]);
  assert.deepEqual(
    r.spec.map((e) => [e.start_index, e.end_index]),
    stridesIntervals.map((x) => [x.start_index, x.end_index]),
  );
});

// --- Threshold ---------------------------------------------------------------

test("threshold run derives Rep 1 / Rest 1 / Rep 2 with flat steps", () => {
  const r = deriveLabelSpec({
    steps: expandSteps(thresholdPlan),
    eventName: "Threshold 2x20",
    detected: thresholdIntervals,
    streams: makeStreams(3900, () => 250),
    movingTime: 3900,
    cp: 278,
  });
  assert.equal(r.status, "ok");
  if (r.status !== "ok") return;
  assert.equal(r.planSteps, 5);
  assert.equal(r.maxBoundaryDeviationSec, 0);
  assert.deepEqual(labelsOf(r.spec), [
    ["RECOVERY", "Warmup"],
    ["WORK", "Rep 1"],
    ["RECOVERY", "Rest 1"],
    ["WORK", "Rep 2"],
    ["RECOVERY", "Cooldown"],
  ]);
});

test("threshold run: a rep split in two merges into one Rep entry", () => {
  const split = [
    iv(0, 600, 200, "RECOVERY"),
    iv(600, 1200, 290),
    iv(1200, 1800, 288),
    iv(1800, 2100, 190, "RECOVERY"),
    iv(2100, 3300, 288),
    iv(3300, 3900, 185, "RECOVERY"),
  ];
  const r = deriveLabelSpec({
    steps: expandSteps(thresholdPlan),
    eventName: "Threshold 2x20",
    detected: split,
    streams: makeStreams(3900, () => 250),
    movingTime: 3900,
    cp: 278,
  });
  assert.equal(r.status, "ok");
  if (r.status !== "ok") return;
  assert.equal(r.spec.length, 5);
  assert.deepEqual(
    r.spec.map((e) => [e.start_index, e.end_index, e.label]),
    [
      [0, 600, "Warmup"],
      [600, 1800, "Rep 1"],
      [1800, 2100, "Rest 1"],
      [2100, 3300, "Rep 2"],
      [3300, 3900, "Cooldown"],
    ],
  );
});

// --- Easy --------------------------------------------------------------------

test("easy run: one session label across non-glitch intervals, types kept", () => {
  const detected = [
    iv(0, 900, 200, "WORK"),
    iv(900, 960, 0, "WORK"), // 0W dropout, 60s — glitch
    iv(960, 1800, 195, "RECOVERY"),
    iv(1800, 2700, 205, "WORK"),
    iv(2700, 2707, 0, "WORK"), // trailing 7s sliver — glitch
  ];
  const r = deriveLabelSpec({
    steps: expandSteps(easyPlan),
    eventName: "Easy 5mi",
    detected,
    streams: makeStreams(2707, () => 200),
    movingTime: 2707,
    cp: 278,
  });
  assert.equal(r.status, "ok");
  if (r.status !== "ok") return;
  assert.deepEqual(labelsOf(r.spec), [
    ["WORK", "Easy"],
    ["RECOVERY", "Easy"],
    ["WORK", "Easy"],
  ]);
  assert.deepEqual(
    r.spec.map((e) => [e.start_index, e.end_index]),
    [
      [0, 900],
      [960, 1800],
      [1800, 2700],
    ],
  );
});

test("easy run: session label comes from the event name", () => {
  const detected = [iv(0, 900, 200, "WORK"), iv(900, 1800, 195, "RECOVERY")];
  const long = deriveLabelSpec({
    steps: expandSteps(easyPlan),
    eventName: "Long 12mi",
    detected,
    streams: makeStreams(1800, () => 200),
    movingTime: 1800,
    cp: 278,
  });
  assert.equal(long.status, "ok");
  if (long.status === "ok") {
    assert.deepEqual(labelsOf(long.spec), [
      ["WORK", "Long Run"],
      ["RECOVERY", "Long Run"],
    ]);
  }
});

// --- Alignment failures -------------------------------------------------------

test("a plan step with no detected interval aborts (count gate)", () => {
  const missingCooldown = thresholdIntervals.slice(0, 4);
  const r = deriveLabelSpec({
    steps: expandSteps(thresholdPlan),
    eventName: "Threshold 2x20",
    detected: missingCooldown,
    streams: makeStreams(3900, () => 250),
    movingTime: 3900,
    cp: 278,
  });
  assert.equal(r.status, "aborted");
  if (r.status === "aborted") {
    assert.equal(r.reason, "alignment_mismatch");
    assert.equal(r.detail.unmatched_plan_steps[0].label, "Cooldown");
  }
});

test("a detected interval straddling two plan windows aborts", () => {
  const straddling = [
    iv(0, 600, 200, "RECOVERY"),
    iv(600, 1800, 290),
    iv(1900, 2500, 250), // spans the Rest 1 / Rep 2 boundary at 2100
    iv(3300, 3900, 185, "RECOVERY"),
  ];
  const r = deriveLabelSpec({
    steps: expandSteps(thresholdPlan),
    eventName: "Threshold 2x20",
    detected: straddling,
    streams: makeStreams(3900, () => 250),
    movingTime: 3900,
    cp: 278,
  });
  assert.equal(r.status, "aborted");
  if (r.status === "aborted") {
    assert.equal(r.reason, "alignment_mismatch");
    assert.match(String(r.detail.message), /straddles/);
  }
});

// --- Extras -------------------------------------------------------------------

test("extra intervals beyond the plan are classified by average zone", () => {
  const detected = [
    ...stridesIntervals,
    iv(2846, 3146, 180, "RECOVERY"), // < 80% of 278 (222W) -> Extra Recovery
    iv(3146, 3266, 300), // >= 222W -> Extra Work
  ];
  const r = deriveLabelSpec({
    steps: expandSteps(stridesPlan),
    eventName: "Easy 5mi + Strides",
    detected,
    streams: makeStreams(3266, stridesWattsAt),
    movingTime: 3266,
    cp: 278,
  });
  assert.equal(r.status, "ok");
  if (r.status !== "ok") return;
  assert.equal(r.extraCount, 2);
  assert.equal(r.spec.length, 16);
  const tail = r.spec.slice(-2);
  assert.deepEqual(
    tail.map((e) => [e.type, e.label, e.extra]),
    [
      ["RECOVERY", "Extra Recovery 1", true],
      ["WORK", "Extra Work 1", true],
    ],
  );
});

test("extra intervals with no resolvable CP abort (no_power_zones)", () => {
  const detected = [...stridesIntervals, iv(2846, 3146, 180, "RECOVERY")];
  const r = deriveLabelSpec({
    steps: expandSteps(stridesPlan),
    eventName: "Easy 5mi + Strides",
    detected,
    streams: makeStreams(3146, stridesWattsAt),
    movingTime: 3146,
    cp: null,
  });
  assert.equal(r.status, "aborted");
  if (r.status === "aborted") {
    assert.equal(r.reason, "no_power_zones");
  }
});

// --- Sparse streams ------------------------------------------------------------

test("empty streams abort (sparse_streams)", () => {
  const r = deriveLabelSpec({
    steps: expandSteps(thresholdPlan),
    eventName: "Threshold 2x20",
    detected: thresholdIntervals,
    streams: { time: [], distance: [], watts: [] },
    movingTime: 3900,
    cp: 278,
  });
  assert.equal(r.status, "aborted");
  if (r.status === "aborted") assert.equal(r.reason, "sparse_streams");
});

test("too few time samples for the moving time abort (sparse_streams)", () => {
  const sparse = makeStreams(1000, () => 250); // 1001 samples vs 3900s
  const r = deriveLabelSpec({
    steps: expandSteps(thresholdPlan),
    eventName: "Threshold 2x20",
    detected: thresholdIntervals,
    streams: sparse,
    movingTime: 3900,
    cp: 278,
  });
  assert.equal(r.status, "aborted");
  if (r.status === "aborted") assert.equal(r.reason, "sparse_streams");
});

// --- Idempotency / verification -------------------------------------------------

test("verifySpec + isAlreadyLabeled: exact match is a no-op, a differing label is not", () => {
  const spec: LabelSpecEntry[] = [
    { start_index: 0, end_index: 600, type: "RECOVERY", label: "Warmup" },
    { start_index: 600, end_index: 1800, type: "WORK", label: "Rep 1" },
  ];
  const current: DetectedInterval[] = [
    { start_index: 0, end_index: 600, type: "RECOVERY", label: "Warmup" },
    { start_index: 600, end_index: 1800, type: "WORK", label: "Rep 1" },
  ];
  assert.equal(isAlreadyLabeled(current, spec), true);
  const relabeled: DetectedInterval[] = [
    { start_index: 0, end_index: 600, type: "RECOVERY", label: "Easy" },
    { start_index: 600, end_index: 1800, type: "WORK", label: "Rep 1" },
  ];
  assert.equal(isAlreadyLabeled(relabeled, spec), false);
  const v = verifySpec(relabeled, spec);
  assert.equal(v.matched, false);
  assert.equal(v.mismatches.length, 1);
  assert.equal(v.mismatches[0].expected.label, "Warmup");
  assert.equal(v.mismatches[0].actual?.label, "Easy");
});

// --- Parity with the critique script --------------------------------------------

test("threshold spec matches the critique script's quality branch exactly", () => {
  // classify_and_label on the same intervals: >=2 blocks >=60s at >=90% CP
  // (290W, 288W vs CP 278) -> Rep 1 / Rest 1 / Rep 2 with Warmup/Cooldown.
  const r = deriveLabelSpec({
    steps: expandSteps(thresholdPlan),
    eventName: "Threshold 2x20",
    detected: thresholdIntervals,
    streams: makeStreams(3900, () => 250),
    movingTime: 3900,
    cp: 278,
  });
  assert.equal(r.status, "ok");
  if (r.status !== "ok") return;
  assert.deepEqual(labelsOf(r.spec), [
    ["RECOVERY", "Warmup"],
    ["WORK", "Rep 1"],
    ["RECOVERY", "Rest 1"],
    ["WORK", "Rep 2"],
    ["RECOVERY", "Cooldown"],
  ]);
});

test("strides spec matches the critique script except the warmup label", () => {
  // classify_and_label on strides: first block "Easy", strides "Stride N",
  // middles "Easy", last "Cooldown". The labeler labels the first block
  // "Warmup" instead — the plan knows it is the Warmup section, which is
  // the intended plan-driven improvement over the script's approximation.
  const r = deriveLabelSpec({
    steps: expandSteps(stridesPlan),
    eventName: "Easy 5mi + Strides",
    detected: stridesIntervals,
    streams: makeStreams(2846, stridesWattsAt),
    movingTime: 2846,
    cp: 278,
  });
  assert.equal(r.status, "ok");
  if (r.status !== "ok") return;
  const types = r.spec.map((e) => e.type);
  assert.deepEqual(types, [
    "RECOVERY",
    "WORK",
    "RECOVERY",
    "WORK",
    "RECOVERY",
    "WORK",
    "RECOVERY",
    "WORK",
    "RECOVERY",
    "WORK",
    "RECOVERY",
    "WORK",
    "RECOVERY",
    "RECOVERY",
  ]);
  assert.equal(r.spec[0].label, "Warmup"); // script would say "Easy"
  assert.deepEqual(
    r.spec.slice(1).map((e) => e.label),
    [
      "Stride 1",
      "Easy",
      "Stride 2",
      "Easy",
      "Stride 3",
      "Easy",
      "Stride 4",
      "Easy",
      "Stride 5",
      "Easy",
      "Stride 6",
      "Easy",
      "Cooldown",
    ],
  );
});
