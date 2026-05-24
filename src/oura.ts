import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ok } from "./util.js";
import type { OAuthProviderConfig } from "./oauth.js";

const OURA_BASE = "https://api.ouraring.com/v2";

// Scopes Oura supports (space-separated per OAuth 2.0 spec; Oura accepts both
// space-encoded and '+'-encoded). Skipped: `email` (don't need PII), since
// `personal` already gives us the identity endpoint.
export const OURA_DEFAULT_SCOPES =
  "personal daily heartrate workout session tag spo2";

export const OURA_OAUTH: OAuthProviderConfig = {
  label: "Oura",
  authorizeUrl: "https://cloud.ouraring.com/oauth/authorize",
  tokenUrl: "https://api.ouraring.com/oauth/token",
  scopes: OURA_DEFAULT_SCOPES,
  scopeSeparator: " ",
  parseTokenResponse: (body) => {
    const j = body as { access_token: string; refresh_token: string; expires_in: number };
    return {
      accessToken: j.access_token,
      refreshToken: j.refresh_token,
      // Oura uses expires_in (seconds from now), unlike Strava's expires_at
      expiresAt: Date.now() + j.expires_in * 1000,
    };
  },
  // Oura's token response doesn't carry identity. Fetch separately via the
  // personal_info endpoint (requires the `personal` scope).
  fetchIdentity: async (accessToken) => {
    const res = await fetch(`${OURA_BASE}/usercollection/personal_info`, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
    });
    if (!res.ok) throw new Error(`Oura personal_info fetch failed: ${res.status}`);
    const j = (await res.json()) as { id: string; email?: string };
    // Oura's personal_info doesn't include a name field — best available
    // human-readable handle is the email when the scope is granted, falling
    // back to a synthetic label.
    const display = j.email ?? `Oura user ${j.id.slice(0, 8)}`;
    return { providerUserId: j.id, displayName: display };
  },
};

const DateRangeShape = {
  start_date: z.string().optional().describe("YYYY-MM-DD (inclusive). Defaults to one day before end_date."),
  end_date: z.string().optional().describe("YYYY-MM-DD (inclusive). Defaults to today."),
  next_token: z.string().optional().describe("Pagination cursor from a previous response's next_token."),
};

const DateTimeRangeShape = {
  start_datetime: z
    .string()
    .optional()
    .describe("ISO-8601 datetime with timezone (inclusive). Defaults to one day before end_datetime."),
  end_datetime: z
    .string()
    .optional()
    .describe("ISO-8601 datetime with timezone (inclusive). Defaults to now."),
  next_token: z.string().optional().describe("Pagination cursor from a previous response's next_token."),
};

const IdShape = { document_id: z.string().min(1).describe("Oura document id (UUID).") };

function buildQs(params: Record<string, string | undefined>): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== "") qs.set(k, v);
  }
  const s = qs.toString();
  return s ? `?${s}` : "";
}

