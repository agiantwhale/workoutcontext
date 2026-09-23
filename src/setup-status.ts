// `setup_status` MCP tool — ground-truth onboarding state for the LLM.
//
// Why this exists. The LLM can see *which* tools are registered, but it
// often conflates "the MCP entry is in my active connector list" with
// "the user has finished onboarding". The two are unrelated: the MCP
// connection just means the user authenticated to this server, while
// usefulness depends on having at least one upstream provider (Intervals,
// Hevy, Strava, Oura, Withings) linked. Without a tool-grounded answer,
// the LLM has been observed to declare "you're fully set up" on a brand-
// new account with zero providers connected.
//
// What this returns. A structured per-provider snapshot: whether the
// provider is enabled on this deployment at all, and whether this user
// has connected their account. The LLM should call this whenever the
// user asks about setup / onboarding / "is this working" — and ground
// its reply in the result rather than guessing from the tool list.
//
// What this does NOT do. It does not initiate a connection. The user-
// facing onboarding path is the `connect_<provider>` shim tools (which
// mint a single-use /onboard link). This endpoint is read-only.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getCred, type ProviderName } from "./storage.js";
import { tokenIsFresh } from "./oauth.js";
import { isProviderEnabled } from "./auth-handler.js";
import { ok } from "./util.js";
import type { Env, Props } from "./index.js";

const PROVIDER_LABELS: Record<ProviderName, string> = {
  intervals: "Intervals.icu",
  hevy: "Hevy",
  strava: "Strava",
  oura: "Oura",
  withings: "Withings",
};

const KNOWN_PROVIDERS: ProviderName[] = [
  "intervals",
  "hevy",
  "strava",
  "oura",
  "withings",
];

type TokenCheck = "valid" | "invalid" | "fresh" | "stale" | "unchecked";

async function probeEndpoint(url: string, headers: Record<string, string>): Promise<TokenCheck> {
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
    if (res.ok) return "valid";
    return res.status === 401 || res.status === 403 ? "invalid" : "unchecked";
  } catch {
    return "unchecked";
  }
}

// Distinguish "credential present" from "credential works" without side
// effects: Intervals tokens never expire and Hevy uses a static API key, so
// both get a cheap live probe. Strava/Oura/Withings tokens rotate (Oura's
// refresh tokens are single-use), so those are judged by expiry only — this
// tool never triggers a refresh.
async function checkCredToken(
  name: ProviderName,
  cred: { apiKey: string; tokens?: { accessToken: string; refreshToken: string; expiresAt: number } } | null,
): Promise<TokenCheck> {
  if (!cred) return "unchecked";
  if (name === "hevy") {
    return probeEndpoint("https://api.hevyapp.com/v1/user/info", { "api-key": cred.apiKey });
  }
  if (name === "intervals" && cred.tokens) {
    return probeEndpoint("https://intervals.icu/api/v1/athlete/0", {
      Authorization: `Bearer ${cred.tokens.accessToken}`,
      Accept: "application/json",
    });
  }
  if (cred.tokens) return tokenIsFresh(cred.tokens) ? "fresh" : "stale";
  return "unchecked";
}

export function registerSetupStatusTool(
  server: McpServer,
  env: Env,
  props: Props,
): void {
  server.tool(
    "setup_status",
    [
      "Returns this user's onboarding state: which providers (Intervals.icu, Hevy, Strava, Oura, Withings) are enabled on this deployment, and which the user has actually connected.",
      "",
      "WHEN TO CALL:",
      "- The user asks about setup, onboarding, \"is this working\", \"what's connected\", \"help me get started\", \"can you help me set this up\", or similar.",
      "- Before suggesting next steps for a brand-new or confused-seeming user.",
      "- Before claiming the user is \"fully set up\" — never assert that from tool-list inference alone.",
      "",
      "GROUND YOUR REPLY IN THE RESULT. The presence of this server in the user's MCP connector list does NOT mean they are set up — it only means they authenticated to this server. Real usefulness requires at least one connected provider. Use `ready_to_use` and `needs_connection` from the response to give the user an accurate picture.",
      "",
      "NEXT STEPS. For each entry in `needs_connection`, call the corresponding `connect_<name>` tool to obtain a single-use onboarding link. Hand the link to the user; they paste their API key on the website, then reconnect the MCP session.",
      "",
      "Returns a JSON object with: `mcp_authenticated` (always true if this tool is reachable), `providers` (per-provider details), `ready_to_use` (provider names whose tools are live this session), `needs_connection` (provider names with a `connect_<name>` shim available), and `unavailable_on_this_deployment` (providers the operator has disabled — do not suggest these).",
      "",
      "Each provider entry carries `token_check`: `valid` (live probe succeeded — Intervals.icu and Hevy only), `invalid` (live probe got 401/403 — the stored credential is dead, send the user to reconnect), `fresh` (OAuth token unexpired but not probed live), `stale` (OAuth token expired and will refresh on the next provider call — Oura refresh tokens are single-use, so this tool never triggers a refresh itself), or `unchecked` (no credential, provider disabled, or the probe errored). `connected` means a credential is stored; `token_check` tells you whether it works. Never claim the user is set up when every connected provider reports `invalid`.",
    ].join("\n"),
    {},
    async () => {
      const userId = props.userId;
      const providers = await Promise.all(
        KNOWN_PROVIDERS.map(async (name) => {
          const enabled = isProviderEnabled(env, name);
          const cred = enabled
            ? await getCred(env.OAUTH_KV, userId, name)
            : null;
          return {
            name,
            label: PROVIDER_LABELS[name],
            enabled_on_deployment: enabled,
            connected: Boolean(cred),
            token_check: await checkCredToken(name, cred),
          };
        }),
      );

      const ready_to_use = providers
        .filter((p) => p.enabled_on_deployment && p.connected)
        .map((p) => p.name);
      const needs_connection = providers
        .filter((p) => p.enabled_on_deployment && !p.connected)
        .map((p) => p.name);
      const unavailable_on_this_deployment = providers
        .filter((p) => !p.enabled_on_deployment)
        .map((p) => p.name);

      return ok({
        mcp_authenticated: true,
        providers,
        ready_to_use,
        needs_connection,
        unavailable_on_this_deployment,
      });
    },
  );
}
