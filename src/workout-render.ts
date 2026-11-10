// Structured workout JSON (issue #164) — validation, DSL rendering, comment
// round-trip, patch-merge, and verification for `intervals_create_event` /
// `intervals_update_event` (`workout` / `workout_patch` / `caption` params).
//
// Design (see GitHub issue #164 for the full spec):
// - Agents pass a workout as structured JSON; the server renders it to
//   Intervals DSL text, appends the canonical JSON as a single-line HTML
//   comment, and verifies the created/updated event by re-fetching it.
// - The JSON is NEVER pushed as `workout_doc` (the server strips it on
//   async recalc and the chart renders empty).
// - DSL IS re-parsed on UPDATE (verified live 2026-11-08): new DSL lines
//   append, existing step lines edit in place. Plain prose with numeric
//   tokens is ignored by the parser in every tested position, so the
//   caption goes in verbatim and no sanitization is needed.
// - HTML comments are ignored by the parser even with numeric tokens
//   inside, persist in the description, are hidden in the calendar popup,
//   and show as raw text in the Edit dialog.
//
// This module is pure (no I/O): it takes JSON in and returns strings /
// throws structured errors. The Intervals calls live in intervals.ts.

import { z } from "zod";

// ---------------------------------------------------------------------------
// Error reporting (issue #164, "Error reporting" section)
// ---------------------------------------------------------------------------
// Handlers throw Error per the repo convention; the MCP layer surfaces the
// message to the agent. Every error from the workout path starts with a
// stable code in brackets, then a one-line summary, then a compact-JSON
// `detail` block, then a `hint` naming the next step.

export type WorkoutErrorCode =
  | "WORKOUT_VALIDATION"
  | "WORKOUT_RENDER"
  | "WORKOUT_VERIFY_MISMATCH"
  | "WORKOUT_LOAD_OVERRIDE_FAILED"
  | "WORKOUT_NO_STORED_JSON"
  | "WORKOUT_PATCH"
  | "INTERVALS_HTTP_ERROR";

export function workoutError(
  code: WorkoutErrorCode,
  summary: string,
  detail: Record<string, unknown>,
  hint: string,
): Error {
  return new Error(
    `[${code}] ${summary}\ndetail: ${JSON.stringify(detail)}\nhint: ${hint}`,
  );
}

