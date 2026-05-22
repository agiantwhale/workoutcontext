import { OAuthProvider, type OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AuthHandler } from "./auth-handler.js";
import { registerIntervalsTools, INTERVALS_OAUTH } from "./intervals.js";
import { registerHevyTools } from "./hevy.js";
import { registerStravaTools, STRAVA_OAUTH } from "./strava.js";
import { registerOuraTools, OURA_OAUTH } from "./oura.js";
import { registerWithingsTools, WITHINGS_OAUTH } from "./withings.js";
import { createOnboardToken, getCred, setCred, type ProviderName } from "./storage.js";
import { makeAccessTokenGetter, type OAuthProviderConfig } from "./oauth.js";
import { isProviderEnabled } from "./auth-handler.js";
import { registerDebugTraceTool } from "./debug-trace.js";
import { registerServerVersionTool } from "./server-version.js";
import { GIT_COMMIT_SHORT } from "./generated/commit.js";

export type Props = {
  userId: string;
  displayName: string;
};

export interface Env {
  INVITE_CODE: string;
  PUBLIC_URL: string;
  // userId (UUID) whose session unlocks /admin. If unset, /admin is 404 for
  // everyone. Find your userId by signing in and checking /settings — it's
  // the short hex shown next to your display name.
  ADMIN_USER_ID: string;
  // Intervals.icu OAuth app credentials. When unset, Intervals is hidden
  // from the UI and /intervals/callback returns 503.
  INTERVALS_CLIENT_ID: string;
  INTERVALS_CLIENT_SECRET: string;
  // Shared secret echoed back as the `Authorization` header on every
  // intervals.icu webhook POST. Configured in intervals.icu → Settings →
  // Manage App (per OAuth app, NOT per user). When unset, /webhooks/intervals
  // returns 503 and no events are accepted. Generate a random value and
  // paste the SAME value into both intervals.icu's Manage App page and the
  // Cloudflare secret store (one each for staging + prod).
  INTERVALS_WEBHOOK_TOKEN: string;
  // Strava OAuth app credentials. When unset, Strava is hidden from the UI
  // and /strava/callback returns 503 — Strava simply isn't available on that
  // environment. Add via `wrangler secret put STRAVA_CLIENT_ID --env <env>`.
  STRAVA_CLIENT_ID: string;
  STRAVA_CLIENT_SECRET: string;
  // Oura OAuth app credentials. Same env-gated visibility pattern as Strava.
  OURA_CLIENT_ID: string;
  OURA_CLIENT_SECRET: string;
  // Withings OAuth app credentials. Same env-gated visibility pattern.
  WITHINGS_CLIENT_ID: string;
  WITHINGS_CLIENT_SECRET: string;
  // IANA TZ name used to bucket Withings measurements into daily wellness
  // rows when the /measure response itself doesn't carry a `timezone` field.
  // Optional — falls back to "America/New_York" inside withings-sync.ts.
  WITHINGS_DEFAULT_TZ: string;
  // Per-provider on/off toggles. Override the in-code defaults defined in
  // PROVIDER_DEFAULT_ENABLED (auth-handler.ts). Set to "1"/"true" to enable,
  // "0"/"false" to disable. Unset → use code default. Toggles control UI
  // visibility, auth-handler refusals, and MCP tool registration uniformly.
  INTERVALS_ENABLED: string;
  HEVY_ENABLED: string;
  STRAVA_ENABLED: string;
  OURA_ENABLED: string;
  WITHINGS_ENABLED: string;
  // Dev-only escape hatch. When truthy ("1" / "true"), the intervals + hevy
  // validators accept sentinel keys (DEV_INTERVALS_<id>, DEV_HEVY_<id>) without
  // contacting the upstream API, so you can stage multi-account scenarios
  // locally. NEVER set this in production — it lets anyone create accounts
  // with arbitrary provider identities.
  DEV_ALLOW_FAKE_KEYS: string;
  // GitHub Issues integration for the `debug_trace` MCP tool. Both optional —
  // when either is unset, the tool returns a clear "not configured" message
  // instead of throwing. GITHUB_ISSUE_REPO is "<owner>/<repo>" (e.g.
  // "agiantwhale/workoutcontext-feedback"). GITHUB_ISSUE_TOKEN is a
  // fine-grained PAT scoped to that repo with `Issues: write` only.
  GITHUB_ISSUE_TOKEN: string;
  GITHUB_ISSUE_REPO: string;
  OAUTH_KV: KVNamespace;
  MCP_OBJECT: DurableObjectNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
}

