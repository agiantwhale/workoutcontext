import type { AuthRequest } from "@cloudflare/workers-oauth-provider";
import type { Env, Props } from "./index.js";
import {
  type ProviderName,
  type UserRecord,
  consumeOnboardToken,
  createUser,
  deleteCred,
  getCred,
  getUser,
  lookupIdentity,
  setCred,
  setIdentity,
} from "./storage.js";
import {
  clearCookieHeader,
  createSession,
  destroySession,
  readSession,
  sessionCookieHeader,
  type Session,
} from "./session.js";

const INTERVALS_VALIDATE_URL = "https://intervals.icu/api/v1/athlete/0";
const HEVY_VALIDATE_URL = "https://api.hevyapp.com/v1/user/info";

export const AuthHandler = {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return new Response("workoutcontext.fit ok", {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      });
    }

    if (url.pathname === "/" && request.method === "GET") {
      return handleWelcomeGet(request, env);
    }

    if (url.pathname === "/privacy" && request.method === "GET") {
      return renderPrivacyPage();
    }

    if (url.pathname === "/tos" && request.method === "GET") {
      return renderTosPage();
    }

    // --- OAuth flow for MCP clients ---
    if (url.pathname === "/authorize" && request.method === "GET") {
      return handleAuthorizeGet(request, env);
    }
    const authPostMatch = /^\/authorize\/(intervals|hevy)$/.exec(url.pathname);
    if (authPostMatch && request.method === "POST") {
      return handleAuthorizePost(request, env, authPostMatch[1] as ProviderName);
    }

    // --- Browser login (no OAuth, just session cookie) ---
    if (url.pathname === "/login" && request.method === "GET") {
      return renderLoginPage(env, null, null);
    }
    const loginPostMatch = /^\/login\/(intervals|hevy)$/.exec(url.pathname);
    if (loginPostMatch && request.method === "POST") {
      return handleLoginPost(request, env, loginPostMatch[1] as ProviderName);
    }

    if (url.pathname === "/logout" && request.method === "POST") {
      return handleLogoutPost(request, env);
    }

    // --- Magic-link onboarding (used by MCP connect_<provider> tools) ---
    if (url.pathname === "/onboard" && request.method === "GET") {
      return handleOnboardGet(request, env);
    }

    // --- Settings ---
    if (url.pathname === "/settings" && request.method === "GET") {
      return handleSettingsGet(request, env);
    }
    const disconnectMatch = /^\/settings\/(intervals|hevy)\/disconnect$/.exec(url.pathname);
    if (disconnectMatch && request.method === "POST") {
      return handleSettingsDisconnect(request, env, disconnectMatch[1] as ProviderName);
    }
    const settingsPostMatch = /^\/settings\/(intervals|hevy)$/.exec(url.pathname);
    if (settingsPostMatch && request.method === "POST") {
      return handleSettingsPost(request, env, settingsPostMatch[1] as ProviderName);
    }
    if (url.pathname === "/settings/account/delete" && request.method === "POST") {
      return handleAccountDeleteConfirm(request, env);
    }
    if (url.pathname === "/settings/account/delete/confirm" && request.method === "POST") {
      return handleAccountDeleteExecute(request, env);
    }

    // --- Admin (gated by ADMIN_USER_ID; 404s for everyone else to hide existence) ---
    if (url.pathname === "/admin" && request.method === "GET") {
      return handleAdminGet(request, env);
    }
    if (url.pathname === "/admin/lookup" && request.method === "GET") {
      return handleAdminLookup(request, env);
    }
    const adminUserMatch = /^\/admin\/users\/([^/]+)$/.exec(url.pathname);
    if (adminUserMatch && request.method === "GET") {
      return handleAdminUserGet(request, env, adminUserMatch[1]);
    }
    const adminRevokeMatch = /^\/admin\/users\/([^/]+)\/revoke-grants$/.exec(url.pathname);
    if (adminRevokeMatch && request.method === "POST") {
      return handleAdminRevokeGrants(request, env, adminRevokeMatch[1]);
    }
    const adminDeleteMatch = /^\/admin\/users\/([^/]+)\/delete$/.exec(url.pathname);
    if (adminDeleteMatch && request.method === "POST") {
      return handleAdminDeleteConfirm(request, env, adminDeleteMatch[1]);
    }
    const adminDeleteExecMatch = /^\/admin\/users\/([^/]+)\/delete\/confirm$/.exec(url.pathname);
    if (adminDeleteExecMatch && request.method === "POST") {
      return handleAdminDeleteExecute(request, env, adminDeleteExecMatch[1]);
    }

    return new Response("Not found", { status: 404 });
  },
};

// === Welcome / landing ======================================================

async function handleWelcomeGet(request: Request, env: Env): Promise<Response> {
  const session = await readSession(env.OAUTH_KV, request);
  const mcpUrl = `${new URL(request.url).origin}/mcp`;
  return renderWelcomePage(session, mcpUrl);
}

function renderWelcomePage(session: Session | null, mcpUrl: string): Response {
  const providerList = PROVIDER_UIS.map(
    (ui) =>
      `<li><strong>${escape(ui.label)}</strong> — ${escape(ui.description)} <span class="muted">${escape(ui.helpText)} Get a key at <a href="${escape(ui.helpUrl)}" target="_blank" rel="noopener noreferrer">${escape(ui.keyLocation)}</a>.</span></li>`,
  ).join("\n");

  const ctaBlock = session
    ? `<div class="cta">
         <p>Signed in as <strong>${escape(session.displayName)}</strong>.</p>
         <div class="actions">
           <a class="button" href="/settings">Manage connections</a>
           <form method="POST" action="/logout" style="margin:0"><button type="submit" class="secondary">Sign out</button></form>
         </div>
       </div>`
    : `<div class="cta">
         <p>Have an account? Sign in →</p>
         <div class="actions"><a class="button" href="/login">Sign in</a></div>
       </div>`;

  const body = `
    <h1>workoutcontext.fit</h1>
    <p class="lede">Turn your AI assistant into a coach that actually knows you. Connect your training data once, and Claude, ChatGPT, or Gemini can answer with your real numbers — not generic advice.</p>

    <h2>Getting started</h2>
    <p>Add this URL to your AI client as a connector — that's the whole setup. On first use your client opens a browser tab where you paste a provider API key, and you're in.</p>
    <pre>${escape(mcpUrl)}</pre>
    <p class="muted">Use this URL in Claude.ai's "Add custom connector" or as the <code>mcp-remote</code> target in Claude Desktop / ChatGPT / Gemini config.</p>

    <h2>Supported providers</h2>
    <ul class="providers">
      ${providerList}
    </ul>

    ${ctaBlock}

    <p class="fineprint">We store only what's strictly necessary for the service to work — nothing more. You can delete your account and all stored data at any time from <a href="/settings">/settings</a>. <a href="/privacy">Privacy</a> · <a href="/tos">Terms</a> · <a href="https://github.com/agiantwhale/workoutcontext" target="_blank" rel="noopener noreferrer">Source</a>.</p>
  `;
  return htmlResponse("workoutcontext.fit", body, 200);
}