export function isWorkoutError(e: unknown): boolean {
  return (
    e instanceof Error &&
    /^\[(WORKOUT_VALIDATION|WORKOUT_RENDER|WORKOUT_VERIFY_MISMATCH|WORKOUT_LOAD_OVERRIDE_FAILED|WORKOUT_NO_STORED_JSON|WORKOUT_PATCH|INTERVALS_HTTP_ERROR)\]/.test(
      e.message,
    )
  );
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// Wrap an Intervals fetch failure as INTERVALS_HTTP_ERROR. `intervalsFetch`
// throws IntervalsHttpError (status/method/path/body attached) or a network
// TypeError; anything else is passed through unchanged.
export function toIntervalsError(
  e: unknown,
  flowStep: string,
  eventId?: string | number,
): Error {
  if (isWorkoutError(e)) return e as Error;
  const anyE = e as {
    status?: unknown;
    method?: unknown;
    path?: unknown;
    body?: unknown;
    message?: unknown;
  };
  let status: number | null = null;
  let method = "";
  let path = "";
  let body = "";
  if (typeof anyE?.status === "number") {
    status = anyE.status;
    method = typeof anyE.method === "string" ? anyE.method : "";
    path = typeof anyE.path === "string" ? anyE.path : "";
    body = typeof anyE.body === "string" ? anyE.body : messageOf(e);
  } else {
    // Fall back to parsing the `Intervals <METHOD> <path> → <status>: <body>`
    // message shape (the intervalsFetch throw format).
    const m = /^Intervals (\S+) (\S+) → (\d+): ([\s\S]*)$/.exec(messageOf(e));
    if (m) {
      method = m[1];
      path = m[2];
      status = Number(m[3]);
      body = m[4];
    } else {
      body = messageOf(e);
    }
  }
  const retryable = status === null || status === 429 || status >= 500;
  const summary =
    status === null
      ? `Intervals request failed during ${flowStep} (no HTTP response — network error).`
      : `Intervals ${method} ${path} → ${status} during ${flowStep}.`;
  return workoutError(
    "INTERVALS_HTTP_ERROR",
    summary,
    {
      flow_step: flowStep,
      ...(eventId !== undefined ? { event_id: eventId } : {}),
      ...(status !== null ? { status } : {}),
      ...(method ? { method } : {}),
      ...(path ? { path } : {}),
      body: body.slice(0, 2048),
      retryable,
    },
    retryable
      ? "Transient upstream failure — retry the call."
      : status === 400 || status === 422
        ? "The payload was rejected — fix the request and retry."
        : status === 401 || status === 403
          ? "Authentication/authorization failure — not fixable by the agent; the athlete needs to re-connect Intervals.icu."
          : "Upstream failure — inspect the body and retry or fix the request.",
  );
}

// ---------------------------------------------------------------------------
// Schema (v1)
// ---------------------------------------------------------------------------

export const TARGET_METRICS = ["power", "hr", "pace"] as const;
export type WorkoutTargetMetric = (typeof TARGET_METRICS)[number];

const METRIC_SUFFIX: Record<WorkoutTargetMetric, string> = {
  power: "Power",
  hr: "HR",
  pace: "Pace",
};

// A step's length: exactly one of distance / duration. Single object with
// all-optional keys + an exactly-one refine (rather than a union) so a bad
// value fails with a precise path instead of a bare "Invalid input" union
// error.
const lengthSchema = z
  .object({
    mi: z.number().positive().optional(),
    km: z.number().positive().optional(),
    m: z.number().positive().optional(),
    minutes: z.number().positive().optional(),
    seconds: z.number().positive().optional(),
    hours: z.number().positive().optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    const keys = ["mi", "km", "m", "minutes", "seconds", "hours"].filter(
      (k) => (v as Record<string, unknown>)[k] !== undefined,
    );
    if (keys.length !== 1) {
      ctx.addIssue({
        code: "custom",
        message: `exactly one of mi/km/m/minutes/seconds/hours is required, got: ${keys.join(", ") || "(none)"}`,
      });
    }
  });

const zoneValueSchema = z.union(
  [
    z.number().int().min(1).max(7),
    z.tuple([
      z.number().int().min(1).max(7),
      z.number().int().min(1).max(7),
    ]),
    z.literal("SS"),
  ],
  { error: 'zone must be 1-7, a [lo,hi] range, or "SS"' },
);

const pctValueSchema = z.union(
  [
    z.number().positive().max(300),
    z.tuple([
      z.number().positive().max(300),
      z.number().positive().max(300),
    ]),
  ],
  { error: "pct must be a number or a [lo,hi] range" },
);

const wattsValueSchema = z.union(
  [z.number().positive(), z.tuple([z.number().positive(), z.number().positive()])],
  { error: "watts must be a number or a [lo,hi] range" },
);

// Absolute pace, "m:ss" per mi or per km.
const paceStringSchema = z
  .string()
  .regex(/^\d{1,2}:[0-5]\d\/(mi|km)$/, 'pace must be "m:ss/mi" or "m:ss/km"');

const paceValueSchema = z.union(
  [paceStringSchema, z.tuple([paceStringSchema, paceStringSchema])],
  { error: 'pace must be "m:ss/mi", "m:ss/km", or a [lo,hi] range of those' },
);

// Ramp ends are single values (a ramp IS a range) in pct or watts.
const rampEndSchema = z
  .object({
    pct: pctValueSchema.optional(),
    pct_of: z.enum(["lthr", "max"]).optional(),
    watts: wattsValueSchema.optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    const keys = ["pct", "watts"].filter(
      (k) => (v as Record<string, unknown>)[k] !== undefined,
    );
    if (keys.length !== 1) {
      ctx.addIssue({
        code: "custom",
        message: `ramp from/to must have exactly one of pct/watts, got: ${keys.join(", ") || "(none)"}`,
      });
    }
    if (v.pct !== undefined && Array.isArray(v.pct)) {
      ctx.addIssue({
        code: "custom",
        path: ["pct"],
        message: "ramp pct must be a single value, not a range",
      });
    }
    if (v.watts !== undefined && Array.isArray(v.watts)) {
      ctx.addIssue({
        code: "custom",
        path: ["watts"],
        message: "ramp watts must be a single value, not a range",
      });
    }
    if (v.pct_of !== undefined && v.pct === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["pct_of"],
        message: "pct_of only applies to pct targets",
      });
    }
  });

// The target is a single object with exactly one target key (rather than a
// union of single-key objects) so a bad value fails with a precise path
// instead of a bare "Invalid input" union error.
const targetSchema = z
  .object({
    zone: zoneValueSchema.optional(),
    pct: pctValueSchema.optional(),
    pct_of: z.enum(["lthr", "max"]).optional(),
    watts: wattsValueSchema.optional(),
    pace: paceValueSchema.optional(),
    ramp: z
      .object({ from: rampEndSchema, to: rampEndSchema })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    const keys = ["zone", "pct", "watts", "pace", "ramp"].filter(
      (k) => (v as Record<string, unknown>)[k] !== undefined,
    );
    if (keys.length !== 1) {
      ctx.addIssue({
        code: "custom",
        message: `target needs exactly one of zone/pct/watts/pace/ramp, got: ${keys.join(", ") || "(none)"}`,
      });
    }
    if (v.pct_of !== undefined && v.pct === undefined && v.ramp === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["pct_of"],
        message: "pct_of only applies to pct targets",
      });
    }
  });

const cadenceSchema = z.union(
  [
    z.number().int().positive(),
    z.tuple([z.number().int().positive(), z.number().int().positive()]),
  ],
  { error: "cadence must be an rpm number or a [lo,hi] range" },
);