interface ProviderRegistration {
  name: ProviderName;
  label: string;
  register: (server: McpServer, getKey: () => Promise<string>) => void;
}

// API-key providers only — intervals migrated to OAuth, wired via
// registerOAuthProvider below alongside Strava/Oura/Withings.
const PROVIDERS: ProviderRegistration[] = [
  { name: "hevy", label: "Hevy", register: registerHevyTools },
];

// Session-level instructions surfaced to the LLM client during the MCP
// initialization handshake. Clients that respect them (Claude.ai, Claude
// Desktop) treat the string as additional context — comparable to a per-
// session system prompt. Use sparingly: only put things here that every
// session should know, regardless of which providers the user has connected
// or which tools end up registered. Right now this is just a nudge to use
// debug_trace proactively when the user is stuck — without it the LLM tends
// to reserve the tool for explicit user requests.
const SERVER_INSTRUCTIONS = [
  "This server provides AI-driven recovery analysis for athletes by connecting their Intervals.icu, Hevy, Strava, Oura, and Withings accounts. Tools are registered per-user based on which providers they've connected.",
  "",
  "Strength workflow: when the user is designing, planning, or executing a strength workout, treat Hevy as the canonical system. Consult hevy_get_exercise_history before prescribing working weights — don't guess. When materializing a session, default to creating a Hevy routine via hevy_create_routine; pair it with an intervals_create_event for the schedule and training-load tracking. Don't offer one without the other for strength.",
  "",
  "Feedback loop: when a session isn't going well — the user is frustrated, retried the same task multiple times without success, or you're about to tell them you can't help — proactively offer to file a debug_trace report. Phrase it as something that helps everyone (\"would you like me to file a debug trace so the maintainer can improve this?\"), not as an apology. It is rate-limited to one per user per 5 minutes, so use the slot deliberately. If the tool returns status \"not_configured\", do not mention it to the user — the operator hasn't set up the integration on this environment.",
  "",
  "Drift triage when filing debug_trace: always populate `mcpToolBaseline` (the build hash baked into the `check_server_version` tool's description — read it straight out of that description, no tool call needed) and, if a WorkoutContext skill is loaded in this session, `skillVersion` (the short SHA from the SKILL.md footer line that starts with \"Built from\"). The server compares both against its own current build and tags drift in the report. Without these, the maintainer can't tell whether a bug is a real bug or a stale-cache artifact.",
].join("\n");

export class WorkoutContextMCP extends McpAgent<Env, unknown, Props> {
  server = new McpServer(
    { name: "workoutcontext.fit", version: "0.1.0" },
    { instructions: SERVER_INSTRUCTIONS },
  );
  // Per-instance promise locks for OAuth refresh: dedupe concurrent token
  // refreshes within a single Durable Object so we don't burn a refresh token
  // by racing two parallel /oauth/token calls. Worth knowing: this only
  // protects against in-DO races, not cross-DO ones — but the McpAgent DO is
  // pinned per user, so all of one user's tool calls hit the same instance.
  // Oura's refresh tokens are single-use, so this lock is especially load-bearing
  // there: racing two refreshes would invalidate one of them permanently.
  // Intervals.icu tokens never expire and have no refresh_token grant, so
  // its lock is never exercised — but registerOAuthProvider expects one, so
  // it's defined here for symmetry.
  private intervalsRefreshLock = { pending: null as Promise<import("./oauth.js").OAuthTokens> | null };
  private stravaRefreshLock = { pending: null as Promise<import("./oauth.js").OAuthTokens> | null };
  private ouraRefreshLock = { pending: null as Promise<import("./oauth.js").OAuthTokens> | null };
  private withingsRefreshLock = { pending: null as Promise<import("./oauth.js").OAuthTokens> | null };

  // Tool-list staleness detection. The DO persists the build hash that
  // served the most recent tools/list response in this user's session
  // (`lastServedBuild` in DurableObjectStorage). When the worker is
  // redeployed and the DO is rehydrated on new code, init() runs against
  // the new build but the client may still be working from a tool list
  // it cached against the old build. The next time we observe a hash
  // mismatch, we fire `notifications/tools/list_changed` after the
  // transport is connected (deferred from init() to onStart since
  // McpAgent.onStart() awaits init() before connecting the transport,
  // and sending a notification before that point is a no-op).
  private _toolListChangedPending = false;

