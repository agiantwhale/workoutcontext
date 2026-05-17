import { OAuthProvider, type OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AuthHandler } from "./auth-handler.js";
import { registerIntervalsTools } from "./intervals.js";
import { registerHevyTools } from "./hevy.js";
import { createOnboardToken, getCred, type ProviderName } from "./storage.js";

export type Props = {
  userId: string;
  displayName: string;
};

export interface Env {
  INVITE_CODE: string;
  PUBLIC_URL: string;
  // Dev-only escape hatch. When truthy ("1" / "true"), the intervals + hevy
  // validators accept sentinel keys (DEV_INTERVALS_<id>, DEV_HEVY_<id>) without
  // contacting the upstream API, so you can stage multi-account scenarios
  // locally. NEVER set this in production — it lets anyone create accounts
  // with arbitrary provider identities.
  DEV_ALLOW_FAKE_KEYS: string;
  OAUTH_KV: KVNamespace;
  MCP_OBJECT: DurableObjectNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
}

interface ProviderRegistration {
  name: ProviderName;
  label: string;
  register: (server: McpServer, getKey: () => Promise<string>) => void;
}

const PROVIDERS: ProviderRegistration[] = [
  { name: "intervals", label: "intervals.icu", register: registerIntervalsTools },
  { name: "hevy", label: "Hevy", register: registerHevyTools },
];

export class WorkoutContextMCP extends McpAgent<Env, unknown, Props> {
  server = new McpServer({ name: "workoutcontext.fit", version: "0.1.0" });

  async init() {
    const userId = this.props?.userId;
    if (!userId) return; // no valid grant, nothing to register

    // Look up which providers this user has actually connected, then register
    // the real tools for connected ones and a single connect_<provider> shim
    // for the rest. Keeps the LLM's tool list focused on what it can actually
    // call — and gives the user a discoverable path to connect more.
    const creds = await Promise.all(
      PROVIDERS.map((p) => getCred(this.env.OAUTH_KV, userId, p.name).then((c) => [p, c] as const)),
    );

    for (const [provider, cred] of creds) {
      if (cred) {
        provider.register(this.server, this.makeApiKeyGetter(provider.name, provider.label));
      } else {
        this.registerConnectShim(provider);
      }
    }
  }

  private makeApiKeyGetter(provider: ProviderName, label: string): () => Promise<string> {
    return async () => {
      const userId = this.props?.userId;
      if (!userId) throw new Error("No user on this session — re-authenticate.");
      const cred = await getCred(this.env.OAUTH_KV, userId, provider);
      if (!cred) {
        throw new Error(
          `${label} was disconnected mid-session. Reconnect at ${this.env.PUBLIC_URL}/settings, then reconnect this MCP session.`,
        );
      }
      return cred.apiKey;
    };
  }

  private registerConnectShim(provider: ProviderRegistration) {
    this.server.tool(
      `connect_${provider.name}`,
      `Connect ${provider.label} to this account so the corresponding tools become available. Returns a single-use browser link — the API key is pasted on the website, never through this chat. After connecting, reconnect this MCP session to see the new ${provider.label} tools.`,
      {},
      async () => {
        const userId = this.props?.userId;
        if (!userId) throw new Error("No user on this session — re-authenticate.");
        const token = await createOnboardToken(this.env.OAUTH_KV, userId);
        // PUBLIC_URL falls back to localhost for `wrangler dev` without .dev.vars.
        // Deploy MUST set this via `wrangler secret put PUBLIC_URL` — otherwise
        // the LLM will hand the user a localhost URL that points at their machine.
        const base = (this.env.PUBLIC_URL || "http://localhost:8787").replace(/\/$/, "");
        const url = `${base}/onboard?token=${token}`;
        return {
          content: [
            {
              type: "text",
              text:
                `To connect ${provider.label}:\n\n` +
                `1. Open this single-use link in a browser (valid for 10 minutes):\n   ${url}\n\n` +
                `2. You'll be auto-signed-in to /settings. Paste your ${provider.label} API key in the ${provider.label} section and click Connect.\n` +
                `3. Reconnect this MCP session — the ${provider.label} tools will appear in the tool list.`,
            },
          ],
        };
      },
    );
  }
}

const innerMcpHandler = WorkoutContextMCP.serve("/mcp");

// agents/mcp emits "Content-Type: text/event-stream" with no charset. The wire
// format is UTF-8, but RFC-2616-era HTTP clients (e.g. Python's `requests`)
// default text/* without a charset to ISO-8859-1, which mojibakes multi-byte
// chars into single bytes — and the third byte of '★' (\xe2\x98\x85) becomes
// \x85 (NEL), which str.splitlines() treats as a line break and shreds JSON
// mid-payload. Inject the explicit charset so this can't happen.
const mcpHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const res = await innerMcpHandler.fetch(request, env, ctx);
    if (res.headers.get("content-type") === "text/event-stream") {
      const headers = new Headers(res.headers);
      headers.set("content-type", "text/event-stream; charset=utf-8");
      return new Response(res.body, {
        status: res.status,
        statusText: res.statusText,
        headers,
      });
    }
    return res;
  },
};

const oauthProvider = new OAuthProvider({
  apiRoute: "/mcp",
  apiHandler: mcpHandler as any,
  defaultHandler: AuthHandler as any,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
});

export default {
  fetch: oauthProvider.fetch.bind(oauthProvider),
};