const workoutStepSchema = z
  .object({
    distance: lengthSchema.optional(),
    duration: lengthSchema.optional(),
    target: targetSchema,
    type: z.enum(["work", "recovery"]).optional(),
    label: z.string().min(1).optional(),
    cadence: cadenceSchema.optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (
      (v.distance === undefined) === (v.duration === undefined)
    ) {
      ctx.addIssue({
        code: "custom",
        message: "each step needs exactly one of distance or duration",
      });
    }
  });

const workoutSectionSchema = z
  .object({
    name: z.string().min(1),
    repeat: z.number().int().positive().max(99).optional(),
    steps: z.array(workoutStepSchema).min(1),
  })
  .strict();

export const workoutJsonSchema = z
  .object({
    version: z.literal(1, {
      error: "version must be 1 — this server implements workout JSON v1 only",
    }),
    sport: z.string().min(1),
    target_metric: z.enum(TARGET_METRICS),
    sections: z.array(workoutSectionSchema).min(1),
    meta: z
      .object({ planned_load: z.number().int().positive().optional() })
      .passthrough()
      .optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    // Single primary metric per workout (Intervals requires it) + label rules.
    v.sections.forEach((section, si) => {
      section.steps.forEach((step, ti) => {
        const base = ["sections", si, "steps", ti] as (string | number)[];
        const t = step.target;
        const metric = v.target_metric;
        const mismatch = (msg: string) =>
          ctx.addIssue({
            code: "custom",
            path: [...base, "target"],
            message: msg,
          });
        if (t.watts !== undefined && metric !== "power") {
          mismatch(
            `watts targets require target_metric 'power', got '${metric}'`,
          );
        }
        if (t.pace !== undefined && metric !== "pace") {
          mismatch(
            `pace targets require target_metric 'pace', got '${metric}'`,
          );
        }
        if (t.pct_of === "max" && metric !== "hr") {
          mismatch(`pct_of 'max' (% MaxHR) requires target_metric 'hr', got '${metric}'`);
        }
        if (t.pct_of === "lthr" && metric !== "hr") {
          mismatch(`pct_of 'lthr' (% LTHR) requires target_metric 'hr', got '${metric}'`);
        }
        if (t.zone === "SS" && metric !== "power") {
          mismatch(`zone "SS" (sweet spot) requires target_metric 'power', got '${metric}'`);
        }
        if (t.ramp !== undefined) {
          const ends = [t.ramp.from, t.ramp.to] as const;
          const kinds = ends.map((e) =>
            e.pct !== undefined ? "pct" : "watts",
          );
          if (kinds[0] !== kinds[1]) {
            mismatch(
              `ramp from/to must be the same kind (both pct or both watts), got from=${kinds[0]}, to=${kinds[1]}`,
            );
          }
          ends.forEach((e, ei) => {
            if (e.watts !== undefined && metric !== "power") {
              ctx.addIssue({
                code: "custom",
                path: [...base, "target", "ramp", ei === 0 ? "from" : "to"],
                message: `ramp watts requires target_metric 'power', got '${metric}'`,
              });
            }
            if (e.pct_of === "max" && metric !== "hr") {
              ctx.addIssue({
                code: "custom",
                path: [...base, "target", "ramp", ei === 0 ? "from" : "to"],
                message: `ramp pct_of 'max' requires target_metric 'hr', got '${metric}'`,
              });
            }
            if (e.pct_of === "lthr" && metric !== "hr") {
              ctx.addIssue({
                code: "custom",
                path: [...base, "target", "ramp", ei === 0 ? "from" : "to"],
                message: `ramp pct_of 'lthr' requires target_metric 'hr', got '${metric}'`,
              });
            }
          });
        }
        // Label rules.
        if (step.label !== undefined) {
          const label = step.label;
          if (/\r|\n/.test(label)) {
            ctx.addIssue({
              code: "custom",
              path: [...base, "label"],
              message: "label must be a single line (no newlines)",
            });
          }
          if (/\{n\}/.test(label) && section.repeat === undefined) {
            ctx.addIssue({
              code: "custom",
              path: [...base, "label"],
              message: "{n} is only allowed on steps inside a repeat block",
            });
          }
          const otherPlaceholder = /\{[^n}][^}]*\}|\{\}/.exec(label);
          if (otherPlaceholder) {
            ctx.addIssue({
              code: "custom",
              path: [...base, "label"],
              message: `only the {n} placeholder is supported in labels, got '${otherPlaceholder[0]}'`,
            });
          }
          if (hasDslToken(label)) {
            ctx.addIssue({
              code: "custom",
              path: [...base, "label"],
              message: `label '${label}' contains a DSL-parseable token (duration/distance/zone/%/unit) — it would be misread as structure; reword it without numbers+units`,
            });
          }
        }
      });
    });
  });

// The stored form is the input form plus the caption (kept in the comment so
// a later update without a new caption preserves it). The caption is a
// separate `caption` param on the tools, never a key inside `workout`.
export const storedWorkoutJsonSchema = workoutJsonSchema.extend({
  caption: z.string().optional(),
});

