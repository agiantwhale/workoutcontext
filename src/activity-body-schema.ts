// Shared zod field sets for write-tool bodies — imports only zod, so
// it is unit-testable under node --test (see test/activity-body-schema.test.ts,
// test/library-workout-schema.test.ts, test/sport-settings-schema.test.ts).
// It also holds the canonical sport-type enum (SportInfo.type in the
// OpenAPI spec), shared by the library-workout and sport-settings sets,
// and the canonical event-category enum (Event.category), shared by the
// event create/update/list/delete tools.
//
// The tools build a fresh z.object from these sets per tool (same pattern
// as intervalBodyFields in intervals.ts) so a per-tool .describe() cannot
// leak across. Every field is nullable + optional: the old free-form
// record passed null through, and Intervals treats null as no-change.
// The objects are passthrough: any other field from the Intervals.ICU
// OpenAPI schema — including athlete-defined custom fields — flows
// through unchanged.

import { z } from "zod";

// The canonical sport-type list from the Intervals.ICU OpenAPI spec
// (`SportInfo.type` / `Settings.type`). There is no "Note" sport type:
// a document is not a workout. Declared before the field sets so they
// can use it.
export const sportTypeValues = [
  "Ride",
  "Run",
  "Swim",
  "WeightTraining",
  "Hike",
  "Walk",
  "AlpineSki",
  "BackcountrySki",
  "Badminton",
  "Canoeing",
  "Crossfit",
  "EBikeRide",
  "EMountainBikeRide",
  "Elliptical",
  "Golf",
  "GravelRide",
  "TrackRide",
  "Handcycle",
  "HighIntensityIntervalTraining",
  "Hockey",
  "IceSkate",
  "InlineSkate",
  "Kayaking",
  "Kitesurf",
  "MountainBikeRide",
  "Cyclocross",
  "NordicSki",
  "OpenWaterSwim",
  "Padel",
  "Pilates",
  "Pickleball",
  "Racquetball",
  "Rugby",
  "RockClimbing",
  "RollerSki",
  "Rowing",
  "Sail",
  "Skateboard",
  "Snowboard",
  "Snowshoe",
  "Soccer",
  "Squash",
  "StairStepper",
  "StandUpPaddling",
  "Surfing",
  "TableTennis",
  "Tennis",
  "TrailRun",
  "Transition",
  "Velomobile",
  "VirtualRide",
  "VirtualRow",
  "VirtualRun",
  "VirtualSki",
  "WaterSport",
  "Wheelchair",
  "Windsurf",
  "Workout",
  "Yoga",
  "Other",
] as const;

// Common Activity fields, documented so assistants stop guessing shapes
// (notably gear). Computed fields (icu_ctl, icu_atl, averages) are left
// out on purpose: Intervals recomputes or ignores them on update.
// Distance and moving_time are a manual activity's actual data, so they
// live in manualActivityCreateFields instead of this shared set.
export const activityBodyFields = {
  gear: z
    .object({ id: z.string() })
    .nullable()
    .optional()
    .describe(
      'Shoe/gear: {"id": "<gear id>"} — get ids from ' +
        "intervals_list_gear. There is no flat gear_id field.",
    ),
  name: z.string().nullable().optional().describe("Activity name."),
  description: z
    .string()
    .nullable()
    .optional()
    .describe("Free-text notes on the activity."),
  type: z
    .enum(sportTypeValues)
    .nullable()
    .optional()
    .describe("Sport: 'Ride', 'Run', 'Swim', 'WeightTraining', etc."),
  tags: z
    .array(z.string())
    .nullable()
    .optional()
    .describe("Tags attached to the activity."),
  paired_event_id: z
    .number()
    .int()
    .nullable()
    .optional()
    .describe("Id of the planned calendar event to link this activity to."),
  icu_training_load: z
    .number()
    .int()
    .nullable()
    .optional()
    .describe("Training load (TSS) override."),
  icu_rpe: z
    .number()
    .int()
    .nullable()
    .optional()
    .describe("Rating of perceived exertion."),
  feel: z
    .number()
    .int()
    .nullable()
    .optional()
    .describe("Feel score."),
  trainer: z
    .boolean()
    .nullable()
    .optional()
    .describe("Whether the activity was indoors on a trainer."),
  commute: z
    .boolean()
    .nullable()
    .optional()
    .describe("Whether the activity was a commute."),
  race: z
    .boolean()
    .nullable()
    .optional()
    .describe("Whether the activity was a race."),
  sub_type: z
    .enum(["NONE", "COMMUTE", "WARMUP", "COOLDOWN", "RACE"])
    .nullable()
    .optional()
    .describe("Activity sub-type."),
};