// === /privacy ===============================================================

function renderPrivacyPage(): Response {
  const body = `
    <header class="topbar">
      <div></div>
      <a href="/">Home</a>
    </header>
    <h1>Privacy</h1>
    <p class="lede">We try to store as little as possible. Here's exactly what we do — and don't — store.</p>

    <h2>What we store</h2>
    <p>When you sign up:</p>
    <ul>
      <li>A random UUID as your internal user id</li>
      <li>The display name returned by your provider's API (e.g. your intervals.icu athlete name)</li>
      <li>The timestamp of your signup</li>
    </ul>
    <p>When you connect a provider:</p>
    <ul>
      <li>The API key you pasted</li>
      <li>The provider-side user id (so we can detect re-linking)</li>
      <li>The display name returned by that provider</li>
    </ul>
    <p>When you sign in to <a href="/settings">/settings</a>:</p>
    <ul>
      <li>A random session token, valid for 7 days, scoped to your user id</li>
    </ul>
    <p>When you call <code>connect_&lt;provider&gt;</code> from your AI client:</p>
    <ul>
      <li>A single-use magic-link token, valid for 10 minutes, deleted immediately on first use</li>
    </ul>
    <p class="muted">All of the above lives in Cloudflare KV, encrypted at rest by the platform.</p>

    <h2>What we don't store</h2>
    <ul>
      <li>Any workout, activity, wellness, or other content from intervals.icu or Hevy — we fetch it live on every tool call and never persist it</li>
      <li>LLM conversations, messages, or tool-call history</li>
      <li>Your IP address (Cloudflare may log it at the network layer for abuse prevention, but our worker code does not access or persist it)</li>
      <li>Anything else not listed in the section above</li>
    </ul>

    <h2>Operator access</h2>
    <p>The service operator (the single account configured as admin) can see the data listed in "What we store" — your display name, which providers you've connected, when you signed up, and the count of active OAuth grants. They cannot read your provider API keys in plaintext from any UI. They can revoke your OAuth grants (forcing re-auth) or delete your account on your behalf. All admin actions hit the same KV that you can wipe yourself at any time via <a href="/settings">/settings</a>.</p>

    <h2>Third parties</h2>
    <ul>
      <li><strong>Cloudflare Workers + KV</strong> — runs the service and stores the data listed above</li>
      <li><strong>Intervals.icu</strong> — receives API calls with your key when you use intervals tools</li>
      <li><strong>Hevy</strong> — receives API calls with your key when you use hevy tools</li>
      <li><strong>Google Fonts</strong> — serves the Roboto Mono webfont; each page view fetches the stylesheet</li>
    </ul>

    <h2>Deleting your account</h2>
    <p>You can delete your account and everything tied to it at any time from <a href="/settings">/settings</a> → Danger zone. Deletion is immediate and permanent: all credentials, identity links, session cookies, magic-link tokens, OAuth grants issued to your AI clients, and your user record are removed. Your data on the upstream providers themselves (intervals.icu, Hevy) is untouched.</p>

    <h2>Audit the code</h2>
    <p>This service is open source. If you want to verify exactly what's stored and how, read the source:</p>
    <pre><a href="https://github.com/agiantwhale/workoutcontext" target="_blank" rel="noopener noreferrer">https://github.com/agiantwhale/workoutcontext</a></pre>
  `;
  return htmlResponse("Privacy", body, 200);
}

// === /tos ===================================================================

function renderTosPage(): Response {
  const body = `
    <header class="topbar">
      <div></div>
      <a href="/">Home</a>
    </header>
    <h1>Terms of Service</h1>
    <p class="lede">Last updated: 2026-05-17. By using workoutcontext.fit you agree to the terms below.</p>

    <h2>The service</h2>
    <p>workoutcontext.fit is a hosted MCP server that lets you connect your training data from third-party providers (intervals.icu, Hevy, Oura, etc.) to AI assistants you already use. The service is free, open source, and operated as a personal / community project.</p>

    <h2>Your responsibilities</h2>
    <ul>
      <li>You're responsible for keeping your provider API keys secure. If a key leaks or is revoked, that's between you and the upstream provider.</li>
      <li>You must comply with each upstream provider's terms of service (intervals.icu, Hevy, Oura, etc.). This service is a bridge — using it doesn't override your obligations to those providers.</li>
      <li>Don't abuse the service: no automated scraping, no attempts to interfere with other users' data, no using the service to violate anyone's privacy or rights.</li>
      <li>You're responsible for any content or decisions you make using the service, including any AI-generated workout plans, training recommendations, or analysis. The service is not a substitute for medical or coaching advice.</li>
    </ul>

    <h2>Data handling</h2>
    <p>See <a href="/privacy">/privacy</a> for what's stored and what isn't. You can delete your account and all stored data at any time from <a href="/settings">/settings</a>.</p>

    <h2>No warranty</h2>
    <p>The service is provided "as is" and "as available" without any warranty of any kind, express or implied. We make no guarantees about uptime, accuracy, fitness for any particular purpose, or that the service will continue to be available.</p>

    <h2>Limitation of liability</h2>
    <p>To the maximum extent permitted by law, the operators of workoutcontext.fit are not liable for any direct, indirect, incidental, consequential, or special damages arising from your use of (or inability to use) the service. Your sole remedy if you're unhappy with the service is to stop using it and delete your account.</p>

    <h2>Termination</h2>
    <p>You can stop using the service at any time by deleting your account from <a href="/settings">/settings</a>. We may also modify, suspend, or shut down the service at any time, with or without notice — though we'll try to give reasonable warning when we can.</p>

    <h2>Changes to these terms</h2>
    <p>These terms may change. The current version always lives at this URL. Continued use of the service after changes constitutes acceptance of the new terms.</p>

    <h2>Governing law</h2>
    <p>These terms are governed by the laws of the State of New York, USA, without regard to its conflict-of-law provisions. Any disputes arising from these terms or your use of the service will be resolved exclusively in the state or federal courts located in New York County, New York.</p>
  `;
  return htmlResponse("Terms of Service", body, 200);
}

// === OAuth /authorize (MCP client flow) =====================================

async function handleAuthorizeGet(request: Request, env: Env): Promise<Response> {
  const oauthReqInfo = await env.OAUTH_PROVIDER.parseAuthRequest(request);
  if (!oauthReqInfo.clientId) {
    return new Response("Invalid OAuth request", { status: 400 });
  }
  return renderAuthorizePage(env, encodeState(oauthReqInfo), null, null);
}

