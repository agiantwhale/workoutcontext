// Schedule an Intervals workout from a Hevy routine (issue #169, Part 1).
// The intervals_create_event tool calls into here when `hevy_routine_id`
// is passed. The server fetches the routine from Hevy, renders the
// prescription (prose + markdown table with muscle groups) into the
// description, and stores the full prescription JSON in a single-line
// HTML comment — mirroring the structured-workout JSON pattern from
// issue #164 (src/workout-render.ts).
//
// This module is pure except for the fetch helpers at the bottom (which
// use the global fetch, like hevy-intervals-sync.ts). It imports only
// zod, so the pure functions are unit-testable under node --test type
// stripping. The HTML comment prefix/suffix mirror WORKOUT_COMMENT_PREFIX
// / WORKOUT_COMMENT_SUFFIX in src/workout-render.ts — keep them identical.
// The muscle/number helpers are small local copies (same duplication
// the repo already accepts between formatNumber/fmtNum).

import { z } from "zod";

// --- Error reporting (same [CODE] summary / detail / hint shape as
// workoutError in src/workout-render.ts) ------------------------------------

export type HevyRoutineErrorCode =
  | "WORKOUT_VALIDATION"
  | "WORKOUT_RENDER"
  | "WORKOUT_VERIFY_MISMATCH"
  | "INTERVALS_HTTP_ERROR";

export function hevyRoutineError(
  code: HevyRoutineErrorCode,
  summary: string,
  detail: Record<string, unknown>,
  hint: string,
): Error {
  return new Error(
    `[${code}] ${summary}\ndetail: ${JSON.stringify(detail)}\nhint: ${hint}`,
  );
}

// --- HTML comment (mirrors src/workout-render.ts — keep identical) ---------

export const HEVY_COMMENT_PREFIX = "<!-- workoutcontext: ";
export const HEVY_COMMENT_SUFFIX = " -->";

// --- Small helpers --------------------------------------------------------

