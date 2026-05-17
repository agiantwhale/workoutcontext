import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ok } from "./util.js";

const HEVY_BASE = "https://api.hevyapp.com/v1";

const PageShape = {
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(1).max(10).default(10),
};

const SetSchema = z.object({
  type: z.enum(["normal", "warmup", "dropset", "failure"]).default("normal"),
  weight_kg: z.number().nullable().optional(),
  reps: z.number().int().nullable().optional(),
  distance_meters: z.number().nullable().optional(),
  duration_seconds: z.number().int().nullable().optional(),
  rpe: z.number().nullable().optional(),
});

const WorkoutExerciseSchema = z.object({
  exercise_template_id: z.string(),
  superset_id: z.number().int().nullable().optional(),
  notes: z.string().optional(),
  sets: z.array(SetSchema),
});

const RoutineExerciseSchema = z.object({
  exercise_template_id: z.string(),
  superset_id: z.number().int().nullable().optional(),
  rest_seconds: z.number().int().nullable().optional(),
  notes: z.string().nullable().optional(),
  sets: z.array(SetSchema),
});

const ExerciseTypeEnum = z.enum([
  "weight_reps",
  "reps_only",
  "bodyweight_reps",
  "bodyweight_assisted_reps",
  "duration",
  "weight_duration",
  "distance_duration",
  "short_distance_weight",
]);

const EquipmentEnum = z.enum([
  "none",
  "barbell",
  "dumbbell",
  "kettlebell",
  "machine",
  "plate",
  "resistance_band",
  "suspension",
  "other",
]);

const MuscleGroupEnum = z.enum([
  "abdominals",
  "shoulders",
  "biceps",
  "triceps",
  "forearms",
  "quadriceps",
  "hamstrings",
  "calves",
  "glutes",
  "abductors",
  "adductors",
  "lats",
  "upper_back",
  "traps",
  "lower_back",
  "chest",
  "cardio",
  "neck",
  "full_body",
  "other",
]);

const BodyMeasurementFields = {
  weight_kg: z.number().nullable().optional(),
  lean_mass_kg: z.number().nullable().optional(),
  fat_percent: z.number().nullable().optional(),
  neck_cm: z.number().nullable().optional(),
  shoulder_cm: z.number().nullable().optional(),
  chest_cm: z.number().nullable().optional(),
  left_bicep_cm: z.number().nullable().optional(),
  right_bicep_cm: z.number().nullable().optional(),
  left_forearm_cm: z.number().nullable().optional(),
  right_forearm_cm: z.number().nullable().optional(),
  abdomen: z.number().nullable().optional(),
  waist: z.number().nullable().optional(),
  hips: z.number().nullable().optional(),
  left_thigh_cm: z.number().nullable().optional(),
  right_thigh_cm: z.number().nullable().optional(),
  left_calf_cm: z.number().nullable().optional(),
  right_calf_cm: z.number().nullable().optional(),
  notes: z.string().nullable().optional(),
};

