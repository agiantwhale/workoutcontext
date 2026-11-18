// Pure parsing for the Intervals.icu webhook envelope — no imports, so it
// is unit-testable under node --test (see
// test/intervals-webhook-events.test.ts).
//
// Observed live Nov 17, 2026 (staging): a delivery is
//   { secret, events: [{ athlete_id, type, timestamp, events: [...], deleted_events: [...] }] }
// The handler previously parsed top-level `type` / `athlete_id`, which
// matches nothing in a real delivery.

export type IntervalsWebhookEvent = {
  athleteId: string;
  type: string;
  // ISO string in real deliveries ("2026-11-18T04:09:48.482+00:00");
  // kept as-is for logging, never parsed.
  timestamp?: string | number;
  raw: Record<string, unknown>;
};

// The two event types that can deliver a paired activity, and the only
// ones the label fan-out acts on (observed live Nov 17–18, 2026):
// a fresh upload (ACTIVITY_UPLOADED — the payload already carries
// paired_event_id when the upload auto-pairs) and a manual pairing or any
// other activity edit (ACTIVITY_UPDATED). ACTIVITY_ANALYZED is
// deliberately NOT a trigger (Nov 18, 2026): a re-analysis means the user
// is designing the activity's intervals themselves, so the fan-out stays
// out of the way — the manual labeler tool remains the way to re-label.
// The run-once tag dedups across the two triggers: whichever fires first
// labels, the other sees the tag and skips.
export function isActivityLabelTrigger(type: string): boolean {
  return type === "ACTIVITY_UPLOADED" || type === "ACTIVITY_UPDATED";
}

// Parse the envelope into its per-athlete events. Malformed entries are
// skipped (the handler logs the raw body, so they stay observable).
export function parseIntervalsWebhookEvents(
  body: unknown,
): IntervalsWebhookEvent[] {
  if (body === null || typeof body !== "object") return [];
  const events = (body as Record<string, unknown>).events;
  if (!Array.isArray(events)) return [];
  const out: IntervalsWebhookEvent[] = [];
  for (const entry of events) {
    if (entry === null || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const athleteId =
      typeof e.athlete_id === "string"
        ? e.athlete_id
        : typeof e.athlete_id === "number"
          ? String(e.athlete_id)
          : "";
    const type = typeof e.type === "string" ? e.type : "";
    if (!athleteId || !type) continue;
    out.push({
      athleteId,
      type,
      timestamp:
        typeof e.timestamp === "number" || typeof e.timestamp === "string"
          ? e.timestamp
          : undefined,
      raw: e,
    });
  }
  return out;
}

// The activity id for an ACTIVITY_* event. Observed live Nov 17–18, 2026:
// ACTIVITY_UPLOADED, ACTIVITY_UPDATED and ACTIVITY_ANALYZED all carry a
// full `activity` object with `activity.id` — that is the primary path.
// The `activity.activity_id` and inner-`events` fallbacks stay for
// shapes we have not seen yet.
export function extractActivityId(
  event: IntervalsWebhookEvent,
): string | null {
  const raw = event.raw;
  const activity = raw.activity;
  if (activity !== null && typeof activity === "object") {
    const a = activity as Record<string, unknown>;
    if (typeof a.id === "string" && a.id) return a.id;
    if (typeof a.id === "number") return String(a.id);
    if (typeof a.activity_id === "string" && a.activity_id)
      return a.activity_id;
  }
  const inner = raw.events;
  if (Array.isArray(inner) && inner.length > 0) {
    const first = inner[0];
    if (first !== null && typeof first === "object") {
      const f = first as Record<string, unknown>;
      if (typeof f.id === "string" && f.id) return f.id;
      if (typeof f.id === "number") return String(f.id);
    }
  }
  return null;
}
