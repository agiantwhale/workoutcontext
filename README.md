# workoutcontext.fit

> Turn your AI assistant into a coach that actually knows you.

Multi-tenant MCP server for **Intervals.icu** and **Hevy**, running on Cloudflare Workers. Users sign up by pasting a provider API key into a hosted form; their credentials are stored per-user and surfaced as MCP tools to any AI client (Claude.ai, Claude Desktop, ChatGPT, Gemini).

Live at **https://workoutcontext.fit**.

---

## What it does

- Hosts the standard OAuth 2.1 endpoints (`/authorize`, `/token`, `/register`) that MCP clients expect, plus a custom login form where users paste their Intervals.icu or Hevy API key.
- Validates pasted keys against the upstream provider before storage; re-validates on every `/settings` page load and surfaces an inline warning for revoked / stale keys.
- Maintains an internal UUID-based identity model with a provider-identity index so a user can sign in via either provider and link the other later (or be refused if they paste a key already linked to someone else's account).
- **Conditionally registers each provider's tools per-user.** Connected providers get their full tool set (~129 intervals tools, ~22 hevy tools). Unconnected providers get a single `connect_<provider>` shim that mints a single-use magic-link URL for onboarding from inside a chat — the API key never enters the LLM context.
- Browser `/settings` page for connect / disconnect / rotate. Enforces "at least one provider must be connected" — full account deletion is the only path to zero connections.
- Account deletion immediately revokes every OAuth grant the user has issued and wipes all per-user KV rows.

## Source layout

```
src/
├── index.ts          # OAuthProvider entry; WorkoutContextMCP Durable Object
├── auth-handler.ts   # /, /privacy, /authorize, /login, /settings, /onboard
├── storage.ts        # KV-backed user records, identity index, cred rows, magic-link tokens
├── session.ts        # Browser session cookies (separate from MCP OAuth tokens)
├── intervals.ts      # Intervals.icu client + 129 tools
├── hevy.ts           # Hevy client + 22 tools
└── util.ts           # JSON-response compactor for token efficiency
```

## KV layout

| Key | Value | TTL |
|---|---|---|
| `user:<userId>` | `{userId, displayName, createdAt}` | none |
| `identity:<provider>:<providerUserId>` | `<userId>` | none |
| `cred:<userId>:<provider>` | `{apiKey, providerUserId, displayName}` | none |
| `session:<sessionId>` | `{userId, displayName, expiresAt}` | 7 days |
| `onboard:<token>` | `<userId>` | 10 min, single-use |
| `oauth:*` | managed by `@cloudflare/workers-oauth-provider` | per-grant |

`userId` is a random UUID minted at signup — never a provider's id. `providerUserId` is the stable id returned by the provider's identity endpoint (Intervals: numeric athlete id; Hevy: account UUID).

## `debug_trace` MCP tool

A global tool registered for every authenticated session that lets the LLM file a **structured bug report** when the user is dissatisfied with a tool's result. The report becomes a GitHub Issue in a private feedback repo for the maintainer to triage. Feedback closes the loop on tool descriptions, schemas, and behavior.

**Privacy posture.** Issues land in a **private** GitHub repo. The tool description explicitly tells the LLM to paraphrase and never paste raw user messages, raw tool-call response bodies, or biometric numbers verbatim. The schema enforces a length cap on every field. We treat issue contents as if they could leak.

**Rate limit.** One filing per user per 5 minutes, enforced via KV row `debug-trace-rate-limit:<userId>` with a 300s TTL.

**Configuration secrets** (both required for the tool to file; absence yields a clean "not configured" response, not a throw):

```sh
# Fine-grained PAT scoped to the feedback repo, `Issues: write` only.
npx wrangler secret put GITHUB_ISSUE_TOKEN

# "<owner>/<repo>" — e.g. "agiantwhale/workoutcontext-feedback"
npx wrangler secret put GITHUB_ISSUE_REPO
```

Each filed issue is auto-labeled `debug-trace` and the title is prefixed `[debug-trace] …` for filtering.

## Webhooks

### `POST /withings/notify` — Withings Notify API

Withings calls this endpoint when an event happens for a connected user. The endpoint is subscribed automatically during the Withings OAuth callback (one subscription per `appli` code, per user). The endpoint is unauthenticated — security comes from looking the `userid` up in our local `identity:withings:<providerUserId>` index, so a forged callback for an unknown user is a no-op.

**Schema references:**
- [Notify request format & appli code list](https://developer.withings.com/developer-guide/v3/integration-guide/public-health-data-api/data-api/notifications/notification-content/) — `userid` / `appli` / `action` semantics
- [Withings data API developer guide](https://developer.withings.com/developer-guide/v3/data-api/) — full surface

**What Withings sends us:**

| Method | Purpose | Body |
|---|---|---|
| `HEAD` / `GET` | Preflight reachability check before activating a subscription | (none) |
| `POST` | Event notification | `application/x-www-form-urlencoded`: `userid=<int>&appli=<int>&action=<str>[&startdate=<unix>&enddate=<unix>]` |

**What we always return: `200`.**

Even on malformed bodies, unknown `userid`s, or unrecognized `action`s, the handler returns 200 with an empty body. Withings retries non-2xx responses (historically up to 3 times with backoff); returning 200 prevents retry storms when the cause isn't recoverable. Anything we'd want a human to see goes to `console.error` and shows up in `wrangler tail`.

**Dispatch table:**

| `appli` | `action` | Side effect on KV |
|---|---|---|
| `46` (user actions) | `unlink` | Delete `cred:<userId>:withings`; keep `identity:withings:<providerUserId>` so re-link finds the same user |
| `46` | `delete` | Delete cred row **and** identity row — that Withings userid is gone forever |
| `46` | unknown | Logged and ignored |
| any other `appli` | * | Currently ignored (measurement sync via `appli=1` lands in a follow-up PR) |

`appli=46` is subscribed by `subscribeWithingsNotify(...)` in `src/withings.ts`; `appli=1` will fold into the same code path once measurement sync ships.

## Local dev

```sh
npm install
cp .dev.vars.example .dev.vars   # PUBLIC_URL, INVITE_CODE (optional), DEV_ALLOW_FAKE_KEYS
npm run dev                      # http://localhost:8787
```

To exercise multi-account scenarios without real provider keys, set `DEV_ALLOW_FAKE_KEYS=1` and paste sentinels like `DEV_INTERVALS_alice` or `DEV_HEVY_account-x` into the login forms. The validators short-circuit these to fake identities. **Never set `DEV_ALLOW_FAKE_KEYS` in production** — it would let anyone create accounts with arbitrary provider identities.

## Deploy

The Worker auto-deploys via Workers Builds on push to `main`. For ad-hoc deploys:

```sh
npm run deploy
```

One-time setup on a fresh Cloudflare account:

```sh
# Create the KV namespace and put its returned id into wrangler.jsonc
npx wrangler kv namespace create workoutcontext-fit-oauth

# Required secrets
npx wrangler secret put PUBLIC_URL        # e.g. https://workoutcontext.fit
npx wrangler secret put INVITE_CODE       # optional; gates /login + /authorize POSTs
```

`PUBLIC_URL` is the only one whose absence causes user-visible breakage — the `connect_<provider>` magic links are built against it.

### Per-PR preview deploys

Every PR (from this repo, not forks) gets its own isolated Cloudflare Worker, KV namespace, and custom subdomain via `.github/workflows/preview-deploy.yml`:

| Event | Effect |
|---|---|
| PR opened / synchronize | Create-or-update worker `workoutcontext-pr-<n>`, KV namespace `workoutcontext-pr-<n>-oauth`, snapshot staging's KV into it, custom hostname `pr-<n>-preview.workoutcontext.fit`, push secrets, post a sticky comment with the URL |
| PR closed | Delete worker, KV namespace, and custom-domain attachment |

The KV snapshot means previews can be browsed as an existing staging user — sessions, creds, OAuth grants all carry over. The snapshot refreshes on every push, and per-PR writes stay in the per-PR namespace, so staging data is never touched.

OAuth flows and inbound webhooks **won't reach preview URLs** — provider redirect URIs and webhook URLs are registered against `staging.workoutcontext.fit`. Use staging for OAuth/webhook PRs; preview is meant for HTML / copy / internal-logic review.

One-time setup on the repo:

1. **Cloudflare API token.** Easiest path: start from the "Edit Cloudflare Workers" template and narrow the Zone resource to `workoutcontext.fit`. If building a custom token manually, you need:
   - Account → `Workers Scripts:Edit`
   - Account → `Workers KV Storage:Edit`
   - Add a **Zone** resource (`workoutcontext.fit`) → `Workers Routes:Edit`
     (this permission is zone-scoped — it doesn't appear in the Account-level dropdown. Custom Domains for Workers auto-manages DNS records, so no separate `DNS:Edit` is needed.)
2. **Repo-level GitHub Actions secrets.** Under *Settings → Secrets and variables → Actions*:
   - `CLOUDFLARE_API_TOKEN` — the token above
   - `CLOUDFLARE_ACCOUNT_ID`
   - `CLOUDFLARE_ZONE_ID` — zone id for `workoutcontext.fit`
   - `WC_*` mirror of every secret that staging needs — same value as on staging:
     - `WC_INTERVALS_CLIENT_ID`, `WC_INTERVALS_CLIENT_SECRET`
     - `WC_STRAVA_CLIENT_ID`, `WC_STRAVA_CLIENT_SECRET`
     - `WC_OURA_CLIENT_ID`, `WC_OURA_CLIENT_SECRET`
     - `WC_WITHINGS_CLIENT_ID`, `WC_WITHINGS_CLIENT_SECRET`, `WC_WITHINGS_DEFAULT_TZ`
     - `WC_INTERVALS_WEBHOOK_TOKEN`
     - `WC_INVITE_CODE`, `WC_ADMIN_USER_ID`
     - `WC_GITHUB_ISSUE_TOKEN`, `WC_GITHUB_ISSUE_REPO`

`PUBLIC_URL` is computed per-PR (`https://pr-<n>-preview.workoutcontext.fit`) and pushed automatically — don't add it as a repo secret. The hostname is kept one level deep on purpose so it falls under the zone's existing `*.workoutcontext.fit` Universal SSL wildcard — TLS provisioning is instant on first attach.

## Adding a new provider

For an API-key provider (the simple case):

1. Drop `src/<provider>.ts` that exports `register<Provider>Tools(server, getApiKey: () => Promise<string>)` and wraps the upstream HTTP API.
2. Extend `ProviderName` + `CredTypes` in `storage.ts`.
3. Add the entry to `PROVIDERS` in `index.ts` and `PROVIDER_UIS` in `auth-handler.ts`.
4. Add a `validate<Provider>Key(env, apiKey)` in `auth-handler.ts` that calls the provider's identity endpoint and returns `{providerUserId, displayName}` on success — and register it in the `VALIDATORS` map.

Login flow, settings UI, conditional tool registration, and magic-link onboarding all pick up the new provider automatically.

For an OAuth provider (Strava / Withings / etc.) the shape is bigger — you also need a per-user OAuth bootstrap flow and refresh-token rotation. See `fitness-mcp` (the single-user predecessor) for working examples.

## Privacy

See [/privacy](https://workoutcontext.fit/privacy) for an exhaustive list of what's stored, what isn't, and which third parties (Cloudflare, Intervals.icu, Hevy, Google Fonts) are involved. The page reflects the source — there's no hidden telemetry.

## License

MIT — see [LICENSE](./LICENSE).

## Made by

[Il Jae Lee](https://jae.works/)