async function handleAuthorizePost(
  request: Request,
  env: Env,
  provider: ProviderName,
): Promise<Response> {
  if (!isFormPost(request)) return new Response("Expected form POST", { status: 415 });

  const form = await request.formData();
  const stateRaw = String(form.get("state") ?? "");
  const apiKey = String(form.get("api_key") ?? "").trim();
  const inviteCode = String(form.get("invite_code") ?? "").trim();

  let oauthReqInfo: AuthRequest;
  try {
    oauthReqInfo = decodeState(stateRaw);
  } catch {
    return new Response("Invalid state", { status: 400 });
  }

  if (env.INVITE_CODE && inviteCode !== env.INVITE_CODE) {
    return renderAuthorizePage(env, stateRaw, provider, "Invalid invite code.");
  }
  if (!apiKey) {
    return renderAuthorizePage(env, stateRaw, provider, "API key is required.");
  }

  const result = await loginViaProvider(request, env, provider, apiKey);
  if (!result.ok) {
    return renderAuthorizePage(env, stateRaw, provider, result.error);
  }

  const props: Props = { userId: result.userId, displayName: result.displayName };
  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request: oauthReqInfo,
    userId: result.userId,
    metadata: { label: result.displayName },
    scope: oauthReqInfo.scope,
    props,
  });

  const sessionId = await createSession(env.OAUTH_KV, result.userId, result.displayName);
  return redirectWithCookie(redirectTo, sessionCookieHeader(sessionId));
}

// === Browser /login flow ====================================================

async function handleLoginPost(
  request: Request,
  env: Env,
  provider: ProviderName,
): Promise<Response> {
  if (!isFormPost(request)) return new Response("Expected form POST", { status: 415 });

  const form = await request.formData();
  const apiKey = String(form.get("api_key") ?? "").trim();
  const inviteCode = String(form.get("invite_code") ?? "").trim();

  if (env.INVITE_CODE && inviteCode !== env.INVITE_CODE) {
    return renderLoginPage(env, provider, "Invalid invite code.");
  }
  if (!apiKey) {
    return renderLoginPage(env, provider, "API key is required.");
  }

  const result = await loginViaProvider(request, env, provider, apiKey);
  if (!result.ok) {
    return renderLoginPage(env, provider, result.error);
  }

  const sessionId = await createSession(env.OAUTH_KV, result.userId, result.displayName);
  return redirectWithCookie("/settings", sessionCookieHeader(sessionId));
}

async function handleLogoutPost(request: Request, env: Env): Promise<Response> {
  await destroySession(env.OAUTH_KV, request);
  return redirectWithCookie("/login", clearCookieHeader());
}

// === Magic-link onboarding ==================================================

async function handleOnboardGet(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const token = url.searchParams.get("token") ?? "";
  if (!token) return new Response("Missing token", { status: 400 });

  const userId = await consumeOnboardToken(env.OAUTH_KV, token);
  if (!userId) {
    return htmlResponse(
      "Onboarding link expired",
      `<h1>Onboarding link expired</h1>
       <p>This link has already been used or has expired (links are valid for 10 minutes and single-use). Generate a new one by calling the connect tool from your MCP client again, or sign in directly at <a href="/login">/login</a>.</p>`,
      400,
    );
  }

  const user = await getUser(env.OAUTH_KV, userId);
  if (!user) return new Response("User not found", { status: 404 });

  const sessionId = await createSession(env.OAUTH_KV, user.userId, user.displayName);
  return redirectWithCookie("/settings", sessionCookieHeader(sessionId));
}

// === /settings ==============================================================

async function handleSettingsGet(request: Request, env: Env): Promise<Response> {
  const session = await readSession(env.OAUTH_KV, request);
  if (!session) return Response.redirect(new URL("/login", request.url).toString(), 302);
  return renderSettingsPage(env, session, null, null);
}

async function handleSettingsPost(
  request: Request,
  env: Env,
  provider: ProviderName,
): Promise<Response> {
  const session = await readSession(env.OAUTH_KV, request);
  if (!session) return Response.redirect(new URL("/login", request.url).toString(), 302);
  if (!isFormPost(request)) return new Response("Expected form POST", { status: 415 });

  const form = await request.formData();
  const apiKey = String(form.get("api_key") ?? "").trim();
  if (!apiKey) {
    return renderSettingsPage(env, session, provider, "API key is required.");
  }

  // loginViaProvider runs the find/create/link logic against the existing
  // session — refusing if the key belongs to a different account, linking
  // it to the current user otherwise.
  const result = await loginViaProvider(request, env, provider, apiKey);
  if (!result.ok) {
    return renderSettingsPage(env, session, provider, result.error);
  }
  return Response.redirect(new URL("/settings", request.url).toString(), 302);
}

async function handleSettingsDisconnect(
  request: Request,
  env: Env,
  provider: ProviderName,
): Promise<Response> {
  const session = await readSession(env.OAUTH_KV, request);
  if (!session) return Response.redirect(new URL("/login", request.url).toString(), 302);

  // Refuse if this is the user's only connection — an account with zero
  // providers is a dead-end. Force them to connect another first or delete
  // the account entirely.
  const allCreds = await Promise.all(
    PROVIDER_UIS.map((p) => getCred(env.OAUTH_KV, session.userId, p.name)),
  );
  const connectedCount = allCreds.filter(Boolean).length;
  const targetExists = allCreds[PROVIDER_UIS.findIndex((p) => p.name === provider)];
  if (targetExists && connectedCount <= 1) {
    return renderSettingsPage(
      env,
      session,
      provider,
      "Can't disconnect your only connected provider. Connect another provider first, or delete the account entirely from the Danger zone.",
    );
  }

  // Note: we leave the identity index entry in place so re-adding the same
  // provider account later links back to this user. Only the cred is removed.
  await deleteCred(env.OAUTH_KV, session.userId, provider);
  return Response.redirect(new URL("/settings", request.url).toString(), 302);
}

// === Account deletion =======================================================

async function handleAccountDeleteConfirm(request: Request, env: Env): Promise<Response> {
  const session = await readSession(env.OAUTH_KV, request);
  if (!session) return Response.redirect(new URL("/login", request.url).toString(), 302);
  return renderAccountDeletePage(session);
}