  async init() {
    const props = this.props;
    if (!props?.userId) return; // no valid grant, nothing to register
    const userId = props.userId;

    // Global tool — registered for every authenticated session regardless of
    // which providers are connected. Lets the LLM file structured feedback
    // when the user is dissatisfied with a tool's result.
    registerDebugTraceTool(this.server, this.env, props);

    // Global tool — diagnostic that returns the server's build hash. The
    // hash is baked into the tool's description string at registration
    // time so the LLM can compare against the live hash returned by the
    // call and detect mid-session schema drift. See src/server-version.ts.
    registerServerVersionTool(this.server);

    // Look up which providers this user has actually connected, then register
    // the real tools for connected ones and a single connect_<provider> shim
    // for the rest. Keeps the LLM's tool list focused on what it can actually
    // call — and gives the user a discoverable path to connect more.
    const creds = await Promise.all(
      PROVIDERS.map((p) => getCred(this.env.OAUTH_KV, userId, p.name).then((c) => [p, c] as const)),
    );

    for (const [provider, cred] of creds) {
      if (!isProviderEnabled(this.env, provider.name)) continue; // toggle off → don't surface tools at all
      if (cred) {
        provider.register(this.server, this.makeApiKeyGetter(provider.name, provider.label));
      } else {
        this.registerConnectShim(provider);
      }
    }

    // OAuth providers: only active on environments where the corresponding
    // app credentials are configured. Each gets its own per-instance refresh
    // promise lock so concurrent tool calls can't race the /oauth/token endpoint.
    await this.registerOAuthProvider(
      userId,
      "intervals",
      "Intervals.icu",
      INTERVALS_OAUTH,
      this.env.INTERVALS_CLIENT_ID,
      this.env.INTERVALS_CLIENT_SECRET,
      this.intervalsRefreshLock,
      (getAccessToken) => registerIntervalsTools(this.server, getAccessToken),
    );

    await this.registerOAuthProvider(
      userId,
      "strava",
      "Strava",
      STRAVA_OAUTH,
      this.env.STRAVA_CLIENT_ID,
      this.env.STRAVA_CLIENT_SECRET,
      this.stravaRefreshLock,
      (getAccessToken, providerUserId) =>
        registerStravaTools(this.server, getAccessToken, async () => Number(providerUserId)),
    );

    await this.registerOAuthProvider(
      userId,
      "oura",
      "Oura",
      OURA_OAUTH,
      this.env.OURA_CLIENT_ID,
      this.env.OURA_CLIENT_SECRET,
      this.ouraRefreshLock,
      (getAccessToken) => registerOuraTools(this.server, getAccessToken),
    );

    await this.registerOAuthProvider(
      userId,
      "withings",
      "Withings",
      WITHINGS_OAUTH,
      this.env.WITHINGS_CLIENT_ID,
      this.env.WITHINGS_CLIENT_SECRET,
      this.withingsRefreshLock,
      (getAccessToken) => registerWithingsTools(this.server, getAccessToken),
    );

    // Tool-list build-drift detection. Compare the current build to whatever
    // served this user's last DO start. A mismatch means the worker was
    // redeployed since this user last had a fresh handshake — the cached
    // tool list on the client side may be stale. We flag here and let
    // onStart() send the actual notifications/tools/list_changed once the
    // transport is connected (sendToolListChanged at this point is a no-op).
    const lastServedBuild = (await this.ctx.storage.get("lastServedBuild")) as
      | string
      | undefined;
    if (lastServedBuild && lastServedBuild !== GIT_COMMIT_SHORT) {
      this._toolListChangedPending = true;
    }
    await this.ctx.storage.put("lastServedBuild", GIT_COMMIT_SHORT);
  }

  // McpAgent.onStart() awaits init() then calls server.connect(transport).
  // We override to fire the deferred tools/list_changed notification *after*
  // super.onStart() returns, so the transport is up and the notification
  // actually reaches the client. Best-effort: failures here are logged but
  // never thrown — a missed notification just leaves the client on its
  // existing tool list until it refreshes for some other reason.
  async onStart(...args: Parameters<typeof McpAgent.prototype.onStart>) {
    await super.onStart(...args);
    if (this._toolListChangedPending) {
      this._toolListChangedPending = false;
      try {
        this.server.sendToolListChanged();
      } catch (e) {
        console.error("[tools/list_changed] notification failed:", e);
      }
    }
  }

