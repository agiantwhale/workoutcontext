import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { sportSettingsFields } from "../src/activity-body-schema.ts";

const body = z.object({ ...sportSettingsFields }).passthrough();
const bulkBody = z.array(body);

test("sport settings accept HR zones, thresholds and sport types", () => {
  const out = body.parse({
    id: 3332355,
    types: ["Run", "VirtualRun", "TrailRun"],
    hr_zones: [129, 147, 156, 166, 174],
    hr_zone_names: ["Riscaldamento", "Facile", "Aerobico", "Soglia", "Massima"],
    lthr: 165,
    max_hr: 174,
  });
  assert.equal(out.lthr, 165);
  assert.deepEqual(out.types, ["Run", "VirtualRun", "TrailRun"]);
});

test("sport settings reject a non-sport type in `types`", () => {
  assert.throws(
    () => body.parse({ types: ["Run", "Note"] }),
    /Invalid option/,
  );
});

test("bulk sport settings require an array — a single object is rejected", () => {
  const entry = { id: 3332355, lthr: 165 };
  assert.deepEqual(bulkBody.parse([entry]), [entry]);
  assert.throws(() => bulkBody.parse(entry), /expected array/);
});

test("sport settings body keeps unknown keys and accepts nulls", () => {
  const out = body.parse({ lthr: null, some_future_field: 1 });
  assert.equal(out.lthr, null);
  assert.equal(out.some_future_field, 1);
});