async function handleAccountDeleteExecute(request: Request, env: Env): Promise<Response> {
  const session = await readSession(env.OAUTH_KV, request);
  if (!session) return Response.redirect(new URL("/login", request.url).toString(), 302);

  // 1. Revoke every OAuth grant for this user — invalidates active MCP-client
  //    bearer tokens so future tool calls force a fresh /authorize round-trip.
  let grantCursor: string | undefined;
  do {
    const result = await env.OAUTH_PROVIDER.listUserGrants(session.userId, { cursor: grantCursor });
    for (const grant of result.items) {
      await env.OAUTH_PROVIDER.revokeGrant(grant.id, session.userId);
    }
    grantCursor = result.cursor;
  } while (grantCursor);

  // 2. Delete cred rows for every known provider.
  for (const ui of PROVIDER_UIS) {
    await deleteCred(env.OAUTH_KV, session.userId, ui.name);
  }

  // 3. Scan the identity index for entries pointing to this userId and delete
  //    them so the same provider account can sign up fresh later if desired.
  let identCursor: string | undefined;
  do {
    const result = await env.OAUTH_KV.list({ prefix: "identity:", cursor: identCursor });
    for (const k of result.keys) {
      const v = await env.OAUTH_KV.get(k.name);
      if (v === session.userId) await env.OAUTH_KV.delete(k.name);
    }
    identCursor = result.list_complete ? undefined : result.cursor;
  } while (identCursor);

  // 4. Delete user record + session, clear cookie.
  await env.OAUTH_KV.delete(`user:${session.userId}`);
  await destroySession(env.OAUTH_KV, request);
  return redirectWithCookie("/", clearCookieHeader());
}

// === /admin =================================================================

async function requireAdmin(request: Request, env: Env): Promise<Session | null> {
  if (!env.ADMIN_USER_ID) return null;
  const session = await readSession(env.OAUTH_KV, request);
  if (!session) return null;
  if (session.userId !== env.ADMIN_USER_ID) return null;
  return session;
}

// Hide admin existence — return 404 instead of 401/403 so unauthenticated
// scanners can't tell whether there's an admin surface here at all.
function adminNotFound(): Response {
  return new Response("Not found", { status: 404 });
}

const ADMIN_PAGE_SIZE = 20;

async function handleAdminGet(request: Request, env: Env): Promise<Response> {
  const session = await requireAdmin(request, env);
  if (!session) return adminNotFound();

  const url = new URL(request.url);
  const cursor = url.searchParams.get("cursor") ?? undefined;

  // List up to ADMIN_PAGE_SIZE user keys; bounded CPU since we parse at most
  // 20 JSON blobs per request regardless of total user count.
  const result = await env.OAUTH_KV.list({ prefix: "user:", limit: ADMIN_PAGE_SIZE, cursor });
  const users = (
    await Promise.all(
      result.keys.map(async (k) => {
        const raw = await env.OAUTH_KV.get(k.name);
        return raw ? (JSON.parse(raw) as UserRecord) : null;
      }),
    )
  ).filter((u): u is UserRecord => u !== null);
  // Newest first
  users.sort((a, b) => b.createdAt - a.createdAt);

  const nextCursor = result.list_complete ? null : result.cursor ?? null;
  return renderAdminPage(session, users, cursor ?? null, nextCursor);
}

async function handleAdminLookup(request: Request, env: Env): Promise<Response> {
  const session = await requireAdmin(request, env);
  if (!session) return adminNotFound();
  const id = (new URL(request.url).searchParams.get("userId") ?? "").trim();
  if (!id) return Response.redirect(new URL("/admin", request.url).toString(), 302);
  return Response.redirect(new URL(`/admin/users/${encodeURIComponent(id)}`, request.url).toString(), 302);
}

async function handleAdminUserGet(
  request: Request,
  env: Env,
  userId: string,
): Promise<Response> {
  const session = await requireAdmin(request, env);
  if (!session) return adminNotFound();
  const user = await getUser(env.OAUTH_KV, userId);
  if (!user) {
    return htmlResponse(
      "User not found",
      `<header class="topbar"><div></div><a href="/admin">Back</a></header>
       <h1>User not found</h1>
       <p>No user record exists for <code>${escape(userId)}</code>.</p>`,
      404,
    );
  }

  const creds = await Promise.all(
    PROVIDER_UIS.map(async (ui) => ({
      ui,
      cred: await getCred(env.OAUTH_KV, userId, ui.name),
    })),
  );

  // Count active OAuth grants (don't render each — just the count, since
  // grants don't carry useful metadata for admin debugging).
  let grantCount = 0;
  let grantCursor: string | undefined;
  do {
    const result = await env.OAUTH_PROVIDER.listUserGrants(userId, { cursor: grantCursor });
    grantCount += result.items.length;
    grantCursor = result.cursor;
  } while (grantCursor);

  return renderAdminUserPage(session, user, creds, grantCount);
}

async function handleAdminRevokeGrants(
  request: Request,
  env: Env,
  userId: string,
): Promise<Response> {
  const session = await requireAdmin(request, env);
  if (!session) return adminNotFound();
  let cursor: string | undefined;
  do {
    const result = await env.OAUTH_PROVIDER.listUserGrants(userId, { cursor });
    for (const grant of result.items) {
      await env.OAUTH_PROVIDER.revokeGrant(grant.id, userId);
    }
    cursor = result.cursor;
  } while (cursor);
  return Response.redirect(
    new URL(`/admin/users/${encodeURIComponent(userId)}`, request.url).toString(),
    302,
  );
}

async function handleAdminDeleteConfirm(
  request: Request,
  env: Env,
  userId: string,
): Promise<Response> {
  const session = await requireAdmin(request, env);
  if (!session) return adminNotFound();
  const user = await getUser(env.OAUTH_KV, userId);
  if (!user) return adminNotFound();
  return renderAdminDeleteConfirmPage(user);
}

async function handleAdminDeleteExecute(
  request: Request,
  env: Env,
  userId: string,
): Promise<Response> {
  const session = await requireAdmin(request, env);
  if (!session) return adminNotFound();

  // Same wipe sequence as user-initiated account delete.
  let grantCursor: string | undefined;
  do {
    const result = await env.OAUTH_PROVIDER.listUserGrants(userId, { cursor: grantCursor });
    for (const grant of result.items) {
      await env.OAUTH_PROVIDER.revokeGrant(grant.id, userId);
    }
    grantCursor = result.cursor;
  } while (grantCursor);

  for (const ui of PROVIDER_UIS) {
    await deleteCred(env.OAUTH_KV, userId, ui.name);
  }

  let identCursor: string | undefined;
  do {
    const result = await env.OAUTH_KV.list({ prefix: "identity:", cursor: identCursor });
    for (const k of result.keys) {
      const v = await env.OAUTH_KV.get(k.name);
      if (v === userId) await env.OAUTH_KV.delete(k.name);
    }
    identCursor = result.list_complete ? undefined : result.cursor;
  } while (identCursor);

  await env.OAUTH_KV.delete(`user:${userId}`);
  return Response.redirect(new URL("/admin", request.url).toString(), 302);
}

