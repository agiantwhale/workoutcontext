// MCP tool that exposes the current server build hash, so the LLM can
// detect mid-session schema drift caused by a redeploy.
//
// Why this exists. Tool schemas are cached by MCP clients at tools/list
// time. When we ship a breaking schema change (e.g. param rename), every
// active conversation holds an outdated copy of the schema until the
// client re-fetches it. Claude.ai's connector currently strips both the
// `instructions` field and `_meta` on tool responses before they reach
// the LLM context, so neither the protocol-level
// `notifications/tools/list_changed` nor an in-band hash beacon survive
// the round trip. The one thing that DOES reach the LLM verbatim is the
// tool description string itself.
//
// The trick. Bake the build hash into THIS tool's description at
// registration time, and return the *current* build hash from the
// handler. Because the description is part of what the LLM sees when
// the tool list is loaded, the cached baseline lives alongside the
// instruction to compare. When the LLM calls the tool, the response
// gives it the live hash; if it differs from the baked-in baseline,
// the server was redeployed mid-session and any other cached schemas
// may be stale.
//
// The LLM is told (in this very description) to call the tool when it
// hits unexpected validation errors, and to ask the user to start a
// new conversation if a mismatch is observed — which in Claude.ai's
// connector model triggers a fresh initialize + tools/list, picking
// up the current schemas.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { GIT_COMMIT_SHORT } from "./generated/commit.js";
import { ok } from "./util.js";

export function registerServerVersionTool(server: McpServer): void {
  server.tool(
    "check_server_version",
    [
      `Returns the current server build hash. The build hash baked into THIS description at the time the tool list was loaded is \`${GIT_COMMIT_SHORT}\`. If a future call returns a different value, the server was redeployed mid-session and your cached tool schemas may be stale.`,
      "",
      "WHEN TO CALL:",
      "- You got an unexpected validation error from another tool (e.g. \"Invalid input: expected array, received undefined at path ['x']\") that suggests the schema you were calling against doesn't match the server's current expectation.",
      "- You're about to start a substantive multi-tool workflow on a long-running conversation and want to confirm the server hasn't been redeployed since the conversation began.",
      "",
      `WHAT TO DO ON MISMATCH (returned hash != \`${GIT_COMMIT_SHORT}\`):`,
      "- Stop calling tools.",
      "- Tell the user something like: \"It looks like the server was updated since this conversation started — please start a new conversation to refresh the tools.\"",
      "- Wait for the user to start a new conversation before retrying.",
      "",
      "WHEN NOT TO CALL:",
      "- Routinely — this is a diagnostic, not a heartbeat. Don't burn a turn on it unless you have a reason.",
    ].join("\n"),
    {},
    async () => ok({ server_build: GIT_COMMIT_SHORT }),
  );
}