// Manual-activity create fields: the shared Activity fields plus the
// activity's own data (start, moving time, distance).
export const manualActivityCreateFields = {
  ...activityBodyFields,
  start_date_local: z
    .string()
    .nullable()
    .optional()
    .describe("Local start time (ISO-8601)."),
  moving_time: z
    .number()
    .int()
    .nullable()
    .optional()
    .describe("Moving time in seconds."),
  distance: z
    .number()
    .nullable()
    .optional()
    .describe("Distance in meters."),
};

// Gear types from the Intervals.ICU OpenAPI Gear schema. The enum is the
// point: Intervals rejects anything outside it with a 400 "JSON parse
// error" (e.g. "shoes" must be "Shoes").
export const gearTypeValues = [
  "Bike",
  "Shoes",
  "Wetsuit",
  "RowingMachine",
  "Skis",
  "Snowboard",
  "Boat",
  "Board",
  "Equipment",
  "Accessories",
  "Apparel",
  "Computer",
  "Light",
  "Battery",
  "Brake",
  "BrakePads",
  "Rotor",
  "Drivetrain",
  "BottomBracket",
  "Cassette",
  "Chain",
  "Chainrings",
  "Crankset",
  "Derailleur",
  "Pedals",
  "Lever",
  "Cable",
  "Frame",
  "Fork",
  "Handlebar",
  "Headset",
  "Saddle",
  "Seatpost",
  "Shock",
  "Stem",
  "Axel",
  "Hub",
  "Trainer",
  "Tube",
  "Tyre",
  "Wheel",
  "Wheelset",
  "PowerMeter",
  "Cleats",
  "CyclingShoes",
  "Paddle",
] as const;

// Gear fields, shared by intervals_create_gear and intervals_update_gear.
// distance/time/activities are computed (recalculated by the calc
// endpoint) and id/athlete_id are server-managed, so they stay out.
export const gearBodyFields = {
  type: z
    .enum(gearTypeValues)
    .nullable()
    .optional()
    .describe(
      "Gear type — must be one of the listed values " +
        "(e.g. 'Shoes', not 'shoes').",
    ),
  name: z.string().nullable().optional().describe("Gear name."),
  purchased: z
    .string()
    .nullable()
    .optional()
    .describe("Purchase date (ISO date string)."),
  notes: z
    .string()
    .nullable()
    .optional()
    .describe("Free-text notes on the gear."),
  retired: z
    .string()
    .nullable()
    .optional()
    .describe(
      "Retirement date (ISO date string) — set to retire the gear.",
    ),
};


// The canonical event-category list from the Intervals.ICU OpenAPI spec
// (`Event.category` / `EventEx.category`, verified live Nov 20, 2026).
// A few are system-set (SET_EFTP, SET_FITNESS, FITNESS_DAYS, TARGET,
// PLAN) and rarely passed on create, but all 14 are valid values.
export const eventCategoryValues = [
  "WORKOUT",
  "RACE_A",
  "RACE_B",
  "RACE_C",
  "NOTE",
  "PLAN",
  "HOLIDAY",
  "SICK",
  "INJURED",
  "SET_EFTP",
  "FITNESS_DAYS",
  "SEASON_START",
  "TARGET",
  "SET_FITNESS",
] as const;

// Common library-workout fields. `type` is the point: Intervals
// rejects anything outside the sport types with a 422
// ("Invalid type [Note]") — the enum catches that at the schema layer
// instead of the server.
export const libraryWorkoutBodyFields = {
  type: z
    .enum(sportTypeValues)
    .nullable()
    .optional()
    .describe(
      "Sport type — must be one of the listed values (e.g. 'Run'). " +
        "Library workouts are structured workouts; there is no 'Note' " +
        "type — for documents, create a NOTE calendar event instead.",
    ),
  name: z.string().nullable().optional().describe("Workout name."),
  description: z
    .string()
    .nullable()
    .optional()
    .describe("Free-text description (Markdown)."),
  folder_id: z
    .number()
    .int()
    .nullable()
    .optional()
    .describe(
      "Library folder id — required when creating a workout " +
        "(Intervals rejects a create without one).",
    ),
  tags: z
    .array(z.string())
    .nullable()
    .optional()
    .describe("Tags attached to the workout."),
  workout_doc: z
    .record(z.string(), z.any())
    .nullable()
    .optional()
    .describe(
      "Structured workout steps (workout_doc object). See " +
        "intervals_get_workout_json_schema for the machine-readable schema.",
    ),
};

