import type { AuthRequest } from "@cloudflare/workers-oauth-provider";
import type { Env, Props } from "./index.js";
import {
  type ProviderName,
  type UserRecord,
  consumeOnboardToken,
  createUser,
  deleteCred,
  deleteHevyWebhookToken,
  deleteIdentity,
  generateHevyWebhookToken,
  getCred,
  getOrCreateHevyWebhookToken,
  getUser,
  getUserSettings,
  lookupIdentity,
  lookupUserByHevyWebhookToken,
  setCred,
  setIdentity,
  setUserSettings,
} from "./storage.js";
import {
  clearCookieHeader,
  createSession,
  destroySession,
  readSession,
  sessionCookieHeader,
  type Session,
} from "./session.js";
import { buildAuthorizeUrl, exchangeCode, type OAuthProviderConfig } from "./oauth.js";
import { STRAVA_OAUTH } from "./strava.js";
import { STRAVA_CONNECT_BUTTON_DATA_URL } from "./strava-button.js";
import { OURA_OAUTH } from "./oura.js";
import {
  WITHINGS_APPLI,
  WITHINGS_OAUTH,
  listWithingsNotifySubscriptions,
  revokeWithingsNotify,
  subscribeWithingsNotify,
} from "./withings.js";
import { INTERVALS_OAUTH } from "./intervals.js";
import { syncWithingsMeasurementsToIntervals } from "./withings-sync.js";
import { syncWithingsMeasurementsToHevy } from "./withings-hevy-sync.js";
import { fetchWithingsReadingsByDate, type ReadingsByDate, type SyncResult } from "./withings-readings.js";
import { syncHevyWorkoutToIntervals } from "./hevy-intervals-sync.js";
import { subscribeHevyWebhook, unsubscribeHevyWebhook } from "./hevy-webhook.js";
import {
  isSyncEnabled,
  lookupSync,
  SYNCS,
  syncKey,
  syncsForDest,
  syncsForSource,
} from "./sync-registry.js";
import { GIT_COMMIT_FULL, GIT_COMMIT_SHORT } from "./generated/commit.js";

const INTERVALS_VALIDATE_URL = "https://intervals.icu/api/v1/athlete/0";
const HEVY_VALIDATE_URL = "https://api.hevyapp.com/v1/user/info";

export const AuthHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
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

    if (url.pathname === "/features" && request.method === "GET") {
      return renderFeaturesPage();
    }

    // --- OAuth flow for MCP clients ---
    if (url.pathname === "/authorize" && request.method === "GET") {
      return handleAuthorizeGet(request, env);
    }
    // Hevy is the only remaining API-key provider — POST routes carry the
    // pasted-key form submission.
    const authPostMatch = /^\/authorize\/(hevy)$/.exec(url.pathname);
    if (authPostMatch && request.method === "POST") {
      return handleAuthorizePost(request, env, authPostMatch[1] as ProviderName);
    }
    // OAuth-redirect providers use GET to kick off; state arrives back via /<provider>/callback
    if (url.pathname === "/authorize/intervals" && request.method === "GET") {
      return handleOAuthRedirect(request, env, "intervals", "authorize");
    }
    if (url.pathname === "/authorize/strava" && request.method === "GET") {
      return handleOAuthRedirect(request, env, "strava", "authorize");
    }
    if (url.pathname === "/authorize/oura" && request.method === "GET") {
      return handleOAuthRedirect(request, env, "oura", "authorize");
    }
    if (url.pathname === "/authorize/withings" && request.method === "GET") {
      return handleOAuthRedirect(request, env, "withings", "authorize");
    }

    // --- Browser login (no OAuth, just session cookie) ---
    if (url.pathname === "/login" && request.method === "GET") {
      return renderLoginPage(env, null, null);
    }
    const loginPostMatch = /^\/login\/(hevy)$/.exec(url.pathname);
    if (loginPostMatch && request.method === "POST") {
      return handleLoginPost(request, env, loginPostMatch[1] as ProviderName);
    }
    if (url.pathname === "/login/intervals" && request.method === "GET") {
      return handleOAuthRedirect(request, env, "intervals", "login");
    }
    if (url.pathname === "/login/strava" && request.method === "GET") {
      return handleOAuthRedirect(request, env, "strava", "login");
    }
    if (url.pathname === "/login/oura" && request.method === "GET") {
      return handleOAuthRedirect(request, env, "oura", "login");
    }
    if (url.pathname === "/login/withings" && request.method === "GET") {
      return handleOAuthRedirect(request, env, "withings", "login");
    }

    // --- OAuth provider callbacks ---
    if (url.pathname === "/intervals/callback" && request.method === "GET") {
      return handleOAuthCallback(request, env, "intervals");
    }
    if (url.pathname === "/strava/callback" && request.method === "GET") {
      return handleOAuthCallback(request, env, "strava");
    }
    if (url.pathname === "/oura/callback" && request.method === "GET") {
      return handleOAuthCallback(request, env, "oura");
    }
    if (url.pathname === "/withings/callback" && request.method === "GET") {
      return handleOAuthCallback(request, env, "withings");
    }
    // Withings Notify webhook (subscribed during OAuth callback). Handles both
    // the HEAD preflight Withings issues before activating a subscription and
    // the POST callbacks. No auth header — security is via userid lookup +
    // authenticated re-fetch (the callback body itself is unsigned).
    if (url.pathname === "/withings/notify") {
      return handleWithingsNotify(request, env, ctx);
    }
    // Hevy notify webhook. User pastes URL + per-user Authorization token
    // into their Hevy settings page; Hevy POSTs { workoutId } on save.
    if (url.pathname === "/webhooks/hevy" && request.method === "POST") {
      return handleHevyWebhook(request, env);
    }
    // Intervals.icu notify webhook. Subscription is configured per OAuth app
    // (NOT per user) at intervals.icu → Settings → Manage App. Auth is via the
    // `Authorization` header value also set in Manage App; we compare it
    // against env.INTERVALS_WEBHOOK_TOKEN. Currently observe-only — logs the
    // payload and 200s. Real fan-out logic is added once we've seen the live
    // event shapes for ACTIVITY_UPLOADED / ACTIVITY_ANALYZED / SPORT_SETTINGS_UPDATED.
    if (url.pathname === "/webhooks/intervals" && request.method === "POST") {
      return handleIntervalsWebhook(request, env);
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
    const disconnectMatch = /^\/settings\/(intervals|hevy|strava|oura|withings)\/disconnect$/.exec(url.pathname);
    if (disconnectMatch && request.method === "POST") {
      return handleSettingsDisconnect(request, env, disconnectMatch[1] as ProviderName);
    }
    // /settings/<provider> POST is for the paste-key form (API-key providers
    // only). OAuth providers use /login/<provider> GET → /<provider>/callback.
    const settingsPostMatch = /^\/settings\/(intervals|hevy)$/.exec(url.pathname);
    if (settingsPostMatch && request.method === "POST") {
      return handleSettingsPost(request, env, settingsPostMatch[1] as ProviderName);
    }
    if (url.pathname === "/settings/sync-toggle" && request.method === "POST") {
      return handleSettingsSyncToggle(request, env);
    }
    if (url.pathname === "/settings/hevy/rotate-webhook-token" && request.method === "POST") {
      return handleHevyRotateWebhookToken(request, env);
    }
    if (url.pathname === "/settings/account/delete" && request.method === "POST") {
      return handleAccountDeleteConfirm(request, env);
    }
    if (url.pathname === "/settings/account/delete/confirm" && request.method === "POST") {
      return handleAccountDeleteExecute(request, env);
    }
    const settingsRevokeClientMatch = /^\/settings\/clients\/([^/]+)\/revoke$/.exec(url.pathname);
    if (settingsRevokeClientMatch && request.method === "POST") {
      return handleSettingsRevokeClient(request, env, settingsRevokeClientMatch[1]);
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
    const adminWithingsSyncMatch = /^\/admin\/users\/([^/]+)\/withings\/sync$/.exec(url.pathname);
    if (adminWithingsSyncMatch && request.method === "POST") {
      return handleAdminWithingsSync(request, env, adminWithingsSyncMatch[1]);
    }
    const adminHevySyncMatch = /^\/admin\/users\/([^/]+)\/hevy\/sync$/.exec(url.pathname);
    if (adminHevySyncMatch && request.method === "POST") {
      return handleAdminHevySync(request, env, adminHevySyncMatch[1]);
    }

    return new Response("Not found", { status: 404 });
  },
};

// === Welcome / landing ======================================================

async function handleWelcomeGet(request: Request, env: Env): Promise<Response> {
  const session = await readSession(env.OAUTH_KV, request);
  const mcpUrl = `${new URL(request.url).origin}/mcp`;
  return renderWelcomePage(env, session, mcpUrl);
}

