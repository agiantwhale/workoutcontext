// Unit tests for the per-user sync registry (issue #163 Phase 2:
// the auto-label toggle is a registry sync). Run with: npm test
// (node --test, type stripping)
import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_SYNCS,
  isSyncEnabled,
  lookupSync,
  syncsForDest,
  syncsForSource,
} from "../src/sync-registry.ts";

test("auto-label is a registered intervals → intervals sync", () => {
  const descriptor = lookupSync("intervals", "intervals");
  assert.ok(descriptor);
  assert.equal(descriptor.contentLabel, "Auto-label activity intervals");
});

test("auto-label renders under the Intervals card", () => {
  const sources = syncsForSource("intervals");
  assert.equal(sources.length, 1);
  assert.equal(sources[0].contentLabel, "Auto-label activity intervals");
});

test("disconnecting Intervals revokes auto-label", () => {
  const dests = syncsForDest("intervals");
  assert.ok(
    dests.some((s) => s.source === "intervals" && s.dest === "intervals"),
  );
});

test("new signups get auto-label on", () => {
  assert.equal(DEFAULT_SYNCS["intervals.intervals"], true);
});

test("isSyncEnabled: missing dict or key reads as off", () => {
  assert.equal(isSyncEnabled(undefined, "intervals", "intervals"), false);
  assert.equal(isSyncEnabled({}, "intervals", "intervals"), false);
  assert.equal(
    isSyncEnabled({ "intervals.intervals": false }, "intervals", "intervals"),
    false,
  );
  assert.equal(
    isSyncEnabled({ "intervals.intervals": true }, "intervals", "intervals"),
    true,
  );
});

test("unknown pairs are not registered", () => {
  assert.equal(lookupSync("strava", "intervals"), undefined);
  assert.equal(lookupSync("intervals", "hevy"), undefined);
});