// === Find-or-create-or-link =================================================

type LoginResult =
  | { ok: true; userId: string; displayName: string; linked: boolean }
  | { ok: false; error: string };

async function loginViaProvider(
  request: Request,
  env: Env,
  provider: ProviderName,
  apiKey: string,
): Promise<LoginResult> {
  const identity = await VALIDATORS[provider](env, apiKey);
  if (!identity) {
    return {
      ok: false,
      error: `${PROVIDER_UIS.find((p) => p.name === provider)!.label} rejected that key. Double-check the value and try again.`,
    };
  }

  const existingUserId = await lookupIdentity(env.OAUTH_KV, provider, identity.providerUserId);
  const currentSession = await readSession(env.OAUTH_KV, request);
  let userId: string;
  let displayName: string;
  let linked = false;

  if (existingUserId) {
    if (currentSession && currentSession.userId !== existingUserId) {
      // The pasted key belongs to a different account. Refuse to silently
      // move the identity — the user should sign out of the current account
      // first to avoid losing access to it.
      return {
        ok: false,
        error: `This ${PROVIDER_UIS.find((p) => p.name === provider)!.label} account is already linked to a different user. Sign out of your current session first, then sign in with this account.`,
      };
    }
    userId = existingUserId;
    displayName = currentSession?.displayName ?? identity.displayName;
  } else if (currentSession) {
    // User is signed in via another provider. Link this new identity to them.
    userId = currentSession.userId;
    displayName = currentSession.displayName;
    await setIdentity(env.OAUTH_KV, provider, identity.providerUserId, userId);
    linked = true;
  } else {
    // Brand-new signup.
    const user = await createUser(env.OAUTH_KV, identity.displayName);
    userId = user.userId;
    displayName = user.displayName;
    await setIdentity(env.OAUTH_KV, provider, identity.providerUserId, userId);
  }

  await setCred(env.OAUTH_KV, userId, provider, {
    apiKey,
    providerUserId: identity.providerUserId,
    displayName: identity.displayName,
  });

  return { ok: true, userId, displayName, linked };
}

// === Validators =============================================================

interface ProviderIdentity {
  providerUserId: string;
  displayName: string;
}

function fakeKeyEnabled(env: Env): boolean {
  const v = env.DEV_ALLOW_FAKE_KEYS;
  return v === "1" || v === "true";
}

function parseSentinel(prefix: string, apiKey: string): ProviderIdentity | null {
  if (!apiKey.startsWith(prefix)) return null;
  const id = apiKey.slice(prefix.length);
  if (!id) return null;
  return { providerUserId: id, displayName: `Test ${prefix.replace(/^DEV_|_$/g, "")} user ${id}` };
}

async function validateIntervalsKey(env: Env, apiKey: string): Promise<ProviderIdentity | null> {
  if (fakeKeyEnabled(env)) {
    const fake = parseSentinel("DEV_INTERVALS_", apiKey);
    if (fake) return fake;
  }
  const basic = btoa(`API_KEY:${apiKey}`);
  const res = await fetch(INTERVALS_VALIDATE_URL, {
    headers: { Authorization: `Basic ${basic}`, Accept: "application/json" },
  });
  if (!res.ok) return null;
  const body = (await res.json()) as { id?: string | number; name?: string };
  if (body.id === undefined) return null;
  return {
    providerUserId: String(body.id),
    displayName: body.name ?? `athlete ${body.id}`,
  };
}

async function validateHevyKey(env: Env, apiKey: string): Promise<ProviderIdentity | null> {
  if (fakeKeyEnabled(env)) {
    const fake = parseSentinel("DEV_HEVY_", apiKey);
    if (fake) return fake;
  }
  const res = await fetch(HEVY_VALIDATE_URL, {
    headers: { "api-key": apiKey, Accept: "application/json" },
  });
  if (!res.ok) return null;
  const body = (await res.json()) as { data?: { id?: string; name?: string } };
  const data = body.data;
  if (!data?.id) return null;
  return {
    providerUserId: data.id,
    displayName: data.name ?? `Hevy user ${data.id.slice(0, 8)}`,
  };
}

const VALIDATORS: Record<ProviderName, (env: Env, key: string) => Promise<ProviderIdentity | null>> = {
  intervals: validateIntervalsKey,
  hevy: validateHevyKey,
};

// === Provider UI metadata ===================================================

interface ProviderUI {
  name: ProviderName;
  label: string;
  description: string;
  helpUrl: string;
  helpText: string;
  keyLocation: string;
}

const PROVIDER_UIS: ProviderUI[] = [
  {
    name: "intervals",
    label: "Intervals.icu",
    description: "Training calendar, activities, wellness, and structured workouts.",
    helpUrl: "https://intervals.icu/settings",
    helpText: "Free for all intervals.icu accounts.",
    keyLocation: "intervals.icu → Settings → API → Generate",
  },
  {
    name: "hevy",
    label: "Hevy",
    description: "Strength workouts and routines.",
    helpUrl: "https://hevy.com/settings?developer",
    helpText: "Requires a Hevy Pro subscription.",
    keyLocation: "hevy.com → Settings → Developer",
  },
];

// === HTML rendering =========================================================

function renderAuthorizePage(
  env: Env,
  state: string,
  errorProvider: ProviderName | null,
  errorMessage: string | null,
): Response {
  const intro = `
    <h1>Connect your account</h1>
    <p>An MCP client is requesting access to this server. Sign in with the provider you want as your primary identity — you can link more providers later from <a href="/settings">/settings</a>.</p>
  `;
  return htmlResponse(
    "Connect",
    intro + renderProviderForms(env, "/authorize", state, errorProvider, errorMessage),
    errorMessage ? 400 : 200,
  );
}

function renderLoginPage(
  env: Env,
  errorProvider: ProviderName | null,
  errorMessage: string | null,
): Response {
  const intro = `
    <header class="topbar">
      <div></div>
      <a href="/">Home</a>
    </header>
    <h1>Sign in</h1>
    <p>Sign in with any connected provider to manage your account.</p>
  `;
  return htmlResponse(
    "Sign in",
    intro + renderProviderForms(env, "/login", null, errorProvider, errorMessage),
    errorMessage ? 400 : 200,
  );
}

