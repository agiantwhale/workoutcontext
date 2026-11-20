// Pure validation for intervals_update_activity bodies — no imports, so
// it is unit-testable under node --test (see
// test/activity-update.test.ts).
//
// Two guards, both fail fast with a message the calling assistant can act
// on instead of Intervals' terse 422:
// 1. a flat `gear_id` top-level field — not a real Intervals activity
//    field (Intervals rejects it as "Unknown custom field [gear_id]");
//    the gear goes in `gear: { id }`.
// 2. a `gear.id` that is not in the athlete's gear list — the handler
//    fetches the list once via GET /athlete/{id}/gear before the PUT and
//    passes it here, so this check stays pure. A missing/unreadable list
//    fails open (returns null) and the PUT goes ahead for Intervals to
//    decide.

export function findActivityUpdateBodyError(
  body: Record<string, unknown>,
): string | null {
  if ("gear_id" in body) {
    return (
      'gear_id is not an Intervals activity field — set the shoe/gear with ' +
      'body {"gear": {"id": "<gear id>"}} using an id from intervals_list_gear.'
    );
  }
  return null;
}

export function findUnknownGearId(
  body: Record<string, unknown>,
  gearList: unknown,
): string | null {
  const gear = body.gear;
  if (gear === null || typeof gear !== "object" || Array.isArray(gear)) {
    return null;
  }
  const id = (gear as Record<string, unknown>).id;
  if (id === undefined || id === null) return null;
  // Fail open when the list is missing or malformed: the PUT goes ahead
  // and Intervals decides.
  if (!Array.isArray(gearList)) return null;
  const known = new Set(
    gearList.map((g) =>
      String((g as Record<string, unknown> | null)?.id ?? ""),
    ),
  );
  if (!known.has(String(id))) {
    return (
      `gear id "${String(id)}" is not in the athlete's gear list — ` +
      "use an id from intervals_list_gear."
    );
  }
  return null;
}