// Common sport-settings fields: zones, thresholds, and the sport
// types the entry applies to. The bulk update endpoint
// (PUT /sport-settings) takes an ARRAY of these objects — a single
// object fails Intervals deserialization with a 400 "JSON parse
// error". The bulk tool's schema is therefore z.array(...) of this
// set, so the mistake is caught at the schema layer instead of the
// server.
export const sportSettingsFields = {
  id: z
    .number()
    .int()
    .nullable()
    .optional()
    .describe("Sport-settings entry id."),
  types: z
    .array(z.enum(sportTypeValues))
    .nullable()
    .optional()
    .describe(
      "Sport types this entry applies to " +
        "(e.g. ['Run', 'VirtualRun', 'TrailRun']).",
    ),
  hr_zones: z
    .array(z.number())
    .nullable()
    .optional()
    .describe("HR zone upper boundaries (bpm)."),
  hr_zone_names: z
    .array(z.string())
    .nullable()
    .optional()
    .describe("HR zone names."),
  pace_zones: z
    .array(z.number())
    .nullable()
    .optional()
    .describe("Pace zone boundaries."),
  pace_zone_names: z
    .array(z.string())
    .nullable()
    .optional()
    .describe("Pace zone names."),
  power_zones: z
    .array(z.number())
    .nullable()
    .optional()
    .describe("Power zone boundaries (watts)."),
  power_zone_names: z
    .array(z.string())
    .nullable()
    .optional()
    .describe("Power zone names."),
  lthr: z
    .number()
    .int()
    .nullable()
    .optional()
    .describe("Lactate threshold heart rate (bpm)."),
  max_hr: z
    .number()
    .int()
    .nullable()
    .optional()
    .describe("Maximum heart rate (bpm)."),
  ftp: z
    .number()
    .int()
    .nullable()
    .optional()
    .describe("Functional threshold power (watts)."),
  indoor_ftp: z
    .number()
    .int()
    .nullable()
    .optional()
    .describe("Indoor FTP (watts)."),
  threshold_pace: z
    .number()
    .nullable()
    .optional()
    .describe("Threshold pace."),
};

// Common wellness fields, as enumerated by intervals_log_wellness.
// The bulk wellness tool shares this set so the two cannot drift;
// any other Wellness field passes through as-is (passthrough).
export const wellnessFields = {
  restingHR: z.number().optional().describe("Resting heart rate (bpm)."),
  hrv: z.number().optional().describe("Heart rate variability (ms)."),
  weight: z.number().optional().describe("Body weight."),
  sleepSecs: z
    .number()
    .int()
    .optional()
    .describe("Sleep duration (seconds)."),
  sleepQuality: z
    .number()
    .int()
    .min(1)
    .max(4)
    .optional()
    .describe("Sleep quality (1-4)."),
  fatigue: z
    .number()
    .int()
    .min(1)
    .max(4)
    .optional()
    .describe("Fatigue (1-4)."),
  stress: z
    .number()
    .int()
    .min(1)
    .max(4)
    .optional()
    .describe("Stress (1-4)."),
  mood: z
    .number()
    .int()
    .min(1)
    .max(4)
    .optional()
    .describe("Mood (1-4)."),
  motivation: z
    .number()
    .int()
    .min(1)
    .max(4)
    .optional()
    .describe("Motivation (1-4)."),
  soreness: z
    .number()
    .int()
    .min(1)
    .max(4)
    .optional()
    .describe("Soreness (1-4)."),
  comments: z.string().optional().describe("Free-text notes."),
};

