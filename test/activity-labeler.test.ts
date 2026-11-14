// Unit tests for the activity-interval auto-labeler (issue #163).
// The labeler builds intervals directly from the plan (no detected
// intervals needed). Run with: npm test (node --test, type stripping)
import test from "node:test";
import assert from "node:assert/strict";
import {
  deriveLabelSpec,
  extractStreams,
  isAlreadyLabeled,
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

// Streams sampled every `step` seconds: time[i] = i*step, distance[i] =
// 3*i*step meters (3 m/s), watts from a per-second function. Length is
// floor(totalSeconds / step) + 1.
function makeStreams(
  totalSeconds: number,
  wattsAt: (t: number) => number,
  step = 1,
): StreamSet {
  const time: Array<number | null> = [];
  const distance: Array<number | null> = [];
  const watts: Array<number | null> = [];
  const n = Math.floor(totalSeconds / step) + 1;
  for (let i = 0; i < n; i++) {
    time.push(i * step);
    distance.push(3 * i * step);
    watts.push(wattsAt(i * step));
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

// Stryd-style 5-zone table (upper-bound percentages of CP).
const STRYD_ZONES = [80, 90, 100, 115, 999];
const CP = 278;

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

const STRIDE_WORK: Array<[number, number]> = [
  [2146, 2180],
  [2246, 2280],
  [2346, 2380],
  [2446, 2480],
  [2546, 2580],
  [2646, 2680],
];

function stridesWattsAt(t: number): number {
  for (const [a, b] of STRIDE_WORK) {
    if (t >= a && t < b) return 350;
  }
  if (t >= 2746) return 190; // cooldown
  return 200; // warmup + recoveries
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

// Multi-section easy plan: every step is easy, so the whole activity is
// one interval with the session label.
const easySectionsPlan: StoredWorkoutJson = {
  version: 1,
  sport: "Run",
  target_metric: "power",
  sections: [
    { name: "Warmup", steps: [{ distance: { mi: 1 }, target: { zone: 1 } }] },
    { name: "Easy", steps: [{ distance: { mi: 3 }, target: { zone: 1 } }] },
    {
      name: "Cooldown",
      steps: [{ distance: { km: 0.5 }, target: { zone: 1 } }],
    },
  ],
};

function labelsOf(spec: LabelSpecEntry[]): Array<[string, string]> {
  return spec.map((e) => [e.type, e.label]);
}

function derive(
  plan: StoredWorkoutJson,
  opts: {
    eventName?: string;
    streams: StreamSet;
    movingTime: number;
    cp?: number | null;
    zones?: number[] | null;
    targetMetric?: string | null;
  },
) {
  return deriveLabelSpec({
    steps: expandSteps(plan),
    eventName: opts.eventName ?? "Test",
    streams: opts.streams,
    movingTime: opts.movingTime,
    cp: opts.cp !== undefined ? opts.cp : CP,
    zones: opts.zones !== undefined ? opts.zones : STRYD_ZONES,
    targetMetric: opts.targetMetric !== undefined ? opts.targetMetric : "power",
  });
}

// --- Session label ----------------------------------------------------------

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

test("strides run builds the plan intervals (Warmup / Stride N / Easy / Cooldown)", () => {
  const r = derive(stridesPlan, {
    eventName: "Easy 5mi + Strides",
    streams: makeStreams(2846, stridesWattsAt),
    movingTime: 2846,
  });
  assert.equal(r.status, "ok");
  if (r.status !== "ok") return;
  assert.equal(r.planSteps, 14);
  assert.equal(r.extraCount, 0);
  // The last recovery and the Cooldown are adjacent RECOVERY steps, so
  // they merge into one interval labeled Cooldown — 13 entries, not 14.
  assert.equal(r.spec.length, 13);
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
    ["RECOVERY", "Cooldown"],
  ]);
  assert.deepEqual(
    r.spec.map((e) => [e.start_index, e.end_index]),
    [
      [0, 2146],
      [2146, 2180],
      [2180, 2246],
      [2246, 2280],
      [2280, 2346],
      [2346, 2380],
      [2380, 2446],
      [2446, 2480],
      [2480, 2546],
      [2546, 2580],
      [2580, 2646],
      [2646, 2680],
      [2680, 2847],
    ],
  );
  // One merge warning (recovery + cooldown); no zone warnings — the
  // strides average 350W against a Z5 floor of 256W.
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /merged into one interval labeled "Cooldown"/);
});

test("strides run at 3 s sampling builds the same intervals (coverage gate, not density)", () => {
  const streams = makeStreams(2846, stridesWattsAt, 3);
  assert.equal(streams.time.length, 949); // 1136 samples would be the dummy's 3 s run
  const r = derive(stridesPlan, {
    eventName: "Easy 5mi + Strides",
    streams,
    movingTime: 2846,
  });
  assert.equal(r.status, "ok");
  if (r.status !== "ok") return;
  assert.equal(r.spec.length, 13);
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
    ["RECOVERY", "Cooldown"],
  ]);
  assert.equal(r.spec[0].start_index, 0);
  assert.equal(r.spec[r.spec.length - 1].end_index, streams.time.length);
  // Boundaries land within one sample (3 s) of the 1 Hz positions.
  assert.ok(Math.abs(r.spec[1].start_index * 3 - 2146) <= 3);
  assert.ok(Math.abs(r.spec[1].end_index * 3 - 2180) <= 3);
});