export function registerHevyTools(
  server: McpServer,
  getApiKey: () => Promise<string>,
) {
  async function hevyFetch(
    path: string,
    init: RequestInit = {},
  ): Promise<unknown> {
    const headers = new Headers(init.headers);
    headers.set("api-key", await getApiKey());
    headers.set("Accept", "application/json");
    if (init.body) headers.set("Content-Type", "application/json");

    const res = await fetch(`${HEVY_BASE}${path}`, { ...init, headers });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`Hevy ${init.method ?? "GET"} ${path} → ${res.status}: ${text}`);
    }
    return text ? JSON.parse(text) : null;
  }

  // === User ===
  server.tool(
    "hevy_user_info",
    "Get the authenticated Hevy user's profile info.",
    {},
    async () => ok(await hevyFetch("/user/info")),
  );

  // === Workouts ===
  server.tool(
    "hevy_list_workouts",
    "List the authenticated user's Hevy workouts (paginated, newest first).",
    PageShape,
    async ({ page, pageSize }) =>
      ok(await hevyFetch(`/workouts?page=${page}&pageSize=${pageSize}`)),
  );

  server.tool(
    "hevy_workout_count",
    "Total number of workouts logged by the authenticated user.",
    {},
    async () => ok(await hevyFetch("/workouts/count")),
  );

  server.tool(
    "hevy_workout_events",
    "List workout updates and deletes since a given timestamp — for incremental sync. Returns newest first.",
    {
      since: z
        .string()
        .describe("ISO-8601 datetime; only events at or after this time are returned"),
      page: z.number().int().min(1).default(1),
      pageSize: z.number().int().min(1).max(10).default(10),
    },
    async ({ since, page, pageSize }) =>
      ok(
        await hevyFetch(`/workouts/events?since=${encodeURIComponent(since)}&page=${page}&pageSize=${pageSize}`,
        ),
      ),
  );

  server.tool(
    "hevy_get_workout",
    "Fetch a single Hevy workout by id.",
    { workoutId: z.string().min(1) },
    async ({ workoutId }) =>
      ok(await hevyFetch(`/workouts/${encodeURIComponent(workoutId)}`)),
  );

  const WorkoutInputShape = {
    title: z.string().min(1),
    description: z.string().nullable().optional(),
    start_time: z.string().describe("ISO-8601 datetime"),
    end_time: z.string().describe("ISO-8601 datetime"),
    is_private: z.boolean().default(false),
    exercises: z.array(WorkoutExerciseSchema).min(1),
  };

  server.tool(
    "hevy_create_workout",
    "Log a new completed workout in Hevy.",
    WorkoutInputShape,
    async (input) =>
      ok(
        await hevyFetch("/workouts", {
          method: "POST",
          body: JSON.stringify({ workout: input }),
        }),
      ),
  );

  server.tool(
    "hevy_update_workout",
    "Update an existing logged workout in Hevy. All fields are replaced.",
    { workoutId: z.string().min(1), ...WorkoutInputShape },
    async ({ workoutId, ...workout }) =>
      ok(
        await hevyFetch(`/workouts/${encodeURIComponent(workoutId)}`, {
          method: "PUT",
          body: JSON.stringify({ workout }),
        }),
      ),
  );

  // === Routines ===
  server.tool(
    "hevy_list_routines",
    "List the authenticated user's saved routines (paginated).",
    PageShape,
    async ({ page, pageSize }) =>
      ok(await hevyFetch(`/routines?page=${page}&pageSize=${pageSize}`)),
  );

  server.tool(
    "hevy_get_routine",
    "Fetch a single Hevy routine by id.",
    { routineId: z.string().min(1) },
    async ({ routineId }) =>
      ok(await hevyFetch(`/routines/${encodeURIComponent(routineId)}`)),
  );

  server.tool(
    "hevy_create_routine",
    "Create a new Hevy routine. Pass folder_id (or null for default 'My Routines' folder).",
    {
      title: z.string().min(1),
      folder_id: z.number().int().nullable().optional(),
      notes: z.string().optional(),
      exercises: z.array(RoutineExerciseSchema).min(1),
    },
    async (routine) =>
      ok(
        await hevyFetch("/routines", {
          method: "POST",
          body: JSON.stringify({ routine }),
        }),
      ),
  );

  server.tool(
    "hevy_update_routine",
    "Update an existing Hevy routine. Cannot change folder — use create+delete to move.",
    {
      routineId: z.string().min(1),
      title: z.string().min(1),
      notes: z.string().nullable().optional(),
      exercises: z.array(RoutineExerciseSchema).min(1),
    },
    async ({ routineId, ...routine }) =>
      ok(
        await hevyFetch(`/routines/${encodeURIComponent(routineId)}`, {
          method: "PUT",
          body: JSON.stringify({ routine }),
        }),
      ),
  );

  // === Routine folders ===
  server.tool(
    "hevy_list_routine_folders",
    "List the authenticated user's routine folders.",
    PageShape,
    async ({ page, pageSize }) =>
      ok(await hevyFetch(`/routine_folders?page=${page}&pageSize=${pageSize}`)),
  );

  server.tool(
    "hevy_get_routine_folder",
    "Fetch a single routine folder by id.",
    { folderId: z.union([z.string(), z.number()]) },
    async ({ folderId }) =>
      ok(await hevyFetch(`/routine_folders/${encodeURIComponent(String(folderId))}`)),
  );

  server.tool(
    "hevy_create_routine_folder",
    "Create a new routine folder. Inserted at index 0; existing folders shift down.",
    { title: z.string().min(1) },
    async ({ title }) =>
      ok(
        await hevyFetch("/routine_folders", {
          method: "POST",
          body: JSON.stringify({ routine_folder: { title } }),
        }),
      ),
  );

  // === Exercise templates ===
  server.tool(
    "hevy_list_exercise_templates",
    "List Hevy exercise templates (the catalog of exercises available).",
    {
      page: z.number().int().min(1).default(1),
      pageSize: z.number().int().min(1).max(100).default(50),
    },
    async ({ page, pageSize }) =>
      ok(
        await hevyFetch(`/exercise_templates?page=${page}&pageSize=${pageSize}`),
      ),
  );

  server.tool(
    "hevy_get_exercise_template",
    "Fetch a single exercise template by id.",
    { exerciseTemplateId: z.string().min(1) },
    async ({ exerciseTemplateId }) =>
      ok(
        await hevyFetch(`/exercise_templates/${encodeURIComponent(exerciseTemplateId)}`,
        ),
      ),
  );

  server.tool(
    "hevy_create_exercise_template",
    "Create a custom exercise template (Pro feature). Use only when no built-in matches.",
    {
      title: z.string().min(1),
      exercise_type: ExerciseTypeEnum,
      equipment_category: EquipmentEnum,
      muscle_group: MuscleGroupEnum,
      other_muscles: z.array(MuscleGroupEnum).optional(),
    },
    async (exercise) =>
      ok(
        await hevyFetch("/exercise_templates", {
          method: "POST",
          body: JSON.stringify({ exercise }),
        }),
      ),
  );

  server.tool(
    "hevy_get_exercise_history",
    "Get all logged sets for a given exercise template — useful for tracking progression and PRs.",
    {
      exerciseTemplateId: z.string().min(1),
      start_date: z.string().optional().describe("ISO-8601 date or datetime; inclusive"),
      end_date: z.string().optional().describe("ISO-8601 date or datetime; inclusive"),
    },
    async ({ exerciseTemplateId, start_date, end_date }) => {
      const qs = new URLSearchParams();
      if (start_date) qs.set("start_date", start_date);
      if (end_date) qs.set("end_date", end_date);
      const suffix = qs.toString() ? `?${qs.toString()}` : "";
      return ok(
        await hevyFetch(`/exercise_history/${encodeURIComponent(exerciseTemplateId)}${suffix}`,
        ),
      );
    },
  );

  // === Body measurements ===
  server.tool(
    "hevy_list_body_measurements",
    "List body measurement entries (newest first, paginated).",
    PageShape,
    async ({ page, pageSize }) =>
      ok(await hevyFetch(`/body_measurements?page=${page}&pageSize=${pageSize}`)),
  );

  server.tool(
    "hevy_get_body_measurement",
    "Fetch the body measurement entry for a specific date (YYYY-MM-DD).",
    { date: z.string().describe("YYYY-MM-DD") },
    async ({ date }) =>
      ok(await hevyFetch(`/body_measurements/${encodeURIComponent(date)}`)),
  );

  server.tool(
    "hevy_create_body_measurement",
    "Create a body measurement entry for a date. Returns 409 if one already exists — use update instead.",
    {
      date: z.string().describe("YYYY-MM-DD"),
      ...BodyMeasurementFields,
    },
    async (body) =>
      ok(
        await hevyFetch("/body_measurements", {
          method: "POST",
          body: JSON.stringify(body),
        }),
      ),
  );

  server.tool(
    "hevy_update_body_measurement",
    "Replace the body measurement entry for a date. All omitted fields are set to null.",
    {
      date: z.string().describe("YYYY-MM-DD"),
      ...BodyMeasurementFields,
    },
    async ({ date, ...body }) =>
      ok(
        await hevyFetch(`/body_measurements/${encodeURIComponent(date)}`, {
          method: "PUT",
          body: JSON.stringify(body),
        }),
      ),
  );
}
