import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ok } from "./util.js";
import type { OAuthProviderConfig } from "./oauth.js";

const WITHINGS_API = "https://wbsapi.withings.net";

// Scopes Withings exposes. user.info is required for the identity link;
// user.metrics / user.activity / user.sleepevents cover the read tools.
export const WITHINGS_DEFAULT_SCOPES = "user.info,user.metrics,user.activity,user.sleepevents";

interface WithingsResponse<T = unknown> {
  status: number;
  body?: T;
  error?: string;
}

export const WITHINGS_OAUTH: OAuthProviderConfig = {
  label: "Withings",
  authorizeUrl: "https://account.withings.com/oauth2_user/authorize2",
  tokenUrl: `${WITHINGS_API}/v2/oauth2`,
  scopes: WITHINGS_DEFAULT_SCOPES,
  scopeSeparator: ",",
  // Withings's token endpoint isn't pure OAuth 2.0: every request must
  // carry `action=requesttoken`, and successful responses are wrapped in
  // `{status: 0, body: {...}}` (non-zero status means error). Errors come
  // back with HTTP 200 and the status code inside the body, so the standard
  // res.ok check in oauth.ts can't catch them — parseTokenResponse below
  // throws on non-zero status.
  extraTokenParams: { action: "requesttoken" },
  parseTokenResponse: (raw) => {
    const w = raw as WithingsResponse<{
      access_token: string;
      refresh_token: string;
      expires_in: number;
      userid?: number;
    }>;
    if (w.status !== 0 || !w.body) {
      throw new Error(`Withings: status=${w.status} ${w.error ?? JSON.stringify(w.body ?? null)}`);
    }
    return {
      accessToken: w.body.access_token,
      refreshToken: w.body.refresh_token,
      expiresAt: Date.now() + w.body.expires_in * 1000,
    };
  },
  identityFromTokenResponse: (raw) => {
    const w = raw as WithingsResponse<{ userid?: number }>;
    if (w.status !== 0 || !w.body?.userid) return null;
    return {
      providerUserId: String(w.body.userid),
      // Withings's API has no user-name endpoint; userid is the only stable
      // identifier returned. Fall back to a synthetic display label — the
      // /settings page shows the providerUserId next to this anyway.
      displayName: `Withings user ${w.body.userid}`,
    };
  },
  // Identity is always carried in token responses, so this fallback is rarely
  // hit. Keep it defensive.
  fetchIdentity: async () => {
    throw new Error("Withings identity must come from the token response (use identityFromTokenResponse).");
  },
};