  /** Common OAuth provider wiring: env-gated visibility + cred lookup + token getter + tools or connect-shim. */
  private async registerOAuthProvider(
    userId: string,
    name: ProviderName,
    label: string,
    config: OAuthProviderConfig,
    clientId: string,
    clientSecret: string,
    lock: { pending: Promise<import("./oauth.js").OAuthTokens> | null },
    onConnected: (getAccessToken: () => Promise<string>, providerUserId: string) => void,
  ) {
    if (!isProviderEnabled(this.env, name)) return; // toggle off
    if (!clientId || !clientSecret) return; // creds missing
    const cred = await getCred(this.env.OAUTH_KV, userId, name);
    if (cred && "tokens" in cred) {
      const getAccessToken = makeAccessTokenGetter(
        config,
        clientId,
        clientSecret,
        async () => {
          const c = await getCred(this.env.OAUTH_KV, userId, name);
          return c && "tokens" in c ? c.tokens : null;
        },
        async (tokens) => {
          const c = await getCred(this.env.OAUTH_KV, userId, name);
          if (!c || !("tokens" in c)) return;
          await setCred(this.env.OAUTH_KV, userId, name, { ...c, tokens });
        },
        lock,
      );
      onConnected(getAccessToken, cred.providerUserId);
    } else {
      this.registerConnectShim({ name, label, register: () => {} });
    }
  }

  private makeApiKeyGetter(provider: ProviderName, label: string): () => Promise<string> {
    return async () => {
      const userId = this.props?.userId;
      if (!userId) throw new Error("No user on this session — re-authenticate.");
      const cred = await getCred(this.env.OAUTH_KV, userId, provider);
      if (!cred) {
        throw new Error(
          `${label} was disconnected mid-session. Reconnect at ${this.env.PUBLIC_URL}/settings, then reconnect this MCP session.`,
        );
      }
      return cred.apiKey;
    };
  }

  private registerConnectShim(provider: ProviderRegistration) {
    this.server.tool(
      `connect_${provider.name}`,
      `Connect ${provider.label} to this account so the corresponding tools become available. Returns a single-use browser link — the API key is pasted on the website, never through this chat. After connecting, reconnect this MCP session to see the new ${provider.label} tools.`,
      {},
      async () => {
        const userId = this.props?.userId;
        if (!userId) throw new Error("No user on this session — re-authenticate.");
        const token = await createOnboardToken(this.env.OAUTH_KV, userId);
        // PUBLIC_URL falls back to localhost for `wrangler dev` without .dev.vars.
        // Deploy MUST set this via `wrangler secret put PUBLIC_URL` — otherwise
        // the LLM will hand the user a localhost URL that points at their machine.
        const base = (this.env.PUBLIC_URL || "http://localhost:8787").replace(/\/$/, "");
        const url = `${base}/onboard?token=${token}`;
        return {
          content: [
            {
              type: "text",
              text:
                `To connect ${provider.label}:\n\n` +
                `1. Open this single-use link in a browser (valid for 10 minutes):\n   ${url}\n\n` +
                `2. You'll be auto-signed-in to /settings. Paste your ${provider.label} API key in the ${provider.label} section and click Connect.\n` +
                `3. Reconnect this MCP session — the ${provider.label} tools will appear in the tool list.`,
            },
          ],
        };
      },
    );
  }
}

const innerMcpHandler = WorkoutContextMCP.serve("/mcp");

// agents/mcp emits "Content-Type: text/event-stream" with no charset. The wire
// format is UTF-8, but RFC-2616-era HTTP clients (e.g. Python's `requests`)
// default text/* without a charset to ISO-8859-1, which mojibakes multi-byte
// chars into single bytes — and the third byte of '★' (\xe2\x98\x85) becomes
// \x85 (NEL), which str.splitlines() treats as a line break and shreds JSON
// mid-payload. Inject the explicit charset so this can't happen.
const mcpHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const res = await innerMcpHandler.fetch(request, env, ctx);
    if (res.headers.get("content-type") === "text/event-stream") {
      const headers = new Headers(res.headers);
      headers.set("content-type", "text/event-stream; charset=utf-8");
      return new Response(res.body, {
        status: res.status,
        statusText: res.statusText,
        headers,
      });
    }
    return res;
  },
};

const oauthProvider = new OAuthProvider({
  apiRoute: "/mcp",
  apiHandler: mcpHandler as any,
  defaultHandler: AuthHandler as any,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
});

export default {
  fetch: oauthProvider.fetch.bind(oauthProvider),
};