// Activity filters for curve endpoints (f1/f2/f3/filters), from the
// Intervals.ICU OpenAPI spec (`ActivityFilter`). Verified live Nov 21,
// 2026: each filter set is a JSON array of these objects; `value` is a
// list for `type` (["Run"]) and a scalar otherwise; `id`/`not`/`code`
// default server-side. All ten operators were verified live.
export const activityFilterFieldValues = [
  "type",
  "indoor",
  "name",
  "notName",
  "description",
  "moving_time",
  "elapsed_time",
  "coasting_time",
  "distance",
  "climbing",
  "load",
  "source",
  "race",
  "average_heartrate",
  "max_heartrate",
  "hrrc",
  "average_power",
  "norm_power",
  "pace",
  "gap",
  "average_speed",
  "max_speed",
  "variability_index",
  "intensity",
  "average_cadence",
  "average_cadence_z2",
  "average_temp",
  "calories",
  "work",
  "work_above_ftp",
  "max_wbal_depletion",
  "efficiency",
  "power_hr",
  "power_hr_z2",
  "power_hr_z2_mins",
  "rpe",
  "feel",
  "session_rpe",
  "kg_lifted",
  "power_meter",
  "power_meter_serial",
  "gear_name",
  "trimp",
  "custom",
  "tags",
  "device_name",
  "compliance",
  "polarization_index",
  "day_of_week",
  "average_altitude",
  "min_altitude",
  "max_altitude",
  "start_time",
  "route_id",
] as const;

export const activityFilterOperatorValues = [
  "=",
  "!=",
  ">",
  ">=",
  "<",
  "<=",
  "in",
  "not_in",
  "contains",
  "not_contains",
] as const;

export const activityFilterSchema = z
  .object({
    field_id: z.enum(activityFilterFieldValues),
    operator: z.enum(activityFilterOperatorValues),
    value: z.union([
      z.string(),
      z.number(),
      z.boolean(),
      z.array(z.string()),
      z.array(z.number()),
    ]),
    not: z.boolean().optional(),
  })
  .passthrough();

// Fields for `intervals_replace_gear`: the endpoint retires a component
// and replaces it with a copy inheriting the old component's name, type
// and reminders — only `retired` is used (verified live Nov 21, 2026:
// name/notes in the body are ignored, and omitting `retired` 422s).
// Strict: anything else would look accepted and do nothing.
export const gearReplaceFields = {
  retired: z
    .string()
    .describe("Date the old component retires (YYYY-MM-DD). Required."),
};

// Fields for `intervals_update_events_in_range`: the range-update endpoint
// (PUT /athlete/{id}/events) applies ONLY `hide_from_athlete` and
// `athlete_cannot_edit` — the spec says so, and a live probe confirmed
// name/category in the body are silently ignored. So this object is
// deliberately STRICT (no passthrough): any other field would look
// accepted and do nothing.
export const eventRangeUpdateFields = {
  hide_from_athlete: z
    .boolean()
    .optional()
    .describe("Hide these events from the athlete."),
  athlete_cannot_edit: z
    .boolean()
    .optional()
    .describe("Prevent the athlete from editing these events."),
};

// --- The last 20 free-form bodies (Nov 21, 2026) ---
// Field sets for the remaining tools, all taken from the Intervals.ICU
// OpenAPI spec. Same pattern as above: the commonly-set fields are
// enumerated with their spec enums, everything is nullable + optional,
// and the objects are passthrough — except the plan-workout range
// update, which is strict (see below). A few nested values stay loose
// by nature: a custom item's `content` is arbitrary item-definition
// JSON, a stream's `anomalies` are server-computed, and a workout doc
// is the legacy document format.

// Workout intensity targets (the `target`/`targets` values on a
// Workout, and the `workout_targets` values on a Folder/Plan).
export const workoutTargetValues = ["AUTO", "POWER", "HR", "PACE"] as const;

// Fields for `intervals_create_activity_message`: a comment on an
// activity is just its content (NewActivityMsg).
export const activityMessageFields = {
  content: z.string().nullable().optional().describe("Comment text."),
};

// Fields for `intervals_update_activity_streams`: one stream object
// (ActivityStream). `data` is the sample series — one value per second
// for numeric streams, [lat, lng] pairs for latlng streams.
export const activityStreamFields = {
  type: z
    .string()
    .nullable()
    .optional()
    .describe(
      "Stream type, e.g. watts, heartrate, cadence, velocity_smooth, latlng, time.",
    ),
  name: z.string().nullable().optional(),
  data: z
    .array(
      z.union([z.number(), z.boolean(), z.array(z.number())]),
    )
    .nullable()
    .optional()
    .describe("Sample values, one per second."),
  data2: z
    .array(
      z.union([z.number(), z.boolean(), z.array(z.number())]),
    )
    .nullable()
    .optional()
    .describe("Second sample series (e.g. the lng half of a latlng stream)."),
  valueTypeIsArray: z.boolean().nullable().optional(),
  anomalies: z
    .array(z.object({}).passthrough())
    .nullable()
    .optional()
    .describe("Server-detected anomalies in the stream."),
  custom: z.boolean().nullable().optional(),
  allNull: z.boolean().nullable().optional(),
};

