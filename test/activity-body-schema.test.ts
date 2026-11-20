import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import {
  activityBodyFields,
  gearBodyFields,
  manualActivityCreateFields,
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