function makeOuraFetch(getAccessToken: () => Promise<string>) {
  return async function ouraFetch(path: string, init: RequestInit = {}): Promise<unknown> {
    const token = await getAccessToken();
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${token}`);
    headers.set("Accept", "application/json");
    if (init.body) headers.set("Content-Type", "application/json");

    const res = await fetch(`${OURA_BASE}${path}`, { ...init, headers });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`Oura ${init.method ?? "GET"} ${path} → ${res.status}: ${text}`);
    }
    return text ? JSON.parse(text) : null;
  };
}

function listAndGet(
  server: McpServer,
  ouraFetch: ReturnType<typeof makeOuraFetch>,
  collection: string,
  toolBaseName: string,
  description: string,
  opts: { datetime?: boolean; noGet?: boolean } = {},
) {
  const dateLabel = opts.datetime ? "datetime range" : "date range";
  server.tool(
    `oura_list_${toolBaseName}`,
    `List Oura ${description} for a ${dateLabel}. Returns { data, next_token }.`,
    opts.datetime ? DateTimeRangeShape : DateRangeShape,
    async (args: Record<string, string | undefined>) =>
      ok(await ouraFetch(`/usercollection/${collection}${buildQs(args)}`)),
  );

  if (!opts.noGet) {
    server.tool(
      `oura_get_${toolBaseName}`,
      `Fetch a single Oura ${description} document by id.`,
      IdShape,
      async ({ document_id }) =>
        ok(await ouraFetch(`/usercollection/${collection}/${encodeURIComponent(document_id)}`)),
    );
  }
}

export function registerOuraTools(
  server: McpServer,
  getAccessToken: () => Promise<string>,
) {
  const ouraFetch = makeOuraFetch(getAccessToken);

  // === Personal info (singleton) ===
  server.tool(
    "oura_personal_info",
    "Get the authenticated Oura user's profile (age, weight, height, biological sex, email).",
    {},
    async () => ok(await ouraFetch("/usercollection/personal_info")),
  );

  // === Daily summaries ===
  listAndGet(server, ouraFetch, "daily_activity", "daily_activity", "daily activity summaries");
  listAndGet(server, ouraFetch, "daily_cardiovascular_age", "daily_cardiovascular_age", "daily cardiovascular age estimates");
  listAndGet(server, ouraFetch, "daily_readiness", "daily_readiness",
    "daily readiness scores (0-100, higher = more recovered; ≥85 = go hard, 70-84 = normal, <70 = consider easy/rest). Key contributors: hrv_balance, body_temperature, resting_heart_rate, recovery_index, previous_night, sleep_balance, previous_day_activity, activity_balance");
  listAndGet(server, ouraFetch, "daily_resilience", "daily_resilience", "daily resilience scores");
  listAndGet(server, ouraFetch, "daily_sleep", "daily_sleep",
    "daily sleep scores (0-100, higher = better; ≥85 = optimal, 70-84 = good, <70 = poor). Key fields: score, contributors (deep_sleep, efficiency, latency, rem_sleep, restfulness, timing, total_sleep), timestamp");
  listAndGet(server, ouraFetch, "daily_spo2", "daily_spo2", "daily average SpO₂ measurements");
  listAndGet(server, ouraFetch, "daily_stress", "daily_stress",
    "daily stress summaries. Key fields: stress_high (seconds in high stress), recovery_high (seconds in recovery), day_summary (restored/normal/stressful). Higher recovery_high and 'restored' summary = good recovery day");

  // === Sleep periods ===
  listAndGet(server, ouraFetch, "sleep", "sleep", "sleep periods (one entry per nap or main sleep)");
  listAndGet(server, ouraFetch, "sleep_time", "sleep_time", "recommended bedtime windows");

  // === Activity & sessions ===
  listAndGet(server, ouraFetch, "workout", "workout", "logged workouts");
  listAndGet(server, ouraFetch, "session", "session", "guided sessions (meditation, breathwork, etc.)");
  listAndGet(server, ouraFetch, "enhanced_tag", "enhanced_tag", "user-applied enhanced tags");
  listAndGet(server, ouraFetch, "rest_mode_period", "rest_mode_period", "rest mode periods");
  listAndGet(server, ouraFetch, "vO2_max", "vo2_max", "VO₂ Max estimates");

  // === Heart rate (high-frequency, datetime-based, no get-by-id) ===
  listAndGet(server, ouraFetch, "heartrate", "heartrate", "heart rate samples", {
    datetime: true,
    noGet: true,
  });

  // === Ring configuration (no date filter) ===
  server.tool(
    "oura_list_ring_configuration",
    "List the user's Oura ring configurations (size, color, hardware type, firmware).",
    { next_token: z.string().optional().describe("Pagination cursor from a previous response.") },
    async ({ next_token }) =>
      ok(await ouraFetch(`/usercollection/ring_configuration${buildQs({ next_token })}`)),
  );

  server.tool(
    "oura_get_ring_configuration",
    "Fetch a single Oura ring configuration by id.",
    IdShape,
    async ({ document_id }) =>
      ok(await ouraFetch(`/usercollection/ring_configuration/${encodeURIComponent(document_id)}`)),
  );
}
