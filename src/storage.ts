// Per-user storage in OAUTH_KV.
//
// Identity model:
//   user:<userId>                          → UserRecord (canonical user)
//   identity:<provider>:<providerUserId>   → <userId> (one row per linked provider)
//   cred:<userId>:<provider>               → provider-specific cred blob
//
// userId is a UUID minted on first signup; it's decoupled from any provider's
// id so one human can sign in from multiple providers and resolve to the same
// account. providerUserId is the *stable* identifier returned by that
// provider's identity endpoint (intervals: numeric user id; hevy: account UUID).

export type ProviderName = "intervals" | "hevy" | "strava" | "oura" | "withings";

// === Cred shapes ============================================================

// Intervals.icu uses OAuth 2.0. Their tokens don't expire and they don't
// issue refresh tokens (replaced only when the user re-authorizes), so
// refreshToken is always "" and expiresAt is far in the future — see
// src/intervals.ts INTERVALS_OAUTH for the rationale. apiKey is kept "" for
// shape compatibility with other cred types in renderers.
export interface IntervalsCred {
  apiKey: "";
  providerUserId: string;
  displayName: string;
  tokens: {
    accessToken: string;
    refreshToken: string;
    expiresAt: number; // ms epoch
  };
}

export interface HevyCred {
  apiKey: string;
  providerUserId: string;
  displayName: string;
}

// Strava uses OAuth 2.0 with rotating refresh tokens; the apiKey field stays
// (set to "" / unused) so the cred shape is structurally compatible with the
// other providers for UI rendering. The real auth material lives in tokens.
export interface StravaCred {
  apiKey: "";
  providerUserId: string;
  displayName: string;
  tokens: {
    accessToken: string;
    refreshToken: string;
    expiresAt: number; // ms epoch
  };
}

// Oura: identical OAuth shape as Strava (same fields, same semantics). Oura's
// refresh tokens are single-use — the new refresh token from each refresh call
// replaces the previous one, handled transparently by makeAccessTokenGetter.
export interface OuraCred {
  apiKey: "";
  providerUserId: string;
  displayName: string;
  tokens: {
    accessToken: string;
    refreshToken: string;
    expiresAt: number; // ms epoch
  };
}

// Withings: same OAuth-tokens shape. Withings's quirks (action=requesttoken
// param, status-wrapped responses) are handled in src/withings.ts +
// src/oauth.ts, transparent to storage.
export interface WithingsCred {
  apiKey: "";
  providerUserId: string;
  displayName: string;
  tokens: {
    accessToken: string;
    refreshToken: string;
    expiresAt: number; // ms epoch
  };
}

interface CredTypes {
  intervals: IntervalsCred;
  hevy: HevyCred;
  strava: StravaCred;
  oura: OuraCred;
  withings: WithingsCred;
}

// === User record ============================================================

export interface UserRecord {
  userId: string;
  displayName: string;
  createdAt: number;
}

function userKey(userId: string): string {
  return `user:${userId}`;
}

function identityKey(provider: ProviderName, providerUserId: string): string {
  return `identity:${provider}:${providerUserId}`;
}

function credKey(userId: string, provider: ProviderName): string {
  return `cred:${userId}:${provider}`;
}

export async function createUser(
  kv: KVNamespace,
  displayName: string,
): Promise<UserRecord> {
  const user: UserRecord = {
    userId: crypto.randomUUID(),
    displayName,
    createdAt: Date.now(),
  };
  await kv.put(userKey(user.userId), JSON.stringify(user));
  return user;
}

export async function getUser(
  kv: KVNamespace,
  userId: string,
): Promise<UserRecord | null> {
  const raw = await kv.get(userKey(userId));
  if (!raw) return null;
  return JSON.parse(raw) as UserRecord;
}

// === Identity index =========================================================

export async function lookupIdentity(
  kv: KVNamespace,
  provider: ProviderName,
  providerUserId: string,
): Promise<string | null> {
  return await kv.get(identityKey(provider, providerUserId));
}

export async function setIdentity(
  kv: KVNamespace,
  provider: ProviderName,
  providerUserId: string,
  userId: string,
): Promise<void> {
  await kv.put(identityKey(provider, providerUserId), userId);
}

export async function deleteIdentity(
  kv: KVNamespace,
  provider: ProviderName,
  providerUserId: string,
): Promise<void> {
  await kv.delete(identityKey(provider, providerUserId));
}

// === Credentials ============================================================

export async function getCred<P extends ProviderName>(
  kv: KVNamespace,
  userId: string,
  provider: P,
): Promise<CredTypes[P] | null> {
  const raw = await kv.get(credKey(userId, provider));
  if (!raw) return null;
  return JSON.parse(raw) as CredTypes[P];
}

export async function setCred<P extends ProviderName>(
  kv: KVNamespace,
  userId: string,
  provider: P,
  value: CredTypes[P],
): Promise<void> {
  await kv.put(credKey(userId, provider), JSON.stringify(value));
}

export async function deleteCred(
  kv: KVNamespace,
  userId: string,
  provider: ProviderName,
): Promise<void> {
  await kv.delete(credKey(userId, provider));
}

// === Per-user settings ======================================================
//
// User-tunable preferences that aren't tied to a specific provider cred.
// Stored as a single JSON blob per user so we can add fields without
// schema migrations; readers tolerate missing keys via per-field defaults.

export interface UserSettings {
  // Per-sync gates keyed by "<source>.<dest>" (see src/sync-registry.ts).
  // Each value gates the corresponding webhook write path. Default off:
  // missing keys read as false, so existing users opt in explicitly.
  syncs?: Record<string, boolean>;

