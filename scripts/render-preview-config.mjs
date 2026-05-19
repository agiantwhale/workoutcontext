// Render a per-PR wrangler config from the top-level wrangler.jsonc.
//
// The committed wrangler.jsonc has prod at the top level and `env.staging`
// underneath. For per-PR preview deploys we want a flat config bound to a
// per-PR worker name + per-PR KV namespace, with no envs and no production
// routes. This script strips JSONC comments, overrides `name` + KV id from
// CLI args, drops `env` and `routes`, and writes the result to a target path.
//
// Used by .github/workflows/preview-deploy.yml. Kept as a Node script (not
// jq) so the JSONC comment stripping logic can match the regex used by
// .github/workflows/check-wrangler-config.yml — same parser for both.
//
// Usage:
//   node scripts/render-preview-config.mjs \
//     --name workoutcontext-pr-72 \
//     --kv-id <returned-from-kv-namespace-create> \
//     --out wrangler.pr.jsonc

import { readFileSync, writeFileSync } from "node:fs";

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) {
    console.error(`Missing required --${name}`);
    process.exit(1);
  }
  return process.argv[i + 1];
}

const name = arg("name");
const kvId = arg("kv-id");
const out = arg("out");

const raw = readFileSync("wrangler.jsonc", "utf8");
// Strip /* ... */ block comments first so a `/* ... // ... */` doesn't leave
// a dangling `*/` after stripping line comments. Same order as the CI check.
const stripped = raw
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/\/\/.*/g, "");
const config = JSON.parse(stripped);

config.name = name;
const oauthKv = config.kv_namespaces?.find((kv) => kv.binding === "OAUTH_KV");
if (!oauthKv) {
  console.error("wrangler.jsonc is missing the OAUTH_KV binding at top level");
  process.exit(1);
}
oauthKv.id = kvId;

// Per-PR deploys don't inherit prod routes and don't need the env block —
// the workflow attaches a custom domain via the Cloudflare API instead.
delete config.routes;
delete config.env;

writeFileSync(out, JSON.stringify(config, null, 2));
console.log(`Wrote ${out} for worker=${name} kv=${kvId}`);