function renderWelcomePage(env: Env, session: Session | null, mcpUrl: string): Response {
  const activeUis = activeProviders(env);
  const providerList = activeUis.map((ui) => {
    // Primary signin providers: framing is about starting an account here.
    // Non-primary providers: framing is about connecting after signing in
    // with a primary — they can't be used to create a brand-new account.
    const access = ui.isPrimarySignin
      ? ui.authType === "oauth"
        ? `Sign in with <a href="${escape(ui.helpUrl)}" target="_blank" rel="noopener noreferrer">${escape(ui.label)}</a>.`
        : `Get a key at <a href="${escape(ui.helpUrl)}" target="_blank" rel="noopener noreferrer">${escape(ui.keyLocation ?? ui.label)}</a>.`
      : `Connect with <a href="${escape(ui.helpUrl)}" target="_blank" rel="noopener noreferrer">${escape(ui.label)}</a> from <a href="/settings">/settings</a>.`;
    return `<li><strong>${escape(ui.label)}</strong> — ${escape(ui.description)} <span class="muted">${escape(ui.helpText)} ${access}</span></li>`;
  }).join("\n");

  // Primary-signin providers, joined with English-list commas. Drives the
  // "sign in with X / Y" line in the Getting started block — stays accurate
  // if a new primary provider is added or one is disabled via env toggle.
  const primaryLabels = activeUis.filter((ui) => ui.isPrimarySignin).map((ui) => ui.label);
  const signinList =
    primaryLabels.length <= 1
      ? primaryLabels[0] ?? "your provider account"
      : primaryLabels.length === 2
        ? `${primaryLabels[0]} or ${primaryLabels[1]}`
        : `${primaryLabels.slice(0, -1).join(", ")}, or ${primaryLabels[primaryLabels.length - 1]}`;

  // Built-in syncs are driven off the SYNCS registry so adding a new
  // (source, dest) row there lights it up on the home page automatically.
  // Skip rows where either endpoint's provider is disabled in this env.
  // Group by (source, contentLabel) so a source fanning out to multiple
  // destinations renders as one row ("Withings → Intervals.icu / Hevy").
  const labelByName = new Map(activeUis.map((ui) => [ui.name, ui.label]));
  type SyncGroup = { source: ProviderName; contentLabel: string; dests: ProviderName[] };
  const groups = new Map<string, SyncGroup>();
  for (const s of SYNCS) {
    if (!labelByName.has(s.source) || !labelByName.has(s.dest)) continue;
    const key = `${s.source}|${s.contentLabel}`;
    let g = groups.get(key);
    if (!g) {
      g = { source: s.source, contentLabel: s.contentLabel, dests: [] };
      groups.set(key, g);
    }
    g.dests.push(s.dest);
  }
  // Trigger phrasing per contentLabel — kept here (not on the registry)
  // because the registry is also consumed by /settings, where this phrasing
  // wouldn't fit.
  const triggerCopy: Record<string, string> = {
    "Body composition": "on every weigh-in",
    "Strength workouts": "as soon as you save the session",
  };
  const syncList = Array.from(groups.values())
    .map((g) => {
      const sourceLabel = labelByName.get(g.source)!;
      const destLabels = g.dests.map((d) => labelByName.get(d)!).join(" / ");
      const trigger = triggerCopy[g.contentLabel] ?? "as soon as the source records it";
      return `<li><strong>${escape(sourceLabel)} → ${escape(destLabels)}</strong> — ${escape(g.contentLabel.toLowerCase())}, ${escape(trigger)}.</li>`;
    })
    .join("\n");

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
    <h1>WorkoutContext.fit 💪 📊</h1>
    <p class="lede">Turn your AI assistant into a coach that actually knows you.</p>
    <p>Your AI assistant, finally with your training data in hand — workouts planned in your real numbers, pushed to your watch, with the load tracked when it comes back.</p>

    <figure class="hero-demo">
      <video autoplay muted loop playsinline preload="metadata" poster="/demo-poster.webp" aria-label="30-second screen recording: planning a workout in Claude and watching it land on the Intervals.icu calendar and Hevy routine">
        <source src="/demo.mp4" type="video/mp4" />
      </video>
    </figure>

    <h2>Getting started</h2>
    <p>Add this URL to your AI client as a connector — that's the whole setup. On first use your client opens a browser tab where you sign in with ${escape(signinList)}, and you're in.</p>
    <pre>${escape(mcpUrl)}</pre>
    <p class="muted">Use this URL in Claude.ai's <a href="https://claude.ai/customize/connectors" target="_blank" rel="noopener noreferrer">"Add custom connector"</a> or as the <code>mcp-remote</code> target in Claude Desktop / ChatGPT / Gemini config.</p>

    <p><strong>[Optional, <em>Recommended</em>]</strong> Install the <a href="https://github.com/agiantwhale/workoutcontext/releases/latest/download/workout-context.zip"><code>workout-context</code> skill</a> so the assistant arrives knowing how to structure your training context — playbook notes, change-tracking, DSL gotchas. <a href="https://github.com/agiantwhale/workoutcontext/releases/latest">Latest release</a> · <a href="https://claude.ai/customize/skills" target="_blank" rel="noopener noreferrer">Add to Claude</a>.</p>

    <h2>See it in action</h2>
    <p><a href="/features">Browse example workflows</a> — screenshots of Claude reading your running playbook, building structured intervals.icu workouts that push straight to your Garmin / Coros watch, and authoring Hevy strength templates that sync back as training load.</p>

    <h2>Supported providers</h2>
    <ul class="providers">
      ${providerList}
    </ul>
    <p class="muted">Not seeing a provider you want? <a href="mailto:agiantwhale@gmail.com">Shoot us an email</a>.</p>

    <h2>Built-in syncs</h2>
    <p>Once you've connected both endpoints, the worker can mirror data between them in real time — no cron, no polling.</p>
    <ul class="providers">
      ${syncList}
    </ul>
    <p class="muted">Off by default; opt in per sync under <a href="/settings">/settings</a>.</p>

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
      <li>OAuth access + refresh tokens (for OAuth providers — Intervals.icu, Strava, Oura, Withings), or the API key you pasted (for Hevy)</li>
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
    <p class="lede">Last updated: 2026-05-19. By using workoutcontext.fit you agree to the terms below.</p>

    <h2>The service</h2>
    <p>workoutcontext.fit is a hosted MCP server that lets you connect your training data from third-party providers (intervals.icu, Hevy, Oura, etc.) to AI assistants you already use. The service is free, open source, and operated as a personal / community project.</p>

    <h2>Your responsibilities</h2>
    <ul>
      <li>You're responsible for keeping your upstream provider credentials secure — OAuth sessions you've authorized through us (Intervals.icu, Strava, Oura, Withings) and any API keys you've pasted (Hevy). If a credential leaks or is revoked, that's between you and the upstream provider.</li>
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

// === /features ==============================================================

function renderFeaturesPage(): Response {
  const body = `
    <header class="topbar">
      <div></div>
      <a href="/">Home</a>
    </header>
    <h1>What it looks like</h1>
    <p class="lede">Four flows users actually run, end to end. Each shot below is a real session — not a mockup.</p>

    <h2>Your running playbook, in context</h2>
    <p>The <a href="https://github.com/agiantwhale/workoutcontext/releases/latest/download/workout-context.zip"><code>workout-context</code> skill</a> teaches the assistant where your athlete profile, training paces, and recent activity live. It pulls them at the start of a session so advice is grounded in <em>your</em> numbers — current threshold, last week's volume, planned next workout — instead of generic templates.</p>
    <figure class="feature-shot">
      <img src="/screenshots/running_playbook.webp" alt="Claude reading a running playbook with the user's training paces and recent runs" loading="lazy" />
    </figure>

    <h2>Structured workouts, synced straight to your watch</h2>
    <p>Ask for a tempo session and the assistant writes it as a structured workout in intervals.icu — proper warm-up / main set / cool-down, with paces or %FTP/%threshold pulled from your sport settings. From there, intervals.icu's Garmin and Coros integrations push the workout to your watch automatically, ready to execute step-by-step on your wrist when you head out the door.</p>
    <figure class="feature-shot">
      <img src="/screenshots/tempo_workout_sample.webp" alt="A tempo workout authored by Claude as a structured intervals.icu workout, ready to sync to a Garmin or Coros watch" loading="lazy" />
    </figure>

    <h2>Strength templates that match the plan</h2>
    <p>For strength days, the assistant builds a <a href="https://hevy.com" target="_blank" rel="noopener noreferrer">Hevy</a> routine — working weights informed by your recent set history, not guesses. You execute the session from the Hevy app on your phone; the assistant has already paired it with a calendar event so it lands as planned training.</p>
    <figure class="feature-shot">
      <img src="/screenshots/hevy_strength_template.webp" alt="A Hevy strength routine drafted by Claude with exercises, sets, and target weights" loading="lazy" />
    </figure>

    <h2>Hevy → Intervals.icu, automatically</h2>
    <p>Once you finish a Hevy session, the built-in <a href="/settings">Hevy → Intervals.icu sync</a> mirrors it across as a structured activity — duration, exercises, set-level detail — so your training load chart reflects the strength work, not just the runs and rides. No cron, no polling: Hevy webhooks fire the moment you save.</p>
    <figure class="feature-shot">
      <img src="/screenshots/hevy_strength_sync.webp" alt="A finished Hevy strength workout mirrored into intervals.icu as a structured activity" loading="lazy" />
    </figure>

    <div class="cta">
      <p>Ready to wire your own data in?</p>
      <div class="actions"><a class="button" href="/">Back to setup</a></div>
    </div>
  `;
  return htmlResponse("Features", body, 200);
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

// === Upstream OAuth redirect (Strava, future Withings) ======================

type OAuthFlowType = "login" | "authorize" | "settings-link";

interface OAuthFlowState {
  flow: OAuthFlowType;
  /** Encoded AuthRequest for the MCP-OAuth flow (only when flow === "authorize") */
  oauthReq?: string;
  nonce: string;
}

type OAuthProviderName = "intervals" | "strava" | "oura" | "withings";

function configForProvider(env: Env, provider: OAuthProviderName): OAuthProviderConfig | null {
  if (provider === "intervals") {
    if (!env.INTERVALS_CLIENT_ID || !env.INTERVALS_CLIENT_SECRET) return null;
    return INTERVALS_OAUTH;
  }
  if (provider === "strava") {
    if (!env.STRAVA_CLIENT_ID || !env.STRAVA_CLIENT_SECRET) return null;
    return STRAVA_OAUTH;
  }
  if (provider === "oura") {
    if (!env.OURA_CLIENT_ID || !env.OURA_CLIENT_SECRET) return null;
    return OURA_OAUTH;
  }
  if (provider === "withings") {
    if (!env.WITHINGS_CLIENT_ID || !env.WITHINGS_CLIENT_SECRET) return null;
    return WITHINGS_OAUTH;
  }
  return null;
}

function credentialsForProvider(env: Env, provider: OAuthProviderName): { clientId: string; clientSecret: string } | null {
  if (provider === "intervals") {
    if (!env.INTERVALS_CLIENT_ID || !env.INTERVALS_CLIENT_SECRET) return null;
    return { clientId: env.INTERVALS_CLIENT_ID, clientSecret: env.INTERVALS_CLIENT_SECRET };
  }
  if (provider === "strava") {
    if (!env.STRAVA_CLIENT_ID || !env.STRAVA_CLIENT_SECRET) return null;
    return { clientId: env.STRAVA_CLIENT_ID, clientSecret: env.STRAVA_CLIENT_SECRET };
  }
  if (provider === "oura") {
    if (!env.OURA_CLIENT_ID || !env.OURA_CLIENT_SECRET) return null;
    return { clientId: env.OURA_CLIENT_ID, clientSecret: env.OURA_CLIENT_SECRET };
  }
  if (provider === "withings") {
    if (!env.WITHINGS_CLIENT_ID || !env.WITHINGS_CLIENT_SECRET) return null;
    return { clientId: env.WITHINGS_CLIENT_ID, clientSecret: env.WITHINGS_CLIENT_SECRET };
  }
  return null;
}

function encodeOAuthState(s: OAuthFlowState): string {
  return btoa(JSON.stringify(s));
}

function decodeOAuthState(raw: string): OAuthFlowState {
  return JSON.parse(atob(raw));
}

function randomNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// HttpOnly cookie that binds the OAuth state nonce to the requesting browser.
// On the redirect to the provider we Set-Cookie the nonce; on the callback we
// require the cookie value to equal state.nonce before completing the flow.
// Without this, the nonce in state.nonce is decorative — any holder of a valid
// (code, state) pair can complete a flow on any browser, enabling OAuth
// login-fixation (attacker initiates flow on their browser, captures the
// callback URL, gets a victim to click it → victim's browser ends up bound
// to the attacker's provider identity).
//
// Per-provider name so a user mid-flow against Strava doesn't have their
// nonce clobbered by starting a parallel Oura flow in another tab. Same-
// provider parallel flows still collide (rare in practice).
function oauthStateCookieName(provider: OAuthProviderName): string {
  return `wc_oauth_state_${provider}`;
}

function oauthStateCookieHeader(provider: OAuthProviderName, nonce: string): string {
  return [
    `${oauthStateCookieName(provider)}=${nonce}`,
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    "Path=/",
    "Max-Age=600",
  ].join("; ");
}

function oauthStateClearCookieHeader(provider: OAuthProviderName): string {
  return [
    `${oauthStateCookieName(provider)}=`,
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    "Path=/",
    "Max-Age=0",
  ].join("; ");
}

function readOAuthStateCookie(
  request: Request,
  provider: OAuthProviderName,
): string | null {
  const cookie = request.headers.get("cookie");
  if (!cookie) return null;
  const target = oauthStateCookieName(provider);
  for (const part of cookie.split(/;\s*/)) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq) === target) return part.slice(eq + 1);
  }
  return null;
}

