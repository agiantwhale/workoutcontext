// Hevy webhook subscription management.
//
// Endpoint: POST /v1/webhook-subscription. Not in Hevy's published OpenAPI
// spec but reachable and stable — confirmed empirically against staging.
// One subscription per account; POST is upsert-style (returns 201 either
// way; the existing subscription's url + auth_token are replaced). DELETE
// removes the subscription.
//
// Body shape quirk: the GET response returns snake_case (`auth_token`) but
// the POST body must use camelCase (`authToken`). Wrapping the body in a
// `{ webhook: {...} }` envelope returns 400 — only the flat shape works,
// despite what some third-party clients (chrisdoc/hevy-mcp) imply.
//
// Hevy delivers POSTs ONLY on workout creation — not updates, not deletes.
// To detect deletes we'd need to poll `GET /v1/workouts/events` instead.

const HEVY_BASE = "https://api.hevyapp.com/v1";

// POST our notify URL + the per-user auth token to Hevy. Idempotent — same
// values produce no observable change; different values replace the
// previously registered subscription. Logs on non-201 but doesn't throw,
// so a subscribe failure won't fail the surrounding signup/connect flow.
export async function subscribeHevyWebhook(
  apiKey: string,
  notifyUrl: string,
  authToken: string,
): Promise<void> {
  const res = await fetch(`${HEVY_BASE}/webhook-subscription`, {
    method: "POST",
    headers: {
      "api-key": apiKey,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ url: notifyUrl, authToken }),
  });
  if (res.status !== 201) {
    const text = await res.text().catch(() => "");
    console.error(
      `[hevy/webhook-subscribe] POST /webhook-subscription → ${res.status}: ${text}`,
    );
    return;
  }
  console.log(
    `[hevy/webhook-subscribe] subscribed url=${notifyUrl} (200/201 ok)`,
  );
}

// DELETE the subscription so a leaked webhook token can't continue delivering
// to a disconnected user. Like subscribe, logs on failure but doesn't throw —
// disconnect must succeed even if Hevy is unreachable.
export async function unsubscribeHevyWebhook(apiKey: string): Promise<void> {
  const res = await fetch(`${HEVY_BASE}/webhook-subscription`, {
    method: "DELETE",
    headers: {
      "api-key": apiKey,
      Accept: "application/json",
    },
  });
  // 200 or 204 means it was deleted; 404 means there was nothing to delete.
  // Both are acceptable end states for our purposes.
  if (res.status >= 300 && res.status !== 404) {
    const text = await res.text().catch(() => "");
    console.error(
      `[hevy/webhook-subscribe] DELETE /webhook-subscription → ${res.status}: ${text}`,
    );
    return;
  }
  console.log(`[hevy/webhook-subscribe] unsubscribed (status=${res.status})`);
}