// --- Threshold ---------------------------------------------------------------

test("threshold run builds Rep 1 / Rest 1 / Rep 2 with flat steps", () => {
  const r = derive(thresholdPlan, {
    eventName: "Threshold 2x20",
    streams: makeStreams(3900, (t) =>
      t >= 600 && t < 1800 ? 290 : t >= 2100 && t < 3300 ? 288 : 200,
    ),
    movingTime: 3900,
  });
  assert.equal(r.status, "ok");
  if (r.status !== "ok") return;
  assert.equal(r.planSteps, 5);
  assert.equal(r.warnings.length, 0);
  assert.deepEqual(labelsOf(r.spec), [
    ["RECOVERY", "Warmup"],
    ["WORK", "Rep 1"],
    ["RECOVERY", "Rest 1"],
    ["WORK", "Rep 2"],
    ["RECOVERY", "Cooldown"],
  ]);
  assert.deepEqual(
    r.spec.map((e) => [e.start_index, e.end_index]),
    [
      [0, 600],
      [600, 1800],
      [1800, 2100],
      [2100, 3300],
      [3300, 3901],
    ],
  );
});

// --- Easy --------------------------------------------------------------------

test("easy run: one interval for the whole activity, session label", () => {
  const streams = makeStreams(2707, () => 200);
  const r = derive(easyPlan, {
    eventName: "Easy 5mi",
    streams,
    movingTime: 2707,
  });
  assert.equal(r.status, "ok");
  if (r.status !== "ok") return;
  assert.deepEqual(r.spec, [
    {
      start_index: 0,
      end_index: 2708,
      type: "RECOVERY",
      label: "Easy",
    },
  ]);
});

test("easy run: session label comes from the event name, sections merged", () => {
  const streams = makeStreams(2000, () => 200);
  const r = derive(easySectionsPlan, {
    eventName: "Long 12mi",
    streams,
    movingTime: 2000,
  });
  assert.equal(r.status, "ok");
  if (r.status === "ok") {
    assert.equal(r.spec.length, 1);
    assert.equal(r.spec[0].label, "Long Run");
    assert.equal(r.spec[0].type, "RECOVERY");
  }
});

// --- Zone check ---------------------------------------------------------------

test("a work window far below its zone floor warns instead of aborting", () => {
  const r = derive(thresholdPlan, {
    eventName: "Threshold 2x20",
    streams: makeStreams(3900, () => 100), // everything at 100W
    movingTime: 3900,
  });
  assert.equal(r.status, "ok");
  if (r.status !== "ok") return;
  assert.equal(r.spec.length, 5);
  const zoneWarnings = r.warnings.filter((w) => w.includes("below the"));
  assert.equal(zoneWarnings.length, 2);
  assert.match(zoneWarnings[0], /Step "Rep 1" averaged 100W, below the Z4 floor of 222W/);
  assert.match(zoneWarnings[1], /Step "Rep 2" averaged 100W, below the Z4 floor of 222W/);
});

