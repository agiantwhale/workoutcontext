// `debug_trace` MCP tool — structured user-experience feedback channel.
//
// When an LLM session yields unsatisfactory results, the LLM (with the user's
// consent or at the user's explicit request) calls this tool with a short
// structured summary. The tool files a GitHub Issue in a private feedback
// repo for the maintainer to review, then returns the issue URL + a short
// trace id the LLM can hand back to the user.
//
// Privacy posture (defense in depth — three layers):
//   - Issues land in a *private* GitHub repo (set via GITHUB_ISSUE_REPO).
//   - The tool description warns the LLM to paraphrase rather than paste raw
//     user messages or biometric tool-call results.
//   - The server never embeds the user's display name in the issue body —
//     only a truncated, opaque user id for cross-referencing.
//   - Every free-text field is run through `scrubPII` before it leaves the
//     worker (high-precision email/phone redaction). This is best-effort, not
//     a guarantee — the authoritative safeguard is the confirmation step.
//   - TWO-PHASE CONFIRM: the first call (confirmed:false) files nothing — it
//     returns the exact scrubbed issue body as a `preview` for the LLM to show
//     the user. Only a second call with confirmed:true actually files. So the
//     user always sees and approves the precise content before it is sent.
//
// Rate limiting: KV row `debug-trace-rate-limit:<userId>` with a 5-minute
// TTL ensures one report per user per 5min window. Eventually-consistent
// KV makes this best-effort against very tight bursts; that's acceptable
// for V1.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getCred, type ProviderName } from "./storage.js";
import { GIT_COMMIT_FULL, GIT_COMMIT_SHORT } from "./generated/commit.js";
import type { Env, Props } from "./index.js";

const RATE_LIMIT_TTL_SECONDS = 300;
const KNOWN_PROVIDERS: ProviderName[] = [
  "intervals",
  "hevy",
  "strava",
  "oura",
  "withings",
];

// Same source-of-truth as the page footer so cross-referencing is one click.
const COMMIT_LINK = `https://github.com/agiantwhale/workoutcontext/commit/${GIT_COMMIT_FULL}`;

function rateLimitKey(userId: string): string {
  return `debug-trace-rate-limit:${userId}`;
}

function shortTraceId(): string {
  // 6-byte random → 12 hex chars, prefixed `dt_` for grep-ability.
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return (
    "dt_" +
    Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
  );
}

// Best-effort, high-precision PII redaction applied to every free-text field
// before the report leaves the worker. We deliberately only match patterns we
// can detect with near-zero false positives — emails and phone numbers — so we
// never silently mangle legitimate content (zone labels, dates, tool names).
// This is a backstop, NOT the primary safeguard: the LLM is told to paraphrase,
// and the user confirms the exact rendered preview before anything is filed.
const PII_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  // Email addresses.
  [/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi, "[redacted-email]"],
  // Phone numbers: optional country code, then 3-3-4 grouping with common
  // separators (or parenthesized area code). The mandatory 4-digit final group
  // keeps ISO dates like 2026-06-03 (which end in a 2-digit group) from matching.
  [
    /(?:\+\d{1,3}[\s.-]?)?(?:\(\d{3}\)[\s.-]?|\d{3}[\s.-])\d{3}[\s.-]\d{4}\b/g,
    "[redacted-phone]",
  ],
];

function scrubPII(text: string): string {
  let out = text;
  for (const [re, repl] of PII_PATTERNS) out = out.replace(re, repl);
  return out;
}

// Scrub every free-text field. Tool names and version SHAs are not free text
// (closed vocabulary / hex), so they pass through untouched.
function scrubFields(fields: IssueFields): IssueFields {
  return {
    ...fields,
    summary: scrubPII(fields.summary),
    expected: scrubPII(fields.expected),
    actual: scrubPII(fields.actual),
    userGoal: fields.userGoal ? scrubPII(fields.userGoal) : undefined,
    excerpt: fields.excerpt ? scrubPII(fields.excerpt) : undefined,
  };
}

async function listConnectedProviders(env: Env, userId: string): Promise<ProviderName[]> {
  const results = await Promise.all(
    KNOWN_PROVIDERS.map(async (p) => {
      const cred = await getCred(env.OAUTH_KV, userId, p);
      return cred ? p : null;
    }),
  );
  return results.filter((p): p is ProviderName => p !== null);
}

interface IssueFields {
  summary: string;
  expected: string;
  actual: string;
  userGoal?: string;
  toolsInvolved?: string[];
  excerpt?: string;
  mcpToolBaseline?: string;
  skillVersion?: string;
}