// Fields for a library Workout (the `Workout` schema), used for the
// `extra_workouts` elements of ApplyPlanDTO. The `type` is the sport
// enum (same valid values as a library workout's type).
export const workoutFields = {
  name: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  type: z
    .enum(sportTypeValues)
    .nullable()
    .optional()
    .describe("Sport type of the workout."),
  indoor: z.boolean().nullable().optional(),
  color: z.string().nullable().optional(),
  moving_time: z
    .number()
    .int()
    .nullable()
    .optional()
    .describe("Moving time in seconds."),
  joules: z.number().int().nullable().optional(),
  joules_above_ftp: z.number().int().nullable().optional(),
  workout_doc: z
    .record(z.string(), z.any())
    .nullable()
    .optional()
    .describe("Structured workout document (legacy format)."),
  folder_id: z.number().int().nullable().optional(),
  day: z.number().int().nullable().optional().describe("Day offset in the plan."),
  days: z.number().int().nullable().optional().describe("Plan length in days."),
  plan_applied: z.string().nullable().optional(),
  hide_from_athlete: z.boolean().nullable().optional(),
  target: z
    .enum(workoutTargetValues)
    .nullable()
    .optional()
    .describe("Intensity target for the workout."),
  targets: z
    .array(z.enum(workoutTargetValues))
    .nullable()
    .optional(),
  carbs_per_hour: z.number().int().nullable().optional(),
  tags: z.array(z.string()).nullable().optional(),
  sub_type: z
    .enum(["NONE", "COMMUTE", "WARMUP", "COOLDOWN", "RACE"])
    .nullable()
    .optional(),
  for_week: z.boolean().nullable().optional(),
  distance: z.number().nullable().optional().describe("Distance in meters."),
  icu_training_load: z.number().int().nullable().optional(),
  icu_intensity: z.number().nullable().optional(),
};

// Fields for `intervals_apply_plan` (ApplyPlanDTO): apply a training
// plan folder to the calendar from a start date.
export const applyPlanFields = {
  start_date_local: z
    .string()
    .nullable()
    .optional()
    .describe(
      "Local date-time the plan starts (ISO-8601 datetime, e.g. 2027-01-04T00:00:00 — a bare date is rejected).",
    ),
  folder_id: z
    .number()
    .int()
    .nullable()
    .optional()
    .describe("Id of the plan folder to apply."),
  extra_workouts: z
    .array(z.object(workoutFields).passthrough())
    .nullable()
    .optional()
    .describe("Additional workouts to add to the plan."),
};

// Fields for `intervals_duplicate_events` (DuplicateEventsDTO).
export const duplicateEventsFields = {
  numCopies: z.number().int().nullable().optional(),
  weeksBetween: z.number().int().nullable().optional(),
  eventIds: z
    .array(z.number().int())
    .nullable()
    .optional()
    .describe("Calendar event ids to duplicate."),
};

// Fields for `intervals_duplicate_workouts` (DuplicateWorkoutsDTO).
export const duplicateWorkoutsFields = {
  numCopies: z.number().int().nullable().optional(),
  weeksBetween: z.number().int().nullable().optional(),
  workoutIds: z
    .array(z.number().int())
    .nullable()
    .optional()
    .describe("Library workout ids to duplicate."),
};

// Folder/plan type and visibility (Folder / CreateFolderDTO).
export const folderTypeValues = ["FOLDER", "PLAN"] as const;
export const folderVisibilityValues = ["PRIVATE", "PUBLIC"] as const;