function renderProviderForms(
  env: Env,
  prefix: string,
  state: string | null,
  errorProvider: ProviderName | null,
  errorMessage: string | null,
): string {
  const showInvite = Boolean(env.INVITE_CODE);
  return PROVIDER_UIS.map((ui) => {
    const localError = errorProvider === ui.name ? errorMessage : null;
    return `
      <section class="provider">
        <h2>${escape(ui.label)}</h2>
        <p>${escape(ui.description)} <span class="muted">${escape(ui.helpText)}</span></p>
        ${localError ? `<div class="error">${escape(localError)}</div>` : ""}
        <form method="POST" action="${escape(prefix)}/${escape(ui.name)}" autocomplete="off">
          ${state !== null ? `<input type="hidden" name="state" value="${escape(state)}" />` : ""}
          <label>${escape(ui.label)} API key
            <input type="password" name="api_key" required
                   autocapitalize="off" autocorrect="off" spellcheck="false" />
          </label>
          ${
            showInvite
              ? `<label>Invite code
                  <input type="text" name="invite_code" required
                         autocapitalize="off" autocorrect="off" spellcheck="false" />
                </label>`
              : ""
          }
          <div class="actions">
            <button type="submit">Sign in with ${escape(ui.label)}</button>
            <div class="help-stack">
              <a href="${escape(ui.helpUrl)}" target="_blank" rel="noopener noreferrer" class="help">Get a key here</a>
              <span class="key-path">${escape(ui.keyLocation)}</span>
            </div>
          </div>
        </form>
      </section>`;
  }).join("\n");
}

async function renderSettingsPage(
  env: Env,
  session: Session,
  errorProvider: ProviderName | null,
  errorMessage: string | null,
): Promise<Response> {
  // Fetch all creds + validations in one parallel pass so we can also compute
  // the connected count up-front (used to decide whether disconnect buttons
  // should render — see "at least one provider must remain" rule).
  const credsAndValidation = await Promise.all(
    PROVIDER_UIS.map(async (ui) => {
      const existing = await getCred(env.OAUTH_KV, session.userId, ui.name);
      const validated = existing
        ? await VALIDATORS[ui.name](env, existing.apiKey).catch(() => null)
        : null;
      return { ui, existing, validated };
    }),
  );
  const connectedCount = credsAndValidation.filter((c) => c.existing).length;

  const sections = credsAndValidation.map(({ ui, existing, validated }) => {
    const isStale = Boolean(existing && !validated);
    const localError = errorProvider === ui.name ? errorMessage : null;
    const isLastConnection = Boolean(existing && connectedCount <= 1);

    const statusBadge = !existing
        ? '<span class="status">not connected</span>'
        : isStale
          ? '<span class="status stale">key rejected</span>'
          : '<span class="status connected">connected</span>';
      const header = `
          <h2>${escape(ui.label)} ${statusBadge}</h2>
          <p>${escape(ui.description)} <span class="muted">${escape(ui.helpText)}</span></p>`;
      const errorBlock = localError ? `<div class="error">${escape(localError)}</div>` : "";

      if (existing && !isStale) {
        return `
        <section class="provider">
          ${header}
          <p class="current">Connected as <strong>${escape(existing.displayName)}</strong> <span class="muted">(${escape(existing.providerUserId)})</span> · key <code>${escape(mask(existing.apiKey))}</code></p>
          ${errorBlock}
          ${
            isLastConnection
              ? `<p class="muted">This is your only connected provider. Connect another to enable disconnect, or delete the account from the Danger zone below.</p>`
              : `<form method="POST" action="/settings/${escape(ui.name)}/disconnect">
            <div class="actions">
              <button type="submit" class="secondary">Disconnect ${escape(ui.label)}</button>
              <span class="help muted">To rotate the key, disconnect first, then reconnect.</span>
            </div>
          </form>`
          }
        </section>`;
      }

      const staleBanner = isStale && existing
        ? `<div class="warning">${escape(ui.label)} rejected the stored key just now (it may have been regenerated or revoked). Paste a new key below to reconnect — previously linked as <strong>${escape(existing.displayName)}</strong> (${escape(existing.providerUserId)}).</div>`
        : "";

      const staleDisconnect = isStale && !isLastConnection
        ? `<button type="submit" formaction="/settings/${escape(ui.name)}/disconnect" formnovalidate class="secondary">Remove stored key</button>`
        : "";

      return `
        <section class="provider">
          ${header}
          ${staleBanner}
          ${errorBlock}
          <form method="POST" action="/settings/${escape(ui.name)}" autocomplete="off">
            <label>${escape(ui.label)} API key
              <input type="password" name="api_key" required
                     autocapitalize="off" autocorrect="off" spellcheck="false"
                     placeholder="Paste your key" />
            </label>
            <div class="actions">
              <button type="submit">${escape(isStale ? "Reconnect" : "Connect")} ${escape(ui.label)}</button>
              ${staleDisconnect}
              <div class="help-stack">
                <a href="${escape(ui.helpUrl)}" target="_blank" rel="noopener noreferrer" class="help">Get a key here</a>
                <span class="key-path">${escape(ui.keyLocation)}</span>
              </div>
            </div>
          </form>
        </section>`;
  });

  const body = `
    <header class="topbar">
      <div>Signed in as <strong>${escape(session.displayName)}</strong> <span class="muted">(${escape(session.userId.slice(0, 8))}…)</span></div>
      <div class="topbar-actions">
        <a href="/">Home</a>
        <form method="POST" action="/logout" style="margin:0"><button type="submit" class="secondary">Sign out</button></form>
      </div>
    </header>
    <h1>Connected providers</h1>
    <p>Paste a provider's API key below to connect or update it. Any provider's key will be linked to this account.</p>
    ${sections.join("\n")}

    <section class="danger-zone">
      <h2>Danger zone</h2>
      <p>Permanently delete this account: revokes all MCP client sessions, removes every stored credential and provider link, and clears your user record. Re-signing in with the same provider key afterward creates a fresh account.</p>
      <form method="POST" action="/settings/account/delete">
        <div class="actions">
          <button type="submit" class="danger">Delete account…</button>
        </div>
      </form>
    </section>
  `;
  return htmlResponse("Settings", body, 200);
}

function renderAccountDeletePage(session: Session): Response {
  const body = `
    <header class="topbar">
      <div>Signed in as <strong>${escape(session.displayName)}</strong> <span class="muted">(${escape(session.userId.slice(0, 8))}…)</span></div>
      <a href="/settings">Back to settings</a>
    </header>
    <h1>Delete account</h1>
    <div class="warning">
      <p><strong>This cannot be undone.</strong> The following will happen immediately:</p>
      <ul>
        <li>Every OAuth grant for this account will be revoked — any AI client connected to this server will start failing with auth errors until you reconnect with a fresh account.</li>
        <li>All stored provider credentials (Intervals.icu, Hevy, etc.) will be deleted.</li>
        <li>All provider-identity links pointing to this account will be removed, so the same provider keys can be used to create a brand-new account afterward.</li>
        <li>Your user record and current session will be deleted.</li>
      </ul>
      <p class="muted">Your data on the upstream providers themselves (intervals.icu, Hevy, etc.) is not touched — this only removes the keys you pasted here.</p>
    </div>
    <form method="POST" action="/settings/account/delete/confirm">
      <div class="actions">
        <button type="submit" class="danger">Yes, delete this account</button>
        <a href="/settings" class="help">Cancel</a>
      </div>
    </form>
  `;
  return htmlResponse("Delete account", body, 200);
}

