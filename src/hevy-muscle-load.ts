// Per-muscle-group load for Hevy → Intervals sync (issue #169, Part 2).
// Pure logic, no I/O: the sync in hevy-intervals-sync.ts calls into here
// with the fetched workout + resolved exercise templates. This module
// imports nothing (no zod, no other src files) so it is unit-testable
// under node --test type stripping.
//
// Model (decided in implementation — see the PR description for the
// rationale):
// - Allocator: per-exercise volume. Tonnage (Σ weight_kg × reps over
//   working sets) when > 0; else Σ reps (bodyweight / reps-only); else
//   Σ distance_meters; else Σ duration_seconds; else 0. Working sets only
//   (type !== "warmup"); if an exercise has no working sets, all its sets
//   count. The units differ across the fallback levels, but the split is
//   proportional — the volume only ranks exercises relative to each other.
// - Split: each exercise's share of the session load goes 70% to its
//   primary muscle group and 30% shared equally among its secondary
//   muscles. No secondaries → primary takes 100%. An exercise whose
//   template can't be resolved is allocated to "other", so the per-muscle
//   loads still sum to the session load. Loads are rounded to integers;
//   rounding may move the total by ±1. Compound lifts are handled by the
//   same split: the secondaries are the other muscles a compound lift
//   works, so they get their 30% share.

export interface HevyLoadSet {
  type?: string | null;
  weight_kg?: number | null;
  reps?: number | null;
  distance_meters?: number | null;
  duration_seconds?: number | null;
  rpe?: number | null;
}

export interface HevyLoadExercise {
  exercise_template_id?: string | null;
  title?: string | null;
  sets?: HevyLoadSet[] | null;
}

export interface HevyLoadTemplate {
  muscle_group?: string | null;
  other_muscles?: string[] | null;
}

export type TemplateMap = Record<string, HevyLoadTemplate | null | undefined>;

// snake_case enum value → Title Case display name ("upper_back" →
// "Upper Back", "quadriceps" → "Quadriceps").
export function muscleDisplayName(muscle: string): string {
  return muscle
    .split("_")
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

// Primary first, secondaries in parentheses, e.g.
// "Quadriceps (+ Glutes, Hamstrings)" or just "Quadriceps".
export function formatMuscles(primary: string, secondaries: string[]): string {
  const p = muscleDisplayName(primary);
  if (secondaries.length === 0) return p;
  return `${p} (+ ${secondaries.map(muscleDisplayName).join(", ")})`;
}

// Python's `:g` format: drop trailing zeros, no unnecessary decimals.
export function formatNumber(n: number): string {
  return Number.isInteger(n) ? String(n) : String(parseFloat(n.toFixed(6)));
}

// Working sets only (type !== "warmup"); fall back to all sets when an
// exercise has no working sets (e.g. a warmup-only prescription).
export function workingSets(sets: HevyLoadSet[] | null | undefined): HevyLoadSet[] {
  const all = sets ?? [];
  const working = all.filter((s) => (s.type ?? "normal").toLowerCase() !== "warmup");
  return working.length > 0 ? working : all;
}

// Per-exercise volume for the load allocator (see the module header for
// the fallback order). Returns 0 when the exercise has no measurable
// volume (e.g. all sets empty).
export function exerciseVolume(exercise: HevyLoadExercise): number {
  const sets = workingSets(exercise.sets);
  let tonnage = 0;
  let reps = 0;
  let distance = 0;
  let duration = 0;
  for (const s of sets) {
    if (s.weight_kg != null && s.reps != null) tonnage += s.weight_kg * s.reps;
    if (s.reps != null) reps += s.reps;
    if (s.distance_meters != null) distance += s.distance_meters;
    if (s.duration_seconds != null) duration += s.duration_seconds;
  }
  if (tonnage > 0) return tonnage;
  if (reps > 0) return reps;
  if (distance > 0) return distance;
  if (duration > 0) return duration;
  return 0;
}

export interface MuscleLoad {
  muscle: string;
  load: number;
}

// Split a session load (Foster sRPE, same units as icu_training_load)
// across muscle groups, proportional to per-exercise volume. Returns
// null when there is no load to split or no exercise has volume.
// Results are sorted by load desc, then muscle name for determinism.
export function computePerMuscleLoad(
  exercises: HevyLoadExercise[],
  templates: TemplateMap,
  sessionLoad: number | null,
): MuscleLoad[] | null {
  if (sessionLoad == null || sessionLoad <= 0) return null;
  const vols = exercises.map((ex) => exerciseVolume(ex));
  const totalVol = vols.reduce((a, b) => a + b, 0);
  if (totalVol <= 0) return null;
  const totals = new Map<string, number>();
  exercises.forEach((ex, i) => {
    const vol = vols[i];
    if (vol <= 0) return;
    const share = (vol / totalVol) * sessionLoad;
    const tpl = ex.exercise_template_id
      ? templates[ex.exercise_template_id]
      : null;
    const primary = tpl?.muscle_group ?? "other";
    const secondaries = (tpl?.other_muscles ?? []).filter(Boolean);
    if (secondaries.length === 0) {
      totals.set(primary, (totals.get(primary) ?? 0) + share);
    } else {
      totals.set(primary, (totals.get(primary) ?? 0) + share * 0.7);
      const each = (share * 0.3) / secondaries.length;
      for (const sec of secondaries) {
        totals.set(sec, (totals.get(sec) ?? 0) + each);
      }
    }
  });
  const out = [...totals.entries()]
    .map(([muscle, load]) => ({ muscle, load: Math.round(load) }))
    .filter((m) => m.load > 0)
    .sort((a, b) => b.load - a.load || a.muscle.localeCompare(b.muscle));
  return out.length > 0 ? out : null;
}

// Markdown lines for the per-muscle section appended to the synced
// activity's description.
export function renderMuscleLoadSection(muscleLoads: MuscleLoad[]): string[] {
  const lines = ["### Load by muscle group"];
  for (const m of muscleLoads) {
    lines.push(`- ${muscleDisplayName(m.muscle)}: ${m.load}`);
  }
  return lines;
}

// Renders one set as a bullet line. Weight is rendered whenever present,
// even without reps — previously (in hevy-intervals-sync.ts) it was only
// rendered inside the reps branch, which dropped the weight for weighted
// distance sets (e.g. a 20m walking Lunge with dumbbells).
export function formatSet(s: HevyLoadSet): string {
  const parts: string[] = [];
  const setType = (s.type ?? "normal").toLowerCase();
  if (setType !== "normal") parts.push(setType.toUpperCase());
  if (s.reps != null) {
    if (s.weight_kg) parts.push(`${formatNumber(s.weight_kg)}kg x ${s.reps}`);
    else parts.push(`${s.reps} reps`);
  } else if (s.weight_kg) {
    parts.push(`${formatNumber(s.weight_kg)}kg`);
  }
  if (s.duration_seconds) parts.push(`${s.duration_seconds}s`);
  if (s.distance_meters) parts.push(`${formatNumber(s.distance_meters)}m`);
  if (s.rpe) parts.push(`RPE ${formatNumber(s.rpe)}`);
  return parts.length ? "  - " + parts.join(", ") : "  - (empty set)";
}
