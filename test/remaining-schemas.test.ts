import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import {
  activityMessageFields,
  activityStreamFields,
  applyPlanFields,
  athleteRouteFields,
  athleteUpdateFields,
  chatMessageFields,
  customItemFields,
  duplicateEventsFields,
  duplicateWorkoutsFields,
  folderFields,
  gearReminderFields,
  planWorkoutRangeFields,
  sharedWithFields,
  trainingPlanUpdateFields,
  weatherConfigFields,
  workoutFields,
} from "../src/activity-body-schema.ts";

const body = (fields: Record<string, z.ZodTypeAny>) =>
  z.object(fields).passthrough();

test("activity message body is just content", () => {
  const b = body(activityMessageFields);
  assert.equal(b.parse({ content: "Nice run!" }).content, "Nice run!");
  assert.deepEqual(b.parse({}), {});
});

test("activity stream body accepts numeric and latlng data", () => {
  const streams = z
    .array(z.object(activityStreamFields).passthrough())
    .min(1);
  assert.equal(streams.parse([{ type: "watts", data: [200, 210] }]).length, 1);
  assert.deepEqual(
    streams.parse([{ type: "latlng", data: [[40.7, -74.0]] }])[0].data,
    [[40.7, -74.0]],
  );
  assert.throws(() => streams.parse([{ type: "watts", data: ["fast"] }]));
  assert.throws(() => streams.parse([]));
});

test("workout fields accept the sport enum and reject free text", () => {
  const b = body(workoutFields);
  assert.equal(b.parse({ name: "Tempo", type: "Run", target: "POWER" }).type, "Run");
  assert.throws(() => b.parse({ type: "running" }), /Invalid option/);
  assert.throws(() => b.parse({ target: "WATTS" }), /Invalid option/);
});

test("apply-plan body takes a folder id, a start date and extra workouts", () => {
  const b = body(applyPlanFields);
  const out = b.parse({
    folder_id: 824349,
    start_date_local: "2027-01-04",
    extra_workouts: [{ name: "Easy", type: "Run" }],
  });
  assert.equal(out.extra_workouts[0].name, "Easy");
  assert.throws(() =>
    b.parse({ extra_workouts: [{ type: "jogging" }] }),
  );
});

test("duplicate bodies take ids and copy counts", () => {
  assert.deepEqual(body(duplicateEventsFields).parse({
    numCopies: 1, weeksBetween: 2, eventIds: [158572556],
  }).eventIds, [158572556]);
  assert.deepEqual(body(duplicateWorkoutsFields).parse({
    numCopies: 2, weeksBetween: 1, workoutIds: [5],
  }).workoutIds, [5]);
});

test("folder body accepts the type/visibility enums and sport list", () => {
  const b = body(folderFields);
  const out = b.parse({
    type: "PLAN", name: "Base", visibility: "PRIVATE",
    activity_types: ["Run", "VirtualRun"],
  });
  assert.equal(out.type, "PLAN");
  assert.throws(() => b.parse({ type: "FOLDERS" }), /Invalid option/);
  assert.throws(() => b.parse({ activity_types: ["running"] }), /Invalid option/);
  assert.throws(() => b.parse({ visibility: "FRIENDS" }), /Invalid option/);
});

test("shared-with body is an array of athletes", () => {
  const list = z.array(z.object(sharedWithFields).passthrough());
  assert.equal(list.parse([{ id: "i290753", canEdit: true }]).length, 1);
  assert.equal(list.parse([]).length, 0);
});

test("plan-workout range body only accepts hide_from_athlete (strict)", () => {
  const b = z.object(planWorkoutRangeFields).strict();
  assert.equal(b.parse({ hide_from_athlete: true }).hide_from_athlete, true);
  assert.equal(b.parse({}).hide_from_athlete, undefined);
  assert.throws(() => b.parse({ name: "Tempo" }), /Unrecognized key/);
  assert.throws(() => b.parse({ type: "Run" }), /Unrecognized key/);
});

test("athlete update body accepts profile fields and enum values", () => {
  const b = body(athleteUpdateFields);
  const out = b.parse({
    city: "New York", timezone: "America/New_York",
    wind_speed: "MPH", rain: "INCHES", visibility: "PUBLIC",
    email_notifications: ["ACHIEVEMENTS"],
  });
  assert.equal(out.wind_speed, "MPH");
  assert.throws(() => b.parse({ wind_speed: "MS" }), /Invalid option/);
  assert.throws(() => b.parse({ email_notifications: ["SPAM"] }), /Invalid option/);
  assert.equal(b.parse({ weight: null }).weight, null);
});

test("training plan update body takes the plan id and start date", () => {
  const out = body(trainingPlanUpdateFields).parse({
    training_plan_id: 123, training_plan_start_date: "2027-01-04",
  });
  assert.equal(out.training_plan_id, 123);
});

test("gear reminder body takes threshold fields", () => {
  const out = body(gearReminderFields).parse({
    name: "Chain check", distance: 500000, days: 90,
  });
  assert.equal(out.distance, 500000);
});

test("route body takes latlng pairs", () => {
  const b = body(athleteRouteFields);
  const out = b.parse({ name: "CP Loop", latlngs: [[40.78, -73.97]] });
  assert.deepEqual(out.latlngs, [[40.78, -73.97]]);
  assert.throws(() => b.parse({ latlngs: [["40.78", "-73.97"]] }));
});

test("custom item body accepts the type enum and free-form content", () => {
  const b = body(customItemFields);
  const out = b.parse({
    type: "FITNESS_CHART", visibility: "PUBLIC", content: { chart: "ctl" },
  });
  assert.equal(out.type, "FITNESS_CHART");
  assert.throws(() => b.parse({ type: "CHART" }), /Invalid option/);
  assert.throws(() => b.parse({ visibility: "FRIENDS" }), /Invalid option/);
});

test("weather config body takes forecast entries with the provider enum", () => {
  const b = body(weatherConfigFields);
  const out = b.parse({
    forecasts: [{ provider: "OPEN_WEATHER", location: "New York", enabled: true }],
  });
  assert.equal(out.forecasts[0].provider, "OPEN_WEATHER");
  assert.throws(() =>
    b.parse({ forecasts: [{ provider: "DARK_SKY" }] }),
  );
});

test("chat message body accepts the type enum", () => {
  const b = body(chatMessageFields);
  assert.equal(b.parse({ type: "TEXT", content: "hi" }).type, "TEXT");
  assert.throws(() => b.parse({ type: "DM" }), /Invalid option/);
});
