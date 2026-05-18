import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ISO_OR_UNIX_DESC, isoOrUnixSeconds, ok } from "./util.js";
import type { OAuthProviderConfig } from "./oauth.js";

const STRAVA_API = "https://www.strava.com/api/v3";

// Strava requires comma-separated scopes. read+write is intentional: users
// have granted write access (e.g. AI-initiated activity logging is in scope).
export const STRAVA_DEFAULT_SCOPES =
  "read,read_all,profile:read_all,activity:read,activity:read_all,activity:write";

// OAuth provider config for the reusable client (src/oauth.ts).
export const STRAVA_OAUTH: OAuthProviderConfig = {
  label: "Strava",
  authorizeUrl: "https://www.strava.com/oauth/authorize",
  tokenUrl: "https://www.strava.com/api/v3/oauth/token",
  scopes: STRAVA_DEFAULT_SCOPES,
  scopeSeparator: ",",
  parseTokenResponse: (body) => {
    const j = body as { access_token: string; refresh_token: string; expires_at: number };
    return {
      accessToken: j.access_token,
      refreshToken: j.refresh_token,
      expiresAt: j.expires_at * 1000, // unix seconds → ms
    };
  },
  identityFromTokenResponse: (body) => {
    const j = body as { athlete?: { id: number; firstname?: string; lastname?: string } };
    if (!j.athlete?.id) return null;
    const name = [j.athlete.firstname, j.athlete.lastname].filter(Boolean).join(" ").trim();
    return {
      providerUserId: String(j.athlete.id),
      displayName: name || `Strava athlete ${j.athlete.id}`,
    };
  },
  fetchIdentity: async (accessToken) => {
    const res = await fetch(`${STRAVA_API}/athlete`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) throw new Error(`Strava /athlete fetch failed: ${res.status}`);
    const j = (await res.json()) as { id: number; firstname?: string; lastname?: string };
    const name = [j.firstname, j.lastname].filter(Boolean).join(" ").trim();
    return {
      providerUserId: String(j.id),
      displayName: name || `Strava athlete ${j.id}`,
    };
  },
};

type QueryParams = Record<string, string | number | boolean | undefined | null>;

function buildQuery(params?: QueryParams): string {
  if (!params) return "";
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    qs.set(k, String(v));
  }
  const s = qs.toString();
  return s ? `?${s}` : "";
}

function makeStravaApi(getAccessToken: () => Promise<string>) {
  return async function stravaApi(
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    opts?: { query?: QueryParams; form?: QueryParams },
  ): Promise<unknown> {
    const token = await getAccessToken();
    const url = `${STRAVA_API}${path}${buildQuery(opts?.query)}`;
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    let body: BodyInit | undefined;
    if (opts?.form) {
      const fd = new URLSearchParams();
      for (const [k, v] of Object.entries(opts.form)) {
        if (v === undefined || v === null || v === "") continue;
        fd.set(k, String(v));
      }
      body = fd;
      headers["Content-Type"] = "application/x-www-form-urlencoded";
    }
    const res = await fetch(url, { method, headers, body });
    const usage = res.headers.get("x-ratelimit-usage");
    const limit = res.headers.get("x-ratelimit-limit");
    if (!res.ok) {
      const text = await res.text();
      const rate = usage && limit ? ` [usage=${usage} limit=${limit}]` : "";
      throw new Error(`Strava ${method} ${path} → ${res.status}${rate}: ${text}`);
    }
    if (res.status === 204) return null;
    return res.json();
  };
}

