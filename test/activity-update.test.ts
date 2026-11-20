import test from "node:test";
import assert from "node:assert/strict";
import {
  findActivityUpdateBodyError,
  findUnknownGearId,
} from "../src/activity-update.ts";

test("flat gear_id is rejected with the gear-object guidance", () => {
  const err = findActivityUpdateBodyError({ gear_id: "76171" });
  assert.ok(err);
  assert.match(err, /gear_id is not an Intervals activity field/);
  assert.match(err, /\{"gear": \{"id"/);
  assert.match(err, /intervals_list_gear/);
});

test("flat gear_id is rejected even alongside valid fields", () => {
  assert.ok(findActivityUpdateBodyError({ gear_id: "76171", name: "Easy" }));
});

test("correct gear shape and gear-free bodies pass the shape guard", () => {
  assert.equal(
    findActivityUpdateBodyError({ gear: { id: "76171" } }),
    null,
  );
  assert.equal(findActivityUpdateBodyError({ name: "Easy" }), null);
  assert.equal(findActivityUpdateBodyError({}), null);
});

test("gear id present in the list passes", () => {
  const list = [{ id: "76171", name: "Superblast 3" }, { id: "60829" }];
  assert.equal(findUnknownGearId({ gear: { id: "76171" } }, list), null);
});

test("gear id compared as a string, so a numeric id matches a string list id", () => {
  const list = [{ id: "76171" }];
  assert.equal(findUnknownGearId({ gear: { id: 76171 } }, list), null);
});

test("gear id missing from the list is rejected with the id and guidance", () => {
  const err = findUnknownGearId(
    { gear: { id: "g35061301" } },
    [{ id: "76171" }, { id: "60829" }],
  );
  assert.ok(err);
  assert.match(err, /g35061301/);
  assert.match(err, /not in the athlete's gear list/);
  assert.match(err, /intervals_list_gear/);
});

test("gear check fails open when the list is missing or malformed", () => {
  assert.equal(findUnknownGearId({ gear: { id: "76171" } }, null), null);
  assert.equal(
    findUnknownGearId({ gear: { id: "76171" } }, { id: "76171" }),
    null,
  );
});

test("gear check passes when there is no gear id to check", () => {
  const list = [{ id: "76171" }];
  assert.equal(findUnknownGearId({}, list), null);
  assert.equal(findUnknownGearId({ gear: {} }, list), null);
  assert.equal(findUnknownGearId({ gear: "76171" }, list), null);
  // null gear (clearing the shoe) has no id to check.
  assert.equal(findUnknownGearId({ gear: null }, list), null);
});
