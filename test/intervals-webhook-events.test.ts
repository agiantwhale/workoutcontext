// Unit tests for the Intervals.icu webhook envelope parser (issue #163
// Phase 2). Run with: npm test (node --test, type stripping)
import test from "node:test";
import assert from "node:assert/strict";
import {
  extractActivityId,
  extractPairedEventId,
  isActivityLabelTrigger,
  parseIntervalsWebhookEvents,
  payloadActivityHasTags,
} from "../src/intervals-webhook-events.ts";

// The envelope as observed live Nov 17, 2026 (staging CALENDAR_UPDATED
// delivery): { secret, events: [{ athlete_id, type, timestamp, events,
// deleted_events }] }.
const calendarDelivery = {
  secret: "s3cret",
  events: [
    {
      athlete_id: "i596923",
      type: "CALENDAR_UPDATED",
      timestamp: "2026-11-17T22:47:00.000+00:00",
      events: [{ id: 157472446, name: "[TEST] Webhook Probe" }],
      deleted_events: [],
    },
  ],
};

test("parses the observed envelope into one event per entry", () => {
  const parsed = parseIntervalsWebhookEvents(calendarDelivery);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].athleteId, "i596923");
  assert.equal(parsed[0].type, "CALENDAR_UPDATED");
  assert.equal(parsed[0].timestamp, "2026-11-17T22:47:00.000+00:00");
});

test("numeric athlete_id is stringified", () => {
  const parsed = parseIntervalsWebhookEvents({
    events: [{ athlete_id: 596923, type: "ACTIVITY_ANALYZED" }],
  });
  assert.equal(parsed[0].athleteId, "596923");
});

test("top-level type/athlete_id (the old parse) matches nothing", () => {
  // A body shaped like the handler used to expect yields no events —
  // the envelope's `events` array is the only source.
  const parsed = parseIntervalsWebhookEvents({
    type: "ACTIVITY_ANALYZED",
    athlete_id: "i596923",
  });
  assert.equal(parsed.length, 0);
});

test("malformed entries are skipped, not fatal", () => {
  const parsed = parseIntervalsWebhookEvents({
    events: [
      null,
      "not-an-object",
      { type: "ACTIVITY_ANALYZED" },
      { athlete_id: "i596923" },
      { athlete_id: "i596923", type: "ACTIVITY_ANALYZED" },
    ],
  });
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].type, "ACTIVITY_ANALYZED");
});

test("non-object bodies parse to no events", () => {
  assert.deepEqual(parseIntervalsWebhookEvents(null), []);
  assert.deepEqual(parseIntervalsWebhookEvents("garbage"), []);
  assert.deepEqual(parseIntervalsWebhookEvents({}), []);
});

test("extractActivityId reads activity.id first", () => {
  const [event] = parseIntervalsWebhookEvents({
    events: [
      {
        athlete_id: "i596923",
        type: "ACTIVITY_ANALYZED",
        activity: { id: "i211012182" },
      },
    ],
  });
  assert.equal(extractActivityId(event), "i211012182");
});

test("extractActivityId falls back to the inner events array", () => {
  const [event] = parseIntervalsWebhookEvents({
    events: [
      {
        athlete_id: "i596923",
        type: "ACTIVITY_ANALYZED",
        events: [{ id: "i211012182" }],
      },
    ],
  });
  assert.equal(extractActivityId(event), "i211012182");
});

test("extractActivityId returns null when no id is present", () => {
  const [event] = parseIntervalsWebhookEvents({
    events: [{ athlete_id: "i596923", type: "ACTIVITY_ANALYZED" }],
  });
  assert.equal(extractActivityId(event), null);
});

test("extractPairedEventId reads the payload's paired_event_id", () => {
  const [event] = parseIntervalsWebhookEvents({
    events: [
      {
        athlete_id: "i596923",
        type: "ACTIVITY_UPLOADED",
        activity: { id: "i211012182", paired_event_id: 157472446 },
      },
    ],
  });
  assert.equal(extractPairedEventId(event), 157472446);
});

test("extractPairedEventId returns null when unpaired or absent", () => {
  const [unpaired] = parseIntervalsWebhookEvents({
    events: [
      {
        athlete_id: "i596923",
        type: "ACTIVITY_UPLOADED",
        activity: { id: "i211012182" },
      },
    ],
  });
  assert.equal(extractPairedEventId(unpaired), null);
  const [noActivity] = parseIntervalsWebhookEvents({
    events: [{ athlete_id: "i596923", type: "ACTIVITY_UPLOADED" }],
  });
  assert.equal(extractPairedEventId(noActivity), null);
});

test("payloadActivityHasTags reports the tags array's presence", () => {
  const [withTags] = parseIntervalsWebhookEvents({
    events: [
      {
        athlete_id: "i596923",
        type: "ACTIVITY_UPLOADED",
        activity: { id: "i211012182", tags: ["intervals-labeled"] },
      },
    ],
  });
  assert.equal(payloadActivityHasTags(withTags), true);
  const [withoutTags] = parseIntervalsWebhookEvents({
    events: [
      {
        athlete_id: "i596923",
        type: "ACTIVITY_UPLOADED",
        activity: { id: "i211012182" },
      },
    ],
  });
  assert.equal(payloadActivityHasTags(withoutTags), false);
});

test("isActivityLabelTrigger fires on upload and pairing/edit only", () => {
  // Upload and manual pairing/edit — observed live Nov 17–18, 2026. The
  // run-once tag dedups across them. Re-analysis is deliberately not a
  // trigger: re-analyzing means the user is designing the intervals
  // themselves (Nov 18, 2026).
  assert.equal(isActivityLabelTrigger("ACTIVITY_UPLOADED"), true);
  assert.equal(isActivityLabelTrigger("ACTIVITY_UPDATED"), true);
  assert.equal(isActivityLabelTrigger("ACTIVITY_ANALYZED"), false);
});

test("isActivityLabelTrigger ignores other event types", () => {
  assert.equal(isActivityLabelTrigger("CALENDAR_UPDATED"), false);
  assert.equal(isActivityLabelTrigger("SPORT_SETTINGS_UPDATED"), false);
  assert.equal(isActivityLabelTrigger("ACTIVITY_DELETED"), false);
  assert.equal(isActivityLabelTrigger(""), false);
});