export function registerStravaTools(
  server: McpServer,
  getAccessToken: () => Promise<string>,
  getAthleteId: () => Promise<number>,
) {
  const stravaApi = makeStravaApi(getAccessToken);

  // ============================================================
  //   Athlete
  // ============================================================
  server.tool(
    "strava_get_athlete",
    "Get the currently authenticated athlete's profile.",
    {},
    async () => ok(await stravaApi("GET", "/athlete")),
  );

  server.tool(
    "strava_get_athlete_stats",
    "Get the totals & recent activity stats for an athlete. Defaults to the authenticated athlete.",
    {
      id: z.number().int().optional().describe("Athlete id. Defaults to the authenticated athlete."),
    },
    async ({ id }) => {
      const athleteId = id ?? (await getAthleteId());
      return ok(await stravaApi("GET", `/athletes/${athleteId}/stats`));
    },
  );

  server.tool(
    "strava_get_athlete_zones",
    "Get the authenticated athlete's heart-rate and power zones.",
    {},
    async () => ok(await stravaApi("GET", "/athlete/zones")),
  );

  server.tool(
    "strava_update_athlete",
    "Update the authenticated athlete. Strava only supports updating weight via this endpoint.",
    {
      weight: z.number().describe("New weight in kilograms."),
    },
    async ({ weight }) =>
      ok(await stravaApi("PUT", "/athlete", { form: { weight } })),
  );

  // ============================================================
  //   Activities (read)
  // ============================================================
  server.tool(
    "strava_list_activities",
    "List activities for the authenticated athlete, newest first.",
    {
      before: isoOrUnixSeconds.optional().describe(`Only return activities before this time. ${ISO_OR_UNIX_DESC}`),
      after: isoOrUnixSeconds.optional().describe(`Only return activities after this time. ${ISO_OR_UNIX_DESC}`),
      page: z.number().int().optional(),
      per_page: z.number().int().min(1).max(200).optional().describe("Max 200."),
    },
    async (args) => ok(await stravaApi("GET", "/athlete/activities", { query: args })),
  );

  server.tool(
    "strava_get_activity",
    "Fetch a single activity by id.",
    {
      id: z.number().int(),
      include_all_efforts: z
        .boolean()
        .optional()
        .describe("Include segment efforts. Defaults to false."),
    },
    async ({ id, include_all_efforts }) =>
      ok(
        await stravaApi("GET", `/activities/${id}`, {
          query: { include_all_efforts },
        }),
      ),
  );

  server.tool(
    "strava_get_activity_zones",
    "Get HR / power zone distribution for an activity (premium athletes only).",
    { id: z.number().int() },
    async ({ id }) => ok(await stravaApi("GET", `/activities/${id}/zones`)),
  );

  server.tool(
    "strava_get_activity_laps",
    "Get the laps for an activity.",
    { id: z.number().int() },
    async ({ id }) => ok(await stravaApi("GET", `/activities/${id}/laps`)),
  );

  server.tool(
    "strava_get_activity_comments",
    "List comments on an activity.",
    {
      id: z.number().int(),
      page: z.number().int().optional(),
      per_page: z.number().int().min(1).max(200).optional(),
    },
    async ({ id, ...query }) =>
      ok(await stravaApi("GET", `/activities/${id}/comments`, { query })),
  );

  server.tool(
    "strava_get_activity_kudoers",
    "List athletes who kudoed an activity.",
    {
      id: z.number().int(),
      page: z.number().int().optional(),
      per_page: z.number().int().min(1).max(200).optional(),
    },
    async ({ id, ...query }) =>
      ok(await stravaApi("GET", `/activities/${id}/kudos`, { query })),
  );

  // ============================================================
  //   Activities (write)
  // ============================================================
  server.tool(
    "strava_create_activity",
    "Manually log an activity (no GPS/streams). Times in seconds, distance in meters, dates in ISO 8601 local time.",
    {
      name: z.string(),
      sport_type: z
        .string()
        .describe(
          "Strava sport_type, e.g. Ride, Run, Walk, Hike, VirtualRide, GravelRide, MountainBikeRide, Swim, Workout, WeightTraining, Yoga.",
        ),
      start_date_local: z
        .string()
        .describe("ISO 8601 local time, e.g. '2026-05-07T07:30:00'."),
      elapsed_time: z.number().int().describe("Elapsed time in seconds."),
      description: z.string().optional(),
      distance: z.number().optional().describe("Distance in meters."),
      trainer: z.boolean().optional(),
      commute: z.boolean().optional(),
    },
    async (args) => ok(await stravaApi("POST", "/activities", { form: args })),
  );

  server.tool(
    "strava_update_activity",
    "Update an activity's metadata. Only the fields you pass are changed.",
    {
      id: z.number().int(),
      name: z.string().optional(),
      sport_type: z.string().optional(),
      description: z.string().optional(),
      gear_id: z.string().optional().describe("Use 'none' to unset gear."),
      trainer: z.boolean().optional(),
      commute: z.boolean().optional(),
      hide_from_home: z.boolean().optional(),
    },
    async ({ id, ...form }) =>
      ok(await stravaApi("PUT", `/activities/${id}`, { form })),
  );

  // ============================================================
  //   Streams
  // ============================================================
  const STREAM_KEYS_DESC =
    "Comma-separated stream types. Common: time,distance,latlng,altitude,velocity_smooth,heartrate,cadence,watts,temp,moving,grade_smooth.";

  server.tool(
    "strava_get_activity_streams",
    "Get raw data streams for an activity (time/distance/latlng/altitude/velocity/heartrate/cadence/watts/temp/moving/grade_smooth).",
    {
      id: z.number().int(),
      keys: z.string().describe(STREAM_KEYS_DESC),
      key_by_type: z.boolean().default(true),
    },
    async ({ id, ...query }) =>
      ok(await stravaApi("GET", `/activities/${id}/streams`, { query })),
  );

  server.tool(
    "strava_get_segment_streams",
    "Get raw data streams for a segment.",
    {
      id: z.number().int(),
      keys: z.string().describe(STREAM_KEYS_DESC),
      key_by_type: z.boolean().default(true),
    },
    async ({ id, ...query }) =>
      ok(await stravaApi("GET", `/segments/${id}/streams`, { query })),
  );

  server.tool(
    "strava_get_segment_effort_streams",
    "Get raw data streams for a segment effort.",
    {
      id: z.number().int(),
      keys: z.string().describe(STREAM_KEYS_DESC),
      key_by_type: z.boolean().default(true),
    },
    async ({ id, ...query }) =>
      ok(await stravaApi("GET", `/segment_efforts/${id}/streams`, { query })),
  );

  server.tool(
    "strava_get_route_streams",
    "Get raw data streams for a route.",
    { id: z.number().int() },
    async ({ id }) => ok(await stravaApi("GET", `/routes/${id}/streams`)),
  );

  // ============================================================
  //   Segments
  // ============================================================
  server.tool(
    "strava_explore_segments",
    "Search public segments inside a bounding box.",
    {
      bounds: z
        .string()
        .describe("Comma-separated 'sw_lat,sw_lng,ne_lat,ne_lng'."),
      activity_type: z.enum(["running", "riding"]).optional(),
      min_cat: z.number().int().min(0).max(5).optional().describe("Min climb category (riding only)."),
      max_cat: z.number().int().min(0).max(5).optional().describe("Max climb category (riding only)."),
    },
    async (args) => ok(await stravaApi("GET", "/segments/explore", { query: args })),
  );

  server.tool(
    "strava_list_starred_segments",
    "List the authenticated athlete's starred segments.",
    {
      page: z.number().int().optional(),
      per_page: z.number().int().min(1).max(200).optional(),
    },
    async (query) => ok(await stravaApi("GET", "/segments/starred", { query })),
  );

  server.tool(
    "strava_get_segment",
    "Fetch a segment by id.",
    { id: z.number().int() },
    async ({ id }) => ok(await stravaApi("GET", `/segments/${id}`)),
  );

  server.tool(
    "strava_star_segment",
    "Star or unstar a segment for the authenticated athlete.",
    {
      id: z.number().int(),
      starred: z.boolean(),
    },
    async ({ id, starred }) =>
      ok(await stravaApi("PUT", `/segments/${id}/starred`, { form: { starred } })),
  );

  server.tool(
    "strava_get_segment_efforts",
    "List the authenticated athlete's efforts on a segment, optionally filtered by date range.",
    {
      segment_id: z.number().int(),
      start_date_local: z.string().optional().describe("ISO 8601."),
      end_date_local: z.string().optional().describe("ISO 8601."),
      per_page: z.number().int().min(1).max(200).optional(),
    },
    async (args) =>
      ok(await stravaApi("GET", "/segment_efforts", { query: args })),
  );

  server.tool(
    "strava_get_segment_effort",
    "Fetch a segment effort by id.",
    { id: z.number().int() },
    async ({ id }) =>
      ok(await stravaApi("GET", `/segment_efforts/${id}`)),
  );

  // ============================================================
  //   Routes
  // ============================================================
  server.tool(
    "strava_list_athlete_routes",
    "List routes created by an athlete. Defaults to the authenticated athlete.",
    {
      id: z.number().int().optional(),
      page: z.number().int().optional(),
      per_page: z.number().int().min(1).max(200).optional(),
    },
    async ({ id, ...query }) => {
      const athleteId = id ?? (await getAthleteId());
      return ok(await stravaApi("GET", `/athletes/${athleteId}/routes`, { query }));
    },
  );

  server.tool(
    "strava_get_route",
    "Fetch a route by id.",
    { id: z.number().int() },
    async ({ id }) => ok(await stravaApi("GET", `/routes/${id}`)),
  );

  // ============================================================
  //   Clubs
  // ============================================================
  server.tool(
    "strava_list_athlete_clubs",
    "List clubs the authenticated athlete belongs to.",
    {
      page: z.number().int().optional(),
      per_page: z.number().int().min(1).max(200).optional(),
    },
    async (query) => ok(await stravaApi("GET", "/athlete/clubs", { query })),
  );

  server.tool(
    "strava_get_club",
    "Fetch a club by id.",
    { id: z.number().int() },
    async ({ id }) => ok(await stravaApi("GET", `/clubs/${id}`)),
  );

  server.tool(
    "strava_get_club_members",
    "List members of a club.",
    {
      id: z.number().int(),
      page: z.number().int().optional(),
      per_page: z.number().int().min(1).max(200).optional(),
    },
    async ({ id, ...query }) =>
      ok(await stravaApi("GET", `/clubs/${id}/members`, { query })),
  );

  server.tool(
    "strava_get_club_activities",
    "List recent activities posted by club members.",
    {
      id: z.number().int(),
      page: z.number().int().optional(),
      per_page: z.number().int().min(1).max(200).optional(),
    },
    async ({ id, ...query }) =>
      ok(await stravaApi("GET", `/clubs/${id}/activities`, { query })),
  );

  // ============================================================
  //   Gear
  // ============================================================
  server.tool(
    "strava_get_gear",
    "Fetch a piece of gear (bike or shoes) by id.",
    {
      id: z.string().describe("Gear id, e.g. 'b1234567' for a bike or 'g7654321' for shoes."),
    },
    async ({ id }) => ok(await stravaApi("GET", `/gear/${id}`)),
  );
}
