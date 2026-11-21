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
