import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ok } from "./util.js";
import type { OAuthProviderConfig } from "./oauth.js";

const INTERVALS_BASE = "https://intervals.icu/api/v1";

// All scopes Intervals.icu exposes. Intervals' OAuth requires each category
// appear at most once (listing both ACTIVITY:READ and ACTIVITY:WRITE returns
// "Duplicate scope ACTIVITY"). WRITE implies READ on intervals.icu, so we
// just request WRITE for everything we need to mutate.
export const INTERVALS_DEFAULT_SCOPES =
  "ACTIVITY:WRITE,WELLNESS:WRITE,CALENDAR:WRITE,LIBRARY:WRITE,SETTINGS:WRITE,CHATS:WRITE";

// Intervals.icu's OAuth is unusually simple: tokens don't expire and there
// is no refresh_token grant. We set expiresAt arbitrarily far in the future
// so makeAccessTokenGetter's refresh-on-expiry path never fires.
const NEVER_EXPIRES = Number.MAX_SAFE_INTEGER;

export const INTERVALS_OAUTH: OAuthProviderConfig = {
  label: "Intervals.icu",
  authorizeUrl: "https://intervals.icu/oauth/authorize",
  tokenUrl: "https://intervals.icu/api/oauth/token",
  scopes: INTERVALS_DEFAULT_SCOPES,
  scopeSeparator: ",",
  parseTokenResponse: (raw) => {
    const j = raw as { access_token: string; scope?: string };
    return {
      accessToken: j.access_token,
      // Intervals tokens don't expire (replaced only when the user re-auths)
      // and there is no refresh_token. We never need to refresh, so an empty
      // refreshToken is fine — the never-fresh check on expiresAt guards it.
      refreshToken: "",
      expiresAt: NEVER_EXPIRES,
    };
  },
  identityFromTokenResponse: (raw) => {
    const j = raw as { athlete?: { id: string | number; name?: string } };
    if (!j.athlete?.id) return null;
    return {
      providerUserId: String(j.athlete.id),
      displayName: j.athlete.name ?? `athlete ${j.athlete.id}`,
    };
  },
  // Refresh / re-fetch identity should never be needed (token doesn't expire,
  // identity is in the initial token response). Defensive fallback hits
  // /athlete/0 which is the same identity endpoint we used in the API-key era.
  fetchIdentity: async (accessToken) => {
    const res = await fetch(`${INTERVALS_BASE}/athlete/0`, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
    });
    if (!res.ok) throw new Error(`Intervals /athlete/0 fetch failed: ${res.status}`);
    const j = (await res.json()) as { id?: string | number; name?: string };
    if (j.id === undefined) throw new Error("Intervals /athlete/0 returned no id");
    return {
      providerUserId: String(j.id),
      displayName: j.name ?? `athlete ${j.id}`,
    };
  },
};

const DateRange = {
  oldest: z.string().describe("YYYY-MM-DD start date (inclusive)"),
  newest: z.string().describe("YYYY-MM-DD end date (inclusive)"),
};

function enc(x: string | number): string {
  return encodeURIComponent(String(x));
}

