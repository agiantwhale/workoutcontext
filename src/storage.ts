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

export interface IntervalsCred {
  apiKey: string;
  providerUserId: string;
  displayName: string;
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