function muscleDisplayName(muscle: string): string {
  return muscle
    .split("_")
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

function formatMuscles(primary: string, secondaries: string[]): string {
  const p = muscleDisplayName(primary);
  if (secondaries.length === 0) return p;
  return `${p} (+ ${secondaries.map(muscleDisplayName).join(", ")})`;
}

// Python's `:g` format: drop trailing zeros, no unnecessary decimals.
function formatNumber(n: number): string {
  return Number.isInteger(n) ? String(n) : String(parseFloat(n.toFixed(6)));
}

interface PrescriptionSet {
  type?: string | null;
  weight_kg?: number | null;
  reps?: number | null;
  distance_meters?: number | null;
  duration_seconds?: number | null;
  rpe?: number | null;
}

// Working sets only (type !== "warmup"); fall back to all sets when an
// exercise has no working sets.
function workingSets(sets: PrescriptionSet[] | null | undefined): PrescriptionSet[] {
  const all = sets ?? [];
  const working = all.filter((s) => (s.type ?? "normal").toLowerCase() !== "warmup");
  return working.length > 0 ? working : all;
}

// --- Prescription JSON schema ----------------------------------------------
// Separate schema from the structured-workout JSON, distinguished by
// `kind`. The JSON stores kg (Hevy's native unit); the table renders the
// user's preferred unit. Storing the full prescription (not just the
// routine ID) makes the comment self-contained, so the server can
// re-render the description or detect drift without re-fetching Hevy.

const HevyRoutineSetSchema = z.object({
  type: z.string().default("normal"),
  weight_kg: z.number().nullable().optional(),
  reps: z.number().int().nullable().optional(),
  distance_meters: z.number().nullable().optional(),
  duration_seconds: z.number().int().nullable().optional(),
  rpe: z.number().nullable().optional(),
});

const HevyRoutineExerciseSchema = z.object({
  template_id: z.string(),
  title: z.string(),
  muscle_group: z.string(),
  other_muscles: z.array(z.string()).default([]),
  rest_seconds: z.number().int().nullable().optional(),
  sets: z.array(HevyRoutineSetSchema),
});

export const HevyRoutinePrescriptionSchema = z.object({
  version: z.literal(1),
  kind: z.literal("hevy_routine"),
  routine_id: z.string().min(1),
  routine_title: z.string(),
  exercises: z.array(HevyRoutineExerciseSchema),
});

export type HevyRoutinePrescription = z.infer<typeof HevyRoutinePrescriptionSchema>;

// --- Hevy input shapes (what the API returns) ------------------------------

export interface HevyRoutineSetInput {
  type?: string | null;
  weight_kg?: number | null;
  reps?: number | null;
  distance_meters?: number | null;
  duration_seconds?: number | null;
  rpe?: number | null;
}

export interface HevyRoutineExerciseInput {
  exercise_template_id: string;
  superset_id?: number | null;
  rest_seconds?: number | null;
  notes?: string | null;
  sets?: HevyRoutineSetInput[] | null;
}

export interface HevyRoutineInput {
  id: string;
  title: string;
  folder_id?: number | null;
  notes?: string | null;
  exercises?: HevyRoutineExerciseInput[] | null;
}

export interface HevyTemplateInput {
  id?: string;
  title?: string | null;
  // Hevy's API returns primary_muscle_group / secondary_muscle_groups on
  // exercise templates; the older muscle_group / other_muscles names are
  // kept as a fallback (live staging test Nov 10, 2026: reading only the
  // old names resolved every template to "other").
  primary_muscle_group?: string | null;
  secondary_muscle_groups?: string[] | null;
  muscle_group?: string | null;
  other_muscles?: string[] | null;
}

// --- Build (pure) -----------------------------------------------------------

// Builds + validates the prescription JSON from a fetched routine and a
// template map (template id → template, or null when unresolvable).
// An exercise whose template can't be resolved falls back to title
// "Exercise" and muscle_group "other" so scheduling still works.
export function buildHevyRoutinePrescription(
  routine: HevyRoutineInput,
  templatesById: Record<string, HevyTemplateInput | null | undefined>,
): HevyRoutinePrescription {
  const exercises = (routine.exercises ?? []).map((ex) => {
    const tpl = templatesById[ex.exercise_template_id];
    return {
      template_id: ex.exercise_template_id,
      title: tpl?.title ?? "Exercise",
      muscle_group:
        tpl?.primary_muscle_group ?? tpl?.muscle_group ?? "other",
      other_muscles: (
        tpl?.secondary_muscle_groups ??
        tpl?.other_muscles ??
        []
      ).filter(Boolean),
      rest_seconds: ex.rest_seconds ?? null,
      sets: (ex.sets ?? []).map((s) => ({
        type: (s.type ?? "normal").toLowerCase(),
        weight_kg: s.weight_kg ?? null,
        reps: s.reps ?? null,
        distance_meters: s.distance_meters ?? null,
        duration_seconds: s.duration_seconds ?? null,
        rpe: s.rpe ?? null,
      })),
    };
  });
  const parsed = HevyRoutinePrescriptionSchema.safeParse({
    version: 1,
    kind: "hevy_routine",
    routine_id: routine.id,
    routine_title: routine.title,
    exercises,
  });
  if (!parsed.success) {
    throw hevyRoutineError(
      "WORKOUT_VALIDATION",
      `Hevy routine ${routine.id} failed prescription validation (${parsed.error.issues.length} issue${parsed.error.issues.length === 1 ? "" : "s"}).`,
      { issues: parsed.error.issues.map((i) => i.message) },
      "The routine data from Hevy did not match the expected shape — check the routine in Hevy and retry.",
    );
  }
  return parsed.data;
}

// --- Weight units -----------------------------------------------------------
// Hevy stores kg; the table renders the user's preferred unit, read from
// Hevy /user/info (`weight_unit`: "lbs" or "kg").

const KG_PER_LB = 0.453592;

export function formatWeight(kg: number, weightUnit: string): string {
  if (weightUnit.toLowerCase().startsWith("lb")) {
    const lb = kg / KG_PER_LB;
    return `${formatNumber(Math.round(lb * 10) / 10)} lb`;
  }
  // Round kg to 2 decimals — Hevy stores kg converted from lb (e.g.
  // 90 lb → 40.82328 kg), and the raw value is not displayable.
  return `${formatNumber(Math.round(kg * 100) / 100)} kg`;
}

// --- Table cells (pure) -----------------------------------------------------

// The "Per Set" column: the per-set measure with its unit — a rep count
// (`8`), a distance (`20m`), or a duration (`60s`). When the working
// sets all share one measure it is shown once; when they vary they are
// joined with "/" (e.g. `12/8/8`).
export function perSetMeasure(sets: PrescriptionSet[] | null | undefined): string {
  const working = workingSets(sets);
  if (working.length === 0) return "—";
  const measures = working
    .map((s) => {
      if (s.reps != null) return String(s.reps);
      if (s.distance_meters != null) return `${formatNumber(s.distance_meters)}m`;
      if (s.duration_seconds != null) return `${s.duration_seconds}s`;
      return null;
    })
    .filter((m): m is string => m !== null);
  if (measures.length === 0) return "—";
  if (measures.every((m) => m === measures[0])) return measures[0];
  return measures.join("/");
}

// The Weight column: the working sets' weight in the user's preferred
// unit, or "Bodyweight" when no set carries a weight. Varying weights
// are joined with "/" (e.g. `70 lb/75 lb`).
export function weightCell(
  sets: PrescriptionSet[] | null | undefined,
  weightUnit: string,
): string {
  const working = workingSets(sets);
  const weights = working
    .map((s) => s.weight_kg)
    .filter((w): w is number => w != null && w > 0);
  if (weights.length === 0) return "Bodyweight";
  const formatted = weights.map((w) => formatWeight(w, weightUnit));
  if (formatted.every((f) => f === formatted[0])) return formatted[0];
  return formatted.join("/");
}

// --- Rendering (pure) -------------------------------------------------------

// Renders the event description: prose (caption, or a default line naming
// the Hevy routine) + the prescription table + the HTML comment carrying
// the full prescription JSON. The table is Markdown; a strength event's
// description stores it intact with no phantom steps (verified Nov 10,
// 2026 — the parser only turns `- `-prefixed lines into steps).
export function renderHevyRoutineDescription(
  prescription: HevyRoutinePrescription,
  weightUnit: string,
  caption?: string,
): { description: string; stored: HevyRoutinePrescription } {
  const json = JSON.stringify(prescription);
  if (json.includes("--")) {
    throw hevyRoutineError(
      "WORKOUT_RENDER",
      "Hevy routine prescription JSON cannot be stored: it contains '--', which would break the HTML comment.",
      { offending: "the canonical JSON contains the sequence '--'" },
      "Remove '--' from the routine title or exercise titles and retry.",
    );
  }
  const prose =
    caption !== undefined && caption !== ""
      ? caption
      : `Hevy ${prescription.routine_title} routine.`;
  const lines: string[] = [
    prose,
    "",
    "| Exercise | Sets | Per Set | Weight | Muscles |",
    "| --- | --- | --- | --- | --- |",
  ];
  for (const ex of prescription.exercises) {
    const sets = workingSets(ex.sets);
    lines.push(
      `| ${ex.title} | ${sets.length} | ${perSetMeasure(ex.sets)} | ${weightCell(ex.sets, weightUnit)} | ${formatMuscles(ex.muscle_group, ex.other_muscles)} |`,
    );
  }
  lines.push("", `${HEVY_COMMENT_PREFIX}${json}${HEVY_COMMENT_SUFFIX}`);
  return { description: lines.join("\n"), stored: prescription };
}

// --- Extraction (description -> stored JSON, never throws) ------------------

export function extractHevyRoutinePrescription(
  description: unknown,
): HevyRoutinePrescription | null {
  try {
    if (typeof description !== "string") return null;
    const start = description.indexOf(HEVY_COMMENT_PREFIX);
    if (start === -1) return null;
    const jsonStart = start + HEVY_COMMENT_PREFIX.length;
    const end = description.indexOf(HEVY_COMMENT_SUFFIX, jsonStart);
    if (end === -1) return null;
    const parsed = HevyRoutinePrescriptionSchema.safeParse(
      JSON.parse(description.slice(jsonStart, end)),
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

// --- Routine-ID extraction --------------------------------------------------

// Accepts a plain routine ID or a Hevy routine share URL and returns the
// routine ID. A URL (or any string containing a UUID) is parsed down to
// its UUID; anything else is returned trimmed as-is.
export function extractHevyRoutineId(input: string): string {
  const trimmed = input.trim();
  const uuid =
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.exec(trimmed);
  if (uuid) return uuid[0];
  return trimmed;
}

// --- Verification (re-fetched event vs. prescription) ------------------------

export interface HevyRoutineVerification {
  comment_round_trip: boolean;
  table_present: boolean;
  steps_empty: boolean;
}

export function verifyHevyRoutineEvent(
  event: unknown,
  prescription: HevyRoutinePrescription,
  eventId: string | number,
): HevyRoutineVerification {
  const e = (event ?? {}) as Record<string, unknown>;
  const doc = (e.workout_doc ?? {}) as Record<string, unknown>;
  const roundTrip = extractHevyRoutinePrescription(e.description);
  const commentRoundTrip =
    roundTrip !== null &&
    roundTrip.routine_id === prescription.routine_id &&
    roundTrip.exercises.length === prescription.exercises.length;
  const tablePresent =
    typeof e.description === "string" &&
    e.description.includes("| Exercise | Sets | Per Set | Weight | Muscles |");
  const stepsEmpty = Array.isArray(doc.steps) && doc.steps.length === 0;
  const failures: string[] = [];
  if (!commentRoundTrip) {
    failures.push(
      "comment round-trip failed — the stored HTML comment does not parse back to the Hevy routine prescription JSON",
    );
  }
  if (!tablePresent) {
    failures.push("prescription table missing from the re-fetched event description");
  }
  if (!stepsEmpty) {
    failures.push(
      `workout_doc.steps is not empty (expected 0 for a strength event, got ${Array.isArray(doc.steps) ? doc.steps.length : "non-array"})`,
    );
  }
  if (failures.length > 0) {
    throw hevyRoutineError(
      "WORKOUT_VERIFY_MISMATCH",
      `Created event ${eventId} does not match the Hevy routine prescription (${failures.length} failed check${failures.length === 1 ? "" : "s"}).`,
      { event_id: eventId, failed_checks: failures },
      `The event was left in place for inspection (id ${eventId}) — re-fetch it, fix the routine, and update it in place, or delete it and retry.`,
    );
  }
  return {
    comment_round_trip: commentRoundTrip,
    table_present: tablePresent,
    steps_empty: stepsEmpty,
  };
}

// --- Hevy fetch (I/O — uses the global fetch, like hevy-intervals-sync.ts) -

const HEVY_BASE = "https://api.hevyapp.com/v1";

async function hevyFetch(apiKey: string, path: string): Promise<unknown> {
  const res = await fetch(`${HEVY_BASE}${path}`, {
    headers: { "api-key": apiKey, Accept: "application/json" },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Hevy GET ${path} → ${res.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

// Hevy wraps some single-get responses ({ routine: {...} }, { data: {...} });
// unwrap through the given keys, falling back to the raw object.
function unwrapHevy<T>(raw: unknown, keys: string[]): T {
  if (raw !== null && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    for (const k of keys) {
      if (obj[k] !== null && typeof obj[k] === "object") return obj[k] as T;
    }
  }
  return raw as T;
}

// Fetches exercise templates for the given ids (deduped, in parallel).
// A single template failing to fetch does not fail the whole call —
// that id maps to null and the prescription falls back to title
// "Exercise" / muscle_group "other". Shared with the Hevy → Intervals
// sync (hevy-intervals-sync.ts), which resolves the same templates for
// its per-muscle load split.
export async function fetchHevyExerciseTemplates(
  apiKey: string,
  templateIds: string[],
): Promise<Record<string, HevyTemplateInput | null>> {
  const unique = [...new Set(templateIds.filter(Boolean))];
  const entries = await Promise.all(
    unique.map(async (id) => {
      try {
        const raw = await hevyFetch(apiKey, `/exercise_templates/${encodeURIComponent(id)}`);
        const tpl = unwrapHevy<HevyTemplateInput>(raw, ["data", "exercise"]);
        return [id, tpl] as const;
      } catch (e) {
        console.error(`[hevy/routine] could not fetch exercise template ${id}:`, e);
        return [id, null] as const;
      }
    }),
  );
  return Object.fromEntries(entries);
}

// Fetches a Hevy routine + the user's weight-unit preference + the
// exercise templates, and builds the prescription JSON. The weight unit
// defaults to kg if the user-info call fails.
export async function fetchHevyRoutinePrescription(
  apiKey: string,
  routineId: string,
): Promise<{ prescription: HevyRoutinePrescription; weightUnit: string }> {
  const rawRoutine = await hevyFetch(apiKey, `/routines/${encodeURIComponent(routineId)}`);
  const routine = unwrapHevy<HevyRoutineInput>(rawRoutine, ["routine", "data"]);
  if (!routine || typeof routine !== "object" || !routine.id) {
    throw hevyRoutineError(
      "WORKOUT_VALIDATION",
      `Hevy routine ${routineId} not found or unexpected response shape.`,
      { routine_id: routineId },
      "Check the routine ID (or share URL) and that the Hevy account is connected.",
    );
  }
  let weightUnit = "kg";
  try {
    const rawUser = await hevyFetch(apiKey, "/user/info");
    const user = unwrapHevy<{ weight_unit?: string }>(rawUser, ["data"]);
    if (typeof user?.weight_unit === "string" && user.weight_unit) {
      weightUnit = user.weight_unit.toLowerCase().startsWith("lb") ? "lbs" : "kg";
    }
  } catch (e) {
    console.error(
      "[hevy/routine] could not fetch Hevy user info (defaulting weight unit to kg):",
      e,
    );
  }
  const templateIds = (routine.exercises ?? [])
    .map((ex) => ex.exercise_template_id)
    .filter(Boolean);
  const templates = await fetchHevyExerciseTemplates(apiKey, templateIds);
  const prescription = buildHevyRoutinePrescription(routine, templates);
  return { prescription, weightUnit };
}