// Fields for `intervals_create_folder` / `intervals_update_folder`.
// CreateFolderDTO carries one extra field, `copy_folder_id` (copy the
// workouts from another folder), added at the create tool. Computed
// fields (children, num_workouts, owner, shareToken) are passthrough.
export const folderFields = {
  type: z
    .enum(folderTypeValues)
    .nullable()
    .optional()
    .describe("FOLDER is a plain folder, PLAN is a training plan."),
  name: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  visibility: z
    .enum(folderVisibilityValues)
    .nullable()
    .optional(),
  start_date_local: z
    .string()
    .nullable()
    .optional()
    .describe("Local start date (ISO-8601) for a plan."),
  rollout_weeks: z.number().int().nullable().optional(),
  auto_rollout_day: z.number().int().nullable().optional(),
  read_only_workouts: z.boolean().nullable().optional(),
  starting_ctl: z.number().int().nullable().optional(),
  starting_atl: z.number().int().nullable().optional(),
  activity_types: z
    .array(z.enum(sportTypeValues))
    .nullable()
    .optional()
    .describe("Sport types the folder/plan covers."),
  duration_weeks: z.number().int().nullable().optional(),
  hours_per_week_min: z.number().int().nullable().optional(),
  hours_per_week_max: z.number().int().nullable().optional(),
  workout_targets: z
    .array(z.enum(workoutTargetValues))
    .nullable()
    .optional(),
  blurb: z.string().nullable().optional(),
};

// Fields for `intervals_update_folder_shared_with`: one entry of the
// share list (SharedWith). The body is an ARRAY of these.
export const sharedWithFields = {
  id: z.string().nullable().optional().describe("Athlete id being shared with."),
  name: z.string().nullable().optional(),
  profile_medium: z.string().nullable().optional(),
  city: z.string().nullable().optional(),
  state: z.string().nullable().optional(),
  country: z.string().nullable().optional(),
  timezone: z.string().nullable().optional(),
  sex: z.string().nullable().optional(),
  bio: z.string().nullable().optional(),
  website: z.string().nullable().optional(),
  email: z.string().nullable().optional(),
  canEdit: z
    .boolean()
    .nullable()
    .optional()
    .describe("Whether the athlete may edit the shared folder/plan."),
};

// Fields for `intervals_update_folder_workouts`: the range-workout
// endpoint (PUT /athlete/{id}/folders/{folderId}/workouts) applies ONLY
// `hide_from_athlete` — the spec says so ("Currently only
// hide_from_athlete can be changed"). So this object is deliberately
// STRICT (no passthrough): any other field would look accepted and do
// nothing. Same pattern as eventRangeUpdateFields.
export const planWorkoutRangeFields = {
  hide_from_athlete: z
    .boolean()
    .optional()
    .describe("Hide these workouts from the athlete."),
};

// Athlete profile enums (AthleteUpdateDTO).
export const windSpeedValues = ["MPS", "KNOTS", "KMH", "MPH", "BFT"] as const;
export const rainValues = ["MM", "INCHES"] as const;
export const athleteVisibilityValues = [
  "PRIVATE",
  "PUBLIC",
  "HIDDEN",
] as const;
export const athleteStatusValues = ["ACTIVE", "DORMANT", "ARCHIVED"] as const;
export const weightSyncValues = ["NONE", "STRAVA"] as const;
export const permissionValues = ["NONE", "READ", "WRITE"] as const;
export const followerApiAccessValues = ["NONE", "COACHES", "FOLLOWERS"] as const;
export const garminPowerTargetValues = [
  "POWER_LAP",
  "POWER",
  "POWER_3S",
  "POWER_10S",
  "POWER_30S",
] as const;
export const heightUnitsValues = ["CM", "FEET"] as const;
export const notificationValues = [
  "NEWSLETTER",
  "ACHIEVEMENTS",
  "FOLLOW_REQUEST",
  "COACH_ME_REQUEST",
  "PRIVATE_CHAT",
  "PRIVATE_MSG",
  "GROUP_CHAT",
  "GROUP_MSG",
  "ACTIVITY_CHAT",
  "ACTIVITY_MSG",
  "COACH_TICK",
  "FOLLOWED_ACTIVITY_CHAT",
  "COACHED_ACTIVITY_CHAT",
  "FOLLOWED_NEW_ACTIVITY",
  "COACHED_NEW_ACTIVITY",
  "GEAR_ALERTS",
  "PLAN_FOR_WEEK",
  "NEW_ACTIVITY",
] as const;