// Compare an LLM-reported SHA against the server's current SHA. Both may
// be short (7-char) or full (40-char); compare by the shared prefix length
// so a short-vs-full pairing matches when one is a prefix of the other.
function compareSha(reported: string | undefined, current: string): "match" | "drift" | "missing" {
  if (!reported) return "missing";
  const a = reported.toLowerCase().trim();
  const b = current.toLowerCase().trim();
  if (!a) return "missing";
  const n = Math.min(a.length, b.length);
  if (n < 4) return "drift"; // too short to be a meaningful match
  return a.slice(0, n) === b.slice(0, n) ? "match" : "drift";
}

function renderVersionLine(label: string, reported: string | undefined, current: string): string {
  if (!reported) return `- ${label}: _(not provided)_`;
  const status = compareSha(reported, current);
  const marker = status === "match" ? "✅ matches server" : "⚠️ differs from server";
  return `- ${label}: \`${reported}\` ${marker}`;
}

function renderIssueTitle(summary: string): string {
  const truncated = summary.length > 100 ? summary.slice(0, 97) + "…" : summary;
  return `[debug-trace] ${truncated}`;
}

function renderIssueBody(
  traceId: string,
  userId: string,
  connectedProviders: ProviderName[],
  fields: IssueFields,
): string {
  // Drift triage: three SHAs to compare. Server "current" is the running
  // build's hash (authoritative — we know it). MCP tool baseline is the
  // SHA the LLM saw baked into check_server_version's description at
  // tool-load time; if it differs from current, the worker was redeployed
  // mid-session and tool schemas in the LLM's cache may be stale. Skill
  // version is from the SKILL.md footer of any loaded WorkoutContext
  // skill; if it differs from current, the skill release workflow hasn't
  // republished yet (or the user has an older skill installed).
  const versionLines = [
    `- Server (current): [\`${GIT_COMMIT_SHORT}\`](${COMMIT_LINK}) — live`,
    renderVersionLine("MCP tools baseline (loaded by LLM)", fields.mcpToolBaseline, GIT_COMMIT_SHORT),
    renderVersionLine("Skill version (from SKILL.md footer)", fields.skillVersion, GIT_COMMIT_SHORT),
  ].join("\n");

  const header = [
    `**Trace ID:** \`${traceId}\``,
    `**User:** \`${userId.slice(0, 8)}…\``,
    `**Filed:** ${new Date().toISOString()}`,
    `**Connected providers:** ${connectedProviders.length ? connectedProviders.join(", ") : "_none_"}`,
    `**Versions:**`,
    versionLines,
  ].join("\n");

  const toolsBlock = fields.toolsInvolved?.length
    ? fields.toolsInvolved.map((t) => `- \`${t}\``).join("\n")
    : "_(none specified)_";

  return [
    header,
    "",
    "## Summary",
    fields.summary,
    "",
    "## Expected",
    fields.expected,
    "",
    "## Actual",
    fields.actual,
    "",
    "## User goal",
    fields.userGoal?.trim() || "_(not provided)_",
    "",
    "## Tools involved",
    toolsBlock,
    "",
    "## Excerpt",
    fields.excerpt?.trim() || "_(none provided)_",
    "",
    "---",
    "_Auto-filed via the `debug_trace` MCP tool._",
  ].join("\n");
}

async function createGitHubIssue(
  token: string,
  repo: string,
  title: string,
  body: string,
): Promise<{ url: string; number: number } | { error: string }> {
  const res = await fetch(`https://api.github.com/repos/${repo}/issues`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      // GitHub rejects requests without a User-Agent.
      "User-Agent": "workoutcontext-debug-trace",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ title, body, labels: ["debug-trace"] }),
  });
  const text = await res.text();
  if (!res.ok) {
    return { error: `GitHub API ${res.status}: ${text.slice(0, 500)}` };
  }
  try {
    const json = JSON.parse(text) as { html_url?: string; number?: number };
    if (!json.html_url || typeof json.number !== "number") {
      return { error: `GitHub API returned 2xx but missing fields: ${text.slice(0, 300)}` };
    }
    return { url: json.html_url, number: json.number };
  } catch {
    return { error: `GitHub API returned non-JSON body: ${text.slice(0, 300)}` };
  }
}

