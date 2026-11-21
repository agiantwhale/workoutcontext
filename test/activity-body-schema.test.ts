import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import {
  activityBodyFields,
  activityFilterSchema,
  eventCategoryValues,
  eventRangeUpdateFields,
  gearBodyFields,
  manualActivityCreateFields,
  wellnessFields,
} from "../src/activity-body-schema.ts";

const gearBody = z.object({ ...gearBodyFields }).passthrough();
const activityBody = z.object({ ...activityBodyFields }).passthrough();
const manualCreateBody = z
  .object({ ...manualActivityCreateFields })
  .passthrough();

test("gear type enum accepts 'Shoes' and rejects 'shoes'", () => {
  assert.equal(
    gearBody.parse({ type: "Shoes", name: "Superblast 3" }).type,
    "Shoes",
  );
  assert.throws(() => gearBody.parse({ type: "shoes" }), /Invalid option/);
  assert.throws(() => gearBody.parse({ type: "Sneakers" }), /Invalid option/);
});

test("gear body keeps unknown keys and accepts nulls", () => {
  const out = gearBody.parse({ type: "Shoes", some_future_field: 1 });
  assert.equal(out.some_future_field, 1);
  assert.equal(gearBody.parse({ type: null, name: null }).type, null);
});

test("activity body accepts the gear shape and keeps unknown keys", () => {
  const out = activityBody.parse({
    gear: { id: "76171" },
    name: "Easy",
    device_name: "COROS PACE 4",
  });
  assert.deepEqual(out.gear, { id: "76171" });
  assert.equal(out.device_name, "COROS PACE 4");
});

test("activity body accepts nulls (old record passed null through)", () => {
  const out = activityBody.parse({ gear: null, name: null });
  assert.equal(out.gear, null);
  assert.equal(out.name, null);
});

test("manual create body adds start, moving time and distance", () => {
  const out = manualCreateBody.parse({
    type: "Run",
    name: "Morning easy",
    start_date_local: "2026-11-20T07:00:00",
    moving_time: 1800,
    distance: 5000,
  });
  assert.equal(out.moving_time, 1800);
  assert.equal(out.distance, 5000);
  assert.equal(out.start_date_local, "2026-11-20T07:00:00");
});

test("event category enum covers all 14 spec values and rejects typos", () => {
  assert.equal(eventCategoryValues.length, 14);
  const category = z.enum(eventCategoryValues);
  for (const value of eventCategoryValues) {
    assert.equal(category.parse(value), value);
  }
  assert.throws(() => category.parse("workout"), /Invalid option/);
  assert.throws(() => category.parse("RACE"), /Invalid option/);
  assert.throws(() => category.parse("NOTES"), /Invalid option/);
});

test("event category field defaults to WORKOUT", () => {
  const field = z.enum(eventCategoryValues).default("WORKOUT");
  assert.equal(field.parse(undefined), "WORKOUT");
  assert.equal(field.parse("NOTE"), "NOTE");
});

test("activity type is the sport enum", () => {
  assert.equal(activityBody.parse({ type: "Run" }).type, "Run");
  assert.equal(activityBody.parse({ type: "WeightTraining" }).type, "WeightTraining");
  assert.throws(() => activityBody.parse({ type: "running" }), /Invalid option/);
  assert.throws(() => activityBody.parse({ type: "Swim " }), /Invalid option/);
});

test("wellness fields parse and enforce the 1-4 ranges", () => {
  const wellnessBody = z.object({ ...wellnessFields }).passthrough();
  const out = wellnessBody.parse({
    restingHR: 52,
    hrv: 61,
    weight: 61.2,
    sleepSecs: 28800,
    sleepQuality: 3,
    comments: "test",
  });
  assert.equal(out.restingHR, 52);
  assert.equal(out.sleepQuality, 3);
  assert.throws(() => wellnessBody.parse({ sleepQuality: 5 }), /Too big: expected number to be <=4/);
  assert.throws(() => wellnessBody.parse({ fatigue: 0 }), /Too small: expected number to be >=1/);
  assert.equal(wellnessBody.parse({ some_future_field: 1 }).some_future_field, 1);
});

test("wellness bulk entries require an id (date)", () => {
  const entry = z.object({ id: z.string(), ...wellnessFields }).passthrough();
  assert.equal(entry.parse({ id: "2027-06-20", restingHR: 55 }).id, "2027-06-20");
  assert.throws(() => entry.parse({ restingHR: 55 }), /expected string, received undefined/);
});

test("activity filter schema parses type, numeric and text filters", () => {
  assert.deepEqual(activityFilterSchema.parse({
    field_id: "type",
    operator: "=",
    value: ["Run"],
  }), { field_id: "type", operator: "=", value: ["Run"] });
  assert.equal(
    activityFilterSchema.parse({ field_id: "distance", operator: ">", value: 10000 }).value,
    10000,
  );
  assert.equal(
    activityFilterSchema.parse({ field_id: "name", operator: "contains", value: "Run" }).value,
    "Run",
  );
  assert.equal(
    activityFilterSchema.parse({ field_id: "indoor", operator: "=", value: true }).value,
    true,
  );
  assert.equal(
    activityFilterSchema.parse({ field_id: "type", operator: "=", value: ["Run"], not: true }).not,
    true,
  );
});

test("activity filter schema rejects bad field, operator and value shapes", () => {
  assert.throws(
    () => activityFilterSchema.parse({ field_id: "bogus", operator: "=", value: ["Run"] }),
    /Invalid option/,
  );
  assert.throws(
    () => activityFilterSchema.parse({ field_id: "type", operator: "like", value: ["Run"] }),
    /Invalid option/,
  );
  assert.throws(
    () => activityFilterSchema.parse({ field_id: "type", operator: "=" }),
    /expected.*received undefined/,
  );
});

test("activity filter list accepts an array of filters or a JSON string", () => {
  const list = z.union([z.array(activityFilterSchema), z.string()]);
  assert.equal(list.parse([{ field_id: "type", operator: "=", value: ["Run"] }]).length, 1);
  const json = '[{"field_id":"type","operator":"=","value":["Run"]}]';
  assert.equal(list.parse(json), json);
});

test("singular wellness update body shares the wellness fields and requires id", () => {
  const body = z.object({ id: z.string(), ...wellnessFields }).passthrough();
  assert.equal(body.parse({ id: "2027-06-22", restingHR: 55, sleepQuality: 3 }).restingHR, 55);
  assert.throws(() => body.parse({ id: "2027-06-22", sleepQuality: 5 }), /Too big/);
  assert.throws(() => body.parse({ restingHR: 55 }), /expected string, received undefined/);
});

test("gear replace body shares the gear fields and rejects a lowercase type", () => {
  const body = z.object(gearBodyFields).passthrough();
  assert.equal(body.parse({ type: "Shoes", name: "[TEST] replace" }).type, "Shoes");
  assert.throws(() => body.parse({ type: "shoes" }), /Invalid option/);
});

test("event range-update body has enums but no category default", () => {
  const body = z.object(eventRangeUpdateFields).passthrough();
  assert.equal(body.parse({ category: "NOTE" }).category, "NOTE");
  assert.equal(body.parse({}).category, undefined);
  assert.throws(() => body.parse({ category: "WORKOUTS" }), /Invalid option/);
  assert.throws(() => body.parse({ type: "running" }), /Invalid option/);
  assert.equal(body.parse({ name: "x", custom_field: 1 }).custom_field, 1);
});