function makeWithingsApi(getAccessToken: () => Promise<string>) {
  return async function withingsApi(
    path: string,
    params: Record<string, string | number | undefined>,
  ): Promise<unknown> {
    const token = await getAccessToken();
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== "") qs.set(k, String(v));
    }
    const res = await fetch(`${WITHINGS_API}${path}?${qs}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const json = (await res.json()) as WithingsResponse;
    if (json.status !== 0) {
      throw new Error(
        `Withings GET ${path} → status=${json.status} ${json.error ?? JSON.stringify(json.body ?? null)}`,
      );
    }
    return json.body;
  };
}

export function registerWithingsTools(
  server: McpServer,
  getAccessToken: () => Promise<string>,
) {
  const withingsApi = makeWithingsApi(getAccessToken);

  // === Body measurements ===
  server.tool(
    "withings_get_measurements",
    "Get body measurements (weight=1, height=4, fat_free_mass=5, fat_ratio=6, fat_mass=8, diastolic_bp=9, systolic_bp=10, heart_pulse=11, temperature=12, spo2=54, body_temp=71, etc.) for a date range.",
    {
      meastype: z.string().optional().describe("Single measure type id, e.g. '1' for weight."),
      meastypes: z.string().optional().describe("Comma-separated measure type ids, e.g. '1,6,9,10'."),
      category: z.number().int().optional().describe("1=real measure (default), 2=user objective."),
      startdate: z.number().int().optional().describe("Unix timestamp inclusive."),
      enddate: z.number().int().optional().describe("Unix timestamp inclusive."),
      lastupdate: z
        .number()
        .int()
        .optional()
        .describe("Unix timestamp; only return measures updated after this. Mutually exclusive with start/enddate."),
      offset: z.number().int().optional(),
    },
    async (args) => ok(await withingsApi("/measure", { action: "getmeas", ...args })),
  );

  // === Activity ===
  server.tool(
    "withings_get_activity",
    "Daily activity summaries (steps, distance, calories, elevation, heart-rate zones) for a date range.",
    {
      startdateymd: z.string().optional().describe("YYYY-MM-DD inclusive."),
      enddateymd: z.string().optional().describe("YYYY-MM-DD inclusive."),
      lastupdate: z.number().int().optional(),
      offset: z.number().int().optional(),
      data_fields: z
        .string()
        .optional()
        .describe("Comma-separated fields. Common: steps,distance,calories,totalcalories,hr_average,hr_min,hr_max,hr_zone_0..3."),
    },
    async (args) => ok(await withingsApi("/v2/measure", { action: "getactivity", ...args })),
  );

  server.tool(
    "withings_get_intraday_activity",
    "Per-minute activity stream (steps, calories, elevation, distance, heart rate) for a datetime range. Withings limits this to 24h per request.",
    {
      startdate: z.number().int().describe("Unix timestamp inclusive."),
      enddate: z.number().int().describe("Unix timestamp inclusive (max 24h after startdate)."),
      data_fields: z
        .string()
        .optional()
        .describe("Comma-separated. Common: steps,elevation,calories,distance,stroke,pool_lap,duration,heart_rate."),
    },
    async (args) => ok(await withingsApi("/v2/measure", { action: "getintradayactivity", ...args })),
  );

  server.tool(
    "withings_get_workouts",
    "Logged workouts for a date range (run, walk, swim, bike, etc.).",
    {
      startdateymd: z.string().optional(),
      enddateymd: z.string().optional(),
      lastupdate: z.number().int().optional(),
      offset: z.number().int().optional(),
      data_fields: z
        .string()
        .optional()
        .describe("Common: calories,intensity,manual_distance,manual_calories,hr_average,hr_min,hr_max,hr_zone_0..3,pause_duration,algo_pause_duration,spo2_average,steps,distance,elevation,pool_laps,strokes,pool_length."),
    },
    async (args) => ok(await withingsApi("/v2/measure", { action: "getworkouts", ...args })),
  );

  // === Sleep ===
  server.tool(
    "withings_get_sleep",
    "Detailed sleep state stream (awake/light/deep/rem) for a datetime range.",
    {
      startdate: z.number().int().describe("Unix timestamp inclusive."),
      enddate: z.number().int().describe("Unix timestamp inclusive."),
      data_fields: z.string().optional().describe("Common: hr,rr,snoring,sdnn_1,rmssd."),
    },
    async (args) => ok(await withingsApi("/v2/sleep", { action: "get", ...args })),
  );

  server.tool(
    "withings_get_sleep_summary",
    "Per-night sleep summaries (duration, efficiency, sleep score, breathing disturbances, HR) for a date range.",
    {
      startdateymd: z.string().optional(),
      enddateymd: z.string().optional(),
      lastupdate: z.number().int().optional(),
      offset: z.number().int().optional(),
      data_fields: z
        .string()
        .optional()
        .describe("Common: deepsleepduration,lightsleepduration,remsleepduration,wakeupduration,wakeupcount,durationtosleep,durationtowakeup,total_timeinbed,total_sleep_time,sleep_score,hr_average,hr_min,hr_max,rr_average,breathing_disturbances_intensity,snoring,snoringepisodecount,apnea_hypopnea_index."),
    },
    async (args) => ok(await withingsApi("/v2/sleep", { action: "getsummary", ...args })),
  );

  // === Heart ===
  server.tool(
    "withings_list_heart_events",
    "List heart events (ECG records, BP measurements with AFib classification).",
    {
      startdate: z.number().int().optional(),
      enddate: z.number().int().optional(),
      offset: z.number().int().optional(),
    },
    async (args) => ok(await withingsApi("/v2/heart", { action: "list", ...args })),
  );

  server.tool(
    "withings_get_heart_event",
    "Fetch ECG signal samples + classification for a single heart event by signalid.",
    { signalid: z.number().int() },
    async ({ signalid }) => ok(await withingsApi("/v2/heart", { action: "get", signalid })),
  );

  // === User / device ===
  server.tool(
    "withings_list_devices",
    "List Withings devices paired with this account (model, battery, last sync).",
    {},
    async () => ok(await withingsApi("/v2/user", { action: "getdevice" })),
  );

  server.tool(
    "withings_get_goals",
    "Get user-set goals (steps, weight, sleep duration).",
    {},
    async () => ok(await withingsApi("/v2/user", { action: "getgoals" })),
  );
}