async function handleOAuthRedirect(
  request: Request,
  env: Env,
  provider: OAuthProviderName,
  flow: "login" | "authorize",
): Promise<Response> {
  if (!isProviderEnabled(env, provider)) {
    return new Response(`${provider} is not enabled on this environment.`, { status: 404 });
  }
  const config = configForProvider(env, provider);
  const creds = credentialsForProvider(env, provider);
  if (!config || !creds) {
    return new Response(`${provider} is not configured (missing CLIENT_ID/CLIENT_SECRET).`, { status: 503 });
  }

  const url = new URL(request.url);
  let oauthReqEncoded: string | undefined;
  if (flow === "authorize") {
    // /authorize/strava is reached via the /authorize picker page, which
    // passed the OAuth provider's AuthRequest as a "state" query param.
    const passthrough = url.searchParams.get("state");
    if (!passthrough) return new Response("Missing OAuth state", { status: 400 });
    oauthReqEncoded = passthrough;
  }

  const nonce = randomNonce();
  const state = encodeOAuthState({ flow, oauthReq: oauthReqEncoded, nonce });
  const redirectUri = `${url.origin}/${provider}/callback`;
  const authUrl = buildAuthorizeUrl(config, creds.clientId, redirectUri, state);
  const headers = new Headers();
  headers.set("Location", authUrl);
  headers.set("Set-Cookie", oauthStateCookieHeader(provider, nonce));
  return new Response(null, { status: 302, headers });
}