export function registerIntervalsTools(
  server: McpServer,
  getAccessToken: () => Promise<string>,
) {
  // athlete id "0" means "the athlete the bearer token belongs to" — the
  // server-side resolution handles per-user routing without us tracking ids.
  const athlete = () => "0";

  async function intervalsFetch(
    path: string,
    init: RequestInit = {},
  ): Promise<unknown> {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${await getAccessToken()}`);
    headers.set("Accept", "application/json");
    if (init.body) headers.set("Content-Type", "application/json");

    const res = await fetch(`${INTERVALS_BASE}${path}`, { ...init, headers });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`Intervals ${init.method ?? "GET"} ${path} → ${res.status}: ${text}`);
    }
    return text ? JSON.parse(text) : null;
  }

  // === Activities (existing) ===

  server.tool(
    "intervals_list_activities",
    "List the athlete's activities in a date range (oldest..newest, YYYY-MM-DD).",
    DateRange,
    async ({ oldest, newest }) => {
      const data = await intervalsFetch(`/athlete/${athlete()}/activities?oldest=${oldest}&newest=${newest}`,
      );
      return ok(data);
    },
  );

  server.tool(
    "intervals_get_activity",
    "Fetch a single Intervals.ICU activity by id (e.g. 'i123456789').",
    { activityId: z.string().min(1) },
    async ({ activityId }) => {
      const data = await intervalsFetch(`/activity/${enc(activityId)}`);
      return ok(data);
    },
  );

  server.tool(
    "intervals_get_activities",
    "Fetch multiple activities by comma-separated ids (e.g. 'i123,i456'). Optionally include interval data.",
    {
      ids: z.string().min(1).describe("Comma-separated activity ids"),
      intervals: z
        .boolean()
        .optional()
        .describe("Include interval data (icu_intervals and icu_groups fields)"),
    },
    async ({ ids, intervals }) => {
      const qs = new URLSearchParams();
      if (intervals !== undefined) qs.set("intervals", String(intervals));
      const suffix = qs.toString() ? `?${qs}` : "";
      const data = await intervalsFetch(`/athlete/${athlete()}/activities/${enc(ids)}${suffix}`,
      );
      return ok(data);
    },
  );

  server.tool(
    "intervals_search_activities",
    "Search activities by name (case-insensitive) or exact tag. Returns compact results (id, name, type, start_date). For date-range queries, use intervals_list_activities instead — this tool searches by text only. For richer fields (distance, duration, training load, etc.), use intervals_search_activities_full.",
    {
      q: z.string().min(1).describe("Search query (name substring or exact tag)"),
      limit: z.number().int().optional(),
    },
    async ({ q, limit }) => {
      const qs = new URLSearchParams();
      qs.set("q", q);
      if (limit !== undefined) qs.set("limit", String(limit));
      const data = await intervalsFetch(`/athlete/${athlete()}/activities/search?${qs}`,
      );
      return ok(data);
    },
  );

  server.tool(
    "intervals_search_activities_full",
    "Search activities by name or tag, returning full activity records (distance, moving_time, icu_training_load, icu_ftp, average_speed, average_heartrate, etc.). Use this over intervals_search_activities when you need metrics, not just IDs. Still text-search only — for date-range filtering, use intervals_list_activities.",
    {
      q: z.string().min(1),
      limit: z.number().int().optional(),
    },
    async ({ q, limit }) => {
      const qs = new URLSearchParams();
      qs.set("q", q);
      if (limit !== undefined) qs.set("limit", String(limit));
      const data = await intervalsFetch(`/athlete/${athlete()}/activities/search-full?${qs}`,
      );
      return ok(data);
    },
  );

  server.tool(
    "intervals_search_activity_intervals",
    "Find activities containing intervals matching the given duration/intensity criteria.",
    {
      minSecs: z.number().int().describe("Min interval duration (seconds)"),
      maxSecs: z.number().int().describe("Max interval duration (seconds)"),
      minIntensity: z.number().int().describe("Min intensity percentage"),
      maxIntensity: z.number().int().describe("Max intensity percentage"),
      type: z.string().optional().describe("Interval type"),
      minReps: z.number().int().optional(),
      maxReps: z.number().int().optional(),
      limit: z.number().int().optional(),
    },
    async (input) => {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(input)) {
        if (v !== undefined) qs.set(k, String(v));
      }
      const data = await intervalsFetch(`/athlete/${athlete()}/activities/interval-search?${qs}`,
      );
      return ok(data);
    },
  );

  server.tool(
    "intervals_get_activities_around",
    "Return activities recorded near a given activity (chronologically or geographically).",
    {
      activity_id: z.string().min(1).describe("The activity at the center"),
      route_id: z.number().int().optional().describe("Restrict to activities on this route"),
      limit: z.number().int().optional().describe("Max activities to return (default 30)"),
    },
    async ({ activity_id, route_id, limit }) => {
      const qs = new URLSearchParams();
      qs.set("activity_id", activity_id);
      if (route_id !== undefined) qs.set("route_id", String(route_id));
      if (limit !== undefined) qs.set("limit", String(limit));
      const data = await intervalsFetch(`/athlete/${athlete()}/activities-around?${qs}`,
      );
      return ok(data);
    },
  );

  server.tool(
    "intervals_create_manual_activity",
    "Create a manual activity entry.",
    {
      body: z
        .record(z.string(), z.any())
        .describe(
          "See `Activity` schema in the Intervals.ICU OpenAPI spec — fields like name, type, start_date_local, moving_time, distance, etc.",
        ),
    },
    async ({ body }) => {
      const data = await intervalsFetch(`/athlete/${athlete()}/activities/manual`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      return ok(data);
    },
  );

  server.tool(
    "intervals_create_manual_activities_bulk",
    "Bulk-create multiple manual activities in one call.",
    {
      activities: z
        .array(z.record(z.string(), z.any()))
        .describe("Array of `Activity` objects (see OpenAPI spec)"),
    },
    async ({ activities }) => {
      const data = await intervalsFetch(`/athlete/${athlete()}/activities/manual/bulk`,
        { method: "POST", body: JSON.stringify(activities) },
      );
      return ok(data);
    },
  );

  // === Activity write (update / delete) ===

  server.tool(
    "intervals_update_activity",
    "Update an activity. Pass any fields to change in the body.",
    {
      activityId: z.string().min(1),
      body: z
        .record(z.string(), z.any())
        .describe("See `Activity` schema in the Intervals.ICU OpenAPI spec"),
    },
    async ({ activityId, body }) => {
      const data = await intervalsFetch(`/activity/${enc(activityId)}`, {
        method: "PUT",
        body: JSON.stringify(body),
      });
      return ok(data);
    },
  );

  server.tool(
    "intervals_delete_activity",
    "Delete an activity.",
    { activityId: z.string().min(1) },
    async ({ activityId }) => {
      await intervalsFetch(`/activity/${enc(activityId)}`, { method: "DELETE" });
      return ok({ deleted: activityId });
    },
  );

  // === Activity sub-resources: efforts, curves, histograms, models ===

  server.tool(
    "intervals_get_activity_best_efforts",
    "Find best efforts in an activity for a given stream (e.g. 'watts', 'heartrate', 'velocity_smooth').",
    {
      activityId: z.string().min(1),
      stream: z.string().min(1).describe("Stream name to search"),
      duration: z.number().int().optional().describe("Effort duration (seconds)"),
      distance: z.number().optional().describe("Effort distance (meters)"),
      count: z.number().int().optional().describe("Number of efforts to return"),
      minValue: z.number().optional(),
      excludeIntervals: z.boolean().optional(),
      startIndex: z.number().int().optional(),
      endIndex: z.number().int().optional(),
    },
    async ({ activityId, ...input }) => {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(input)) {
        if (v !== undefined) qs.set(k, String(v));
      }
      const data = await intervalsFetch(`/activity/${enc(activityId)}/best-efforts?${qs}`,
      );
      return ok(data);
    },
  );

  server.tool(
    "intervals_get_activity_gap_histogram",
    "Get the gradient-adjusted pace histogram for an activity.",
    { activityId: z.string().min(1) },
    async ({ activityId }) => {
      const data = await intervalsFetch(`/activity/${enc(activityId)}/gap-histogram`);
      return ok(data);
    },
  );

  server.tool(
    "intervals_get_activity_hr_curve",
    "Get the heart rate curve for an activity.",
    { activityId: z.string().min(1) },
    async ({ activityId }) => {
      const data = await intervalsFetch(`/activity/${enc(activityId)}/hr-curve`);
      return ok(data);
    },
  );

  server.tool(
    "intervals_get_activity_hr_histogram",
    "Get the heart rate histogram for an activity.",
    {
      activityId: z.string().min(1),
      bucketSize: z.number().int().optional().describe("Beats per bucket (default 5)"),
    },
    async ({ activityId, bucketSize }) => {
      const qs = new URLSearchParams();
      if (bucketSize !== undefined) qs.set("bucketSize", String(bucketSize));
      const suffix = qs.toString() ? `?${qs}` : "";
      const data = await intervalsFetch(`/activity/${enc(activityId)}/hr-histogram${suffix}`,
      );
      return ok(data);
    },
  );

  server.tool(
    "intervals_get_activity_hr_load_model",
    "Get the heart rate training load model for an activity.",
    { activityId: z.string().min(1) },
    async ({ activityId }) => {
      const data = await intervalsFetch(`/activity/${enc(activityId)}/hr-load-model`);
      return ok(data);
    },
  );

  server.tool(
    "intervals_get_activity_interval_stats",
    "Return interval-style stats for a sub-range of an activity stream.",
    {
      activityId: z.string().min(1),
      start_index: z.number().int(),
      end_index: z.number().int(),
    },
    async ({ activityId, start_index, end_index }) => {
      const qs = new URLSearchParams();
      qs.set("start_index", String(start_index));
      qs.set("end_index", String(end_index));
      const data = await intervalsFetch(`/activity/${enc(activityId)}/interval-stats?${qs}`,
      );
      return ok(data);
    },
  );

  server.tool(
    "intervals_get_activity_intervals",
    "Get the intervals (laps/work blocks) detected/configured for an activity.",
    { activityId: z.string().min(1) },
    async ({ activityId }) => {
      const data = await intervalsFetch(`/activity/${enc(activityId)}/intervals`);
      return ok(data);
    },
  );

  server.tool(
    "intervals_update_activity_intervals",
    "Update intervals for an activity (merge by default, or replace all when `all=true`).",
    {
      activityId: z.string().min(1),
      all: z.boolean().optional().describe("Replace all existing intervals when true"),
      body: z
        .record(z.string(), z.any())
        .describe("Intervals payload (see Intervals.ICU OpenAPI spec)"),
    },
    async ({ activityId, all, body }) => {
      const qs = new URLSearchParams();
      if (all !== undefined) qs.set("all", String(all));
      const suffix = qs.toString() ? `?${qs}` : "";
      const data = await intervalsFetch(`/activity/${enc(activityId)}/intervals${suffix}`,
        { method: "PUT", body: JSON.stringify(body) },
      );
      return ok(data);
    },
  );

  server.tool(
    "intervals_update_activity_interval",
    "Create or update a single interval within an activity.",
    {
      activityId: z.string().min(1),
      intervalId: z.number().int(),
      body: z
        .record(z.string(), z.any())
        .describe("See `Interval` schema in the Intervals.ICU OpenAPI spec"),
    },
    async ({ activityId, intervalId, body }) => {
      const data = await intervalsFetch(`/activity/${enc(activityId)}/intervals/${enc(intervalId)}`,
        { method: "PUT", body: JSON.stringify(body) },
      );
      return ok(data);
    },
  );

  server.tool(
    "intervals_delete_activity_intervals",
    "Delete a set of intervals from an activity.",
    {
      activityId: z.string().min(1),
      body: z
        .record(z.string(), z.any())
        .describe("Object describing which intervals to delete (e.g. { ids: [...] })"),
    },
    async ({ activityId, body }) => {
      const data = await intervalsFetch(`/activity/${enc(activityId)}/delete-intervals`,
        { method: "PUT", body: JSON.stringify(body) },
      );
      return ok(data);
    },
  );

  server.tool(
    "intervals_split_activity_interval",
    "Split an interval at the given stream index.",
    {
      activityId: z.string().min(1),
      splitAt: z.number().int().describe("Stream index to split at"),
    },
    async ({ activityId, splitAt }) => {
      const data = await intervalsFetch(`/activity/${enc(activityId)}/split-interval?splitAt=${splitAt}`,
        { method: "PUT" },
      );
      return ok(data);
    },
  );

  server.tool(
    "intervals_get_activity_map",
    "Get GPS map data for an activity (latlngs, optional bounds, optional weather points).",
    {
      activityId: z.string().min(1),
      bounds: z
        .string()
        .optional()
        .describe("Comma-separated bounding box: left,top,right,bottom"),
      boundsOnly: z.boolean().optional(),
      weather: z.boolean().optional(),
    },
    async ({ activityId, bounds, boundsOnly, weather }) => {
      const qs = new URLSearchParams();
      if (bounds !== undefined) qs.set("bounds", bounds);
      if (boundsOnly !== undefined) qs.set("boundsOnly", String(boundsOnly));
      if (weather !== undefined) qs.set("weather", String(weather));
      const suffix = qs.toString() ? `?${qs}` : "";
      const data = await intervalsFetch(`/activity/${enc(activityId)}/map${suffix}`,
      );
      return ok(data);
    },
  );

  server.tool(
    "intervals_list_activity_messages",
    "List comments/messages on an activity.",
    {
      activityId: z.string().min(1),
      sinceId: z.number().int().optional(),
      limit: z.number().int().optional(),
    },
    async ({ activityId, sinceId, limit }) => {
      const qs = new URLSearchParams();
      if (sinceId !== undefined) qs.set("sinceId", String(sinceId));
      if (limit !== undefined) qs.set("limit", String(limit));
      const suffix = qs.toString() ? `?${qs}` : "";
      const data = await intervalsFetch(`/activity/${enc(activityId)}/messages${suffix}`,
      );
      return ok(data);
    },
  );

  server.tool(
    "intervals_create_activity_message",
    "Post a comment/message on an activity.",
    {
      activityId: z.string().min(1),
      body: z
        .record(z.string(), z.any())
        .describe("See `NewActivityMsg` schema in the Intervals.ICU OpenAPI spec"),
    },
    async ({ activityId, body }) => {
      const data = await intervalsFetch(`/activity/${enc(activityId)}/messages`,
        { method: "POST", body: JSON.stringify(body) },
      );
      return ok(data);
    },
  );

  server.tool(
    "intervals_get_activity_pace_curve",
    "Get the pace curve for an activity (optionally gradient-adjusted).",
    {
      activityId: z.string().min(1),
      gap: z.boolean().optional().describe("Return gradient-adjusted pace curve"),
    },
    async ({ activityId, gap }) => {
      const qs = new URLSearchParams();
      if (gap !== undefined) qs.set("gap", String(gap));
      const suffix = qs.toString() ? `?${qs}` : "";
      const data = await intervalsFetch(`/activity/${enc(activityId)}/pace-curve${suffix}`,
      );
      return ok(data);
    },
  );

  server.tool(
    "intervals_get_activity_pace_histogram",
    "Get the pace histogram for an activity.",
    { activityId: z.string().min(1) },
    async ({ activityId }) => {
      const data = await intervalsFetch(`/activity/${enc(activityId)}/pace-histogram`);
      return ok(data);
    },
  );

  server.tool(
    "intervals_get_activity_power_curve",
    "Get the power curve for an activity. Optionally apply a fatigue model (kj0/kj1).",
    {
      activityId: z.string().min(1),
      fatigue: z.string().optional().describe("'kj0' or 'kj1' to apply a predefined fatigue model"),
    },
    async ({ activityId, fatigue }) => {
      const qs = new URLSearchParams();
      if (fatigue !== undefined) qs.set("fatigue", fatigue);
      const suffix = qs.toString() ? `?${qs}` : "";
      const data = await intervalsFetch(`/activity/${enc(activityId)}/power-curve${suffix}`,
      );
      return ok(data);
    },
  );

  server.tool(
    "intervals_get_activity_power_curves",
    "Get one or more power-style curves for an activity (defaults to watts, can include other streams or fatigue variants).",
    {
      activityId: z.string().min(1),
      types: z
        .string()
        .optional()
        .describe("Comma-separated stream types (default 'watts')"),
      fatigue: z
        .string()
        .optional()
        .describe("Comma-separated of 'normal','kj0','kj1' for fatigue variants"),
    },
    async ({ activityId, types, fatigue }) => {
      const qs = new URLSearchParams();
      if (types !== undefined) qs.set("types", types);
      if (fatigue !== undefined) qs.set("fatigue", fatigue);
      const suffix = qs.toString() ? `?${qs}` : "";
      const data = await intervalsFetch(`/activity/${enc(activityId)}/power-curves${suffix}`,
      );
      return ok(data);
    },
  );

  server.tool(
    "intervals_get_activity_power_histogram",
    "Get the power histogram for an activity.",
    {
      activityId: z.string().min(1),
      bucketSize: z.number().int().optional().describe("Watts per bucket (default 25)"),
    },
    async ({ activityId, bucketSize }) => {
      const qs = new URLSearchParams();
      if (bucketSize !== undefined) qs.set("bucketSize", String(bucketSize));
      const suffix = qs.toString() ? `?${qs}` : "";
      const data = await intervalsFetch(`/activity/${enc(activityId)}/power-histogram${suffix}`,
      );
      return ok(data);
    },
  );

  server.tool(
    "intervals_get_activity_power_spike_model",
    "Get the power-spike (anaerobic) model fit for an activity.",
    { activityId: z.string().min(1) },
    async ({ activityId }) => {
      const data = await intervalsFetch(`/activity/${enc(activityId)}/power-spike-model`,
      );
      return ok(data);
    },
  );

  server.tool(
    "intervals_get_activity_power_vs_hr",
    "Get the power-vs-heart-rate scatter/decoupling data for an activity.",
    { activityId: z.string().min(1) },
    async ({ activityId }) => {
      const data = await intervalsFetch(`/activity/${enc(activityId)}/power-vs-hr`);
      return ok(data);
    },
  );

  server.tool(
    "intervals_get_activity_segments",
    "List segment efforts within an activity.",
    { activityId: z.string().min(1) },
    async ({ activityId }) => {
      const data = await intervalsFetch(`/activity/${enc(activityId)}/segments`);
      return ok(data);
    },
  );

  server.tool(
    "intervals_get_activity_streams",
    "Get raw stream data for an activity (e.g. watts, heartrate, latlng, time).",
    {
      activityId: z.string().min(1),
      types: z
        .string()
        .optional()
        .describe("Comma-separated stream types (e.g. 'watts,heartrate,time')"),
      includeDefaults: z
        .boolean()
        .optional()
        .describe("Include default streams alongside any specified in `types`"),
    },
    async ({ activityId, types, includeDefaults }) => {
      const qs = new URLSearchParams();
      if (types !== undefined) qs.set("types", types);
      if (includeDefaults !== undefined) qs.set("includeDefaults", String(includeDefaults));
      const suffix = qs.toString() ? `?${qs}` : "";
      const data = await intervalsFetch(`/activity/${enc(activityId)}/streams${suffix}`,
      );
      return ok(data);
    },
  );

  server.tool(
    "intervals_update_activity_streams",
    "Replace or patch the raw streams of an activity.",
    {
      activityId: z.string().min(1),
      streams: z
        .array(z.record(z.string(), z.any()))
        .min(1)
        .describe(
          "Array of `ActivityStream` objects per the Intervals.ICU OpenAPI spec — each `{ type, data, ... }`.",
        ),
    },
    async ({ activityId, streams }) => {
      const data = await intervalsFetch(`/activity/${enc(activityId)}/streams`, {
        method: "PUT",
        body: JSON.stringify(streams),
      });
      return ok(data);
    },
  );

  server.tool(
    "intervals_get_activity_time_at_hr",
    "Get time-in-heart-rate-zone breakdown for an activity.",
    { activityId: z.string().min(1) },
    async ({ activityId }) => {
      const data = await intervalsFetch(`/activity/${enc(activityId)}/time-at-hr`);
      return ok(data);
    },
  );

  server.tool(
    "intervals_get_activity_weather_summary",
    "Get a weather summary for an activity (optionally for a sub-range).",
    {
      activityId: z.string().min(1),
      start_index: z.number().int().optional(),
      end_index: z.number().int().optional(),
      descr_config: z
        .string()
        .optional()
        .describe("Optional JSON-encoded configuration for the description field"),
    },
    async ({ activityId, start_index, end_index, descr_config }) => {
      const qs = new URLSearchParams();
      if (start_index !== undefined) qs.set("start_index", String(start_index));
      if (end_index !== undefined) qs.set("end_index", String(end_index));
      if (descr_config !== undefined) qs.set("descr_config", descr_config);
      const suffix = qs.toString() ? `?${qs}` : "";
      const data = await intervalsFetch(`/activity/${enc(activityId)}/weather-summary${suffix}`,
      );
      return ok(data);
    },
  );

  // === Wellness ===

  server.tool(
    "intervals_get_wellness",
    "Wellness entries (HRV, RHR, sleep, weight, etc.) for a date range.",
    DateRange,
    async ({ oldest, newest }) => {
      const data = await intervalsFetch(`/athlete/${athlete()}/wellness?oldest=${oldest}&newest=${newest}`,
      );
      return ok(data);
    },
  );

  server.tool(
    "intervals_get_wellness_for_date",
    "Get the wellness entry for a single date (YYYY-MM-DD).",
    { date: z.string().describe("YYYY-MM-DD") },
    async ({ date }) => {
      const data = await intervalsFetch(`/athlete/${athlete()}/wellness/${enc(date)}`,
      );
      return ok(data);
    },
  );

  server.tool(
    "intervals_log_wellness",
    "Create or update a wellness entry for a given date (YYYY-MM-DD). Pass any fields to set; omit to leave unchanged.",
    {
      date: z.string().describe("YYYY-MM-DD"),
      restingHR: z.number().optional(),
      hrv: z.number().optional(),
      weight: z.number().optional(),
      sleepSecs: z.number().int().optional(),
      sleepQuality: z.number().int().min(1).max(4).optional(),
      fatigue: z.number().int().min(1).max(4).optional(),
      stress: z.number().int().min(1).max(4).optional(),
      mood: z.number().int().min(1).max(4).optional(),
      motivation: z.number().int().min(1).max(4).optional(),
      soreness: z.number().int().min(1).max(4).optional(),
      comments: z.string().optional(),
    },
    async ({ date, ...fields }) => {
      const body = { id: date, ...fields };
      const data = await intervalsFetch(`/athlete/${athlete()}/wellness/${date}`, {
        method: "PUT",
        body: JSON.stringify(body),
      });
      return ok(data);
    },
  );

  server.tool(
    "intervals_update_wellness",
    "Update wellness with arbitrary fields (full `Wellness` schema). Use intervals_log_wellness for the common fields.",
    {
      body: z
        .record(z.string(), z.any())
        .describe("See `Wellness` schema in the Intervals.ICU OpenAPI spec"),
    },
    async ({ body }) => {
      const data = await intervalsFetch(`/athlete/${athlete()}/wellness`, {
        method: "PUT",
        body: JSON.stringify(body),
      });
      return ok(data);
    },
  );

  server.tool(
    "intervals_update_wellness_bulk",
    "Bulk-update many wellness entries in one call.",
    {
      entries: z
        .array(z.record(z.string(), z.any()))
        .describe("Array of wellness objects (see `Wellness` schema)"),
    },
    async ({ entries }) => {
      const data = await intervalsFetch(`/athlete/${athlete()}/wellness-bulk`, {
        method: "PUT",
        body: JSON.stringify(entries),
      });
      return ok(data);
    },
  );

  // === Events (existing + extras) ===

  server.tool(
    "intervals_list_events",
    "Calendar events (planned workouts, races, notes) in a date range. " +
      "NOTE-category events render their description as full Markdown. Give each NOTE a stable external_id (e.g., 'strength-context-2026-05-21') for easy retrieval via search.",
    DateRange,
    async ({ oldest, newest }) => {
      const data = await intervalsFetch(`/athlete/${athlete()}/events?oldest=${oldest}&newest=${newest}`,
      );
      return ok(data);
    },
  );

  const EventInputShape = {
    start_date_local: z.string().describe("YYYY-MM-DD or YYYY-MM-DDTHH:MM:SS"),
    category: z.string().default("WORKOUT"),
    name: z.string().min(1),
    description: z
      .string()
      .optional()
      .describe(
        "Free-text notes AND the canonical way to define structured planned workouts. " +
          "PREFERRED FOR PLANNED RUN / RIDE / WORKOUT EVENTS: write the workout as DSL here and leave workout_doc unset. The server parses DSL on CREATE and produces a fully-formed workout_doc including the computed metrics the UI chart needs (zoneTimes, normalized_power, variability_index, polarization_index, average_watts). Manually-supplied workout_doc.steps stores the steps fine but does NOT populate those metrics, so the planned-event chart renders empty even though the steps are there — see the workout_doc field for the caveat. " +
          "DSL syntax: step lines start with '- ' ('- 28m Z2 Power'); section headers omit the dash ('Warmup', 'Strides 6x', 'Cooldown'); a 'Section Nx' header or standalone 'Nx' line creates a repeat block; durations use m=minutes (NOT meters) / s=seconds / h=hours; distance uses km/mi (e.g. '0.4km', not '400m'); intensity via zones with explicit metric suffix ('Z2 Power' / 'Z2 Pace' / 'Z2 HR') OR % / unit ranges ('78-82% pace', '90-95% LTHR', '200-240w'). " +
          "METRIC SUFFIX — MATCH THE ATHLETE'S workout_order: before writing DSL, call intervals_list_sport_settings for the sport and read workout_order; the FIRST token is the primary target metric, so pick the matching suffix and use it on EVERY step — POWER_HR_PACE → ' Power', HR_POWER_PACE → ' HR', PACE_HR_POWER → ' Pace' (same priority that drives the planned-workout chart and training-load metric — see the workout_doc field's workout_order note). Don't fall back to the bare-zone defaults (Run → pace, Ride → power): a Run athlete configured POWER_HR_PACE (e.g. running power from Stryd / Garmin native) silently gets pace-targeted steps unless you append ' Power' explicitly, so the chart and load track the wrong metric. " +
          "Example (45min run with 6 strides): \"Warmup\\n- 35m Z2 Power\\n\\nStrides 6x\\n- 20s Z7 Power\\n- 1m Z1 Power\\n\\nCooldown\\n- 2m Z1 Power\". " +
          "PROSE WARNING: the server's DSL parser scans the ENTIRE description field — there is no separator (a `---` divider, blank lines, headers, etc.) that tells it to stop. Any prose line containing a DSL-like duration/distance token will be silently emitted as a phantom step, inflating the planned moving_time. Observed examples: \"first 400m\" → phantom 400-MINUTE step (24,000s, because 'm' = minutes in DSL); \"feel for the opening 5 min\" → phantom 5-minute step. To mix workout structure with commentary safely: (a) keep description pure DSL and put prose in a SEPARATE event of category NOTE on the same date, OR (b) spell numeric tokens out as words in the prose (\"four hundred meters\", \"five minutes\", \"five-thirty-five pace\" instead of \"400m\", \"5 min\", \"5:35\"). " +
          "ON UPDATE, DSL here is NOT re-parsed once workout_doc exists, AND sending workout_doc.steps via intervals_update_event silently drops the steps. To change structure on an existing event, DELETE and re-create — see intervals_update_event for the canonical pattern. " +
          "Reference: https://zonepace.cc/intervals-workout-format.",
      ),
    type: z
      .string()
      .optional()
      .describe("Sport: 'Ride', 'Run', 'Swim', 'WeightTraining', 'Workout', etc."),
    moving_time: z.number().int().optional().describe("Planned duration (seconds)"),
    icu_training_load: z
      .number()
      .int()
      .optional()
      .describe(
        "Planned training load (TSS / equivalent). " +
          "WHEN OMITTED, intervals.icu auto-computes from workout_doc via Normalized Power's 4th-power weighting — which inflates 3-4× for workouts containing short (<60s) high-intensity intervals like strides or hill sprints (NP on a 50-min run with only 80s above threshold can compute as ~417W → TSS 217 vs realistic ~50). " +
          "PATTERN FOR WORKOUTS WITH SUB-60s Z6+ STEPS: an explicit icu_training_load on CREATE is silently overridden by the server's NP-based estimate. To force the value, CREATE the event first (with DSL in description, no icu_training_load), then call intervals_update_event with the pre-computed icu_training_load — the override only sticks on UPDATE. " +
          "Pre-compute formula: TSS ≈ Σ (duration_seconds × IF²) ÷ 3600 × 100, with IF ≈ { Z1: 0.55, Z2: 0.70, Z3: 0.80, Z4: 0.90, Z5: 1.00, Z6: 1.10, Z7: 1.25 } for run/ride. Worked example: 28m Z2 + 4×(20s Z7 / 60s Z1) + 1m Z1 cooldown → TSS ≈ 23 + 3.5 + 2.5 ≈ 29 (server auto-computes ~100+ here — wrong). " +
          "FOR WORKOUTS WITHOUT SHORT TOP-ZONE BURSTS: omit and let the server compute. The NP-based auto-calc is accurate for steady-state and moderate-interval work. " +
          "STRENGTH WORKOUTS (type=WeightTraining / Strength / similar): intervals.icu does NOT auto-compute icu_training_load for strength — it only fills the field from HR/power streams, and Hevy's API doesn't carry HR. ALWAYS pre-compute as Foster sRPE × planned_minutes ÷ 10, using the target session RPE on a 1-10 scale (typically 6-7 for easy/technique work, 7-8 for hypertrophy, 8-9 for heavy strength, 9-10 for peak/AMRAP). Example: 60min @ planned RPE 8 → icu_training_load ≈ 48. Same formula the Hevy → Intervals webhook sync applies post-hoc to actual sessions, so planned vs actual loads stay comparable on the fitness/fatigue chart.",
      ),
    external_id: z
      .string()
      .optional()
      .describe(
        "Caller-supplied stable identifier (e.g. 'hevy-<workoutId>'). Hidden from the calendar UI; useful for sync idempotency. " +
          "Omit to leave unchanged; pass an empty string to clear (Intervals.icu treats JSON null as 'no change').",
      ),
    paired_activity_id: z
      .string()
      .optional()
      .describe(
        "Activity id to link this planned event to a completed activity. " +
          "Links the planned event to the actual workout so Intervals.icu shows them paired in the calendar UI. " +
          "Get the activity id from intervals_list_activities or intervals_search_activities.",
      ),
    workout_doc: z
      .object({
        duration: z.number().optional().describe("Total seconds (optional, computed if omitted)"),
        distance: z.number().optional().describe("Total meters (optional)"),
        description: z.string().optional(),
        steps: z.array(z.any()).describe(
          "Array of step objects. Each step is either a single step or a repeat block. " +
            "Single step keys: duration (sec) OR distance (m) — pick ONE, not both; " +
            "power/hr/pace as { value, units }; cadence as { value, units: 'rpm' }; text (string, optional step label). " +
            "REPEAT BLOCK: { reps: N, steps: [...inner steps...] }. ONE LEVEL OF NESTING ONLY — reps inside reps are not supported; " +
            "for ladders or compound sets, emit sequential rep blocks at the top level instead. " +
            "Server auto-computes the block's total duration and distance and (when DSL was the input) pulls 'text' from the section header. " +
            "UNITS: power supports '%ftp'|'w'|'z'|'power_zone' (value 1-7); hr supports '%hr'|'bpm'|'z'|'hr_zone' (value 1-7); " +
            "pace supports '%pace'|'z'|'pace_zone' (value 1-7). " +
            "DO NOT include a 'type' field ('warmup'|'cooldown'|'recovery'|'interval'|'rest') on input steps — the server adds warmup/cooldown " +
            "booleans automatically based on step position, and supplying 'type' can cause the API to silently return an empty workout_doc. " +
            "CHART CAVEAT: manually-built steps are stored as-is but do not populate the computed metrics the planned-event chart reads (zoneTimes / normalized_power / variability_index / polarization_index / average_watts) regardless of unit form. The chart will render empty even with valid steps. Use DSL in the description field for chart-rendering planned workouts; reserve manual steps for editing existing events whose workout_doc was already populated.",
        ),
      })
      .passthrough()
      .optional()
      .describe(
        "Structured workout as JSON. " +
          "ESCAPE HATCH — for planned Run/Ride/Workout events that need to render on the UI chart, prefer writing the workout as DSL in the description field. The server parses DSL on CREATE and produces a complete workout_doc including the computed metrics the chart reads (zoneTimes, normalized_power, variability_index, polarization_index, average_watts). Manually-built workout_doc.steps stores fine but the chart will render empty because those computed metrics aren't populated. " +
          "Use this field on CREATE when the workout shape can't be expressed in DSL. On UPDATE, sending workout_doc.steps silently drops them server-side (the response comes back with steps=[] and duration=0) — the only reliable structural-edit path for an existing event is DELETE + re-create via intervals_create_event with DSL in description. See intervals_update_event for the canonical pattern. " +
          "BEFORE BUILDING: call intervals_list_sport_settings to read the athlete's priority order. The relevant fields are load_order (drives Training Load), tiz_order (Time In Zones), workout_order (planned-workout display), and interval_display (activity breakdown). " +
          "Match the workout_doc target metric to workout_order: POWER_HR_PACE → power_zone targets, HR_POWER_PACE → hr_zone, PACE_HR_POWER → pace_zone. " +
          "UNIT TRADE-OFFS: power_zone → power-based metrics — best with a power meter (cycling) or running power source (Stryd / Garmin native); " +
          "hr_zone → HRSS-based training load and HR zone times — best without a power meter, or for easy/recovery work where HR self-regulates for heat/hills; " +
          "pace_zone → pace-based training load and pace zone times — best for traditional pace-driven runners. " +
          "Cycling example (10min Z2 warmup + 4×5min Z5 / 3min Z2 + 10min Z1 cooldown, all power_zone): " +
          '{"steps":[{"duration":600,"power":{"value":2,"units":"power_zone"}},' +
          '{"reps":4,"steps":[{"duration":300,"power":{"value":5,"units":"power_zone"}},' +
          '{"duration":180,"power":{"value":2,"units":"power_zone"}}]},' +
          '{"duration":600,"power":{"value":1,"units":"power_zone"}}]} ' +
          "Run example with reps (28m Z2 + 4×20s Z7 strides / 60s Z1, pace_zone): " +
          '{"steps":[{"duration":1680,"pace":{"units":"pace_zone","value":2}},' +
          '{"reps":4,"steps":[{"duration":20,"pace":{"units":"pace_zone","value":7}},' +
          '{"duration":60,"pace":{"units":"pace_zone","value":1}}]}]} ' +
          "Distance-based race example (negative-split 5k, power_zone with step labels): " +
          '{"steps":[{"distance":1609,"power":{"units":"power_zone","value":4},"text":"Mile 1"},' +
          '{"distance":1609,"power":{"units":"power_zone","value":5},"text":"Mile 2"},' +
          '{"distance":2414,"power":{"units":"power_zone","value":6},"text":"Last 1.5mi"}]} ' +
          "KNOWN QUIRKS (manual workout_doc only — DSL-parsed workout_docs sidestep these): " +
          "(1) Editing the structure via UI or API can flip step target units (e.g. pace_zone → power_zone on save) regardless of Sport Settings priority — verify the saved doc after every update. " +
          "(2) Race-category events (RACE_A/B/C) may not auto-compute icu_training_load even with a valid workout_doc — appears intentional since races are unpredictable.",
      ),
  };

  server.tool(
    "intervals_create_event",
    "Create a calendar event (planned workout, race, note). " +
      "FOR PLANNED RUN / RIDE / WORKOUT WITH STRUCTURE: write the workout as DSL in the description field, leave workout_doc unset. The server parses DSL on CREATE and produces a full workout_doc with the computed metrics the UI chart needs — manually-supplied workout_doc.steps stores fine but renders the chart empty. See the description field for DSL syntax and an example. " +
      "Call intervals_list_sport_settings first to read the athlete's workout_order, then pick the matching metric suffix in the DSL ('Z2 Power' / 'Z2 Pace' / 'Z2 HR') so the chart targets the metric they prioritize. " +
      "Categories: 'WORKOUT', 'RACE_A', 'RACE_B', 'RACE_C', 'NOTE', 'HOLIDAY', 'SICK', 'INJURED'. " +
      "FOR WORKOUTS WITH ANY STEP <60s ABOVE Z5 (strides, hill sprints, etc.): an explicit icu_training_load on the create payload is silently overridden by the server's NP-inflated estimate. Pattern: CREATE the event first (with DSL in description, no icu_training_load), then call intervals_update_event with the pre-computed icu_training_load — the override only sticks on UPDATE. See the icu_training_load field for the formula. " +
      "For strength events (type WeightTraining / Strength / similar): Intervals carries the schedule + training-load tracking regardless of where the prescription lives. Pre-compute icu_training_load in either branch (Intervals can't auto-compute it for strength) — see the icu_training_load field description for the sRPE formula. " +
      "STRENGTH BRANCH A — HEVY CONNECTED (hevy_create_routine is in your tool list): pair this call with hevy_create_routine. Hevy holds the workout structure; set the Intervals event's external_id to `hevy-<routineId>` from the hevy_create_routine response (for upsert idempotency and back-linkage), and put the routine link + full prescription in the description — first line `[Hevy routine](https://hevy.com/routine/<routineId>)`, then a `### <Exercise Name>` heading per exercise with one `- <weight>kg x <reps>` bullet per working set (or `- <reps> reps` for bodyweight). This mirrors the Markdown shape the Hevy → Intervals webhook writes for completed sessions, so the planned event and the synced activity read identically on the calendar. " +
      "STRENGTH BRANCH B — HEVY NOT CONNECTED (hevy_create_routine isn't in your tool list): don't call any Hevy tool. Embed the prescription directly in this event's description in the same Markdown shape — `### <Exercise Name>` heading per exercise, `- <weight>kg x <reps>` bullet per working set — just omit the routine link. The athlete reads the prescription from the Intervals calendar entry itself. Only suggest connecting Hevy if the athlete asks about set-by-set logging or per-set RPE-driven training load. " +
      "DATE FORMAT: start_date_local requires a time component — '2026-05-21' alone returns 422. Use '2026-05-21T00:00:00' for all-day NOTEs or '2026-05-21T18:00:00' for timed events. " +
      "NOTE EVENTS: set category 'NOTE' and omit type — NOTEs have no type field. NOTE descriptions render full Markdown.",
    EventInputShape,
    async (input) => {
      const data = await intervalsFetch(`/athlete/${athlete()}/events`, {
        method: "POST",
        body: JSON.stringify(input),
      });
      return ok(data);
    },
  );

  server.tool(
    "intervals_update_event",
    "Update an existing calendar event by id. Pass any fields to change; omitted fields are left unchanged. " +
      "WORKS RELIABLY for: name, description, start_date_local, category, type, moving_time, icu_training_load, external_id, paired_activity_id. " +
      "DOES NOT WORK for structural changes: sending workout_doc.steps on UPDATE silently drops the steps array — the response comes back with workout_doc.steps=[], workout_doc.duration=0, and all computed metrics (zoneTimes, normalized_power, etc.) null, even when icu_training_load / description / name on the same call all update correctly. " +
      "DESCRIPTION DISTANCE-TOKEN HAZARD: the Intervals.icu API scans description text for distance tokens (e.g. '10 miles', '30km') even on UPDATE and silently appends phantom distance steps to the existing workout_doc, inflating duration and distance. To avoid this, always spell out numbers as words in prose ('ten miles', not '10 miles') or omit distance units next to digits. This re-parsing ONLY affects distance tokens — standalone DSL lines are not re-parsed on UPDATE once workout_doc exists. " +
      "STRUCTURAL-EDIT PATTERN: to add/remove/reshape steps on an existing planned event, DELETE the event via intervals_delete_event and re-create via intervals_create_event (or intervals_create_events_bulk for several at once) with DSL in description. The new event will have a fresh id; if you need to preserve paired_activity_id linkage to a completed activity, set external_id on the recreate to match (or pass paired_activity_id explicitly). " +
      "TO OVERRIDE icu_training_load: this is the correct call. Explicit icu_training_load values are silently ignored on CREATE for workouts with sub-60s Z6+ steps, but DO stick on UPDATE — use the CREATE-with-DSL → UPDATE-with-icu_training_load pattern documented on intervals_create_event. " +
      "NOTE RE-PASS: if updating a NOTE event and omitting category, Intervals defaults it back to WORKOUT and demands a type. Always re-pass category 'NOTE' when updating NOTEs.",
    { eventId: z.string().min(1), ...EventInputShape },
    async ({ eventId, ...input }) => {
      const data = await intervalsFetch(`/athlete/${athlete()}/events/${enc(eventId)}`,
        { method: "PUT", body: JSON.stringify(input) },
      );
      return ok(data);
    },
  );

  server.tool(
    "intervals_delete_event",
    "Delete a calendar event by id.",
    { eventId: z.string().min(1) },
    async ({ eventId }) => {
      await intervalsFetch(`/athlete/${athlete()}/events/${enc(eventId)}`, {
        method: "DELETE",
      });
      return ok({ deleted: eventId });
    },
  );

  server.tool(
    "intervals_get_event",
    "Fetch a single calendar event by numeric id.",
    { eventId: z.number().int() },
    async ({ eventId }) => {
      const data = await intervalsFetch(`/athlete/${athlete()}/events/${enc(eventId)}`,
      );
      return ok(data);
    },
  );

  server.tool(
    "intervals_download_event",
    "Download a calendar event's workout file (defaults to JSON; pass ext like '.zwo', '.mrc' to get other formats — server may return non-JSON which will fail to parse).",
    {
      eventId: z.number().int(),
      ext: z
        .string()
        .optional()
        .describe("Extension including dot (e.g. '.zwo'); empty for default JSON"),
    },
    async ({ eventId, ext }) => {
      const data = await intervalsFetch(`/athlete/${athlete()}/events/${enc(eventId)}/download${ext ?? ""}`,
      );
      return ok(data);
    },
  );

  server.tool(
    "intervals_mark_event_done",
    "Mark a planned event as completed.",
    { eventId: z.number().int() },
    async ({ eventId }) => {
      const data = await intervalsFetch(`/athlete/${athlete()}/events/${enc(eventId)}/mark-done`,
        { method: "POST" },
      );
      return ok(data);
    },
  );

  server.tool(
    "intervals_update_events_in_range",
    "Apply the same update to all events in a date range (PUT bulk by range).",
    {
      oldest: z.string().describe("Local date (ISO-8601), oldest event to update"),
      newest: z.string().describe("Local date (ISO-8601), newest event (inclusive)"),
      body: z
        .record(z.string(), z.any())
        .describe("See `Event` schema in the Intervals.ICU OpenAPI spec"),
    },
    async ({ oldest, newest, body }) => {
      const qs = new URLSearchParams({ oldest, newest });
      const data = await intervalsFetch(`/athlete/${athlete()}/events?${qs}`, {
        method: "PUT",
        body: JSON.stringify(body),
      });
      return ok(data);
    },
  );

  server.tool(
    "intervals_delete_events_in_range",
    "Delete all events in a date range matching the given categories (and optional creator).",
    {
      oldest: z.string().describe("Local date (ISO-8601), oldest event to delete"),
      newest: z.string().optional().describe("Local date (ISO-8601), newest event (inclusive)"),
      createdById: z.string().optional().describe("Only delete events created by this athlete id"),
      category: z
        .string()
        .describe("Comma-separated event categories (e.g. 'WORKOUT,NOTE')"),
    },
    async ({ oldest, newest, createdById, category }) => {
      const qs = new URLSearchParams();
      qs.set("oldest", oldest);
      qs.set("category", category);
      if (newest !== undefined) qs.set("newest", newest);
      if (createdById !== undefined) qs.set("createdById", createdById);
      const data = await intervalsFetch(`/athlete/${athlete()}/events?${qs}`, {
        method: "DELETE",
      });
      return ok(data);
    },
  );

  server.tool(
    "intervals_apply_plan",
    "Apply a training plan to the athlete's calendar.",
    {
      body: z
        .record(z.string(), z.any())
        .describe("See `ApplyPlanDTO` in the Intervals.ICU OpenAPI spec"),
    },
    async ({ body }) => {
      const data = await intervalsFetch(`/athlete/${athlete()}/events/apply-plan`,
        { method: "POST", body: JSON.stringify(body) },
      );
      return ok(data);
    },
  );

  server.tool(
    "intervals_apply_plan_changes",
    "Apply pending plan-driven changes to existing events on the athlete's calendar.",
    {},
    async () => {
      const data = await intervalsFetch(`/athlete/${athlete()}/apply-plan-changes`,
        { method: "PUT" },
      );
      return ok(data);
    },
  );

  server.tool(
    "intervals_create_events_bulk",
    "Bulk create or upsert events. " +
      "IDEMPOTENCY: upsert matches by external_id (per the Intervals.icu maintainer); the maintainer also describes upsert as 'on by default' for this endpoint. To make a retry-safe call, set a stable external_id on every event — without it, re-running the same payload silently duplicates the calendar instead of deduplicating. This wrapper rejects upsert:true (or upsertOnUid:true) calls whose payload is missing the required key, but cannot guard the implicit-default case, so always set external_id on planned-workout writes you might retry. " +
      "Per-event guidance applies — see intervals_create_event's description for: (a) the DSL-in-description pattern (canonical for chart-rendering planned workouts), (b) sport_settings priority and matching metric suffix, and (c) the CREATE-then-UPDATE pattern for icu_training_load on workouts with sub-60s Z6+ steps. For (c), follow the bulk create with intervals_update_event per event whose icu_training_load needs the override.",
    {
      events: z
        .array(z.record(z.string(), z.any()))
        .describe("Array of `Event` objects (see OpenAPI spec). For retry-safe upsert, every event must carry a stable `external_id`."),
      upsert: z
        .boolean()
        .optional()
        .describe("Update events with matching external_id created by the same athlete. REQUIRES external_id set on every event in the payload, otherwise the call is rejected."),
      upsertOnUid: z
        .boolean()
        .optional()
        .describe("Update events with matching uid instead of creating new ones. REQUIRES uid set on every event in the payload, otherwise the call is rejected."),
      updatePlanApplied: z
        .boolean()
        .optional()
        .describe("Tag all created/updated events with the same new plan_applied value"),
    },
    async ({ events, upsert, upsertOnUid, updatePlanApplied }) => {
      if (upsert === true) {
        const missing: number[] = [];
        events.forEach((e, i) => {
          const v = (e as Record<string, unknown>).external_id;
          if (typeof v !== "string" || v.length === 0) missing.push(i);
        });
        if (missing.length > 0) {
          throw new Error(
            `intervals_create_events_bulk: upsert:true requires external_id on every event (Intervals matches upserts by external_id). ` +
              `Missing/empty external_id on event indices: ${missing.join(", ")}. ` +
              `Set a stable external_id per event and retry, or drop upsert and dedupe manually.`,
          );
        }
      }
      if (upsertOnUid === true) {
        const missing: number[] = [];
        events.forEach((e, i) => {
          const v = (e as Record<string, unknown>).uid;
          if (typeof v !== "string" || v.length === 0) missing.push(i);
        });
        if (missing.length > 0) {
          throw new Error(
            `intervals_create_events_bulk: upsertOnUid:true requires uid on every event. ` +
              `Missing/empty uid on event indices: ${missing.join(", ")}.`,
          );
        }
      }
      const qs = new URLSearchParams();
      if (upsert !== undefined) qs.set("upsert", String(upsert));
      if (upsertOnUid !== undefined) qs.set("upsertOnUid", String(upsertOnUid));
      if (updatePlanApplied !== undefined)
        qs.set("updatePlanApplied", String(updatePlanApplied));
      const suffix = qs.toString() ? `?${qs}` : "";
      const data = await intervalsFetch(`/athlete/${athlete()}/events/bulk${suffix}`,
        { method: "POST", body: JSON.stringify(events) },
      );
      return ok(data);
    },
  );

  server.tool(
    "intervals_delete_events_bulk",
    "Bulk-delete events by passing an array of identifier objects. Each item must have either `id` (Intervals.icu numeric event id) or `external_id` (string, set by OAuth-app writes). Example: `[{ id: 110499736 }, { id: 110499740 }]`. Returns `{ eventsDeleted: <n> }` on success.",
    {
      events: z
        .array(
          z.object({
            id: z.number().int().optional(),
            external_id: z.string().optional(),
          }),
        )
        .min(1)
        .describe(
          "Array of `DoomedEvent` objects per the Intervals.ICU OpenAPI spec. Each item: `{ id }` or `{ external_id }`.",
        ),
    },
    async ({ events }) => {
      const data = await intervalsFetch(`/athlete/${athlete()}/events/bulk-delete`,
        { method: "PUT", body: JSON.stringify(events) },
      );
      return ok(data);
    },
  );

  server.tool(
    "intervals_duplicate_events",
    "Duplicate a set of events (e.g. copy a week of workouts to a new date range).",
    {
      body: z
        .record(z.string(), z.any())
        .describe("See `DuplicateEventsDTO` in the Intervals.ICU OpenAPI spec"),
    },
    async ({ body }) => {
      const data = await intervalsFetch(`/athlete/${athlete()}/duplicate-events`,
        { method: "POST", body: JSON.stringify(body) },
      );
      return ok(data);
    },
  );

  // === Workouts library ===

  server.tool(
    "intervals_list_library_workouts",
    "List the athlete's workout library (saved workouts, distinct from calendar events).",
    {},
    async () => {
      const data = await intervalsFetch(`/athlete/${athlete()}/workouts`);
      return ok(data);
    },
  );

  server.tool(
    "intervals_create_library_workout",
    "Create a workout in the athlete's library.",
    {
      body: z
        .record(z.string(), z.any())
        .describe("See `WorkoutEx` schema in the Intervals.ICU OpenAPI spec"),
    },
    async ({ body }) => {
      const data = await intervalsFetch(`/athlete/${athlete()}/workouts`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      return ok(data);
    },
  );

  server.tool(
    "intervals_create_library_workouts_bulk",
    "Bulk-create multiple library workouts in one call.",
    {
      workouts: z
        .array(z.record(z.string(), z.any()))
        .describe("Array of `WorkoutEx` objects"),
    },
    async ({ workouts }) => {
      const data = await intervalsFetch(`/athlete/${athlete()}/workouts/bulk`, {
        method: "POST",
        body: JSON.stringify(workouts),
      });
      return ok(data);
    },
  );

  server.tool(
    "intervals_get_library_workout",
    "Get a single library workout by id.",
    { workoutId: z.number().int() },
    async ({ workoutId }) => {
      const data = await intervalsFetch(`/athlete/${athlete()}/workouts/${enc(workoutId)}`,
      );
      return ok(data);
    },
  );

  server.tool(
    "intervals_update_library_workout",
    "Update a library workout.",
    {
      workoutId: z.number().int(),
      body: z
        .record(z.string(), z.any())
        .describe("See `WorkoutEx` schema in the Intervals.ICU OpenAPI spec"),
    },
    async ({ workoutId, body }) => {
      const data = await intervalsFetch(`/athlete/${athlete()}/workouts/${enc(workoutId)}`,
        { method: "PUT", body: JSON.stringify(body) },
      );
      return ok(data);
    },
  );

  server.tool(
    "intervals_delete_library_workout",
    "Delete a library workout. Pass `others=true` to also delete shared/derived copies.",
    {
      workoutId: z.number().int(),
      others: z.boolean().optional(),
    },
    async ({ workoutId, others }) => {
      const qs = new URLSearchParams();
      if (others !== undefined) qs.set("others", String(others));
      const suffix = qs.toString() ? `?${qs}` : "";
      await intervalsFetch(`/athlete/${athlete()}/workouts/${enc(workoutId)}${suffix}`,
        { method: "DELETE" },
      );
      return ok({ deleted: workoutId });
    },
  );

  server.tool(
    "intervals_duplicate_workouts",
    "Duplicate one or more library workouts.",
    {
      body: z
        .record(z.string(), z.any())
        .describe("See `DuplicateWorkoutsDTO` in the Intervals.ICU OpenAPI spec"),
    },
    async ({ body }) => {
      const data = await intervalsFetch(`/athlete/${athlete()}/duplicate-workouts`,
        { method: "POST", body: JSON.stringify(body) },
      );
      return ok(data);
    },
  );

  // === Folders ===

  server.tool(
    "intervals_list_folders",
    "List workout folders for the athlete.",
    {},
    async () => {
      const data = await intervalsFetch(`/athlete/${athlete()}/folders`);
      return ok(data);
    },
  );

  server.tool(
    "intervals_create_folder",
    "Create a workout folder.",
    {
      body: z
        .record(z.string(), z.any())
        .describe("See `CreateFolderDTO` in the Intervals.ICU OpenAPI spec"),
    },
    async ({ body }) => {
      const data = await intervalsFetch(`/athlete/${athlete()}/folders`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      return ok(data);
    },
  );

  server.tool(
    "intervals_update_folder",
    "Update a workout folder.",
    {
      folderId: z.number().int(),
      body: z
        .record(z.string(), z.any())
        .describe("See `Folder` schema in the Intervals.ICU OpenAPI spec"),
    },
    async ({ folderId, body }) => {
      const data = await intervalsFetch(`/athlete/${athlete()}/folders/${enc(folderId)}`,
        { method: "PUT", body: JSON.stringify(body) },
      );
      return ok(data);
    },
  );

  server.tool(
    "intervals_delete_folder",
    "Delete a workout folder.",
    { folderId: z.number().int() },
    async ({ folderId }) => {
      await intervalsFetch(`/athlete/${athlete()}/folders/${enc(folderId)}`,
        { method: "DELETE" },
      );
      return ok({ deleted: folderId });
    },
  );

  server.tool(
    "intervals_get_folder_shared_with",
    "List athletes that a folder is shared with.",
    { folderId: z.number().int() },
    async ({ folderId }) => {
      const data = await intervalsFetch(`/athlete/${athlete()}/folders/${enc(folderId)}/shared-with`,
      );
      return ok(data);
    },
  );

  server.tool(
    "intervals_update_folder_shared_with",
    "Update the share list for a workout folder.",
    {
      folderId: z.number().int(),
      body: z
        .record(z.string(), z.any())
        .describe("Object describing share targets (athletes/groups)"),
    },
    async ({ folderId, body }) => {
      const data = await intervalsFetch(`/athlete/${athlete()}/folders/${enc(folderId)}/shared-with`,
        { method: "PUT", body: JSON.stringify(body) },
      );
      return ok(data);
    },
  );

  server.tool(
    "intervals_update_folder_workouts",
    "Replace/update the workouts inside a folder for a date-id range.",
    {
      folderId: z.number().int(),
      oldest: z.number().int().describe("Oldest workout id in range"),
      newest: z.number().int().describe("Newest workout id in range"),
      body: z
        .record(z.string(), z.any())
        .describe("See `Workout` schema in the Intervals.ICU OpenAPI spec"),
    },
    async ({ folderId, oldest, newest, body }) => {
      const qs = new URLSearchParams({ oldest: String(oldest), newest: String(newest) });
      const data = await intervalsFetch(`/athlete/${athlete()}/folders/${enc(folderId)}/workouts?${qs}`,
        { method: "PUT", body: JSON.stringify(body) },
      );
      return ok(data);
    },
  );

  // === Athlete ===

  server.tool(
    "intervals_get_athlete",
    "Get the athlete's profile/configuration object.",
    {},
    async () => {
      const data = await intervalsFetch(`/athlete/${athlete()}`);
      return ok(data);
    },
  );

  server.tool(
    "intervals_update_athlete",
    "Update athlete profile fields.",
    {
      body: z
        .record(z.string(), z.any())
        .describe("See `AthleteUpdateDTO` in the Intervals.ICU OpenAPI spec"),
    },
    async ({ body }) => {
      const data = await intervalsFetch(`/athlete/${athlete()}`, {
        method: "PUT",
        body: JSON.stringify(body),
      });
      return ok(data);
    },
  );

  server.tool(
    "intervals_get_profile",
    "Get the athlete's public profile.",
    {},
    async () => {
      const data = await intervalsFetch(`/athlete/${athlete()}/profile`);
      return ok(data);
    },
  );

  server.tool(
    "intervals_get_training_plan",
    "Get the athlete's current training plan settings.",
    {},
    async () => {
      const data = await intervalsFetch(`/athlete/${athlete()}/training-plan`);
      return ok(data);
    },
  );

  server.tool(
    "intervals_update_training_plan",
    "Update the athlete's training plan settings.",
    {
      body: z
        .record(z.string(), z.any())
        .describe("See `AthleteTrainingPlanUpdate` in the Intervals.ICU OpenAPI spec"),
    },
    async ({ body }) => {
      const data = await intervalsFetch(`/athlete/${athlete()}/training-plan`, {
        method: "PUT",
        body: JSON.stringify(body),
      });
      return ok(data);
    },
  );

  server.tool(
    "intervals_get_device_settings",
    "Get device-class-specific settings for the athlete (e.g. Garmin, Wahoo).",
    { deviceClass: z.string().min(1) },
    async ({ deviceClass }) => {
      const data = await intervalsFetch(`/athlete/${athlete()}/settings/${enc(deviceClass)}`,
      );
      return ok(data);
    },
  );

  server.tool(
    "intervals_get_athlete_summary",
    "Get a summary view across the athlete's data (optionally filtered by date range and tags).",
    {
      start: z.string().optional().describe("Local ISO-8601 start"),
      end: z.string().optional().describe("Local ISO-8601 end"),
      tags: z.string().optional().describe("Comma-separated athlete tags"),
    },
    async ({ start, end, tags }) => {
      const qs = new URLSearchParams();
      if (start !== undefined) qs.set("start", start);
      if (end !== undefined) qs.set("end", end);
      if (tags !== undefined) qs.set("tags", tags);
      const suffix = qs.toString() ? `?${qs}` : "";
      const data = await intervalsFetch(`/athlete/${athlete()}/athlete-summary${suffix}`,
      );
      return ok(data);
    },
  );

  // === Sport settings ===

  server.tool(
    "intervals_list_sport_settings",
    "List all sport-settings entries for the athlete.",
    {},
    async () => {
      const data = await intervalsFetch(`/athlete/${athlete()}/sport-settings`);
      return ok(data);
    },
  );

  server.tool(
    "intervals_update_sport_settings",
    "Bulk update sport-settings for the athlete.",
    {
      recalcHrZones: z.boolean().describe("Recalculate HR zones from new thresholds"),
      body: z
        .record(z.string(), z.any())
        .describe("Sport-settings payload (see OpenAPI spec)"),
    },
    async ({ recalcHrZones, body }) => {
      const qs = new URLSearchParams({ recalcHrZones: String(recalcHrZones) });
      const data = await intervalsFetch(`/athlete/${athlete()}/sport-settings?${qs}`,
        { method: "PUT", body: JSON.stringify(body) },
      );
      return ok(data);
    },
  );

  server.tool(
    "intervals_create_sport_settings",
    "Create a new sport-settings entry.",
    {
      body: z
        .record(z.string(), z.any())
        .describe("See `SportSettings` schema in the Intervals.ICU OpenAPI spec"),
    },
    async ({ body }) => {
      const data = await intervalsFetch(`/athlete/${athlete()}/sport-settings`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      return ok(data);
    },
  );

  server.tool(
    "intervals_get_sport_settings",
    "Get a single sport-settings entry by id.",
    { id: z.string().min(1) },
    async ({ id }) => {
      const data = await intervalsFetch(`/athlete/${athlete()}/sport-settings/${enc(id)}`,
      );
      return ok(data);
    },
  );

  server.tool(
    "intervals_update_sport_setting",
    "Update a single sport-settings entry by id.",
    {
      id: z.string().min(1),
      recalcHrZones: z.boolean().describe("Recalculate HR zones from new thresholds"),
      body: z
        .record(z.string(), z.any())
        .describe("See `SportSettings` schema in the Intervals.ICU OpenAPI spec"),
    },
    async ({ id, recalcHrZones, body }) => {
      const qs = new URLSearchParams({ recalcHrZones: String(recalcHrZones) });
      const data = await intervalsFetch(`/athlete/${athlete()}/sport-settings/${enc(id)}?${qs}`,
        { method: "PUT", body: JSON.stringify(body) },
      );
      return ok(data);
    },
  );

  server.tool(
    "intervals_delete_sport_setting",
    "Delete a single sport-settings entry by id.",
    { id: z.number().int() },
    async ({ id }) => {
      await intervalsFetch(`/athlete/${athlete()}/sport-settings/${enc(id)}`,
        { method: "DELETE" },
      );
      return ok({ deleted: id });
    },
  );

  server.tool(
    "intervals_apply_sport_setting",
    "Apply a sport-settings entry (recompute matching activities, etc.).",
    { id: z.string().min(1) },
    async ({ id }) => {
      const data = await intervalsFetch(`/athlete/${athlete()}/sport-settings/${enc(id)}/apply`,
        { method: "PUT" },
      );
      return ok(data);
    },
  );

  server.tool(
    "intervals_get_sport_setting_matching_activities",
    "List activities that match a sport-settings entry's filters.",
    { id: z.string().min(1) },
    async ({ id }) => {
      const data = await intervalsFetch(`/athlete/${athlete()}/sport-settings/${enc(id)}/matching-activities`,
      );
      return ok(data);
    },
  );

  server.tool(
    "intervals_get_sport_setting_pace_distances",
    "Get the pace-distance buckets configured for a sport-settings entry.",
    { id: z.string().min(1) },
    async ({ id }) => {
      const data = await intervalsFetch(`/athlete/${athlete()}/sport-settings/${enc(id)}/pace_distances`,
      );
      return ok(data);
    },
  );

  // === Gear ===

  server.tool(
    "intervals_list_gear",
    "List the athlete's gear (bikes, shoes, etc.).",
    {},
    async () => {
      const data = await intervalsFetch(`/athlete/${athlete()}/gear`);
      return ok(data);
    },
  );

  server.tool(
    "intervals_create_gear",
    "Create a new gear item.",
    {
      body: z
        .record(z.string(), z.any())
        .describe("See `Gear` schema in the Intervals.ICU OpenAPI spec"),
    },
    async ({ body }) => {
      const data = await intervalsFetch(`/athlete/${athlete()}/gear`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      return ok(data);
    },
  );

  server.tool(
    "intervals_update_gear",
    "Update a gear item.",
    {
      gearId: z.string().min(1),
      body: z
        .record(z.string(), z.any())
        .describe("See `Gear` schema in the Intervals.ICU OpenAPI spec"),
    },
    async ({ gearId, body }) => {
      const data = await intervalsFetch(`/athlete/${athlete()}/gear/${enc(gearId)}`,
        { method: "PUT", body: JSON.stringify(body) },
      );
      return ok(data);
    },
  );

  server.tool(
    "intervals_delete_gear",
    "Delete a gear item.",
    { gearId: z.string().min(1) },
    async ({ gearId }) => {
      await intervalsFetch(`/athlete/${athlete()}/gear/${enc(gearId)}`,
        { method: "DELETE" },
      );
      return ok({ deleted: gearId });
    },
  );

  server.tool(
    "intervals_calc_gear",
    "Recalculate cumulative gear stats (distance, time, etc.).",
    { gearId: z.string().min(1) },
    async ({ gearId }) => {
      const data = await intervalsFetch(`/athlete/${athlete()}/gear/${enc(gearId)}/calc`,
      );
      return ok(data);
    },
  );

  server.tool(
    "intervals_create_gear_reminder",
    "Create a maintenance reminder on a gear item.",
    {
      gearId: z.string().min(1),
      body: z
        .record(z.string(), z.any())
        .describe("See `GearReminder` schema in the Intervals.ICU OpenAPI spec"),
    },
    async ({ gearId, body }) => {
      const data = await intervalsFetch(`/athlete/${athlete()}/gear/${enc(gearId)}/reminder`,
        { method: "POST", body: JSON.stringify(body) },
      );
      return ok(data);
    },
  );

  server.tool(
    "intervals_update_gear_reminder",
    "Update a gear maintenance reminder (and optionally reset/snooze it).",
    {
      gearId: z.string().min(1),
      reminderId: z.number().int(),
      reset: z.boolean().describe("Reset the reminder counter"),
      snoozeDays: z.number().int().describe("Snooze the reminder by N days"),
      body: z
        .record(z.string(), z.any())
        .describe("See `GearReminder` schema in the Intervals.ICU OpenAPI spec"),
    },
    async ({ gearId, reminderId, reset, snoozeDays, body }) => {
      const qs = new URLSearchParams({
        reset: String(reset),
        snoozeDays: String(snoozeDays),
      });
      const data = await intervalsFetch(`/athlete/${athlete()}/gear/${enc(gearId)}/reminder/${enc(reminderId)}?${qs}`,
        { method: "PUT", body: JSON.stringify(body) },
      );
      return ok(data);
    },
  );

  server.tool(
    "intervals_delete_gear_reminder",
    "Delete a gear maintenance reminder.",
    {
      gearId: z.string().min(1),
      reminderId: z.number().int(),
    },
    async ({ gearId, reminderId }) => {
      await intervalsFetch(`/athlete/${athlete()}/gear/${enc(gearId)}/reminder/${enc(reminderId)}`,
        { method: "DELETE" },
      );
      return ok({ deleted: reminderId });
    },
  );

  server.tool(
    "intervals_replace_gear",
    "Replace a gear item (e.g. swap shoes), transferring history as configured.",
    {
      gearId: z.string().min(1),
      body: z
        .record(z.string(), z.any())
        .describe("See `Gear` schema in the Intervals.ICU OpenAPI spec for the replacement"),
    },
    async ({ gearId, body }) => {
      const data = await intervalsFetch(`/athlete/${athlete()}/gear/${enc(gearId)}/replace`,
        { method: "POST", body: JSON.stringify(body) },
      );
      return ok(data);
    },
  );

  // === Routes ===

  server.tool(
    "intervals_list_routes",
    "List the athlete's saved routes.",
    {},
    async () => {
      const data = await intervalsFetch(`/athlete/${athlete()}/routes`);
      return ok(data);
    },
  );

  server.tool(
    "intervals_get_route",
    "Get a single route by id, optionally including the GPS path.",
    {
      route_id: z.number().int(),
      includePath: z.boolean().optional(),
    },
    async ({ route_id, includePath }) => {
      const qs = new URLSearchParams();
      if (includePath !== undefined) qs.set("includePath", String(includePath));
      const suffix = qs.toString() ? `?${qs}` : "";
      const data = await intervalsFetch(`/athlete/${athlete()}/routes/${enc(route_id)}${suffix}`,
      );
      return ok(data);
    },
  );

  server.tool(
    "intervals_update_route",
    "Update a route.",
    {
      route_id: z.number().int(),
      body: z
        .record(z.string(), z.any())
        .describe("See `AthleteRoute` schema in the Intervals.ICU OpenAPI spec"),
    },
    async ({ route_id, body }) => {
      const data = await intervalsFetch(`/athlete/${athlete()}/routes/${enc(route_id)}`,
        { method: "PUT", body: JSON.stringify(body) },
      );
      return ok(data);
    },
  );

  server.tool(
    "intervals_get_route_similarity",
    "Compute similarity between two routes.",
    {
      route_id: z.number().int(),
      other_id: z.number().int(),
    },
    async ({ route_id, other_id }) => {
      const data = await intervalsFetch(`/athlete/${athlete()}/routes/${enc(route_id)}/similarity/${enc(other_id)}`,
      );
      return ok(data);
    },
  );

  // === Custom items ===

  server.tool(
    "intervals_list_custom_items",
    "List the athlete's custom dashboard items.",
    {},
    async () => {
      const data = await intervalsFetch(`/athlete/${athlete()}/custom-item`);
      return ok(data);
    },
  );

  server.tool(
    "intervals_create_custom_item",
    "Create a custom dashboard item.",
    {
      body: z
        .record(z.string(), z.any())
        .describe("See `CustomItem` schema in the Intervals.ICU OpenAPI spec"),
    },
    async ({ body }) => {
      const data = await intervalsFetch(`/athlete/${athlete()}/custom-item`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      return ok(data);
    },
  );

  server.tool(
    "intervals_update_custom_item_indexes",
    "Reorder custom items by setting their indexes in bulk.",
    {
      body: z
        .record(z.string(), z.any())
        .describe("Object mapping item ids to new indexes (see OpenAPI spec)"),
    },
    async ({ body }) => {
      const data = await intervalsFetch(`/athlete/${athlete()}/custom-item-indexes`,
        { method: "PUT", body: JSON.stringify(body) },
      );
      return ok(data);
    },
  );

  server.tool(
    "intervals_get_custom_item",
    "Get a single custom item by id.",
    { itemId: z.number().int() },
    async ({ itemId }) => {
      const data = await intervalsFetch(`/athlete/${athlete()}/custom-item/${enc(itemId)}`,
      );
      return ok(data);
    },
  );

  server.tool(
    "intervals_update_custom_item",
    "Update a custom item.",
    {
      itemId: z.number().int(),
      body: z
        .record(z.string(), z.any())
        .describe("See `CustomItem` schema in the Intervals.ICU OpenAPI spec"),
    },
    async ({ itemId, body }) => {
      const data = await intervalsFetch(`/athlete/${athlete()}/custom-item/${enc(itemId)}`,
        { method: "PUT", body: JSON.stringify(body) },
      );
      return ok(data);
    },
  );

  server.tool(
    "intervals_delete_custom_item",
    "Delete a custom item.",
    { itemId: z.number().int() },
    async ({ itemId }) => {
      await intervalsFetch(`/athlete/${athlete()}/custom-item/${enc(itemId)}`,
        { method: "DELETE" },
      );
      return ok({ deleted: itemId });
    },
  );

  // === Athlete-level analytics curves ===

  const AthleteCurveBaseShape = {
    oldest: z.string().describe("Local ISO-8601 oldest date/time"),
    newest: z.string().describe("Local ISO-8601 newest date/time (inclusive)"),
    type: z.string().optional().describe("Sport (Ride, Run, etc.)"),
    filters: z.string().optional().describe("Comma-separated filter expressions"),
  };

  server.tool(
    "intervals_get_athlete_activity_hr_curves",
    "Get HR curves aggregated across the athlete's activities for a date range.",
    {
      ...AthleteCurveBaseShape,
      secs: z.string().optional().describe("Comma-separated durations (seconds) to return"),
    },
    async ({ oldest, newest, type, filters, secs }) => {
      const qs = new URLSearchParams({ oldest, newest });
      if (type !== undefined) qs.set("type", type);
      if (filters !== undefined) qs.set("filters", filters);
      if (secs !== undefined) qs.set("secs", secs);
      const data = await intervalsFetch(`/athlete/${athlete()}/activity-hr-curves?${qs}`,
      );
      return ok(data);
    },
  );

  server.tool(
    "intervals_get_athlete_activity_pace_curves",
    "Get pace curves aggregated across the athlete's activities for a date range.",
    {
      ...AthleteCurveBaseShape,
      distances: z.string().optional().describe("Comma-separated distances in meters"),
      gap: z.boolean().optional().describe("Return gradient-adjusted pace curves"),
    },
    async ({ oldest, newest, type, filters, distances, gap }) => {
      const qs = new URLSearchParams({ oldest, newest });
      if (type !== undefined) qs.set("type", type);
      if (filters !== undefined) qs.set("filters", filters);
      if (distances !== undefined) qs.set("distances", distances);
      if (gap !== undefined) qs.set("gap", String(gap));
      const data = await intervalsFetch(`/athlete/${athlete()}/activity-pace-curves?${qs}`,
      );
      return ok(data);
    },
  );

  server.tool(
    "intervals_get_athlete_activity_power_curves",
    "Get power curves aggregated across the athlete's activities for a date range.",
    {
      ...AthleteCurveBaseShape,
      secs: z.string().optional().describe("Comma-separated durations (seconds) to return"),
      fatigue: z.string().optional().describe("'kj0' or 'kj1' to apply a predefined fatigue model"),
    },
    async ({ oldest, newest, type, filters, secs, fatigue }) => {
      const qs = new URLSearchParams({ oldest, newest });
      if (type !== undefined) qs.set("type", type);
      if (filters !== undefined) qs.set("filters", filters);
      if (secs !== undefined) qs.set("secs", secs);
      if (fatigue !== undefined) qs.set("fatigue", fatigue);
      const data = await intervalsFetch(`/athlete/${athlete()}/activity-power-curves?${qs}`,
      );
      return ok(data);
    },
  );

  const FilteredCurveShape = {
    type: z.string().describe("Sport (Ride, Run, etc.)"),
    f1: z.string().describe("Filter set 1 (comma-separated filter expressions)"),
    f2: z.string().describe("Filter set 2"),
    f3: z.string().describe("Filter set 3"),
    newest: z.string().optional(),
    curves: z
      .string()
      .optional()
      .describe("Comma-separated list of curves to return (default: last year)"),
    subMaxEfforts: z.number().int().optional(),
    now: z.string().optional().describe("Current local date (ISO-8601)"),
    filters: z.string().optional().describe("Base filter expressions"),
  };

  server.tool(
    "intervals_get_hr_curves",
    "Get the athlete's aggregate HR curves with up to 3 filter sets (f1/f2/f3).",
    FilteredCurveShape,
    async (input) => {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(input)) {
        if (v !== undefined) qs.set(k, String(v));
      }
      const data = await intervalsFetch(`/athlete/${athlete()}/hr-curves?${qs}`);
      return ok(data);
    },
  );

  server.tool(
    "intervals_get_pace_curves",
    "Get the athlete's aggregate pace curves with up to 3 filter sets (f1/f2/f3).",
    {
      ...FilteredCurveShape,
      includeRanks: z.boolean().optional(),
      gap: z.boolean().optional(),
      pmType: z.string().optional(),
    },
    async (input) => {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(input)) {
        if (v !== undefined) qs.set(k, String(v));
      }
      const data = await intervalsFetch(`/athlete/${athlete()}/pace-curves?${qs}`);
      return ok(data);
    },
  );

  server.tool(
    "intervals_get_power_curves",
    "Get the athlete's aggregate power curves with up to 3 filter sets (f1/f2/f3).",
    {
      ...FilteredCurveShape,
      includeRanks: z.boolean().optional(),
      pmType: z.string().optional(),
    },
    async (input) => {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(input)) {
        if (v !== undefined) qs.set(k, String(v));
      }
      const data = await intervalsFetch(`/athlete/${athlete()}/power-curves?${qs}`);
      return ok(data);
    },
  );

  server.tool(
    "intervals_get_power_hr_curve",
    "Get the athlete's aggregate power-vs-HR curve for a date range.",
    {
      start: z.string().describe("Local ISO-8601 start"),
      end: z.string().describe("Local ISO-8601 end (inclusive)"),
    },
    async ({ start, end }) => {
      const qs = new URLSearchParams({ start, end });
      const data = await intervalsFetch(`/athlete/${athlete()}/power-hr-curve?${qs}`);
      return ok(data);
    },
  );

  server.tool(
    "intervals_get_mmp_model",
    "Get the athlete's mean-maximal-power model fit.",
    { type: z.string().optional() },
    async ({ type }) => {
      const qs = new URLSearchParams();
      if (type !== undefined) qs.set("type", type);
      const suffix = qs.toString() ? `?${qs}` : "";
      const data = await intervalsFetch(`/athlete/${athlete()}/mmp-model${suffix}`,
      );
      return ok(data);
    },
  );

  server.tool(
    "intervals_get_fitness_model_events",
    "Get fitness/fatigue model events for the athlete.",
    {},
    async () => {
      const data = await intervalsFetch(`/athlete/${athlete()}/fitness-model-events`,
      );
      return ok(data);
    },
  );

  // === Tags ===

  server.tool(
    "intervals_list_activity_tags",
    "List all activity tags used by the athlete.",
    {},
    async () => {
      const data = await intervalsFetch(`/athlete/${athlete()}/activity-tags`);
      return ok(data);
    },
  );

  server.tool(
    "intervals_list_event_tags",
    "List all event tags used by the athlete.",
    {},
    async () => {
      const data = await intervalsFetch(`/athlete/${athlete()}/event-tags`);
      return ok(data);
    },
  );

  server.tool(
    "intervals_list_workout_tags",
    "List all workout tags used by the athlete.",
    {},
    async () => {
      const data = await intervalsFetch(`/athlete/${athlete()}/workout-tags`);
      return ok(data);
    },
  );

  // === Weather ===

  server.tool(
    "intervals_get_weather_config",
    "Get the athlete's weather configuration.",
    {},
    async () => {
      const data = await intervalsFetch(`/athlete/${athlete()}/weather-config`);
      return ok(data);
    },
  );

  server.tool(
    "intervals_update_weather_config",
    "Update the athlete's weather configuration.",
    {
      body: z
        .record(z.string(), z.any())
        .describe("See `WeatherConfig` schema in the Intervals.ICU OpenAPI spec"),
    },
    async ({ body }) => {
      const data = await intervalsFetch(`/athlete/${athlete()}/weather-config`, {
        method: "PUT",
        body: JSON.stringify(body),
      });
      return ok(data);
    },
  );

  server.tool(
    "intervals_get_weather_forecast",
    "Get the athlete's localized weather forecast.",
    {},
    async () => {
      const data = await intervalsFetch(`/athlete/${athlete()}/weather-forecast`);
      return ok(data);
    },
  );

  // === Chats ===

  server.tool(
    "intervals_list_chats",
    "List the athlete's chats.",
    {},
    async () => {
      const data = await intervalsFetch(`/athlete/${athlete()}/chats`);
      return ok(data);
    },
  );

  server.tool(
    "intervals_get_chat",
    "Get a single chat by id.",
    { chatId: z.number().int() },
    async ({ chatId }) => {
      const data = await intervalsFetch(`/chats/${enc(chatId)}`);
      return ok(data);
    },
  );

  server.tool(
    "intervals_list_chat_messages",
    "List messages in a chat.",
    {
      chatId: z.number().int(),
      beforeId: z.number().int().optional().describe("Only return messages older than this id"),
      limit: z.number().int().optional().describe("Max messages (default 30, max 100)"),
    },
    async ({ chatId, beforeId, limit }) => {
      const qs = new URLSearchParams();
      if (beforeId !== undefined) qs.set("beforeId", String(beforeId));
      if (limit !== undefined) qs.set("limit", String(limit));
      const suffix = qs.toString() ? `?${qs}` : "";
      const data = await intervalsFetch(`/chats/${enc(chatId)}/messages${suffix}`);
      return ok(data);
    },
  );

  server.tool(
    "intervals_send_chat_message",
    "Send a new chat message (creates or appends to a chat).",
    {
      body: z
        .record(z.string(), z.any())
        .describe("See `NewMessage` schema in the Intervals.ICU OpenAPI spec"),
    },
    async ({ body }) => {
      const data = await intervalsFetch(`/chats/send-message`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      return ok(data);
    },
  );

  server.tool(
    "intervals_update_chat_message",
    "Edit an existing chat message.",
    {
      chatId: z.number().int(),
      msgId: z.number().int(),
      body: z
        .record(z.string(), z.any())
        .describe("See `Message` schema in the Intervals.ICU OpenAPI spec"),
    },
    async ({ chatId, msgId, body }) => {
      const data = await intervalsFetch(`/chats/${enc(chatId)}/messages/${enc(msgId)}`,
        { method: "PUT", body: JSON.stringify(body) },
      );
      return ok(data);
    },
  );

  server.tool(
    "intervals_delete_chat_message",
    "Delete a chat message.",
    {
      chatId: z.number().int(),
      msgId: z.number().int(),
    },
    async ({ chatId, msgId }) => {
      await intervalsFetch(`/chats/${enc(chatId)}/messages/${enc(msgId)}`,
        { method: "DELETE" },
      );
      return ok({ deleted: msgId });
    },
  );

  server.tool(
    "intervals_mark_chat_message_seen",
    "Mark a chat message as seen.",
    {
      chatId: z.number().int(),
      msgId: z.number().int(),
    },
    async ({ chatId, msgId }) => {
      const data = await intervalsFetch(`/chats/${enc(chatId)}/messages/${enc(msgId)}/seen`,
        { method: "PUT" },
      );
      return ok(data);
    },
  );

  // === Misc ===

  server.tool(
    "intervals_list_pace_distances",
    "Get the global default pace-distance buckets.",
    {},
    async () => {
      const data = await intervalsFetch(`/pace_distances`);
      return ok(data);
    },
  );

  server.tool(
    "intervals_get_shared_event",
    "Fetch a shared event by id.",
    { id: z.number().int() },
    async ({ id }) => {
      const data = await intervalsFetch(`/shared-event/${enc(id)}`);
      return ok(data);
    },
  );
}