function renderAdminPage(
  session: Session,
  users: UserRecord[],
  prevCursor: string | null,
  nextCursor: string | null,
): Response {
  const rows = users
    .map(
      (u) => `
        <tr>
          <td><a href="/admin/users/${escape(u.userId)}"><code>${escape(u.userId.slice(0, 8))}…</code></a></td>
          <td>${escape(u.displayName)}</td>
          <td class="muted">${escape(formatDate(u.createdAt))}</td>
        </tr>`,
    )
    .join("");

  const pager = nextCursor
    ? `<p><a href="/admin?cursor=${encodeURIComponent(nextCursor)}">Next page →</a></p>`
    : prevCursor
      ? `<p class="muted">End of list. <a href="/admin">Back to first page</a>.</p>`
      : `<p class="muted">End of list (${users.length} user${users.length === 1 ? "" : "s"} total).</p>`;

  const body = `
    <header class="topbar">
      <div>Admin · signed in as <strong>${escape(session.displayName)}</strong></div>
      <div class="topbar-actions">
        <a href="/">Home</a>
        <form method="POST" action="/logout" style="margin:0"><button type="submit" class="secondary">Sign out</button></form>
      </div>
    </header>

    <h1>Admin</h1>
    <p class="lede">User lookup, session revocation, and account deletion. Use carefully.</p>

    <h2>Lookup user by id</h2>
    <form method="GET" action="/admin/lookup" autocomplete="off">
      <label>userId (full UUID)
        <input type="text" name="userId" required placeholder="e.g. abc12345-..." />
      </label>
      <div class="actions">
        <button type="submit">Open</button>
      </div>
    </form>

    <h2>${prevCursor ? "Users (continued)" : "Recent users"}</h2>
    ${
      users.length === 0
        ? `<p class="muted">No users on this page.</p>`
        : `<table class="admin-table">
            <thead><tr><th>userId</th><th>display name</th><th>signed up</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>`
    }
    ${pager}
  `;
  return htmlResponse("Admin", body, 200);
}

function renderAdminUserPage(
  session: Session,
  user: UserRecord,
  creds: Array<{ ui: ProviderUI; cred: { apiKey: string; providerUserId: string; displayName: string } | null }>,
  grantCount: number,
): Response {
  const credRows = creds
    .map(({ ui, cred }) => {
      const status = cred
        ? `<span class="status connected">connected</span>`
        : `<span class="status">not connected</span>`;
      const detail = cred
        ? `<span class="muted">${escape(cred.displayName)} (${escape(cred.providerUserId)}) · key <code>${escape(mask(cred.apiKey))}</code></span>`
        : "";
      return `<li><strong>${escape(ui.label)}</strong> ${status} ${detail}</li>`;
    })
    .join("");

  const body = `
    <header class="topbar">
      <div>Admin · <a href="/admin">← back to list</a></div>
      <div class="topbar-actions">
        <a href="/">Home</a>
        <form method="POST" action="/logout" style="margin:0"><button type="submit" class="secondary">Sign out</button></form>
      </div>
    </header>

    <h1>${escape(user.displayName)}</h1>
    <p class="lede"><code>${escape(user.userId)}</code> · signed up ${escape(formatDate(user.createdAt))}</p>

    <h2>Connected providers</h2>
    <ul>${credRows}</ul>

    <h2>OAuth grants</h2>
    <p>${grantCount === 0 ? "No active grants." : `<strong>${grantCount}</strong> active grant${grantCount === 1 ? "" : "s"} (issued to MCP clients).`}</p>
    <form method="POST" action="/admin/users/${escape(user.userId)}/revoke-grants">
      <div class="actions">
        <button type="submit" class="secondary" ${grantCount === 0 ? "disabled" : ""}>Revoke all grants</button>
        <span class="help muted">Forces every connected MCP client to re-auth on next tool call.</span>
      </div>
    </form>

    <section class="danger-zone">
      <h2>Danger zone</h2>
      <p>Deleting this user wipes all credentials, identity links, sessions, OAuth grants, and the user record. This cannot be undone.</p>
      <form method="POST" action="/admin/users/${escape(user.userId)}/delete">
        <div class="actions">
          <button type="submit" class="danger">Delete user…</button>
        </div>
      </form>
    </section>
  `;
  return htmlResponse(`Admin · ${user.displayName}`, body, 200);
}

function renderAdminDeleteConfirmPage(user: UserRecord): Response {
  const body = `
    <header class="topbar">
      <div>Admin · <a href="/admin/users/${escape(user.userId)}">← back</a></div>
      <div></div>
    </header>
    <h1>Delete user</h1>
    <div class="warning">
      <p><strong>This cannot be undone.</strong> The following will happen immediately for <strong>${escape(user.displayName)}</strong> (<code>${escape(user.userId)}</code>):</p>
      <ul>
        <li>All OAuth grants revoked — every connected MCP client gets 401 on next call</li>
        <li>All stored provider credentials deleted</li>
        <li>All identity index entries pointing to this user removed</li>
        <li>The user record itself deleted</li>
      </ul>
      <p class="muted">Their data on the upstream providers themselves is not touched.</p>
    </div>
    <form method="POST" action="/admin/users/${escape(user.userId)}/delete/confirm">
      <div class="actions">
        <button type="submit" class="danger">Yes, delete this user</button>
        <a href="/admin/users/${escape(user.userId)}" class="help">Cancel</a>
      </div>
    </form>
  `;
  return htmlResponse("Confirm delete", body, 200);
}

