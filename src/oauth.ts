// Reusable OAuth 2.0 client for upstream providers that issue access +
// refresh tokens (Strava, Withings, etc.). The MCP server's *own* OAuth
// provider — the one that issues bearer tokens to MCP clients — is the
// `@cloudflare/workers-oauth-provider` package; this module is a separate
// concern: outbound OAuth to external services.
//
// Per-provider config defines the endpoints, scopes, and identity probe.
// The shared OAuth flow: buildAuthorizeUrl → user consents → callback hands
// us a code → exchangeCode for tokens → fetchIdentity using access token →
// store cred. Refresh-on-demand happens at fetch time (see callers).

export interface OAuthTokens {
  accessToken: string;
  refreshToken: string;
  // ms epoch when accessToken expires; a small lead time (REFRESH_LEAD_MS)
  // is baked in so we never serve a token within seconds of expiry
  expiresAt: number;
}

export interface OAuthIdentity {
  providerUserId: string;
  displayName: string;
}

export interface OAuthProviderConfig {
  /** Display label, e.g. "Strava" */
  label: string;
  /** Authorization endpoint (where the user gets redirected to consent) */
  authorizeUrl: string;
  /** Token exchange / refresh endpoint */
  tokenUrl: string;
  /** Space- or comma-separated scopes string requested at authorize time */
  scopes: string;
  /** Scope separator the provider expects in the URL (Strava=","; Withings=" ") */
  scopeSeparator: string;
  /**
   * Parse a token-endpoint response into normalized {accessToken, refreshToken, expiresAt}.
   * Providers differ on whether expiry is `expires_at` (unix seconds) or `expires_in` (seconds-from-now).
   */
  parseTokenResponse: (body: unknown) => OAuthTokens;
  /**
   * Optional: parse identity directly from the token response if the provider
   * returns the user (Strava does — `athlete.id`, `athlete.firstname` etc).
   * If unset, the caller must follow up with fetchIdentity().
   */
  identityFromTokenResponse?: (body: unknown) => OAuthIdentity | null;
  /**
   * Fetch the upstream identity using a fresh access token. Required when
   * identityFromTokenResponse isn't enough (e.g., refresh responses don't
   * carry identity).
   */
  fetchIdentity: (accessToken: string) => Promise<OAuthIdentity>;
}

const REFRESH_LEAD_MS = 60_000; // serve a fresh token if within 60s of expiry

export function buildAuthorizeUrl(
  provider: OAuthProviderConfig,
  clientId: string,
  redirectUri: string,
  state: string,
): string {
  const url = new URL(provider.authorizeUrl);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("approval_prompt", "auto");
  // Use the provider's preferred separator instead of letting URLSearchParams
  // encode each comma — Strava actually requires comma-separated scopes.
  url.searchParams.set("scope", provider.scopes.split(/[,\s]+/).join(provider.scopeSeparator));
  url.searchParams.set("state", state);
  return url.toString();
}

export async function exchangeCode(
  provider: OAuthProviderConfig,
  clientId: string,
  clientSecret: string,
  code: string,
): Promise<{ tokens: OAuthTokens; identity: OAuthIdentity | null }> {
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code,
    grant_type: "authorization_code",
  });
  const json = await tokenRequest(provider, body);
  return {
    tokens: provider.parseTokenResponse(json),
    identity: provider.identityFromTokenResponse?.(json) ?? null,
  };
}

export async function refreshTokens(
  provider: OAuthProviderConfig,
  clientId: string,
  clientSecret: string,
  refreshToken: string,
): Promise<OAuthTokens> {
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });
  return provider.parseTokenResponse(await tokenRequest(provider, body));
}

async function tokenRequest(provider: OAuthProviderConfig, body: URLSearchParams): Promise<unknown> {
  const res = await fetch(provider.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${provider.label} token request failed: ${res.status} ${text}`);
  }
  return JSON.parse(text);
}

/** Returns whether the current access token is fresh enough to use as-is. */
export function tokenIsFresh(tokens: OAuthTokens): boolean {
  return Date.now() + REFRESH_LEAD_MS < tokens.expiresAt;
}

/**
 * Build a token-fetch closure suitable for use inside per-DO tool registrations.
 * Caller provides load/save functions for the cred (so the closure stays
 * decoupled from KV layout) and a per-instance lock map to dedupe concurrent
 * refreshes within the same Durable Object.
 */
export function makeAccessTokenGetter(
  provider: OAuthProviderConfig,
  clientId: string,
  clientSecret: string,
  load: () => Promise<OAuthTokens | null>,
  save: (tokens: OAuthTokens) => Promise<void>,
  lock: { pending: Promise<OAuthTokens> | null },
): () => Promise<string> {
  return async () => {
    const tokens = await load();
    if (!tokens) {
      throw new Error(`${provider.label} is not connected for this user. Reconnect via /settings.`);
    }
    if (tokenIsFresh(tokens)) return tokens.accessToken;

    if (!lock.pending) {
      lock.pending = (async () => {
        try {
          const refreshed = await refreshTokens(provider, clientId, clientSecret, tokens.refreshToken);
          // Some providers (Strava) don't always echo the refresh_token on a
          // refresh call — fall back to the existing one so we don't lose it.
          if (!refreshed.refreshToken) refreshed.refreshToken = tokens.refreshToken;
          await save(refreshed);
          return refreshed;
        } finally {
          lock.pending = null;
        }
      })();
    }
    return (await lock.pending).accessToken;
  };
}