  // Opaque per-user secret pasted into Hevy's webhook settings page as
  // the Authorization header value. Hevy POSTs to /webhooks/hevy with
  // this header; the worker reverse-resolves it to a userId. Generated
  // lazily on first /settings view when Hevy is connected; rotation
  // deletes the prior reverse-index row before minting a new one.
  hevyWebhookToken?: string;

  // LEGACY: single Withings → Intervals body-comp gate. Replaced by syncs
  // above. Read paths migrate transparently in getUserSettings; writers
  // never emit this field again. Left in the type so existing KV blobs
  // parse without errors during the migration window.
  withingsSyncEnabled?: boolean;
}

function settingsKey(userId: string): string {
  return `settings:${userId}`;
}

export async function getUserSettings(
  kv: KVNamespace,
  userId: string,
): Promise<UserSettings> {
  const raw = await kv.get(settingsKey(userId));
  if (!raw) return {};
  const parsed = JSON.parse(raw) as UserSettings;
  // Migrate the legacy single-field toggle into the keyed dict so callers
  // only need to read syncs[...]. We don't write back here — the migration
  // becomes persistent on the next setUserSettings call, which is fine
  // because writes only emit `syncs`.
  if (parsed.withingsSyncEnabled !== undefined) {
    const key = "withings.intervals";
    const syncs = parsed.syncs ?? {};
    if (syncs[key] === undefined) syncs[key] = parsed.withingsSyncEnabled;
    parsed.syncs = syncs;
  }
  return parsed;
}

export async function setUserSettings(
  kv: KVNamespace,
  userId: string,
  settings: UserSettings,
): Promise<void> {
  // Strip the legacy field on write so the migration completes for any
  // user whose blob still carries it. Subsequent reads see only `syncs`.
  const { withingsSyncEnabled: _legacy, ...next } = settings;
  await kv.put(settingsKey(userId), JSON.stringify(next));
}

// === Hevy webhook token =====================================================
//
// Hevy lets the user set a webhook URL + Authorization header in their
// account settings, then POSTs `{ workoutId }` on each workout save. We
// mint a per-user opaque token and ask the user to paste it as the auth
// header value; on inbound webhooks we reverse-resolve token → userId.

function hevyWebhookTokenKey(token: string): string {
  return `hevy-webhook:${token}`;
}

export async function lookupUserByHevyWebhookToken(
  kv: KVNamespace,
  token: string,
): Promise<string | null> {
  if (!token) return null;
  return await kv.get(hevyWebhookTokenKey(token));
}

// Mints a fresh token, writes both forward (UserSettings) and reverse
// (hevy-webhook:<token>) records, and removes the old reverse-index row
// if one existed. Idempotent in the sense that calling twice produces
// two separate live tokens unless the caller checks first.
export async function generateHevyWebhookToken(
  kv: KVNamespace,
  userId: string,
): Promise<string> {
  const existing = await getUserSettings(kv, userId);
  if (existing.hevyWebhookToken) {
    await kv.delete(hevyWebhookTokenKey(existing.hevyWebhookToken));
  }
  const token = randomToken();
  await kv.put(hevyWebhookTokenKey(token), userId);
  await setUserSettings(kv, userId, { ...existing, hevyWebhookToken: token });
  return token;
}

// Returns the existing token, creating one on first call. Safe to call
// from the /settings render path — we want the value visible whenever
// the user is on the page with Hevy connected.
export async function getOrCreateHevyWebhookToken(
  kv: KVNamespace,
  userId: string,
): Promise<string> {
  const existing = await getUserSettings(kv, userId);
  if (existing.hevyWebhookToken) return existing.hevyWebhookToken;
  return await generateHevyWebhookToken(kv, userId);
}

// Removes both the reverse-index row and the forward setting. Called on
// Hevy disconnect — the token is meaningless without a Hevy cred to back
// it, and leaving it live would let a leaked token resurrect access if
// the same user later reconnected. Forward record is cleared on the
// caller's next setUserSettings; this helper only handles the index row.
export async function deleteHevyWebhookToken(
  kv: KVNamespace,
  userId: string,
): Promise<void> {
  const existing = await getUserSettings(kv, userId);
  if (existing.hevyWebhookToken) {
    await kv.delete(hevyWebhookTokenKey(existing.hevyWebhookToken));
    const { hevyWebhookToken: _drop, ...next } = existing;
    await setUserSettings(kv, userId, next);
  }
}

// === One-time onboarding tokens =============================================
//
// Used by MCP `connect_<provider>` tools to mint a magic-link URL that
// transparently logs the user into the browser /settings page without asking
// them to re-paste their primary provider's key. Tokens are single-use and
// short-lived to limit the blast radius of a leaked URL.

const ONBOARD_TTL_SECONDS = 10 * 60;

function onboardKey(token: string): string {
  return `onboard:${token}`;
}

function randomToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function createOnboardToken(
  kv: KVNamespace,
  userId: string,
): Promise<string> {
  const token = randomToken();
  await kv.put(onboardKey(token), userId, { expirationTtl: ONBOARD_TTL_SECONDS });
  return token;
}

export async function consumeOnboardToken(
  kv: KVNamespace,
  token: string,
): Promise<string | null> {
  const userId = await kv.get(onboardKey(token));
  if (!userId) return null;
  await kv.delete(onboardKey(token)); // single-use: invalidate immediately
  return userId;
}

// Read-only peek. Used by /onboard to check the token's target userId before
// deciding whether to consume — if the browser already has a session bound to
// a different user, we want to refuse without burning the token, so the
// legitimate recipient can still redeem it within the 10-min TTL.
export async function peekOnboardToken(
  kv: KVNamespace,
  token: string,
): Promise<string | null> {
  return kv.get(onboardKey(token));
}