function formatDate(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

function htmlResponse(title: string, body: string, status: number): Response {
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(title)} · workoutcontext.fit</title>
     <link rel="preconnect" href="https://fonts.googleapis.com">
     <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
     <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap">
     <style>
       :root{--fg:#222;--fg-hover:#444;--mut:#888;--brd:#ccc;--brd-hover:#888;--bg:#fff;--soft:#f5f5f5;--err:#b00;--err-hover:#d22;--warn:#875;--ok:#060}
       *{box-sizing:border-box}
       body{font-family:"Inter",system-ui,-apple-system,Segoe UI,sans-serif;max-width:680px;margin:2rem auto;padding:0 1rem;line-height:1.55;color:var(--fg);font-size:14px;background:var(--bg)}
       h1,h2{font-weight:600;letter-spacing:-.01em}
       h1{font-size:1.5rem;margin:.5rem 0 .5rem;line-height:1.25}
       h2{font-size:1.15rem;margin:2.5rem 0 .75rem;display:flex;align-items:center;gap:.5rem;line-height:1.3}
       .provider h2,.danger-zone h2{margin:0 0 .5rem}
       p{margin:.5rem 0}
       form{display:flex;flex-direction:column;gap:1rem;margin:1rem 0 0}
       label{display:flex;flex-direction:column;gap:.25rem;font-size:.8rem;color:var(--mut)}
       input{font:inherit;padding:.5rem .65rem;border:1px solid var(--brd);border-radius:0;color:var(--fg);background:var(--bg)}
       input:focus{outline:1px solid var(--fg);outline-offset:0;border-color:var(--fg)}
       button,a.button{font:inherit;padding:.5rem .9rem;background:var(--fg);color:#fff;border:1px solid var(--fg);border-radius:0;cursor:pointer;text-decoration:none;display:inline-block}
       button:hover,a.button:hover{background:var(--fg-hover);border-color:var(--fg-hover);color:#fff}
       button.secondary,a.button.secondary{background:var(--bg);color:var(--fg);border-color:var(--brd)}
       button.secondary:hover,a.button.secondary:hover{background:var(--soft);border-color:var(--brd-hover)}
       button.danger,a.button.danger{background:var(--bg);color:var(--err);border-color:var(--err)}
       button.danger:hover,a.button.danger:hover{background:var(--err-hover);color:#fff;border-color:var(--err-hover)}
       .actions{display:flex;gap:.5rem;align-items:center;flex-wrap:wrap}
       .help{font-size:.85rem;color:var(--mut);margin-left:auto}
       .help-stack{display:flex;flex-direction:column;align-items:flex-end;margin-left:auto;gap:.1rem}
       .help-stack .help{margin-left:0}
       .key-path{font-size:.8rem;color:var(--mut);text-align:right}
       .error{border:1px solid var(--err);color:var(--err);padding:.5rem .75rem;font-size:.9rem;background:var(--bg)}
       .warning{border:1px solid var(--warn);color:var(--warn);padding:.5rem .75rem;font-size:.9rem;background:var(--bg);margin-bottom:.5rem}
       .topbar{display:flex;justify-content:space-between;align-items:center;padding:.5rem 0;border-bottom:1px solid var(--brd);margin-bottom:1rem;font-size:.85rem}
       .topbar-actions{display:flex;gap:.75rem;align-items:center}
       .muted{color:var(--mut);font-weight:normal}
       .provider{border:1px solid var(--brd);padding:1rem;margin:1rem 0;background:var(--bg)}
       .status{font-size:.7rem;font-weight:normal;text-transform:uppercase;letter-spacing:.04em;background:var(--bg);color:var(--mut);padding:.1rem .4rem;border:1px solid var(--brd);border-radius:0}
       .status.connected{color:var(--ok);border-color:var(--ok)}
       .status.stale{color:var(--warn);border-color:var(--warn)}
       .current{font-size:.85rem;color:#555}
       code{font-family:ui-monospace,"SF Mono",Menlo,Consolas,"Liberation Mono",monospace;font-size:.9rem}
       a{color:var(--fg);text-decoration:underline}
       a:hover{color:#000}
       .lede{font-size:.95rem;color:#555}
       .cta{border:1px solid var(--brd);padding:1rem 1.25rem;margin:2.5rem 0;background:var(--bg)}
       .cta .actions{margin-top:.5rem}
       pre{background:var(--soft);padding:.75rem;border:1px solid var(--brd);word-break:break-all;white-space:pre-wrap;font-family:ui-monospace,"SF Mono",Menlo,Consolas,"Liberation Mono",monospace;font-size:.85rem}
       ol,ul.providers{padding-left:1.25rem}
       ol li,ul.providers li{margin:.35rem 0}
       .danger-zone{border:1px solid var(--err);padding:1rem;margin:2rem 0 1rem;background:var(--bg)}
       .danger-zone h2{color:var(--err)}
       .warning ul{margin:.5rem 0;padding-left:1.25rem}
       .warning ul li{margin:.25rem 0}
       .fineprint{font-size:.8rem;color:var(--mut);margin-top:1.5rem}
       .byline{font-size:.8rem;color:var(--mut);margin-top:3rem;padding-top:1rem;border-top:1px solid var(--brd);text-align:left}
       .admin-table{width:100%;border-collapse:collapse;font-size:.85rem;margin:.5rem 0 1rem}
       .admin-table th,.admin-table td{text-align:left;padding:.4rem .5rem;border-bottom:1px solid var(--brd)}
       .admin-table th{font-weight:600;color:var(--mut);text-transform:uppercase;font-size:.7rem;letter-spacing:.04em}

       /* === Responsive overrides — single breakpoint at 600px === */
       @media (max-width: 600px) {
         body{margin:1rem auto;padding:0 .5rem;line-height:1.5}
         h1{font-size:1.15rem;margin-top:.25rem}
         h2{margin:2rem 0 .5rem}

         /* Stack topbar vertically so signed-in label + actions don't overflow */
         .topbar{flex-direction:column;align-items:stretch;gap:.5rem}
         .topbar-actions{justify-content:space-between}

         /* Form rows: stack vertically with full-width buttons (44px tap targets) */
         .actions{flex-direction:column;align-items:stretch}
         button,a.button{width:100%;text-align:center;padding:.7rem 1rem}
         /* Help link + key-path break out of the right-edge stack and read left-to-right */
         .help-stack{align-items:flex-start;margin-left:0;width:100%}
         .help-stack .help{margin-left:0}
         .key-path{text-align:left}

         /* Inputs fill width for easier mobile typing */
         input{width:100%}

         /* Tighter card padding on small screens */
         .provider,.cta,.danger-zone{padding:.85rem 1rem}

         /* Pre blocks (MCP URL) get tighter padding + smaller font */
         pre{padding:.6rem;font-size:.8rem}
       }
     </style>
     </head><body>${body}<footer class="byline">Made with &lt;3 by <a href="https://jae.works/" target="_blank" rel="noopener noreferrer">Il Jae Lee</a></footer></body></html>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}

// === Helpers ================================================================

function isFormPost(request: Request): boolean {
  const ct = request.headers.get("content-type") ?? "";
  return ct.includes("application/x-www-form-urlencoded");
}

function redirectWithCookie(location: string, setCookie: string): Response {
  const headers = new Headers();
  headers.set("Location", location);
  headers.set("Set-Cookie", setCookie);
  return new Response(null, { status: 302, headers });
}

function mask(key: string): string {
  if (key.length <= 4) return "••••";
  return `••••${key.slice(-4)}`;
}

function escape(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

function encodeState(req: AuthRequest): string {
  return btoa(JSON.stringify(req));
}

function decodeState(s: string): AuthRequest {
  return JSON.parse(atob(s));
}
