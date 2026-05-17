// Browser-side session cookies for the /settings page.
//
// Distinct from the OAuth grant tokens used by MCP clients — those persist
// per-MCP-connection and never reach a browser. This is just so a user who
// logs in via /login (or completes the /authorize POST) can keep using
// /settings without re-pasting their API key on every page load.

const COOKIE_NAME = "session";
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

export interface Session {
  userId: string;
  displayName: string;
  expiresAt: number;
}

function key(sessionId: string): string {
  return `session:${sessionId}`;
}

function randomSessionId(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function createSession(
  kv: KVNamespace,
  userId: string,
  displayName: string,
): Promise<string> {
  const id = randomSessionId();
  const session: Session = {
    userId,
    displayName,
    expiresAt: Date.now() + SESSION_TTL_SECONDS * 1000,
  };
  await kv.put(key(id), JSON.stringify(session), {
    expirationTtl: SESSION_TTL_SECONDS,
  });
  return id;
}

export async function readSession(
  kv: KVNamespace,
  request: Request,
): Promise<Session | null> {
  const id = parseSessionCookie(request);
  if (!id) return null;
  const raw = await kv.get(key(id));
  if (!raw) return null;
  const session = JSON.parse(raw) as Session;
  if (session.expiresAt < Date.now()) {
    await kv.delete(key(id));
    return null;
  }
  return session;
}

export async function destroySession(
  kv: KVNamespace,
  request: Request,
): Promise<void> {
  const id = parseSessionCookie(request);
  if (id) await kv.delete(key(id));
}

export function sessionCookieHeader(sessionId: string): string {
  return [
    `${COOKIE_NAME}=${sessionId}`,
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    "Path=/",
    `Max-Age=${SESSION_TTL_SECONDS}`,
  ].join("; ");
}

export function clearCookieHeader(): string {
  return [`${COOKIE_NAME}=`, "HttpOnly", "Secure", "SameSite=Lax", "Path=/", "Max-Age=0"].join("; ");
}

function parseSessionCookie(request: Request): string | null {
  const cookie = request.headers.get("cookie");
  if (!cookie) return null;
  for (const part of cookie.split(/;\s*/)) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq) === COOKIE_NAME) return part.slice(eq + 1);
  }
  return null;
}
