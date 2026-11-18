import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseHevyResponseBody } from "../src/hevy-response.ts";

describe("parseHevyResponseBody", () => {
  it("returns null for an empty body", () => {
    assert.equal(parseHevyResponseBody(""), null);
  });

  it("parses a JSON object", () => {
    assert.deepEqual(parseHevyResponseBody('{"id":"abc","title":"Squat"}'), {
      id: "abc",
      title: "Squat",
    });
  });

  it("parses a JSON array", () => {
    assert.deepEqual(parseHevyResponseBody('[{"id":1},{"id":2}]'), [
      { id: 1 },
      { id: 2 },
    ]);
  });

  it("returns a bare UUID string as-is (Hevy create-exercise-template)", () => {
    const uuid = "ec84bd42-1a2b-3c4d-5e6f-7890abcdef12";
    assert.equal(parseHevyResponseBody(uuid), uuid);
  });

  it("returns other non-JSON text as-is", () => {
    assert.equal(parseHevyResponseBody("ok"), "ok");
  });

  it("still parses JSON scalars", () => {
    assert.equal(parseHevyResponseBody("123"), 123);
    assert.equal(parseHevyResponseBody("null"), null);
  });
});
