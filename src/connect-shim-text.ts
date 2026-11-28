// Text for the connect_<provider> shim tool shown when a provider is not
// connected. Pure (no imports) so it is unit-testable under node --test.
// The per-provider description comes from PROVIDER_UIS in
// src/auth-handler.ts — the same copy the settings page shows — looked up
// by provider name at the call site.

export type ConnectAuthType = "apikey" | "oauth";

/**
 * Tool description for connect_<provider>. Leads with what connecting
 * unlocks (the settings-page description), then how to finish connecting.
 * The auth-type clause matters: only Hevy takes a pasted API key — the
 * OAuth providers sign in at the provider instead.
 */
export function connectShimDescription(
  label: string,
  description: string,
  authType: ConnectAuthType,
): string {
  const how =
    authType === "apikey"
      ? `paste your ${label} API key on the website, never through this chat`
      : `sign in at ${label} on the website to authorize`;
  return (
    `Connect ${label} to this account — ${description} ` +
    `Returns a single-use browser link; ${how}. ` +
    `After connecting, reconnect this MCP session to see the new ${label} tools.`
  );
}

/**
 * Step-by-step result text returned when connect_<provider> is called.
 * Step 2 branches on auth type: OAuth providers connect via a button +
 * provider sign-in, API-key providers via a pasted key (with keyLocation
 * naming where to find it, when known).
 */
export function connectShimSteps(
  label: string,
  authType: ConnectAuthType,
  url: string,
  keyLocation?: string,
): string {
  const step2 =
    authType === "apikey"
      ? `You'll be auto-signed-in to /settings. Paste your ${label} API key in the ${label} section and click Connect.` +
        (keyLocation ? `\n   Find the key at ${keyLocation}.` : "")
      : `You'll be auto-signed-in to /settings. Click Connect next to ${label} and sign in at ${label} to authorize.`;
  return (
    `To connect ${label}:\n\n` +
    `1. Open this single-use link in a browser (valid for 10 minutes):\n   ${url}\n\n` +
    `2. ${step2}\n` +
    `3. Reconnect this MCP session — the ${label} tools will appear in the tool list.`
  );
}