test("zone check is skipped without power data or zones", () => {
  const noZones = derive(thresholdPlan, {
    eventName: "Threshold 2x20",
    streams: makeStreams(3900, () => 100),
    movingTime: 3900,
    cp: null,
    zones: null,
  });
  assert.equal(noZones.status, "ok");
  if (noZones.status === "ok") {
    assert.equal(noZones.warnings.length, 1);
    assert.match(noZones.warnings[0], /No power data or power zones/);
  }
  const hrPlan = derive(thresholdPlan, {
    eventName: "Threshold 2x20",
    streams: makeStreams(3900, () => 100),
    movingTime: 3900,
    targetMetric: "hr",
  });
  assert.equal(hrPlan.status, "ok");
  if (hrPlan.status === "ok") {
    assert.equal(hrPlan.warnings.length, 0);
  }
});

// --- Extras -------------------------------------------------------------------

test("extra easy time past the plan is absorbed into the Cooldown", () => {
  const r = derive(stridesPlan, {
    eventName: "Easy 5mi + Strides",
    streams: makeStreams(3146, (t) => (t >= 2846 ? 180 : stridesWattsAt(t))),
    movingTime: 3146,
  });
  assert.equal(r.status, "ok");
  if (r.status !== "ok") return;
  assert.equal(r.extraCount, 1);
  assert.equal(r.spec.length, 13);
  assert.deepEqual(r.spec[r.spec.length - 1], {
    start_index: 2680,
    end_index: 3147,
    type: "RECOVERY",
    label: "Cooldown",
  });
  assert.ok(r.warnings.some((w) => w.includes("Extra Recovery 1")));
});

test("extra hard time past the plan is a separate Extra Work entry", () => {
  const r = derive(stridesPlan, {
    eventName: "Easy 5mi + Strides",
    streams: makeStreams(2966, (t) => (t >= 2846 ? 300 : stridesWattsAt(t))),
    movingTime: 2966,
  });
  assert.equal(r.status, "ok");
  if (r.status !== "ok") return;
  assert.equal(r.extraCount, 1);
  assert.equal(r.spec.length, 14);
  assert.deepEqual(r.spec[r.spec.length - 1], {
    start_index: 2846,
    end_index: 2967,
    type: "WORK",
    label: "Extra Work 1",
    extra: true,
  });
});

test("extra time with no resolvable CP aborts (no_power_zones)", () => {
  const r = derive(stridesPlan, {
    eventName: "Easy 5mi + Strides",
    streams: makeStreams(3146, (t) => (t >= 2846 ? 180 : stridesWattsAt(t))),
    movingTime: 3146,
    cp: null,
    zones: null,
  });
  assert.equal(r.status, "aborted");
  if (r.status === "aborted") {
    assert.equal(r.reason, "no_power_zones");
  }
});

// --- Truncation ---------------------------------------------------------------

test("recorded data ending mid-plan truncates at the open-ended step", () => {
  const r = derive(stridesPlan, {
    eventName: "Easy 5mi + Strides",
    streams: makeStreams(2700, stridesWattsAt),
    movingTime: 2700,
  });
  assert.equal(r.status, "ok");
  if (r.status !== "ok") return;
  // The S6 recovery window never resolves (data ends at 2700s); the
  // Cooldown is not reached. 13 entries, last is the open-ended recovery,
  // extended to the full stream (2701 samples, indices 0..2700).
  assert.equal(r.spec.length, 13);
  assert.deepEqual(r.spec[r.spec.length - 1], {
    start_index: 2680,
    end_index: 2701,
    type: "RECOVERY",
    label: "Easy",
  });
  assert.ok(
    r.warnings.some((w) =>
      w.includes('Recorded data ends during "Easy" — 1 later step was not reached.'),
    ),
  );
});