async function handleOAuthCallback(
  request: Request,
  env: Env,
  provider: OAuthProviderName,
): Promise<Response> {
  const config = configForProvider(env, provider);
  const creds = credentialsForProvider(env, provider);
  if (!config || !creds) {
    return new Response(`${provider} is not configured.`, { status: 503 });
  }

  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const stateRaw = url.searchParams.get("state");
  const error = url.searchParams.get("error");
  if (error) {
    return htmlResponse(
      `${config.label} authorization failed`,
      `<h1>${escape(config.label)} authorization failed</h1>
       <p>The provider returned: <code>${escape(error)}</code></p>
       <p><a href="/login">Back to sign in</a></p>`,
      400,
    );
  }
  if (!code || !stateRaw) return new Response("Missing code or state", { status: 400 });

  let parsedState: OAuthFlowState;
  try {
    parsedState = decodeOAuthState(stateRaw);
  } catch {
    return new Response("Invalid state", { status: 400 });
  }

  // Bind the state to the requesting browser via the per-provider cookie
  // set on the outbound redirect. Mismatch = the callback URL was opened in
  // a different browser than the one that initiated the flow, which is what
  // an OAuth login-fixation attack looks like. Reject; clear the cookie.
  const cookieNonce = readOAuthStateCookie(request, provider);
  if (!cookieNonce || cookieNonce !== parsedState.nonce) {
    return htmlResponse(
      "OAuth flow refused",
      `<h1>OAuth flow refused</h1>
       <p>This ${escape(config.label)} login flow's state didn't match this browser. That usually means the flow expired (links are valid for ~10 minutes) or the callback URL was opened in a different browser than the one that started the sign-in. Try again from <a href="/login">/login</a>.</p>`,
      400,
      { "Set-Cookie": oauthStateClearCookieHeader(provider) },
    );
  }

  const redirectUri = `${url.origin}/${provider}/callback`;
  const { tokens, identity: idFromToken } = await exchangeCode(config, creds.clientId, creds.clientSecret, code, redirectUri);
  const identity = idFromToken ?? (await config.fetchIdentity(tokens.accessToken));

  const result = await loginViaOAuth(request, env, provider, identity, tokens);
  if (!result.ok) {
    return htmlResponse(`${config.label} sign-in refused`, `<h1>Sign-in refused</h1><p>${escape(result.error)}</p><p><a href="/login">Back to sign in</a></p>`, 403);
  }

  // Withings: subscribe to WEIGHT (appli=1) so Body Scan readings can trigger
  // a real-time sync into Intervals wellness. Re-subscribing on every connect
  // is idempotent; per-appli failure is non-fatal (logged, continue).
  //
  // We do NOT subscribe to USER_ACTION (appli=46) anymore — Withings doesn't
  // sign callbacks, and the body's `userid` field is a small integer, not a
  // secret. An attacker who learns or guesses a victim's Withings userid can
  // forge an `appli=46 action=delete` POST that wipes the victim's cred and
  // identity rows. Stale-cred surfacing via /settings (the existing 401-on-
  // revalidate path) catches the legitimate case where the user revokes our
  // app on Withings's side; auto-cleanup via webhook isn't worth the forgery
  // risk. Any existing USER_ACTION subscription gets revoked below as part
  // of the audit pass, so users who connected before this change get
  // migrated transparently on their next OAuth-callback round-trip.
  //
  // Audit pass: list existing subs per appli and revoke any whose callback
  // host doesn't match this deployment's PUBLIC_URL — Withings stores subs
  // per (callbackurl, appli) and they outlive the worker that registered
  // them (cross-deployment leakage between PR previews, staging, prod).
  // USER_ACTION subs get revoked unconditionally as the deprecation cleanup.
  if (provider === "withings") {
    const notifyUrl = `${env.PUBLIC_URL.replace(/\/+$/, "")}/withings/notify`;
    const expectedHost = new URL(notifyUrl).host;
    const subscribeList: Array<[number, string]> = [
      [WITHINGS_APPLI.WEIGHT, "workoutcontext weight notify"],
    ];
    const revokeOnlyList: number[] = [WITHINGS_APPLI.USER_ACTION];

    for (const [appli, comment] of subscribeList) {
      try {
        const existing = await listWithingsNotifySubscriptions(tokens.accessToken, appli);
        for (const profile of existing) {
          let profileHost: string | null = null;
          try {
            profileHost = new URL(profile.callbackurl).host;
          } catch {
            // Malformed callback URL on Withings's side — treat as foreign
            // so we attempt to remove it.
          }
          if (profileHost !== expectedHost) {
            await revokeWithingsNotify(tokens.accessToken, profile.callbackurl, appli);
            console.log(
              `[withings/notify] revoked stale sub appli=${appli} callback=${profile.callbackurl}`,
            );
          }
        }
      } catch (e) {
        console.error(`[withings/notify] audit failed (appli=${appli}):`, e);
      }
      try {
        await subscribeWithingsNotify(tokens.accessToken, notifyUrl, appli, comment);
      } catch (e) {
        console.error(`[withings/notify] subscribe failed (appli=${appli}):`, e);
      }
    }

    for (const appli of revokeOnlyList) {
      try {
        const existing = await listWithingsNotifySubscriptions(tokens.accessToken, appli);
        for (const profile of existing) {
          await revokeWithingsNotify(tokens.accessToken, profile.callbackurl, appli);
          console.log(
            `[withings/notify] revoked deprecated sub appli=${appli} callback=${profile.callbackurl}`,
          );
        }
      } catch (e) {
        console.error(`[withings/notify] deprecate-revoke failed (appli=${appli}):`, e);
      }
    }
  }

  if (parsedState.flow === "authorize" && parsedState.oauthReq) {
    // Resume the MCP-OAuth flow that triggered the Strava redirect.
    let oauthReqInfo: AuthRequest;
    try {
      oauthReqInfo = decodeState(parsedState.oauthReq);
    } catch {
      return new Response("Invalid MCP OAuth state", { status: 400 });
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
    return redirectWithCookies(redirectTo, [
      sessionCookieHeader(sessionId),
      oauthStateClearCookieHeader(provider),
    ]);
  }

  // flow === "login": ordinary browser sign-in, drop session cookie and go to /settings
  const sessionId = await createSession(env.OAUTH_KV, result.userId, result.displayName);
  return redirectWithCookies("/settings", [
    sessionCookieHeader(sessionId),
    oauthStateClearCookieHeader(provider),
  ]);
}

// === Withings Notify webhook ================================================
//
// Receives Withings's event pings. The body is application/x-www-form-urlencoded
// with at minimum `userid` and `appli`. Withings doesn't sign callbacks; the
// security model is that we look up the userid in our local identity index
// (so we only act on users we already have OAuth tokens for) and, when we
// need actual measurement data, re-fetch via authenticated API call.
//
// Always 200 — including on malformed bodies — to avoid Withings retry storms.
// Errors that matter get logged but don't surface as a non-2xx response.
async function handleWithingsNotify(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  // Withings issues a HEAD preflight before activating a subscription. Some
  // older docs mention GET with `is_test=1`; accept both as a 200.
  if (request.method === "HEAD" || request.method === "GET") {
    return new Response(null, { status: 200 });
  }
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch (e) {
    console.error("[withings/notify] bad form body:", e);
    return new Response(null, { status: 200 });
  }

  const withingsUserId = String(form.get("userid") ?? "").trim();
  const appli = Number(form.get("appli") ?? 0);
  if (!withingsUserId || !appli) {
    console.error("[withings/notify] missing userid or appli:", { withingsUserId, appli });
    return new Response(null, { status: 200 });
  }

  // Work is dispatched via ctx.waitUntil so we ack Withings immediately —
  // their webhook timeout is ~2s and the full sync pipeline (token refresh
  // + /measure + Intervals/Hevy writes) can run 3–8s. Slow acks were the
  // main driver of duplicate deliveries that tripped /measure 601s.
  if (appli === WITHINGS_APPLI.USER_ACTION) {
    // USER_ACTION (appli=46) is no longer honored — Withings doesn't sign
    // callbacks and the `userid` body field is a small integer, not a
    // secret, so a forged POST here was wiping arbitrary users' creds.
    // Log and ack; the audit pass on the next OAuth round-trip revokes the
    // upstream subscription. Legitimate revokes surface via the existing
    // stale-cred path on /settings.
    console.log(
      `[withings/notify] dropping appli=46 user-action for withingsUserId=${withingsUserId} (deprecated; see security audit H2)`,
    );
  } else if (appli === WITHINGS_APPLI.WEIGHT) {
    const startdate = Number(form.get("startdate") ?? 0);
    const enddate = Number(form.get("enddate") ?? 0);
    // Withings docs spell out at-least-once delivery, so even with fast
    // acks we can still see duplicates. Dedup on (userid,startdate,enddate)
    // with a 60s window suppresses the common case before we burn a
    // /measure call. KV is eventually consistent across colos, so this is
    // best-effort; the 601 catch inside handleWithingsWeight handles leaks.
    const claimed = await tryClaimWithingsNotify(
      env.OAUTH_KV,
      withingsUserId,
      startdate,
      enddate,
    );
    if (claimed) {
      ctx.waitUntil(handleWithingsWeight(env, withingsUserId, startdate, enddate));
    } else {
      console.log(
        `[withings/notify] appli=1 duplicate delivery userId=${withingsUserId} window=[${startdate},${enddate}], skipping`,
      );
    }
  }
  // Other appli codes (sleep, activity, etc.) are intentionally unhandled.

  return new Response(null, { status: 200 });
}

// Idempotency claim for Withings's at-least-once webhook delivery.
// Returns true if the caller "won" the claim and should run the sync; false
// if a sibling delivery has already claimed this (userid,startdate,enddate).
// KV minimum TTL is 60s, which comfortably exceeds both Withings's
// retry cadence (~seconds) and their own /measure 10s "same arguments"
// rate-limit window.
const WITHINGS_NOTIFY_DEDUP_TTL_SECONDS = 60;
async function tryClaimWithingsNotify(
  kv: KVNamespace,
  withingsUserId: string,
  startdate: number,
  enddate: number,
): Promise<boolean> {
  const key = `dedup:withings-notify:${withingsUserId}:${startdate}:${enddate}`;
  if (await kv.get(key)) return false;
  await kv.put(key, "1", { expirationTtl: WITHINGS_NOTIFY_DEDUP_TTL_SECONDS });
  return true;
}

// Dispatch table for every Withings-sourced sync. Adding a new destination
// is two steps: register the (source, dest) in src/sync-registry.ts, then
// add an entry here mapping that dest to its sync helper. The webhook
// fan-out below picks it up automatically.
//
// Helpers receive pre-fetched readings rather than a window: the webhook
// hits Withings /measure once per event and shares the result across every
// enabled destination. Fanning the fetch out per-dest tripped two Withings
// rate limits in the wild — (a) the parallel refresh-token race, since
// Withings rotates refresh tokens on use, and (b) "status=601 Same arguments
// in less than 10 seconds" on /measure when both dests called it in lockstep.
const WITHINGS_SYNC_DISPATCH: Record<
  string,
  (env: Env, userId: string, readings: ReadingsByDate) => Promise<SyncResult>
> = {
  intervals: syncWithingsMeasurementsToIntervals,
  hevy: syncWithingsMeasurementsToHevy,
};

// appli=1 dispatch. For each registered withings.<dest> sync, gates on the
// per-user /settings toggle, then runs them in parallel. Always returns void;
// failures are logged so the outer notify handler can still 200 back to
// Withings (avoids retry storms).
async function handleWithingsWeight(
  env: Env,
  withingsUserId: string,
  startUnix: number,
  endUnix: number,
): Promise<void> {
  const userId = await lookupIdentity(env.OAUTH_KV, "withings", withingsUserId);
  if (!userId) {
    console.error(
      `[withings/notify] appli=1 for unknown withingsUserId=${withingsUserId}; ignoring`,
    );
    return;
  }
  const settings = await getUserSettings(env.OAUTH_KV, userId);

  const enabledDests = syncsForSource("withings")
    .map((s) => s.dest)
    .filter((dest) => isSyncEnabled(settings.syncs, "withings", dest))
    .filter((dest) => WITHINGS_SYNC_DISPATCH[dest] != null);

  if (enabledDests.length === 0) {
    console.log(
      `[withings/notify] appli=1 weight event for userId=${userId} window=[${startUnix},${endUnix}] (no enabled syncs, no-op)`,
    );
    return;
  }

  // Fetch readings once, then fan out. Per-dest fetches would race the
  // Withings refresh-token rotation and trip the /measure "same arguments
  // in less than 10 seconds" rate limit (status=601).
  let readings: ReadingsByDate;
  try {
    readings = await fetchWithingsReadingsByDate(env, userId, startUnix, endUnix);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // 601 = "same arguments in less than 10 seconds" — almost always means a
    // sibling delivery beat us to /measure. The KV dedup upstream catches the
    // common case; this is the cross-colo leak. Demote to warn so the alerting
    // signal stays meaningful.
    if (msg.includes("status=601")) {
      console.warn(
        `[withings/notify] appli=1 fetch skipped userId=${userId} window=[${startUnix},${endUnix}] (601 — sibling delivery handled it)`,
      );
      return;
    }
    console.error(
      `[withings/notify] appli=1 fetch failed userId=${userId} window=[${startUnix},${endUnix}]:`,
      msg,
    );
    return;
  }

  await Promise.all(
    enabledDests.map(async (dest) => {
      try {
        const result = await WITHINGS_SYNC_DISPATCH[dest](env, userId, readings);
        console.log(
          `[withings/notify] appli=1 synced userId=${userId} dest=${dest} window=[${startUnix},${endUnix}]:`,
          JSON.stringify(result),
        );
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(
          `[withings/notify] appli=1 sync failed userId=${userId} dest=${dest} window=[${startUnix},${endUnix}]:`,
          msg,
        );
      }
    }),
  );
}

// === Hevy webhook ===========================================================
//
// Hevy lets the user set a notify URL + Authorization header value on their
// account settings page. They paste `https://workoutcontext.fit/webhooks/hevy`
// + their per-user token (surfaced on /settings). Hevy POSTs:
//   { "workoutId": "<uuid>" }
// on every workout save. We reverse-resolve the auth token to a userId,
// gate via the per-user `hevy.intervals` toggle, fetch the workout via
// the Hevy API, and run the sync. Always 200s back to Hevy so a transient
// downstream failure doesn't trigger a webhook retry storm.

async function handleHevyWebhook(request: Request, env: Env): Promise<Response> {
  // Pull the auth header. Accept either the raw token or `Bearer <token>`
  // form — Hevy passes through whatever the user typed and "Bearer" is
  // the obvious thing they'll try first.
  const rawAuth = request.headers.get("Authorization") ?? "";
  const token = rawAuth.replace(/^Bearer\s+/i, "").trim();
  if (!token) {
    return new Response(JSON.stringify({ error: "missing Authorization header" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const userId = await lookupUserByHevyWebhookToken(env.OAUTH_KV, token);
  if (!userId) {
    return new Response(JSON.stringify({ error: "unknown webhook token" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  let body: { workoutId?: unknown } = {};
  try {
    body = (await request.json()) as { workoutId?: unknown };
  } catch (e) {
    console.error(`[hevy/webhook] userId=${userId} bad JSON body:`, e);
    return new Response(JSON.stringify({ ok: false, error: "invalid JSON" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  const workoutId = typeof body.workoutId === "string" ? body.workoutId.trim() : "";
  if (!workoutId) {
    console.error(
      `[hevy/webhook] userId=${userId} payload missing workoutId:`,
      JSON.stringify(body),
    );
    return new Response(JSON.stringify({ ok: false, error: "missing workoutId" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  const settings = await getUserSettings(env.OAUTH_KV, userId);
  if (!isSyncEnabled(settings.syncs, "hevy", "intervals")) {
    console.log(
      `[hevy/webhook] userId=${userId} workoutId=${workoutId} (sync disabled in /settings, no-op)`,
    );
    return new Response(JSON.stringify({ ok: true, status: "sync_disabled" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const result = await syncHevyWorkoutToIntervals(env, userId, workoutId);
    console.log(
      `[hevy/webhook] userId=${userId} synced workoutId=${workoutId}:`,
      JSON.stringify(result),
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(
      `[hevy/webhook] userId=${userId} sync failed workoutId=${workoutId}:`,
      msg,
    );
  }

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

// === Intervals.icu webhook ==================================================
//
// Subscription is configured per OAuth app at intervals.icu → Settings →
// Manage App: webhook URL + Authorization header value + event-type checklist.
// Every authorized athlete shares that single URL — we route to the local
// userId via `lookupIdentity("intervals", athlete_id)`.
//
// Observed event types: ACTIVITY_UPLOADED, ACTIVITY_ANALYZED, CALENDAR_UPDATED,
// SPORT_SETTINGS_UPDATED. Wrapper fields documented on intervals.icu's forum:
// { athlete_id, type, timestamp, oauth_client_id, external_id, ...event-data }.
// CALENDAR_UPDATED carries `events[]` + `deleted_events[]`. ACTIVITY_*
// carries `activity: {...}`. SPORT_SETTINGS_UPDATED's exact shape isn't
// public — we log the raw body so we can build the parser off real samples.
//
// Always 200 on auth-passing requests. Intervals.icu retries non-2xx with
// exponential backoff, which would amplify any parse bug into a retry storm
// while we're observing. Auth failures DO get 401 — they aren't from
// intervals.icu (a real misconfig would be caught when we set up the app).
async function handleIntervalsWebhook(request: Request, env: Env): Promise<Response> {
  const configured = env.INTERVALS_WEBHOOK_TOKEN?.trim();
  if (!configured) {
    console.error("[intervals/webhook] INTERVALS_WEBHOOK_TOKEN unset; refusing");
    return new Response(JSON.stringify({ error: "webhook not configured" }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    });
  }
  const rawAuth = request.headers.get("Authorization") ?? "";
  const presented = rawAuth.replace(/^Bearer\s+/i, "").trim();
  if (presented !== configured) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch (e) {
    console.error("[intervals/webhook] bad JSON body:", e);
    return new Response(JSON.stringify({ ok: false, error: "invalid JSON" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  const eventType = typeof body.type === "string" ? body.type : "<unknown>";
  const athleteId =
    typeof body.athlete_id === "string"
      ? body.athlete_id
      : typeof body.athlete_id === "number"
        ? String(body.athlete_id)
        : "";
  const userId = athleteId ? await lookupIdentity(env.OAUTH_KV, "intervals", athleteId) : null;

  console.log(
    `[intervals/webhook] type=${eventType} athleteId=${athleteId || "<missing>"} userId=${userId ?? "<unmapped>"}:`,
    JSON.stringify(body),
  );

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

// === /settings/hevy/rotate-webhook-token ====================================
//
// Mints a fresh per-user token and invalidates the old one. Used when the
// user thinks the token leaked, or just wants to rotate. Re-renders /settings
// so the new value is immediately visible.

async function handleHevyRotateWebhookToken(
  request: Request,
  env: Env,
): Promise<Response> {
  const session = await readSession(env.OAUTH_KV, request);
  if (!session) {
    return new Response("Sign in required", { status: 401 });
  }
  // Only meaningful if Hevy is connected — refuse otherwise so we don't
  // mint dangling tokens.
  const hevyCred = await getCred(env.OAUTH_KV, session.userId, "hevy");
  if (!hevyCred) {
    return renderSettingsPage(
      env,
      session,
      "hevy",
      "Connect Hevy before generating a webhook token.",
    );
  }
  const newToken = await generateHevyWebhookToken(env.OAUTH_KV, session.userId);
  // Push the new token to Hevy's subscription so the next webhook delivery
  // arrives with the value our handler now expects. Without this re-subscribe,
  // rotation would silently break live sync — Hevy would keep sending the
  // previous token and our auth check would reject it.
  const notifyUrl = `${env.PUBLIC_URL.replace(/\/+$/, "")}/webhooks/hevy`;
  try {
    await subscribeHevyWebhook(hevyCred.apiKey, notifyUrl, newToken);
  } catch (e) {
    console.error(
      `[hevy/webhook-subscribe] userId=${session.userId} rotate re-subscribe threw (continuing):`,
      e instanceof Error ? e.message : String(e),
    );
  }
  return Response.redirect(new URL("/settings", request.url).toString(), 302);
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

  // Stricter than "at least one connection" — at least one PRIMARY SIGNIN
  // provider (Intervals or Strava) must remain so the user can always sign
  // back into their account. Disconnecting the only primary signin would
  // leave the account inaccessible after the current session expires.
  const enabled = activeProviders(env);
  const allCreds = await Promise.all(
    enabled.map(async (p) => ({ ui: p, cred: await getCred(env.OAUTH_KV, session.userId, p.name) })),
  );
  const targetUi = enabled.find((p) => p.name === provider);
  const targetCred = allCreds.find((c) => c.ui.name === provider)?.cred;
  if (targetCred && targetUi?.isPrimarySignin) {
    const primarySigninCount = allCreds.filter((c) => c.ui.isPrimarySignin && c.cred).length;
    if (primarySigninCount <= 1) {
      return renderSettingsPage(
        env,
        session,
        provider,
        `Can't disconnect your only signin provider. Connect another signin provider (${enabled
          .filter((p) => p.isPrimarySignin && p.name !== provider)
          .map((p) => p.label)
          .join(" or ")}) first, or delete the account entirely from the Danger zone.`,
      );
    }
  }

  // Withings only: revoke both notify subscriptions before we throw away the
  // cred. Best-effort — if the stored token is already dead, the webhook
  // handler will treat any leftover Withings-side pings as no-ops once the
  // identity row's cred is gone (cred row delete below is what actually
  // disconnects us).
  if (provider === "withings" && targetCred && "tokens" in targetCred) {
    const notifyUrl = `${env.PUBLIC_URL.replace(/\/+$/, "")}/withings/notify`;
    for (const appli of [WITHINGS_APPLI.USER_ACTION, WITHINGS_APPLI.WEIGHT]) {
      await revokeWithingsNotify(targetCred.tokens.accessToken, notifyUrl, appli);
    }
  }

  // Hevy only: invalidate the webhook token (and its reverse-index row) so
  // a leaked token can't be reused after disconnect. Reconnect mints a
  // fresh one on the next /settings view. Also DELETE the Hevy-side
  // subscription so they stop POSTing at us — best-effort, since the next
  // POST would 401 anyway once the token row is gone.
  if (provider === "hevy") {
    if (targetCred && "apiKey" in targetCred) {
      try {
        await unsubscribeHevyWebhook(targetCred.apiKey);
      } catch (e) {
        console.error(
          `[hevy/webhook-subscribe] userId=${session.userId} unsubscribe threw (continuing):`,
          e instanceof Error ? e.message : String(e),
        );
      }
    }
    await deleteHevyWebhookToken(env.OAUTH_KV, session.userId);
  }

  // Disconnecting a provider revokes implicit consent for any sync that
  // *targets* that provider. Without this, the persisted "on" state would
  // silently auto-reactivate when the user reconnects later — they should
  // have to opt in again explicitly. We only flip dest-side syncs; source-
  // side entries are left alone (the card disappears with the source, the
  // KV row is invisible until reconnect, and symmetry with the previous
  // behavior is preserved on the source side).
  const dependentSyncs = syncsForDest(provider);
  if (dependentSyncs.length > 0) {
    const current = await getUserSettings(env.OAUTH_KV, session.userId);
    if (current.syncs && dependentSyncs.some((s) => current.syncs?.[syncKey(s.source, s.dest)])) {
      const nextSyncs = { ...current.syncs };
      for (const s of dependentSyncs) nextSyncs[syncKey(s.source, s.dest)] = false;
      await setUserSettings(env.OAUTH_KV, session.userId, { ...current, syncs: nextSyncs });
    }
  }

  // Note: we leave the identity index entry in place so re-adding the same
  // provider account later links back to this user. Only the cred is removed.
  await deleteCred(env.OAUTH_KV, session.userId, provider);
  return Response.redirect(new URL("/settings", request.url).toString(), 302);
}

// Toggles one entry in UserSettings.syncs, keyed by (source, dest). Guards:
//   - (source, dest) must be in the sync registry — refuses arbitrary keys.
//   - Both providers must be active in this env (the corresponding card may
//     not even render otherwise, but defense in depth catches stale forms).
//   - Source must be connected; the toggle is meaningless otherwise (no
//     webhooks to gate). Same shape of guard the disconnect path uses.
//   - Enabling additionally requires the dest connected — there's nowhere
//     for the sync to land otherwise, and we don't want to silently accept
//     a flag that'll only produce `sync failed` logs on every webhook.
//     Disabling is always allowed; users can turn things off even after
//     either provider goes away (the disabled-state preserved-preference
//     behavior in the UI is about INPUT, not POST — once they explicitly
//     POST disable, persist).
async function handleSettingsSyncToggle(
  request: Request,
  env: Env,
): Promise<Response> {
  const session = await readSession(env.OAUTH_KV, request);
  if (!session) return Response.redirect(new URL("/login", request.url).toString(), 302);
  if (!isFormPost(request)) return new Response("Expected form POST", { status: 415 });

  const form = await request.formData();
  const sourceRaw = String(form.get("source") ?? "");
  const destRaw = String(form.get("dest") ?? "");
  const enabled = form.get("enabled") === "1";

  // Cast via the registry lookup — lookupSync only returns a SyncDescriptor
  // when both names are valid ProviderNames AND the pair is registered, so
  // this single check covers shape + allowlist + env-enabled-by-extension.
  const descriptor = lookupSync(sourceRaw as ProviderName, destRaw as ProviderName);
  if (!descriptor) {
    return new Response("Unknown sync target", { status: 400 });
  }
  const { source, dest, contentLabel } = descriptor;

  const active = new Set(activeProviders(env).map((p) => p.name));
  if (!active.has(source) || !active.has(dest)) {
    return new Response("Sync target not enabled in this environment", { status: 400 });
  }

  const sourceCred = await getCred(env.OAUTH_KV, session.userId, source);
  if (!sourceCred) {
    const sourceLabel = PROVIDER_UIS.find((p) => p.name === source)?.label ?? source;
    return renderSettingsPage(
      env,
      session,
      source,
      `Connect ${sourceLabel} before changing its sync settings.`,
    );
  }
  if (enabled) {
    const destCred = await getCred(env.OAUTH_KV, session.userId, dest);
    if (!destCred) {
      const destLabel = PROVIDER_UIS.find((p) => p.name === dest)?.label ?? dest;
      return renderSettingsPage(
        env,
        session,
        source,
        `Connect ${destLabel} first — ${contentLabel.toLowerCase()} sync writes there.`,
      );
    }
  }

  const current = await getUserSettings(env.OAUTH_KV, session.userId);
  await setUserSettings(env.OAUTH_KV, session.userId, {
    ...current,
    syncs: { ...(current.syncs ?? {}), [syncKey(source, dest)]: enabled },
  });
  return Response.redirect(new URL("/settings", request.url).toString(), 302);
}

// === Account deletion =======================================================

// The admin user cannot delete their own account from either /settings or /admin.
// They would lock themselves out of the admin surface permanently (the gate is
// the env var, not a role on the user row). To replace the admin, rotate
// ADMIN_USER_ID to a different user first, then delete the old admin account.
function isAdminUserId(env: Env, userId: string): boolean {
  return Boolean(env.ADMIN_USER_ID) && env.ADMIN_USER_ID === userId;
}

async function handleAccountDeleteConfirm(request: Request, env: Env): Promise<Response> {
  const session = await readSession(env.OAUTH_KV, request);
  if (!session) return Response.redirect(new URL("/login", request.url).toString(), 302);
  if (isAdminUserId(env, session.userId)) return renderAdminAccountProtectedPage();
  return renderAccountDeletePage(session);
}

// Revoke a single OAuth grant the user has issued to an MCP client. The
// library's revokeGrant(grantId, userId) enforces ownership, so a forged
// grantId belonging to another user is rejected — no need to re-check here.
async function handleSettingsRevokeClient(
  request: Request,
  env: Env,
  grantId: string,
): Promise<Response> {
  const session = await readSession(env.OAUTH_KV, request);
  if (!session) return Response.redirect(new URL("/login", request.url).toString(), 302);
  await env.OAUTH_PROVIDER.revokeGrant(grantId, session.userId);
  return Response.redirect(new URL("/settings", request.url).toString(), 302);
}

async function handleAccountDeleteExecute(request: Request, env: Env): Promise<Response> {
  const session = await readSession(env.OAUTH_KV, request);
  if (!session) return Response.redirect(new URL("/login", request.url).toString(), 302);
  if (isAdminUserId(env, session.userId)) return renderAdminAccountProtectedPage();

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

  return renderAdminUserPage(env, session, user, creds, grantCount);
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
  if (isAdminUserId(env, userId)) return renderAdminAccountProtectedPage();
  return renderAdminDeleteConfirmPage(user);
}

async function handleAdminDeleteExecute(
  request: Request,
  env: Env,
  userId: string,
): Promise<Response> {
  const session = await requireAdmin(request, env);
  if (!session) return adminNotFound();
  if (isAdminUserId(env, userId)) return renderAdminAccountProtectedPage();

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

// Admin debug + backfill: trigger a Withings → <dest> body-comp sync for an
// arbitrary user and date window. Intentionally bypasses the per-user toggle —
// this is an operator tool, not a user-facing setting. Useful to (a) test
// the sync pipeline without stepping on a scale and (b) recover from dropped
// Withings webhooks.
//
// Query params:
//   from=YYYY-MM-DD   — inclusive start of the local-date window (required)
//   to=YYYY-MM-DD     — inclusive end of the local-date window (required)
//   dest=intervals|hevy   — destination to sync to (default: intervals)
async function handleAdminWithingsSync(
  request: Request,
  env: Env,
  userId: string,
): Promise<Response> {
  const session = await requireAdmin(request, env);
  if (!session) return adminNotFound();
  const user = await getUser(env.OAUTH_KV, userId);
  if (!user) return adminNotFound();

  const url = new URL(request.url);
  const from = url.searchParams.get("from") ?? "";
  const to = url.searchParams.get("to") ?? "";
  const dest = url.searchParams.get("dest") ?? "intervals";
  const iso = /^\d{4}-\d{2}-\d{2}$/;
  if (!iso.test(from) || !iso.test(to)) {
    return new Response(
      JSON.stringify({ error: "from and to must be YYYY-MM-DD" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }
  const dispatch = WITHINGS_SYNC_DISPATCH[dest];
  if (!dispatch) {
    return new Response(
      JSON.stringify({
        error: `unknown dest=${dest}; expected one of ${Object.keys(WITHINGS_SYNC_DISPATCH).join(", ")}`,
      }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }
  // Coerce the window to a generous UTC bracket — the helper buckets by the
  // user's local TZ internally, so we overshoot in UTC and let it filter.
  const startUnix = Math.floor(Date.parse(`${from}T00:00:00Z`) / 1000) - 86400;
  const endUnix = Math.floor(Date.parse(`${to}T23:59:59Z`) / 1000) + 86400;
  if (!Number.isFinite(startUnix) || !Number.isFinite(endUnix)) {
    return new Response(
      JSON.stringify({ error: "could not parse from/to as dates" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }
  try {
    const readings = await fetchWithingsReadingsByDate(env, userId, startUnix, endUnix);
    const result = await dispatch(env, userId, readings);
    return new Response(JSON.stringify(result, null, 2), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[admin/withings/sync] dest=${dest} failed:`, msg);
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}

// Admin replay: trigger a Hevy → Intervals sync for a specific workout id.
// Bypasses the per-user `hevy.intervals` toggle — operator tool. Useful
// when Hevy's webhook didn't fire or the user's auth header was wrong at
// the time of the workout.
//
// Query params:
//   workoutId=<hevy-workout-uuid>   (required)
async function handleAdminHevySync(
  request: Request,
  env: Env,
  userId: string,
): Promise<Response> {
  const session = await requireAdmin(request, env);
  if (!session) return adminNotFound();
  const user = await getUser(env.OAUTH_KV, userId);
  if (!user) return adminNotFound();

  const url = new URL(request.url);
  const workoutId = (url.searchParams.get("workoutId") ?? "").trim();
  if (!workoutId) {
    return new Response(
      JSON.stringify({ error: "workoutId query param is required" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }
  try {
    const result = await syncHevyWorkoutToIntervals(env, userId, workoutId);
    return new Response(JSON.stringify(result, null, 2), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[admin/hevy/sync] userId=${userId} workoutId=${workoutId} failed:`, msg);
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
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
  if (!isProviderEnabled(env, provider)) {
    return { ok: false, error: `${PROVIDER_UIS.find((p) => p.name === provider)!.label} is not enabled on this environment.` };
  }
  const validator = VALIDATORS[provider];
  if (!validator) {
    // Defensive: loginViaProvider is only called from API-key paths. OAuth
    // providers (like Strava) take a different route (loginViaOAuth).
    return { ok: false, error: `${provider} uses OAuth, not API key paste — wrong code path.` };
  }
  const identity = await validator(env, apiKey);
  if (!identity) {
    return {
      ok: false,
      error: `${PROVIDER_UIS.find((p) => p.name === provider)!.label} rejected that key. Double-check the value and try again.`,
    };
  }

  const existingUserId = await lookupIdentity(env.OAUTH_KV, provider, identity.providerUserId);
  const currentSession = await readSession(env.OAUTH_KV, request);
  const refusal = refuseNonPrimarySignup(provider, existingUserId, currentSession);
  if (refusal) return refusal;
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

  // Hevy-only: auto-register the webhook subscription with Hevy so the user
  // doesn't have to paste the URL + token into Hevy's settings page manually.
  // POST is upsert-style on Hevy's side — safe to call on every save (initial
  // connect AND re-paste of a new key). Failures are logged but don't block
  // the connect flow; the user can still recover by setting it manually.
  if (provider === "hevy") {
    const webhookToken = await getOrCreateHevyWebhookToken(env.OAUTH_KV, userId);
    const notifyUrl = `${env.PUBLIC_URL.replace(/\/+$/, "")}/webhooks/hevy`;
    try {
      await subscribeHevyWebhook(apiKey, notifyUrl, webhookToken);
    } catch (e) {
      console.error(
        `[hevy/webhook-subscribe] userId=${userId} subscribe threw (continuing):`,
        e instanceof Error ? e.message : String(e),
      );
    }
  }

  return { ok: true, userId, displayName, linked };
}

// Returns a refusal LoginResult when the provider can't be used as a primary
// signin AND no existing session is present AND no existing identity link
// exists. This catches anyone bypassing the /login picker (which already
// hides non-primary providers) via curl or a direct /login/<provider> URL.
// Non-primary providers can still be linked to existing sessions (the
// /settings → connect flow), so the gate is specifically on "this would
// create a brand-new account."
function refuseNonPrimarySignup(
  provider: ProviderName,
  existingUserId: string | null,
  currentSession: Session | null,
): LoginResult | null {
  const ui = PROVIDER_UIS.find((p) => p.name === provider);
  if (!ui || ui.isPrimarySignin) return null;
  if (existingUserId || currentSession) return null; // either path leads to link, not signup
  return {
    ok: false,
    error: `${ui.label} can only be added to an existing account, not used as a sign-in method. Create your account with Intervals.icu or Strava first, then connect ${ui.label} from /settings.`,
  };
}

// OAuth flavor of the above: same find-or-create-or-link logic, but takes
// upstream-issued tokens + identity (already validated via successful code
// exchange) instead of a raw API key + validator call.
async function loginViaOAuth(
  request: Request,
  env: Env,
  provider: OAuthProviderName,
  identity: { providerUserId: string; displayName: string },
  tokens: { accessToken: string; refreshToken: string; expiresAt: number },
): Promise<LoginResult> {
  if (!isProviderEnabled(env, provider)) {
    return { ok: false, error: `${PROVIDER_UIS.find((p) => p.name === provider)!.label} is not enabled on this environment.` };
  }
  const existingUserId = await lookupIdentity(env.OAUTH_KV, provider, identity.providerUserId);
  const currentSession = await readSession(env.OAUTH_KV, request);
  const refusal = refuseNonPrimarySignup(provider, existingUserId, currentSession);
  if (refusal) return refusal;
  let userId: string;
  let displayName: string;
  let linked = false;

  if (existingUserId) {
    if (currentSession && currentSession.userId !== existingUserId) {
      return {
        ok: false,
        error: `This ${PROVIDER_UIS.find((p) => p.name === provider)!.label} account is already linked to a different user. Sign out of your current session first, then sign in with this account.`,
      };
    }
    userId = existingUserId;
    displayName = currentSession?.displayName ?? identity.displayName;
  } else if (currentSession) {
    userId = currentSession.userId;
    displayName = currentSession.displayName;
    await setIdentity(env.OAUTH_KV, provider, identity.providerUserId, userId);
    linked = true;
  } else {
    const user = await createUser(env.OAUTH_KV, identity.displayName);
    userId = user.userId;
    displayName = user.displayName;
    await setIdentity(env.OAUTH_KV, provider, identity.providerUserId, userId);
  }

  await setCred(env.OAUTH_KV, userId, provider, {
    apiKey: "",
    providerUserId: identity.providerUserId,
    displayName: identity.displayName,
    tokens: {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
    },
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

// Only API-key providers have validators. OAuth providers (Intervals, Strava,
// Oura, Withings) are connected via the OAuth flow and their "is this token
// still valid" check happens at MCP-tool call time via the upstream API.
const VALIDATORS: Partial<Record<ProviderName, (env: Env, key: string) => Promise<ProviderIdentity | null>>> = {
  hevy: validateHevyKey,
};

// === Provider UI metadata ===================================================

interface ProviderUI {
  name: ProviderName;
  label: string;
  description: string;
  helpUrl: string;
  helpText: string;
  /** "apikey" = paste-key form on /login. "oauth" = redirect-to-provider button. */
  authType: "apikey" | "oauth";
  /** Where to find the key (only relevant for apikey providers). */
  keyLocation?: string;
  /**
   * Whether this provider can be used as the FIRST signin to create a new
   * workoutcontext.fit account. Non-primary providers (Hevy, Oura) can still
   * be connected from /settings once the user is signed in — they're just
   * hidden from the /login and /authorize provider pickers and refused at
   * the auth handlers when there's no existing session.
   */
  isPrimarySignin: boolean;
}

const PROVIDER_UIS: ProviderUI[] = [
  {
    name: "intervals",
    label: "Intervals.icu",
    description: "Training calendar, activities, wellness, and structured workouts.",
    helpUrl: "https://intervals.icu/settings",
    helpText: "Free for all intervals.icu accounts.",
    authType: "oauth",
    isPrimarySignin: true,
  },
  {
    name: "strava",
    label: "Strava",
    description: "Activities, segments, routes, and gear. Read + write.",
    helpUrl: "https://www.strava.com/settings/apps",
    helpText: "Free for all Strava accounts.",
    authType: "oauth",
    isPrimarySignin: true,
  },
  {
    name: "oura",
    label: "Oura",
    description: "Sleep, readiness, activity, workouts, HR, SpO₂, and resilience. Read-only.",
    helpUrl: "https://cloud.ouraring.com/oauth/applications",
    helpText: "Free for all Oura accounts.",
    authType: "oauth",
    isPrimarySignin: false,
  },
  {
    name: "withings",
    label: "Withings",
    description: "Body composition, sleep, blood pressure, heart events, activity, and workouts. Read-only.",
    helpUrl: "https://account.withings.com/partner/dashboard_oauth2",
    helpText: "Free for all Withings accounts.",
    authType: "oauth",
    isPrimarySignin: false,
  },
  {
    name: "hevy",
    label: "Hevy",
    description: "Strength workouts and routines.",
    helpUrl: "https://hevy.com/settings?developer",
    helpText: "Requires a Hevy Pro subscription.",
    authType: "apikey",
    keyLocation: "hevy.com → Settings → Developer",
    isPrimarySignin: false,
  },
];

// === Per-provider on/off toggle =============================================
//
// Each provider has an in-code default. The corresponding env var can
// override either direction:
//   <NAME>_ENABLED = "1" / "true"   → force on
//   <NAME>_ENABLED = "0" / "false"  → force off
//   unset                            → use default below
//
// The toggle gates UI visibility (PROVIDER_UIS filtered via activeProviders),
// the auth handlers (refuse if disabled), and MCP tool registration (skip
// disabled providers in index.ts).
// All providers default off — every environment must explicitly opt in.
// This makes deploys safer (a forgotten env var hides a provider rather
// than exposing it unconfigured) and forces both staging and prod to
// have a deliberate config record for each provider.
export const PROVIDER_DEFAULT_ENABLED: Record<ProviderName, boolean> = {
  intervals: false,
  hevy: false,
  withings: false,
  strava: false,
  oura: false,
};

export function isProviderEnabled(env: Env, name: ProviderName): boolean {
  const key = `${name.toUpperCase()}_ENABLED` as keyof Env;
  const v = env[key];
  if (v === "1" || v === "true") return true;
  if (v === "0" || v === "false") return false;
  return PROVIDER_DEFAULT_ENABLED[name];
}

function activeProviders(env: Env): ProviderUI[] {
  return PROVIDER_UIS.filter((ui) => isProviderEnabled(env, ui.name));
}

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
  // /login and /authorize pickers only show providers marked as primary
  // sign-in. Non-primary providers (Hevy, Oura) are still connectable from
  // /settings once the user is signed in.
  return activeProviders(env).filter((ui) => ui.isPrimarySignin).map((ui) => {
    const localError = errorProvider === ui.name ? errorMessage : null;
    const errorBlock = localError ? `<div class="error">${escape(localError)}</div>` : "";

    if (ui.authType === "oauth") {
      // OAuth providers: render a "Sign in with X" link that triggers a
      // server-side redirect to the provider's authorize URL. State (if any)
      // travels as a query param so we can resume the MCP OAuth flow after
      // the provider's callback.
      const href = state !== null
        ? `${prefix}/${escape(ui.name)}?state=${encodeURIComponent(state)}`
        : `${prefix}/${escape(ui.name)}`;
      return `
        <section class="provider">
          <h2>${escape(ui.label)}</h2>
          <p>${escape(ui.description)} <span class="muted">${escape(ui.helpText)}</span></p>
          ${errorBlock}
          <div class="actions">
            ${oauthButtonLink(ui.name, ui.label, href)}
          </div>
        </section>`;
    }

    // API-key provider: paste-key form
    return `
      <section class="provider">
        <h2>${escape(ui.label)}</h2>
        <p>${escape(ui.description)} <span class="muted">${escape(ui.helpText)}</span></p>
        ${errorBlock}
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
              <span class="key-path">${escape(ui.keyLocation ?? "")}</span>
            </div>
          </div>
        </form>
      </section>`;
  }).join("\n");
}

// Renders the "Auto-sync to:" block at the bottom of a provider card. One
// row per registered (source → dest) sync where the dest is active in this
// env; the whole row is a click-to-toggle button.
//
// Click-to-toggle: the form's hidden `enabled` field always carries the
// INVERSE of the current state, so one click flips it server-side. No Save
// button. Button is disabled when the dest provider isn't connected — the
// persisted state still shows in the label so the user can see what'll
// re-activate after they reconnect.
//
// Returns "" when the source has no registered syncs in this env (so the
// caller can drop it into the card unconditionally).
function renderProviderSyncRows(
  env: Env,
  source: ProviderName,
  syncs: Record<string, boolean>,
  destConnected: Record<string, boolean>,
): string {
  const active = new Set(activeProviders(env).map((p) => p.name));
  const rows = syncsForSource(source).filter((s) => active.has(s.dest));
  if (rows.length === 0) return "";

  const rowsHtml = rows.map((sync) => {
    const destUi = PROVIDER_UIS.find((p) => p.name === sync.dest);
    const destLabel = destUi?.label ?? sync.dest;
    const enabled = isSyncEnabled(syncs, sync.source, sync.dest);
    const disabled = !destConnected[sync.dest];
    const stateEmoji = enabled ? "🟢" : "⚪";
    const action = enabled ? "Turn off" : "Turn on";
    const nextValue = enabled ? "" : "1"; // submit flips: empty disables, "1" enables
    const buttonLabel = `${stateEmoji} ${sync.contentLabel} → ${destLabel}`;
    const ariaLabel = `${action} ${sync.contentLabel.toLowerCase()} sync to ${destLabel}`;
    const fieldsLine = sync.customFields && sync.customFields.length > 0
      ? `<p class="sync-fields">Custom ${destLabel} fields: ${sync.customFields.map((f) => `<code>${escape(f)}</code>`).join(", ")}</p>`
      : "";
    const notesLines = (sync.notes ?? [])
      .map((n) => `<p class="sync-fields">${escape(n)}</p>`)
      .join("\n");
    const disabledHint = disabled
      ? `<p class="sync-hint">Connect ${escape(destLabel)} to enable.</p>`
      : "";
    return `
      <form method="POST" action="/settings/sync-toggle" class="sync-toggle-row">
        <input type="hidden" name="source" value="${escape(sync.source)}" />
        <input type="hidden" name="dest" value="${escape(sync.dest)}" />
        <input type="hidden" name="enabled" value="${nextValue}" />
        <button type="submit" class="sync-row"${disabled ? " disabled" : ""} aria-label="${escape(ariaLabel)}">${escape(buttonLabel)}</button>
        ${fieldsLine}
        ${notesLines}
        ${disabledHint}
      </form>`;
  }).join("\n");

  return `
    <div class="sync-block">
      <p class="sync-block-label">Auto-sync to:</p>
      ${rowsHtml}
    </div>`;
}

// Renders the Hevy webhook status disclosure. The notify URL + per-user
// auth token are now registered with Hevy automatically on every Hevy key
// save, so the user doesn't need to paste anything. The disclosure still
// exists for operator visibility + manual token rotation.
function renderHevyWebhookBlock(
  notifyUrl: string,
  token: string,
): string {
  return `
    <details class="webhook-setup">
      <summary>Live-sync webhook (auto-managed)</summary>
      <p class="muted">Registered with <a href="https://hevy.com/settings?developer" target="_blank" rel="noopener noreferrer">Hevy</a> automatically when you connect — Hevy POSTs us on every workout save. No manual setup needed.</p>
      <p class="webhook-row"><strong>Notify URL</strong> <code>${escape(notifyUrl)}</code></p>
      <p class="webhook-row"><strong>Auth token</strong> <code>${escape(token)}</code></p>
      <form method="POST" action="/settings/hevy/rotate-webhook-token">
        <div class="actions">
          <button type="submit" class="secondary">Rotate token</button>
          <span class="help muted">Mints a new value and re-registers with Hevy. The old token stops working immediately.</span>
        </div>
      </form>
    </details>`;
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
    activeProviders(env).map(async (ui) => {
      const existing = await getCred(env.OAUTH_KV, session.userId, ui.name);
      // For API-key providers, re-validate the stored key on every settings
      // page load. For OAuth providers (no entry in VALIDATORS), the
      // equivalent check happens lazily at MCP-tool call time via the
      // access-token refresh path; we trust the cred row here.
      const validator = VALIDATORS[ui.name];
      const validated = existing
        ? validator
          ? await validator(env, existing.apiKey).catch(() => null)
          : { providerUserId: existing.providerUserId, displayName: existing.displayName }
        : null;
      return { ui, existing, validated };
    }),
  );
  const connectedCount = credsAndValidation.filter((c) => c.existing).length;
  const connectedPrimarySigninCount = credsAndValidation.filter(
    (c) => c.existing && c.ui.isPrimarySignin,
  ).length;
  // Per-user prefs for the auto-sync rows rendered at the bottom of each
  // provider card. destConnected feeds the per-row disabled state — a sync's
  // target needs an active cred for the toggle to do anything.
  const userSettings = await getUserSettings(env.OAUTH_KV, session.userId);
  const destConnected: Record<string, boolean> = Object.fromEntries(
    credsAndValidation.map((c) => [c.ui.name, Boolean(c.existing && c.validated)]),
  );

  // Generate the Hevy webhook token lazily if Hevy is connected. Pasted by
  // the user into Hevy's notify-settings page; pre-computed here so the
  // /settings page can render it inline rather than via a separate fetch.
  const hevyConnected = credsAndValidation.some(
    (c) => c.ui.name === "hevy" && c.existing && c.validated,
  );
  const hevyWebhookToken = hevyConnected
    ? await getOrCreateHevyWebhookToken(env.OAUTH_KV, session.userId)
    : null;
  const hevyWebhookUrl = `${env.PUBLIC_URL.replace(/\/+$/, "")}/webhooks/hevy`;

  // Fetch every OAuth grant this user has issued — each one represents an MCP
  // client (Claude, Claude Code, etc.) that's been authorized to call tools on
  // their behalf. lookupClient is deduped via the cache below so multiple
  // grants for the same client only cost one lookup.
  type ConnectedClient = {
    grantId: string;
    clientId: string;
    clientName: string | null;
    scope: string[];
    createdAt: number;
    expiresAt: number | undefined;
  };
  const grantsRaw: Array<{
    id: string;
    clientId: string;
    scope: string[];
    createdAt: number;
    expiresAt?: number;
  }> = [];
  {
    let cursor: string | undefined;
    do {
      const result = await env.OAUTH_PROVIDER.listUserGrants(session.userId, { cursor });
      grantsRaw.push(...result.items);
      cursor = result.cursor;
    } while (cursor);
  }
  const clientLookups = new Map<string, Promise<{ clientName?: string } | null>>();
  const connectedClients: ConnectedClient[] = await Promise.all(
    grantsRaw.map(async (g) => {
      let p = clientLookups.get(g.clientId);
      if (!p) {
        p = env.OAUTH_PROVIDER.lookupClient(g.clientId).catch(() => null);
        clientLookups.set(g.clientId, p);
      }
      const info = await p;
      return {
        grantId: g.id,
        clientId: g.clientId,
        clientName: info?.clientName ?? null,
        scope: g.scope,
        createdAt: g.createdAt,
        expiresAt: g.expiresAt,
      };
    }),
  );
  // Newest grant first
  connectedClients.sort((a, b) => b.createdAt - a.createdAt);

  const sections = credsAndValidation.map(({ ui, existing, validated }) => {
    const isStale = Boolean(existing && !validated);
    const localError = errorProvider === ui.name ? errorMessage : null;
    // Disconnect is blocked when:
    //   - this is the user's only connection at all (current existing rule),
    //     OR
    //   - this is a primary signin provider and the user's only primary
    //     signin (so they always retain a sign-in path).
    const isLastConnection = Boolean(existing && connectedCount <= 1);
    const isOnlySignin = Boolean(
      existing && ui.isPrimarySignin && connectedPrimarySigninCount <= 1,
    );
    const disconnectBlocked = isLastConnection || isOnlySignin;

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
        const keyOrTokens =
          ui.authType === "oauth"
            ? `<span class="muted">OAuth tokens stored, auto-refreshing.</span>`
            : `key <code>${escape(mask(existing.apiKey))}</code>`;
        const extras = renderProviderSyncRows(
          env,
          ui.name,
          userSettings.syncs ?? {},
          destConnected,
        );
        const webhookBlock =
          ui.name === "hevy" && hevyWebhookToken
            ? renderHevyWebhookBlock(hevyWebhookUrl, hevyWebhookToken)
            : "";
        return `
        <section class="provider">
          ${header}
          <p class="current">Connected as <strong>${escape(existing.displayName)}</strong> <span class="muted">(${escape(existing.providerUserId)})</span> · ${keyOrTokens}</p>
          ${errorBlock}
          ${
            disconnectBlocked
              ? `<p class="muted">${
                  isOnlySignin
                    ? "This is your only sign-in provider — disconnect would leave the account inaccessible. Connect another sign-in provider first."
                    : "This is your only connected provider. Connect another to enable disconnect, or delete the account from the Danger zone below."
                }</p>`
              : `<form method="POST" action="/settings/${escape(ui.name)}/disconnect">
            <div class="actions">
              <button type="submit" class="secondary">Disconnect ${escape(ui.label)}</button>
              <span class="help muted">${ui.authType === "oauth" ? "To re-authorize, disconnect first, then reconnect." : "To rotate the key, disconnect first, then reconnect."}</span>
            </div>
          </form>`
          }
          ${extras}
          ${webhookBlock}
        </section>`;
      }

      const staleBanner = isStale && existing
        ? `<div class="warning">${escape(ui.label)} rejected the stored key just now (it may have been regenerated or revoked). Paste a new key below to reconnect — previously linked as <strong>${escape(existing.displayName)}</strong> (${escape(existing.providerUserId)}).</div>`
        : "";

      const staleDisconnect = isStale && !disconnectBlocked
        ? `<button type="submit" formaction="/settings/${escape(ui.name)}/disconnect" formnovalidate class="secondary">Remove stored key</button>`
        : "";

      // OAuth providers: render a redirect button instead of a paste-key form.
      if (ui.authType === "oauth") {
        return `
        <section class="provider">
          ${header}
          ${staleBanner}
          ${errorBlock}
          <div class="actions">
            ${oauthButtonLink(ui.name, ui.label, `/login/${escape(ui.name)}`)}
            ${
              isStale && !disconnectBlocked
                ? `<form method="POST" action="/settings/${escape(ui.name)}/disconnect" style="margin:0"><button type="submit" class="secondary">Remove stored credentials</button></form>`
                : ""
            }
          </div>
        </section>`;
      }

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
                <span class="key-path">${escape(ui.keyLocation ?? "")}</span>
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
    <p>Connect any provider below to link it to this account. Most providers redirect you to sign in via OAuth; Hevy uses a pasted API key.</p>
    <p class="muted">After connecting a new provider, refresh the tools list in Claude (or your AI client) — the new tools won't appear until you do.</p>
    ${sections.join("\n")}

    <h1>Connected MCP clients</h1>
    <p class="muted">AI clients you've authorized to call this server on your behalf. Each appears here after you complete the authorize flow from Claude (or another MCP client).</p>
    ${
      connectedClients.length === 0
        ? `<p class="muted">No MCP clients are currently connected.</p>`
        : `<ul class="clients">${connectedClients
            .map((c) => {
              const name = c.clientName?.trim() || "Unnamed client";
              const expiresLine = c.expiresAt
                ? ` · expires ${escape(formatDate(c.expiresAt * 1000))}`
                : "";
              const scopeLine = c.scope.length
                ? `<div class="muted client-meta">scopes: ${escape(c.scope.join(", "))}</div>`
                : "";
              return `<li class="client">
                <div class="client-head">
                  <div>
                    <strong>${escape(name)}</strong>
                    <span class="muted">· <code>${escape(c.clientId.slice(0, 8))}…</code></span>
                  </div>
                  <form method="POST" action="/settings/clients/${escape(c.grantId)}/revoke" style="margin:0">
                    <button type="submit" class="secondary small">Revoke</button>
                  </form>
                </div>
                ${scopeLine}
                <div class="muted client-meta">granted ${escape(formatDate(c.createdAt * 1000))}${expiresLine}</div>
              </li>`;
            })
            .join("")}</ul>`
    }

    <section class="danger-zone">
      <h2>Danger zone</h2>
      ${
        isAdminUserId(env, session.userId)
          ? `<p>Account deletion is disabled for this account because it is the configured admin (<code>ADMIN_USER_ID</code>). Rotate the admin env var to a different user first if you want to delete this one.</p>`
          : `<p>Permanently delete this account: revokes all MCP client sessions, removes every stored credential and provider link, and clears your user record. Re-signing in with the same provider key afterward creates a fresh account.</p>
            <form method="POST" action="/settings/account/delete">
              <div class="actions">
                <button type="submit" class="danger">Delete account…</button>
              </div>
            </form>`
      }
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
  env: Env,
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
      ${
        isAdminUserId(env, user.userId)
          ? `<p>Deletion is disabled for this user because they are the configured admin (<code>ADMIN_USER_ID</code>). Rotate the admin env var to a different user first if you want to delete this one.</p>`
          : `<p>Deleting this user wipes all credentials, identity links, sessions, OAuth grants, and the user record. This cannot be undone.</p>
            <form method="POST" action="/admin/users/${escape(user.userId)}/delete">
              <div class="actions">
                <button type="submit" class="danger">Delete user…</button>
              </div>
            </form>`
      }
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

function renderAdminAccountProtectedPage(): Response {
  const body = `
    <header class="topbar">
      <div></div>
      <a href="/">Home</a>
    </header>
    <h1>Admin account is protected</h1>
    <p>The admin account cannot be deleted — doing so would lock the admin out of <a href="/admin">/admin</a> permanently (the gate is the <code>ADMIN_USER_ID</code> env var, not a role on the user row).</p>
    <p>To delete this account, first rotate <code>ADMIN_USER_ID</code> to a different user via <code>wrangler secret put ADMIN_USER_ID</code>, then re-attempt the deletion. To disable admin entirely, unset the env var with <code>wrangler secret delete ADMIN_USER_ID</code>.</p>
  `;
  return htmlResponse("Admin protected", body, 403);
}

function formatDate(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

function htmlResponse(
  title: string,
  body: string,
  status: number,
  extraHeaders?: Record<string, string>,
): Response {
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
       ul.clients{list-style:none;padding-left:0;margin:1rem 0;display:flex;flex-direction:column;gap:.5rem}
       li.client{border:1px solid var(--brd);padding:.6rem .9rem;background:var(--bg)}
       .client-meta{font-size:.8rem;margin-top:.15rem}
       .client-head{display:flex;justify-content:space-between;align-items:center;gap:.75rem}
       button.small{padding:.25rem .6rem;font-size:.8rem}
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
       a.strava-connect{display:inline-block;line-height:0;text-decoration:none}
       a.strava-connect img{display:block;height:48px;width:auto;max-width:100%}
       a.strava-connect:hover{opacity:.9}
       figure.feature-shot{margin:1rem 0 2rem;border:1px solid var(--brd);background:var(--bg);padding:.5rem}
       figure.feature-shot img{display:block;width:100%;height:auto}
       figure.hero-demo{margin:1.5rem 0 2rem;border:1px solid var(--brd);background:var(--bg);padding:.5rem}
       figure.hero-demo video{display:block;width:100%;height:auto}
       .admin-table{width:100%;border-collapse:collapse;font-size:.85rem;margin:.5rem 0 1rem}
       .admin-table th,.admin-table td{text-align:left;padding:.4rem .5rem;border-bottom:1px solid var(--brd)}
       .admin-table th{font-weight:600;color:var(--mut);text-transform:uppercase;font-size:.7rem;letter-spacing:.04em}

       /* Provider auto-sync rows: text-link buttons rendered as a flat
          left-aligned list at the bottom of each provider card. */
       .sync-block{margin-top:1.75rem;display:flex;flex-direction:column;gap:.5rem}
       .sync-block-label{color:var(--mut);margin:0;font-size:.85rem}
       form.sync-toggle-row{margin:0;gap:.15rem}
       button.sync-row{background:transparent;color:var(--fg);border:none;padding:.15rem 0;text-align:left;cursor:pointer;font:inherit;text-decoration:none;display:inline-block;width:fit-content}
       button.sync-row:hover:not([disabled]){background:transparent;border:none;color:#000;text-decoration:underline}
       button.sync-row[disabled]{color:var(--mut);cursor:not-allowed;text-decoration:none}
       .sync-fields{font-size:.8rem;color:var(--mut);margin:0;padding-left:1.5rem}
       .sync-fields code{font-size:.8rem;color:var(--mut)}
       .sync-hint{font-size:.8rem;color:var(--mut);margin:0;padding-left:1.5rem;font-style:italic}

       /* Hevy webhook setup disclosure — same top-margin as .sync-block so it
          sits with breathing room beneath the auto-sync rows. */
       .webhook-setup{margin-top:1.75rem}
       .webhook-setup summary{cursor:pointer;color:var(--mut);font-size:.85rem}
       .webhook-setup p{margin:.5rem 0}
       .webhook-row code{word-break:break-all;font-size:.85rem}

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
         /* Sync-row text-links keep their natural width and left alignment
            on mobile — they aren't tap-target-y, they read as list items. */
         button.sync-row{width:auto;text-align:left;padding:.15rem 0}
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
     </head><body>${body}<footer class="byline">Made with &lt;3 by <a href="https://jae.works/" target="_blank" rel="noopener noreferrer">Il Jae Lee</a><span class="build muted"> · build <a href="https://github.com/agiantwhale/workoutcontext/commit/${escape(GIT_COMMIT_FULL)}" target="_blank" rel="noopener noreferrer"><code>${escape(GIT_COMMIT_SHORT)}</code></a></span></footer></body></html>`,
    {
      status,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        ...(extraHeaders ?? {}),
      },
    },
  );
}

// === Helpers ================================================================

// Strava brand guidelines require their official "Connect with Strava"
// button asset (https://developers.strava.com/guidelines/). Other OAuth
// providers (future Withings, etc.) get a plain styled button until we add
// branded assets for them too.
function oauthButtonLink(name: ProviderName, label: string, href: string): string {
  if (name === "strava") {
    return `<a class="strava-connect" href="${href}" aria-label="Connect with Strava">
      <img src="${STRAVA_CONNECT_BUTTON_DATA_URL}" alt="Connect with Strava" width="237" height="48" />
    </a>`;
  }
  return `<a class="button" href="${href}">Sign in with ${escape(label)}</a>`;
}

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

function redirectWithCookies(location: string, setCookies: string[]): Response {
  const headers = new Headers();
  headers.set("Location", location);
  for (const c of setCookies) headers.append("Set-Cookie", c);
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