export function registerDebugTraceTool(
  server: McpServer,
  env: Env,
  props: Props,
): void {
  server.tool(
    "debug_trace",
    [
      "File a structured bug report when the user is hitting a problem this server's tools can't solve. The report becomes a GitHub Issue in a private feedback repo and is reviewed by the maintainer to improve tool descriptions, schemas, and behavior. This is the user's primary feedback channel — use it.",
      "",
      "WHEN THE USER ASKS DIRECTLY (always file):",
      "- The user explicitly says to file feedback, report a bug, submit a debug trace, or similar.",
      "",
      "WHEN TO PROACTIVELY OFFER (suggest first, file on agreement):",
      "- You've made 3+ attempts on the same user request without making progress.",
      "- The user shows signs of frustration or giving up: \"forget it\", \"never mind\", \"this isn't working\", \"ugh\", \"this is useless\", \"why doesn't it know X\".",
      "- You're about to tell the user \"I can't do that\" / \"I don't have a tool for that\" / \"this isn't supported\" — offer to file a trace first so the maintainer can consider adding it.",
      "- A tool returned data that's structurally surprising (missing fields you'd expect, units that don't match the docs, empty when populated data was expected) and the next obvious retry won't fix it.",
      "",
      "Phrase the offer as a way to help everyone, not an apology: \"Want me to file a debug trace so the maintainer can improve this?\" Then call this tool if the user agrees.",
      "",
      "DO NOT use this tool for:",
      "- Routine errors you can recover from yourself by retrying with corrected arguments.",
      "- A 401 / token-expired error (those self-heal on next call or via /settings).",
      "- Cases where the user clearly understands the limitation and isn't asking for it to be fixed.",
      "",
      "PRIVACY: A human reviews these issues. Do NOT paste raw user messages, raw tool-call response bodies, or biometric / personal data into any field. Paraphrase, and actively strip personal identifiers (names, emails, phone numbers, account/device IDs, locations) as you compose the fields. The `excerpt` field is for high-level context only — never paste full conversations or sensitive numbers (weight, heart rate, etc.) verbatim. The server also runs a best-effort PII scrubber and never includes the user's name, but treat that as a backstop, not a license to be careless.",
      "",
      "CONFIRM BEFORE FILING (two-phase, required): the first call files NOTHING. Call with confirmed:false (the default) to get back a `preview` — the exact PII-scrubbed title and body the server would submit. Show that preview to the user, let them correct or redact anything, and get their explicit OK. Only then call again with the SAME fields plus confirmed:true to actually file. Never set confirmed:true without having shown the user the preview and received approval.",
      "",
      "DRIFT DETECTION (always include when filing): populate `mcpToolBaseline` with the build hash baked into the `check_server_version` tool's description (look for the SHA in that description — it's the hash the LLM saw at tool-load time). If a WorkoutContext skill is loaded in this session, also populate `skillVersion` with the short SHA from the skill's SKILL.md footer (line starts with \"Built from\"). The server compares both against its own current build and flags drift in the filed report — this is how the maintainer tells whether the bug is a real bug or a stale-cache artifact.",
      "",
      "RATE LIMIT: one report per 5 minutes per user. If rate-limited, do not retry and do not nag — tell the user calmly when they can file the next one. Use the slot deliberately.",
      "",
      "Returns a JSON object with the filed issue URL and a short trace id to share with the user.",
    ].join("\n"),
    {
      summary: z
        .string()
        .trim()
        .min(10)
        .max(280)
        .describe("One-sentence description of the problem the user is hitting."),
      expected: z
        .string()
        .trim()
        .min(10)
        .max(2000)
        .describe("What the user expected the tool/sequence to produce."),
      actual: z
        .string()
        .trim()
        .min(10)
        .max(2000)
        .describe("What actually happened, paraphrased — no raw response bodies."),
      userGoal: z
        .string()
        .trim()
        .max(500)
        .optional()
        .describe("Paraphrase of the user's original goal (NOT their verbatim message)."),
      toolsInvolved: z
        .array(z.string().min(1).max(80))
        .max(20)
        .optional()
        .describe("MCP tool names whose output the user found unsatisfactory."),
      excerpt: z
        .string()
        .trim()
        .max(2000)
        .optional()
        .describe(
          "Optional short paraphrased context. Never paste raw user messages or sensitive numeric data verbatim — treat this as if it could be read by a third party.",
        ),
      mcpToolBaseline: z
        .string()
        .trim()
        .max(64)
        .optional()
        .describe(
          "Build hash baked into the `check_server_version` tool's description at tool-load time. The server compares against its current hash to flag mid-session schema drift. Short (7-char) or full (40-char) SHA both work.",
        ),
      skillVersion: z
        .string()
        .trim()
        .max(64)
        .optional()
        .describe(
          "Short SHA from the SKILL.md footer of any WorkoutContext skill loaded in this session (line starts with \"Built from\"). Omit if no such skill is loaded.",
        ),
      confirmed: z
        .boolean()
        .default(false)
        .describe(
          "Two-phase safety gate — defaults to false. FIRST call: leave false. The server scrubs the fields of PII and returns the EXACT issue title + body it would file as a `preview`, WITHOUT filing anything. You must then show that preview to the user verbatim (it's already scrubbed — show it as-is) and get their explicit go-ahead. SECOND call: only after the user approves, call again with the IDENTICAL field values plus confirmed:true to actually file. Never set confirmed:true on the first call, and never set it without having shown the user the preview and received approval.",
        ),
    },
    async (fields) => {
      const userId = props.userId;

      // Configuration gate. If the maintainer hasn't set up the GitHub
      // integration yet, return a clear message rather than throwing.
      if (!env.GITHUB_ISSUE_TOKEN || !env.GITHUB_ISSUE_REPO) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  status: "not_configured",
                  message:
                    "debug_trace is not configured on this environment. The operator needs to set GITHUB_ISSUE_TOKEN and GITHUB_ISSUE_REPO secrets. Tell the user their feedback was noted but not submitted.",
                },
                null,
                2,
              ),
            },
          ],
        };
      }

      // Rate limit: one filing per user per 5 minutes. The KV row's existence
      // is the lock; eventually-consistent reads mean very tight bursts may
      // slip through, which is fine for V1 (worst case: two issues filed
      // instead of one). Checked on BOTH phases so we don't render a preview
      // the user can't actually file.
      const rlKey = rateLimitKey(userId);
      const existing = await env.OAUTH_KV.get(rlKey);
      if (existing) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  status: "rate_limited",
                  message:
                    "A debug trace was already filed for this user within the past 5 minutes. Wait a few minutes before filing another.",
                  previousTraceId: existing,
                },
                null,
                2,
              ),
            },
          ],
        };
      }

      // Strip PII from every free-text field BEFORE anything is rendered, so
      // the preview the user approves is byte-identical to what gets filed.
      const scrubbed = scrubFields(fields);
      const connectedProviders = await listConnectedProviders(env, userId);
      const title = renderIssueTitle(scrubbed.summary);

      // PHASE 1 — preview. Nothing is filed until the user has seen the exact
      // (already-scrubbed) content and the LLM re-calls with confirmed:true.
      if (!fields.confirmed) {
        const previewBody = renderIssueBody(
          "(trace id assigned when you file)",
          userId,
          connectedProviders,
          scrubbed,
        );
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  status: "preview",
                  message:
                    "NOT FILED YET. This is the exact, PII-scrubbed report that will be submitted. Show this title and body to the user verbatim, confirm they're OK with it (and let them correct or redact anything), then call debug_trace again with the same fields plus confirmed:true to file it. Do not file without the user's explicit go-ahead.",
                  preview: { title, body: previewBody },
                },
                null,
                2,
              ),
            },
          ],
        };
      }

      // PHASE 2 — file (user has confirmed).
      const traceId = shortTraceId();
      const body = renderIssueBody(traceId, userId, connectedProviders, scrubbed);

      const result = await createGitHubIssue(
        env.GITHUB_ISSUE_TOKEN,
        env.GITHUB_ISSUE_REPO,
        title,
        body,
      );

      if ("error" in result) {
        // Don't burn the rate-limit slot on a failed submission — operator
        // may want the user to retry once the GitHub config is fixed.
        console.error("[debug_trace] GitHub Issue submission failed:", result.error);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  status: "submission_failed",
                  message:
                    "Could not submit the report to GitHub. Tell the user their feedback was recorded locally in logs but not filed; the operator will investigate.",
                  traceId,
                  error: result.error,
                },
                null,
                2,
              ),
            },
          ],
        };
      }

      // Issue created — claim the rate-limit slot now.
      await env.OAUTH_KV.put(rlKey, traceId, {
        expirationTtl: RATE_LIMIT_TTL_SECONDS,
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                status: "filed",
                traceId,
                issueUrl: result.url,
                issueNumber: result.number,
                message: `Filed as issue #${result.number}. Share trace id ${traceId} with the user for follow-up.`,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );
}
