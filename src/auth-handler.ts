import type { AuthRequest } from "@cloudflare/workers-oauth-provider";
import type { Env, Props } from "./index.js";
import {
  type ProviderName,
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
      `<li><strong>${escape(ui.label)}</strong> — ${escape(ui.description)} <span class="muted">${escape(ui.helpText)}</span></li>`,
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
         <p>Sign in with any supported provider's API key to get started. You can link more providers to the same account later from <code>/settings</code>.</p>
         <div class="actions"><a class="button" href="/login">Sign in</a></div>
       </div>`;

  const body = `
    <h1>workoutcontext.fit</h1>
    <p class="lede">An MCP server that gives AI clients (Claude.ai, Claude Desktop, Codex, Gemini) access to your training data across providers.</p>

    ${ctaBlock}

    <h2>How it works</h2>
    <ol>
      <li>Sign in by pasting an API key from one of the supported providers below.</li>
      <li>Add this server to your AI client as a connector (URL below). The first connect opens a browser tab so you can authorize.</li>
      <li>Manage connected providers at <a href="/settings">/settings</a> — link additional providers to the same account at any time.</li>
    </ol>

    <h2>Add to your AI client</h2>
    <p>MCP server URL:</p>
    <pre>${escape(mcpUrl)}</pre>
    <p class="muted">Use this URL in Claude.ai's "Add custom connector" or as the <code>mcp-remote</code> target in Claude Desktop / Codex / Gemini config.</p>

    <h2>Supported providers</h2>
    <ul class="providers">
      ${providerList}
    </ul>

    <p class="fineprint">API keys are validated against the upstream provider before being stored and re-validated each time you open <a href="/settings">/settings</a>. Keys are stored per-account, never sent to the LLM, and can be disconnected at any time.</p>
  `;
  return htmlResponse("workoutcontext.fit", body, 200);
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
}

const PROVIDER_UIS: ProviderUI[] = [
  {
    name: "intervals",
    label: "Intervals.icu",
    description: "Training calendar, activities, wellness, and structured workouts.",
    helpUrl: "https://intervals.icu/settings",
    helpText: "Free for all intervals.icu accounts.",
  },
  {
    name: "hevy",
    label: "Hevy",
    description: "Strength workouts and routines.",
    helpUrl: "https://hevy.com/settings?developer",
    helpText: "Requires a Hevy Pro subscription.",
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
            <a href="${escape(ui.helpUrl)}" target="_blank" rel="noopener noreferrer" class="help">How to get a key</a>
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
              <a href="${escape(ui.helpUrl)}" target="_blank" rel="noopener noreferrer" class="help">How to get a key</a>
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

function htmlResponse(title: string, body: string, status: number): Response {
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><title>${escape(title)} · workoutcontext.fit</title>
     <link rel="preconnect" href="https://fonts.googleapis.com">
     <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
     <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Roboto+Mono:wght@400;500;700&display=swap">
     <style>
       :root{--fg:#222;--fg-hover:#444;--mut:#888;--brd:#ccc;--brd-hover:#888;--bg:#fff;--soft:#f5f5f5;--err:#b00;--err-hover:#d22;--warn:#875;--ok:#060}
       *{box-sizing:border-box}
       body{font-family:"Roboto Mono",ui-monospace,"SF Mono",Menlo,Consolas,"Liberation Mono",monospace;max-width:680px;margin:2rem auto;padding:0 1rem;line-height:1.55;color:var(--fg);font-size:14px;background:var(--bg)}
       h1,h2{font-weight:600;letter-spacing:-.01em}
       h1{font-size:1.15rem;margin:.5rem 0 .5rem}
       h2{font-size:.95rem;margin:0 0 .5rem;display:flex;align-items:center;gap:.5rem}
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
       code{font-family:inherit;font-size:.9rem}
       a{color:var(--fg);text-decoration:underline}
       a:hover{color:#000}
       .lede{font-size:.95rem;color:#555}
       .cta{border:1px solid var(--brd);padding:1rem 1.25rem;margin:1.25rem 0;background:var(--bg)}
       .cta .actions{margin-top:.5rem}
       pre{background:var(--soft);padding:.75rem;border:1px solid var(--brd);word-break:break-all;white-space:pre-wrap;font-family:inherit;font-size:.85rem}
       ol,ul.providers{padding-left:1.25rem}
       ol li,ul.providers li{margin:.35rem 0}
       .danger-zone{border:1px solid var(--err);padding:1rem;margin:2rem 0 1rem;background:var(--bg)}
       .danger-zone h2{color:var(--err)}
       .warning ul{margin:.5rem 0;padding-left:1.25rem}
       .warning ul li{margin:.25rem 0}
       .fineprint{font-size:.8rem;color:var(--mut);margin-top:1.5rem}
     </style>
     </head><body>${body}</body></html>`,
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
