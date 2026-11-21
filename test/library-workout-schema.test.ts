import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { libraryWorkoutBodyFields } from "../src/activity-body-schema.ts";

const body = z.object({ ...libraryWorkoutBodyFields }).passthrough();

test("library workout type enum accepts 'Run' and rejects 'Note'", () => {
  assert.equal(body.parse({ type: "Run", name: "Threshold" }).type, "Run");
  assert.throws(() => body.parse({ type: "Note" }), /Invalid option/);
  assert.throws(() => body.parse({ type: "run" }), /Invalid option/);
});

test("library workout body keeps unknown keys and accepts nulls", () => {
  const out = body.parse({ type: "Run", some_future_field: 1 });
  assert.equal(out.some_future_field, 1);
  assert.equal(body.parse({ type: null, name: null }).type, null);
});

test("library workout body accepts folder, tags and workout_doc", () => {
  const out = body.parse({
    type: "Run",
    name: "Threshold 2x20",
    folder_id: 1098310,
    tags: ["threshold"],
    workout_doc: { steps: [] },
  });
  assert.equal(out.folder_id, 1098310);
  assert.deepEqual(out.tags, ["threshold"]);
});