// Fields for `intervals_update_athlete` (AthleteUpdateDTO). The DTO has
// ~150 properties, mostly per-provider sync settings; this enumerates
// the ones an assistant would plausibly set, and everything else passes
// through. Read-only/server fields (plan, strava_id, icu_admin, …) are
// not enumerated.
export const athleteUpdateFields = {
  name: z.string().nullable().optional(),
  firstname: z.string().nullable().optional(),
  lastname: z.string().nullable().optional(),
  timezone: z.string().nullable().optional(),
  locale: z.string().nullable().optional(),
  date_format: z.string().nullable().optional(),
  time_format: z.string().nullable().optional(),
  weight: z.number().nullable().optional().describe("Weight in kg or lb."),
  height: z.number().nullable().optional(),
  height_units: z.enum(heightUnitsValues).nullable().optional(),
  sex: z.string().nullable().optional(),
  city: z.string().nullable().optional(),
  state: z.string().nullable().optional(),
  country: z.string().nullable().optional(),
  bio: z.string().nullable().optional(),
  website: z.string().nullable().optional(),
  measurement_preference: z
    .string()
    .nullable()
    .optional()
    .describe("Metric or imperial."),
  weight_pref_lb: z.boolean().nullable().optional(),
  fahrenheit: z.boolean().nullable().optional(),
  wind_speed: z.enum(windSpeedValues).nullable().optional(),
  rain: z.enum(rainValues).nullable().optional(),
  visibility: z.enum(athleteVisibilityValues).nullable().optional(),
  status: z.enum(athleteStatusValues).nullable().optional(),
  icu_resting_hr: z.number().int().nullable().optional(),
  icu_weight: z.number().nullable().optional().describe("Weight in kg."),
  icu_weight_sync: z.enum(weightSyncValues).nullable().optional(),
  icu_permission: z.enum(permissionValues).nullable().optional(),
  icu_menstrual_cycle_perm: z.enum(permissionValues).nullable().optional(),
  follower_api_access: z.enum(followerApiAccessValues).nullable().optional(),
  garmin_power_target: z.enum(garminPowerTargetValues).nullable().optional(),
  icu_tags: z.array(z.string()).nullable().optional(),
  icu_wellness_keys: z.array(z.string()).nullable().optional(),
  private_wellness_keys: z.array(z.string()).nullable().optional(),
  countries: z.array(z.string()).nullable().optional(),
  languages: z.array(z.string()).nullable().optional(),
  email_notifications: z
    .array(z.enum(notificationValues))
    .nullable()
    .optional(),
  push_notifications: z
    .array(z.enum(notificationValues))
    .nullable()
    .optional(),
  icu_date_of_birth: z.string().nullable().optional(),
  icu_coach: z.boolean().nullable().optional(),
  icu_form_as_percent: z.boolean().nullable().optional(),
  icu_wellness_prompt: z.boolean().nullable().optional(),
};

// Fields for `intervals_update_training_plan`
// (AthleteTrainingPlanUpdate): change which training plan the athlete
// follows and when it starts.
export const trainingPlanUpdateFields = {
  id: z.string().nullable().optional(),
  training_plan_id: z.number().int().nullable().optional(),
  training_plan_start_date: z
    .string()
    .nullable()
    .optional()
    .describe("Local start date (ISO-8601)."),
  training_plan_alias: z.string().nullable().optional(),
};

// Fields for `intervals_create_gear_reminder` /
// `intervals_update_gear_reminder` (GearReminder). All thresholds are
// optional: set the ones that define the reminder (distance, time,
// activities or days).
export const gearReminderFields = {
  id: z.number().int().nullable().optional(),
  gear_id: z.string().nullable().optional(),
  name: z.string().nullable().optional(),
  distance: z
    .number()
    .nullable()
    .optional()
    .describe("Remind after this many meters."),
  time: z.number().nullable().optional().describe("Remind after this many seconds."),
  activities: z
    .number()
    .int()
    .nullable()
    .optional()
    .describe("Remind after this many activities."),
  days: z.number().int().nullable().optional().describe("Remind after this many days."),
  last_reset: z.string().nullable().optional(),
  starting_distance: z.number().nullable().optional(),
  starting_time: z.number().nullable().optional(),
  starting_activities: z.number().int().nullable().optional(),
  snoozed_until: z.string().nullable().optional(),
  percent_used: z.number().nullable().optional(),
  distance_used: z.number().nullable().optional(),
  time_used: z.number().nullable().optional(),
  activities_used: z.number().int().nullable().optional(),
  days_used: z.number().int().nullable().optional(),
};