export type WorkoutJson = z.infer<typeof workoutJsonSchema>;
export type StoredWorkoutJson = z.infer<typeof storedWorkoutJsonSchema>;
export type WorkoutStep = z.infer<typeof workoutStepSchema>;
export type WorkoutSection = z.infer<typeof workoutSectionSchema>;

// JSON Schema (draft 2020-12) generated from workoutJsonSchema, for agents to
// discover the full workout JSON shape before constructing one. Structural
// only: superRefine rules (exactly-one-of, metric/target consistency, label
// rules) are not expressible in JSON Schema and stay enforced server-side,
// surfacing as WORKOUT_VALIDATION errors. Generated at runtime so it cannot
// drift from the validator. See issue #176.
export function workoutJsonSchemaDocument(): Record<string, unknown> {
  return z.toJSONSchema(workoutJsonSchema) as Record<string, unknown>;
}

// A label is DSL-parseable if it carries a duration/distance/zone/%/unit
// token: a number with a unit (10m, 5 min, 400m, 250w, 90rpm, 10km),
// a pace time (6:40), a zone code (Z4), or a percent sign. Bare numbers
// ("Rep 1") are fine — the parser only reacts to tokens with units.
function hasDslToken(label: string): boolean {
  return (
    /\d+\s*(s|m|h|ms|sec|secs|min|mins|km|mi|mtr|w|rpm)\b/i.test(label) ||
    /\d+:\d{2}/.test(label) ||
    /\bZ[1-7]\b/.test(label) ||
    /%/.test(label)
  );
}

// ---------------------------------------------------------------------------
// Parsing (free-form JSON in, structured errors out)
// ---------------------------------------------------------------------------

// The value at a zod issue path, looked up in the raw input (zod v4 issues
// don't reliably carry the offending value).
function valueAtPath(input: unknown, path: (string | number)[]): unknown {
  let cur: unknown = input;
  for (const key of path) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string | number, unknown>)[key];
  }
  return cur;
}

export function formatZodIssues(
  input: unknown,
  issues: z.ZodIssue[],
): { path: (string | number)[]; message: string; value?: unknown }[] {
  return issues.map((issue) => {
    const value = valueAtPath(input, issue.path as (string | number)[]);
    return {
      path: issue.path as (string | number)[],
      message: issue.message,
      ...(value !== undefined ? { value } : {}),
    };
  });
}

function validationError(
  summary: string,
  input: unknown,
  issues: z.ZodIssue[],
): Error {
  return workoutError(
    "WORKOUT_VALIDATION",
    summary,
    { issues: formatZodIssues(input, issues) },
    "Fix the flagged fields and retry — nothing was written to Intervals.",
  );
}

export function parseWorkoutJson(input: unknown): WorkoutJson {
  const parsed = workoutJsonSchema.safeParse(input);
  if (!parsed.success) {
    throw validationError(
      `Workout JSON failed validation (${parsed.error.issues.length} issue${parsed.error.issues.length === 1 ? "" : "s"}).`,
      input,
      parsed.error.issues,
    );
  }
  return parsed.data;
}

export function parseStoredWorkoutJson(input: unknown): StoredWorkoutJson {
  const parsed = storedWorkoutJsonSchema.safeParse(input);
  if (!parsed.success) {
    throw validationError(
      `Stored workout JSON failed validation (${parsed.error.issues.length} issue${parsed.error.issues.length === 1 ? "" : "s"}).`,
      input,
      parsed.error.issues,
    );
  }
  return parsed.data;
}

// Accept the workout/workout_patch param as an object (normal) or a JSON
// string (a common agent mistake) — a string is parsed, and a bad string
// fails with a clear WORKOUT_VALIDATION instead of the SDK's generic error.
export function coerceWorkoutParam(input: unknown, paramName: string): unknown {
  if (typeof input === "string") {
    try {
      return JSON.parse(input);
    } catch {
      throw workoutError(
        "WORKOUT_VALIDATION",
        `${paramName} must be a JSON object (a JSON string was passed but it does not parse).`,
        { param: paramName, value: input.slice(0, 500) },
        `Pass ${paramName} as an object, not a string.`,
      );
    }
  }
  return input;
}

// ---------------------------------------------------------------------------
// Normalization (type defaults)
// ---------------------------------------------------------------------------