test("recorded data never reaching the first plan step aborts", () => {
  const r = derive(stridesPlan, {
    eventName: "Easy 5mi + Strides",
    streams: makeStreams(1000, () => 200),
    movingTime: 1000,
  });
  assert.equal(r.status, "aborted");
  if (r.status === "aborted") {
    assert.equal(r.reason, "alignment_mismatch");
    assert.match(String(r.detail.message), /never reaches the first plan step/);
  }
});

test("a step shorter than the stream sampling is extended by one sample", () => {
  const tinyPlan: StoredWorkoutJson = {
    version: 1,
    sport: "Run",
    target_metric: "power",
    sections: [
      {
        name: "Warmup",
        steps: [{ duration: { seconds: 601 }, target: { zone: 1 } }],
      },
      {
        name: "Threshold",
        steps: [
          {
            duration: { seconds: 1 },
            target: { zone: 4 },
            type: "work",
            label: "Rep 1",
          },
        ],
      },
      {
        name: "Cooldown",
        steps: [{ duration: { seconds: 600 }, target: { zone: 1 } }],
      },
    ],
  };
  const r = derive(tinyPlan, {
    eventName: "Tiny",
    streams: makeStreams(1202, (t) => (t >= 600 && t < 610 ? 350 : 200), 3),
    movingTime: 1202,
  });
  assert.equal(r.status, "ok");
  if (r.status !== "ok") return;
  assert.equal(r.spec.length, 3);
  // The 1 s rep [601–602] lands inside one 3 s sample; it is extended
  // to a single sample instead of collapsing to an empty interval.
  assert.deepEqual(
    r.spec.map((e) => [e.start_index, e.end_index, e.label]),
    [
      [0, 201, "Warmup"],
      [201, 202, "Rep 1"],
      [202, 401, "Cooldown"],
    ],
  );
  assert.ok(r.warnings.some((w) => w.includes("shorter than the stream sampling")));
});

// --- Sparse streams ------------------------------------------------------------

test("empty streams abort (sparse_streams)", () => {
  const r = derive(thresholdPlan, {
    eventName: "Threshold 2x20",
    streams: { time: [], distance: [], watts: [] },
    movingTime: 3900,
  });
  assert.equal(r.status, "aborted");
  if (r.status === "aborted") assert.equal(r.reason, "sparse_streams");
});

test("too few time samples for the moving time abort (sparse_streams)", () => {
  // 100 samples spread over 3900 s (39 s spacing): fails the count rule.
  const time: Array<number | null> = [];
  const distance: Array<number | null> = [];
  const watts: Array<number | null> = [];
  for (let i = 0; i < 100; i++) {
    time.push(i * 39);
    distance.push(3 * i * 39);
    watts.push(250);
  }
  const r = derive(thresholdPlan, {
    eventName: "Threshold 2x20",
    streams: { time, distance, watts },
    movingTime: 3900,
  });
  assert.equal(r.status, "aborted");
  if (r.status === "aborted") assert.equal(r.reason, "sparse_streams");
});

test("a time stream that stops before the activity ends aborts (sparse_streams)", () => {
  // 1001 samples at 1 Hz, but the activity ran 3900 s: fails coverage.
  const r = derive(thresholdPlan, {
    eventName: "Threshold 2x20",
    streams: makeStreams(1000, () => 250),
    movingTime: 3900,
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
  const r = derive(thresholdPlan, {
    eventName: "Threshold 2x20",
    streams: makeStreams(3900, (t) =>
      t >= 600 && t < 1800 ? 290 : t >= 2100 && t < 3300 ? 288 : 200,
    ),
    movingTime: 3900,
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
  // The trailing recovery + Cooldown merge into one "Cooldown" interval.
  const r = derive(stridesPlan, {
    eventName: "Easy 5mi + Strides",
    streams: makeStreams(2846, stridesWattsAt),
    movingTime: 2846,
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
      "Cooldown",
    ],
  );
});
