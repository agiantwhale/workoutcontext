// Shared zod field sets for Activity and Gear bodies — imports only
// zod, so it is unit-testable under node --test (see
// test/activity-body-schema.test.ts).
//
// The tools build a fresh z.object from these sets per tool (same pattern
// as intervalBodyFields in intervals.ts) so a per-tool .describe() cannot
// leak across. Every field is nullable + optional: the old free-form
// record passed null through, and Intervals treats null as no-change.
// The objects are passthrough: any other field from the Intervals.ICU
// OpenAPI schema — including athlete-defined custom fields — flows
// through unchanged.

import { z } from "zod";

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
    .string()
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