export function normalizeWorkout<T extends StoredWorkoutJson>(workout: T): T {
  const out = JSON.parse(JSON.stringify(workout)) as T;
  for (const section of out.sections) {
    const sectionIsRecovery =
      section.name.toLowerCase() === "warmup" ||
      section.name.toLowerCase() === "cooldown";
    section.steps.forEach((step, i) => {
      if (step.type !== undefined) return;
      if (sectionIsRecovery) step.type = "recovery";
      else if (section.repeat !== undefined) step.type = i === 0 ? "work" : "recovery";
      else step.type = "work";
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Rendering (JSON -> description string)
// ---------------------------------------------------------------------------

export const WORKOUT_COMMENT_PREFIX = "<!-- workoutcontext: ";
export const WORKOUT_COMMENT_SUFFIX = " -->";

function fmtNum(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 1000) / 1000);
}

function renderLength(step: WorkoutStep): string {
  if (step.distance !== undefined) {
    const d = step.distance;
    if (d.mi !== undefined) return `${fmtNum(d.mi)}mi`;
    if (d.km !== undefined) return `${fmtNum(d.km)}km`;
    return `${fmtNum(d.m as number)}mtr`;
  }
  const d = step.duration as NonNullable<WorkoutStep["duration"]>;
  if (d.minutes !== undefined) return `${fmtNum(d.minutes)}m`;
  if (d.seconds !== undefined) return `${fmtNum(d.seconds)}s`;
  return `${fmtNum(d.hours as number)}h`;
}

function pctRef(metric: WorkoutTargetMetric, pctOf?: "lthr" | "max"): string {
  if (metric === "power") return "";
  if (metric === "hr") return pctOf === "max" ? " HR" : " LTHR";
  return " Pace";
}

function renderPctValue(
  pct: number | [number, number],
  metric: WorkoutTargetMetric,
  pctOf?: "lthr" | "max",
): string {
  const ref = pctRef(metric, pctOf);
  if (Array.isArray(pct)) return `${fmtNum(pct[0])}-${fmtNum(pct[1])}%${ref}`;
  return `${fmtNum(pct)}%${ref}`;
}

function renderTarget(
  target: WorkoutStep["target"],
  metric: WorkoutTargetMetric,
): string {
  if (target.zone !== undefined) {
    if (target.zone === "SS") return "SS";
    if (Array.isArray(target.zone)) {
      return `Z${target.zone[0]}-Z${target.zone[1]} ${METRIC_SUFFIX[metric]}`;
    }
    return `Z${target.zone} ${METRIC_SUFFIX[metric]}`;
  }
  if (target.pct !== undefined) {
    return renderPctValue(target.pct, metric, target.pct_of);
  }
  if (target.watts !== undefined) {
    if (Array.isArray(target.watts)) {
      return `${fmtNum(target.watts[0])}-${fmtNum(target.watts[1])}w`;
    }
    return `${fmtNum(target.watts)}w`;
  }
  if (target.pace !== undefined) {
    if (Array.isArray(target.pace)) {
      // Range: the DSL writes `7:15-7:00 Pace` when both sides share a unit
      // (the unit is implied); keep the units only if they differ.
      const [a, b] = target.pace;
      const parsePace = (p: string): { time: string; unit: string } => {
        const m = /^(\d{1,2}:[0-5]\d)\/(mi|km)$/.exec(p);
        return { time: m ? m[1] : p, unit: m ? m[2] : "" };
      };
      const pa = parsePace(a);
      const pb = parsePace(b);
      if (pa.unit !== "" && pa.unit === pb.unit) {
        return `${pa.time}-${pb.time} Pace`;
      }
      return `${a}-${b} Pace`;
    }
    return `${target.pace} Pace`;
  }
  // Ramp: compose from the numeric ends (a ramp IS a range).
  const ramp = target.ramp as NonNullable<WorkoutStep["target"]["ramp"]>;
  const renderEnd = (end: { pct?: number | [number, number]; pct_of?: "lthr" | "max"; watts?: number | [number, number] }): { num: string; unit: string } => {
    if (end.pct !== undefined) {
      const n = end.pct as number;
      return { num: fmtNum(n), unit: `%${pctRef(metric, end.pct_of)}` };
    }
    return { num: fmtNum(end.watts as number), unit: "w" };
  };
  const from = renderEnd(ramp.from);
  const to = renderEnd(ramp.to);
  if (from.unit !== to.unit) {
    throw workoutError(
      "WORKOUT_RENDER",
      "Ramp from/to must use the same unit.",
      { from: ramp.from, to: ramp.to },
      "Use the same kind (both pct or both watts) with the same reference for from and to.",
    );
  }
  return `ramp ${from.num}-${to.num}${from.unit}`;
}

function renderCadence(cadence: NonNullable<WorkoutStep["cadence"]>): string {
  if (Array.isArray(cadence)) return `${cadence[0]}-${cadence[1]}rpm`;
  return `${cadence}rpm`;
}

export function renderWorkoutDescription(
  workout: StoredWorkoutJson,
  caption?: string,
): { description: string; stored: StoredWorkoutJson } {
  const normalized = normalizeWorkout(workout);
  const finalCaption = caption !== undefined ? caption : normalized.caption;
  const stored: StoredWorkoutJson = { ...normalized };
  if (finalCaption !== undefined && finalCaption !== "") {
    stored.caption = finalCaption;
  } else {
    delete stored.caption;
  }
  const json = JSON.stringify(stored);
  if (json.includes("--")) {
    throw workoutError(
      "WORKOUT_RENDER",
      "Workout JSON cannot be stored: it contains '--', which would break the HTML comment.",
      { offending: "the canonical JSON contains the sequence '--'" },
      "Remove '--' from labels, meta values, or the caption and retry.",
    );
  }

  const blocks: string[] = [];
  if (finalCaption !== undefined && finalCaption !== "") {
    blocks.push(finalCaption);
  }
  for (const section of normalized.sections) {
    const header =
      section.repeat !== undefined && section.repeat > 1
        ? `${section.name} ${section.repeat}x`
        : section.name;
    const lines = section.steps.map((step) => {
      let line = "- ";
      // A label renders inline before the duration — unless it contains
      // {n}, which only makes sense after repeat expansion (comment-only).
      if (step.label !== undefined && !step.label.includes("{n}")) {
        line += `${step.label} `;
      }
      line += `${renderLength(step)} ${renderTarget(step.target, normalized.target_metric)}`;
      if (step.cadence !== undefined) {
        line += ` ${renderCadence(step.cadence)}`;
      }
      return line;
    });
    blocks.push(`${header}\n${lines.join("\n")}`);
  }
  blocks.push(`${WORKOUT_COMMENT_PREFIX}${json}${WORKOUT_COMMENT_SUFFIX}`);
  return { description: blocks.join("\n\n"), stored };
}

// ---------------------------------------------------------------------------
// Extraction (description -> stored JSON, never throws)
// ---------------------------------------------------------------------------

export function extractWorkoutFromDescription(
  description: unknown,
): StoredWorkoutJson | null {
  try {
    if (typeof description !== "string") return null;
    const start = description.indexOf(WORKOUT_COMMENT_PREFIX);
    if (start === -1) return null;
    const jsonStart = start + WORKOUT_COMMENT_PREFIX.length;
    const end = description.indexOf(WORKOUT_COMMENT_SUFFIX, jsonStart);
    if (end === -1) return null;
    const parsed = storedWorkoutJsonSchema.safeParse(
      JSON.parse(description.slice(jsonStart, end)),
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Patch merge (workout_patch) — deep merge per issue #164
// ---------------------------------------------------------------------------
// Objects merge by key; arrays merge by index ({} = no change, null =
// delete that element, extra elements append); a scalar present replaces;
// explicit null on an object key deletes it.

const DELETE = Symbol("workout-patch-delete");

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function deepMerge(
  base: unknown,
  patch: unknown,
  path: (string | number)[],
): unknown {
  if (patch === null) return DELETE;
  if (Array.isArray(patch)) {
    if (base === undefined) return patch;
    if (!Array.isArray(base)) {
      throw workoutError(
        "WORKOUT_PATCH",
        `Cannot merge an array into a non-array at ${formatPath(path)}.`,
        { path, base_type: typeof base },
        "Match the patch shape to the stored JSON — arrays patch arrays, objects patch objects.",
      );
    }
    const out: unknown[] = [...base];
    // Apply non-null merges/appends first, then deletions (descending index
    // order so earlier indices stay valid).
    const deletions: number[] = [];
    patch.forEach((elem, i) => {
      if (elem === null) {
        if (i >= base.length) {
          throw workoutError(
            "WORKOUT_PATCH",
            `Cannot delete index ${i} at ${formatPath(path)} — only ${base.length} element(s) exist.`,
            { path: [...path, i] },
            "Delete only indices that exist, or drop the null element.",
          );
        }
        deletions.push(i);
        return;
      }
      if (i < out.length) {
        const merged = deepMerge(out[i], elem, [...path, i]);
        out[i] = merged === DELETE ? out[i] : merged;
      } else {
        out.push(elem);
      }
    });
    deletions.sort((a, b) => b - a);
    for (const i of deletions) out.splice(i, 1);
    return out;
  }
  if (isPlainObject(patch)) {
    if (base === undefined) {
      // Brand-new object: drop null-valued keys (nothing to delete).
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(patch)) {
        if (v !== null) out[k] = v;
      }
      return out;
    }
    if (!isPlainObject(base)) {
      throw workoutError(
        "WORKOUT_PATCH",
        `Cannot merge an object into a non-object at ${formatPath(path)}.`,
        { path, base_type: typeof base },
        "Match the patch shape to the stored JSON — arrays patch arrays, objects patch objects.",
      );
    }
    const out: Record<string, unknown> = { ...base };
    for (const [k, v] of Object.entries(patch)) {
      if (v === null) {
        delete out[k];
        continue;
      }
      const merged = deepMerge(out[k], v, [...path, k]);
      if (merged === DELETE) delete out[k];
      else out[k] = merged;
    }
    return out;
  }
  // Scalar patch: replace (or set a new key). Merging a scalar into an
  // object/array is a shape error.
  if (base !== undefined && (isPlainObject(base) || Array.isArray(base))) {
    throw workoutError(
      "WORKOUT_PATCH",
      `Cannot replace an object/array with a scalar at ${formatPath(path)}.`,
      { path },
      "Match the patch shape to the stored JSON, or use null to delete the key.",
    );
  }
  return patch;
}

function formatPath(path: (string | number)[]): string {
  if (path.length === 0) return "(root)";
  return path
    .map((p) => (typeof p === "number" ? `[${p}]` : `.${p}`))
    .join("")
    .replace(/^\./, "");
}

export function applyWorkoutPatch(stored: unknown, patch: unknown): unknown {
  if (!isPlainObject(patch)) {
    throw workoutError(
      "WORKOUT_PATCH",
      "workout_patch must be an object.",
      { patch_type: Array.isArray(patch) ? "array" : typeof patch },
      "Pass a partial workout object (e.g. {\"meta\": {\"planned_load\": 45}}).",
    );
  }
  return deepMerge(stored, patch, []);
}

// ---------------------------------------------------------------------------
// Repeat expansion (for the #163 auto-labeler)
// ---------------------------------------------------------------------------

export type ExpandedStep = {
  section: string;
  sectionIndex: number;
  iteration: number;
  stepIndex: number;
  step: WorkoutStep;
};

export function expandSteps(workout: StoredWorkoutJson): ExpandedStep[] {
  const normalized = normalizeWorkout(workout);
  const out: ExpandedStep[] = [];
  normalized.sections.forEach((section, sectionIndex) => {
    const reps = section.repeat ?? 1;
    for (let iteration = 1; iteration <= reps; iteration++) {
      section.steps.forEach((step, stepIndex) => {
        const expanded: WorkoutStep = { ...step };
        if (expanded.label !== undefined) {
          expanded.label = expanded.label.replaceAll("{n}", String(iteration));
        }
        out.push({ section: section.name, sectionIndex, iteration, stepIndex, step: expanded });
      });
    }
  });
  return out;
}

// ---------------------------------------------------------------------------
// Expected totals + verification
// ---------------------------------------------------------------------------

export type ExpectedTotals = {
  steps: number;
  durationSeconds: number;
  distanceMeters: number;
  hasDistanceSteps: boolean;
  hasTimeSteps: boolean;
};

const MI_TO_M = 1609.34;

export function expectedTotals(workout: StoredWorkoutJson): ExpectedTotals {
  let steps = 0;
  let durationSeconds = 0;
  let distanceMeters = 0;
  let hasDistanceSteps = false;
  let hasTimeSteps = false;
  for (const section of workout.sections) {
    const reps = section.repeat ?? 1;
    steps += reps * section.steps.length;
    for (const step of section.steps) {
      if (step.distance !== undefined) {
        hasDistanceSteps = true;
        const d = step.distance;
        const meters =
          d.mi !== undefined
            ? d.mi * MI_TO_M
            : d.km !== undefined
              ? d.km * 1000
              : (d.m as number);
        distanceMeters += reps * meters;
      } else {
        hasTimeSteps = true;
        const d = step.duration as NonNullable<WorkoutStep["duration"]>;
        const seconds =
          d.minutes !== undefined
            ? d.minutes * 60
            : d.seconds !== undefined
              ? d.seconds
              : (d.hours as number) * 3600;
        durationSeconds += reps * seconds;
      }
    }
  }
  return { steps, durationSeconds, distanceMeters, hasDistanceSteps, hasTimeSteps };
}

export type VerifiedSummary = {
  steps: { expected: number; actual: number };
  duration_seconds: {
    expected: number;
    actual: number | null;
    check: "exact" | "lower_bound" | "unavailable";
  };
  distance_meters: {
    expected: number;
    actual: number | null;
    check: "exact" | "lower_bound" | "unavailable";
  };
  comment_round_trip: boolean;
};

// Count steps in a server workout_doc, expanding repeat blocks
// ({reps, steps}) the same way the DSL does. If the server already expanded
// them into flat steps, each flat step counts once — the count matches
// either way.
function countServerSteps(steps: unknown): number | null {
  if (!Array.isArray(steps)) return null;
  let n = 0;
  for (const s of steps) {
    if (s !== null && typeof s === "object") {
      const r = s as { reps?: unknown; steps?: unknown };
      if (typeof r.reps === "number" && Array.isArray(r.steps)) {
        n += r.reps * r.steps.length;
      } else {
        n += 1;
      }
    } else {
      n += 1;
    }
  }
  return n;
}

// Verify a re-fetched event against the workout JSON. Duration/distance are
// exact only for the "pure" quantities (time-based durations, distance-based
// distances); the server estimates the cross quantities (distance-step
// durations, time-step distances) from the athlete's pace, so mixed
// workouts check those as lower bounds plus generous sanity caps. Step
// count is always exact — it is the primary structural-fidelity signal
// (phantom steps, dropped steps, and wrong repeat expansion all change it).
export function verifyWorkoutEvent(
  event: unknown,
  workout: StoredWorkoutJson,
  opts: { eventId: string | number; description: string },
): VerifiedSummary {
  const expected = expectedTotals(workout);
  const e = (event ?? {}) as Record<string, unknown>;
  const doc = (e.workout_doc ?? {}) as Record<string, unknown>;
  const actualSteps = countServerSteps(doc.steps);
  const actualDuration =
    typeof doc.duration === "number"
      ? doc.duration
      : typeof e.moving_time === "number"
        ? e.moving_time
        : null;
  const actualDistance =
    typeof doc.distance === "number" ? doc.distance : null;

  const failures: string[] = [];
  if (actualSteps === null) {
    failures.push(
      "workout_doc.steps is missing — the server may not have parsed the workout yet; re-fetch the event and check",
    );
  } else if (actualSteps !== expected.steps) {
    failures.push(`steps: expected ${expected.steps}, got ${actualSteps}`);
  }
  let durationCheck: VerifiedSummary["duration_seconds"]["check"] = "unavailable";
  if (actualDuration === null) {
    failures.push("duration is missing from the re-fetched event");
  } else if (!expected.hasDistanceSteps) {
    durationCheck = "exact";
    if (actualDuration !== expected.durationSeconds) {
      failures.push(
        `duration_seconds: expected ${expected.durationSeconds}, got ${actualDuration}`,
      );
    }
  } else {
    durationCheck = "lower_bound";
    if (actualDuration < expected.durationSeconds) {
      failures.push(
        `duration_seconds: expected at least ${expected.durationSeconds} (time-based steps), got ${actualDuration}`,
      );
    }
    // Distance steps at no slower than 15:00/mi (900s/mi) — the server
    // estimates ~8:00/mi, so this only trips on gross errors.
    const distanceMi = expected.distanceMeters / MI_TO_M;
    if (actualDuration > expected.durationSeconds + distanceMi * 900) {
      failures.push(
        `duration_seconds: ${actualDuration} exceeds the sanity cap ${Math.round(expected.durationSeconds + distanceMi * 900)} for the planned structure`,
      );
    }
  }
  let distanceCheck: VerifiedSummary["distance_meters"]["check"] = "unavailable";
  if (actualDistance === null) {
    failures.push("distance is missing from the re-fetched workout_doc");
  } else if (!expected.hasTimeSteps) {
    distanceCheck = "exact";
    if (Math.abs(actualDistance - expected.distanceMeters) > 1) {
      failures.push(
        `distance_meters: expected ${expected.distanceMeters}, got ${actualDistance}`,
      );
    }
  } else {
    distanceCheck = "lower_bound";
    if (actualDistance < expected.distanceMeters - 1) {
      failures.push(
        `distance_meters: expected at least ${expected.distanceMeters} (distance-based steps), got ${actualDistance}`,
      );
    }
    // Time steps at no faster than 2:30/km (6.67 m/s) — far faster than any
    // plausible server estimate, so this only trips on gross errors.
    if (
      actualDistance >
      expected.distanceMeters + expected.durationSeconds * 6.67 + 1
    ) {
      failures.push(
        `distance_meters: ${actualDistance} exceeds the sanity cap ${Math.round(expected.distanceMeters + expected.durationSeconds * 6.67)} for the planned structure`,
      );
    }
  }

  const roundTrip = extractWorkoutFromDescription(
    (e as Record<string, unknown>).description,
  );
  const commentRoundTrip =
    roundTrip !== null &&
    JSON.stringify(normalizeWorkout(roundTrip)) ===
      JSON.stringify(normalizeWorkout(workout));
  if (!commentRoundTrip) {
    failures.push(
      "comment round-trip failed — the stored HTML comment does not parse back to the workout JSON",
    );
  }

  const summary: VerifiedSummary = {
    steps: { expected: expected.steps, actual: actualSteps ?? -1 },
    duration_seconds: {
      expected: expected.durationSeconds,
      actual: actualDuration,
      check: durationCheck,
    },
    distance_meters: {
      expected: Math.round(expected.distanceMeters * 100) / 100,
      actual: actualDistance,
      check: distanceCheck,
    },
    comment_round_trip: commentRoundTrip,
  };
  if (failures.length > 0) {
    throw workoutError(
      "WORKOUT_VERIFY_MISMATCH",
      `Created/updated event ${opts.eventId} does not match the workout JSON (${failures.length} failed check${failures.length === 1 ? "" : "s"}).`,
      {
        event_id: opts.eventId,
        expected: {
          steps: expected.steps,
          duration_seconds: expected.durationSeconds,
          distance_meters: Math.round(expected.distanceMeters * 100) / 100,
        },
        actual: {
          steps: actualSteps,
          duration_seconds: actualDuration,
          distance_meters: actualDistance,
        },
        failed_checks: failures,
        description: opts.description.slice(0, 2000),
      },
      `The event was left in place for inspection (id ${opts.eventId}) — re-fetch it, fix the workout JSON, and update it in place, or delete it and retry.`,
    );
  }
  return summary;
}

// ---------------------------------------------------------------------------
// Stable external_id (retry-safe idempotency for workout creates)
// ---------------------------------------------------------------------------

// Small deterministic hash (cyrb53) — an id, not security.
function hash53(str: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, "0") + (h1 >>> 0).toString(16).padStart(8, "0");
}

export function stableExternalId(
  stored: StoredWorkoutJson,
  startDateLocal: string,
): string {
  return `wc-${hash53(`${startDateLocal}|${JSON.stringify(stored)}`)}`;
}