// Fields for `intervals_update_route` (AthleteRoute).
export const athleteRouteFields = {
  athlete_id: z.string().nullable().optional(),
  route_id: z.number().int().nullable().optional(),
  name: z.string().nullable().optional(),
  rename_activities: z
    .boolean()
    .nullable()
    .optional()
    .describe("Rename activities on this route when the route is renamed."),
  commute: z.boolean().nullable().optional(),
  tags: z.array(z.string()).nullable().optional(),
  description: z.string().nullable().optional(),
  replaced_by_route_id: z.number().int().nullable().optional(),
  latlngs: z
    .array(z.array(z.number()))
    .nullable()
    .optional()
    .describe("Route points as [lat, lng] pairs."),
};

// Custom item types and visibility (CustomItem).
export const customItemTypeValues = [
  "FITNESS_CHART",
  "FITNESS_TABLE",
  "TRACE_CHART",
  "INPUT_FIELD",
  "ACTIVITY_FIELD",
  "INTERVAL_FIELD",
  "ACTIVITY_STREAM",
  "ACTIVITY_CHART",
  "ACTIVITY_HISTOGRAM",
  "ACTIVITY_HEATMAP",
  "ACTIVITY_MAP",
  "ACTIVITY_PANEL",
  "ZONES",
] as const;
export const customItemVisibilityValues = [
  "PRIVATE",
  "FOLLOWERS",
  "PUBLIC",
] as const;

// Fields for `intervals_create_custom_item` /
// `intervals_update_custom_item` (CustomItem). `content` is the item's
// own definition JSON (chart config, field spec, …) and is free-form
// by nature. The same fields serve `intervals_update_custom_item_indexes`,
// whose body is an ARRAY of these objects (the reorder reads id + index).
export const customItemFields = {
  type: z.enum(customItemTypeValues).nullable().optional(),
  visibility: z.enum(customItemVisibilityValues).nullable().optional(),
  name: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  image: z.string().nullable().optional(),
  content: z
    .record(z.string(), z.any())
    .nullable()
    .optional()
    .describe("Item definition JSON (chart config, field spec, …)."),
  index: z
    .number()
    .int()
    .nullable()
    .optional()
    .describe(
      "Position in the list. The reorder endpoint is 1-based and rejects 0.",
    ),
  hide_script: z.boolean().nullable().optional(),
  hidden_by_id: z.string().nullable().optional(),
  from_id: z.number().int().nullable().optional(),
};

// Weather forecast provider (WeatherConfig's Forecast).
export const weatherForecastProviderValues = ["OPEN_WEATHER"] as const;

// Fields for one forecast entry (Forecast) and for
// `intervals_update_weather_config` (WeatherConfig).
export const weatherForecastFields = {
  id: z.number().int().nullable().optional(),
  provider: z.enum(weatherForecastProviderValues).nullable().optional(),
  location: z.string().nullable().optional(),
  label: z.string().nullable().optional(),
  lat: z.number().nullable().optional(),
  lon: z.number().nullable().optional(),
  enabled: z.boolean().nullable().optional(),
};
export const weatherConfigFields = {
  forecasts: z
    .array(z.object(weatherForecastFields).passthrough())
    .nullable()
    .optional(),
};

// Chat message types (NewMessage / Message).
export const messageTypeValues = [
  "TEXT",
  "FOLLOW_REQ",
  "COACH_REQ",
  "COACH_ME_REQ",
  "ACTIVITY",
  "NOTE",
  "JOIN_REQ",
  "ACCEPT_COACHING_GROUP",
] as const;

// Fields for `intervals_send_chat_message` (NewMessage) and
// `intervals_update_chat_message` (Message): the settable fields of
// both. Server-set fields (id, created, deleted, …) are passthrough.
export const chatMessageFields = {
  type: z.enum(messageTypeValues).nullable().optional(),
  content: z.string().nullable().optional(),
  activity_id: z.string().nullable().optional(),
  start_index: z.number().int().nullable().optional(),
  end_index: z.number().int().nullable().optional(),
  answer: z.string().nullable().optional(),
  attachment_url: z.string().nullable().optional(),
  attachment_mime_type: z.string().nullable().optional(),
  chat_id: z.number().int().nullable().optional(),
  to_athlete_id: z.string().nullable().optional(),
  to_activity_id: z.string().nullable().optional(),
  askACoach: z.boolean().nullable().optional(),
  attachment_id: z.string().nullable().optional(),
  join_group_id: z.number().int().nullable().optional(),
  accept_coaching_group_id: z.number().int().nullable().optional(),
  name: z.string().nullable().optional(),
  seen: z.boolean().nullable().optional(),
};
