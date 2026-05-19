// Clone every key/value pair from one Cloudflare KV namespace into another.
//
// Used by .github/workflows/preview-deploy.yml to seed each per-PR preview
// worker's KV namespace with a snapshot of staging's data, so previews can
// be browsed as an existing user (sessions, creds, OAuth grants all present).
// The clone runs on every deploy event, so the snapshot stays fresh; writes
// during the PR land only in the per-PR KV — staging is never touched.
//
// Bulk endpoints (max 100 per call for read, 10000 per call for write) keep
// this fast even for KVs with thousands of keys. Per-key TTLs are preserved
// via the `expiration` field (absolute unix-seconds).
//
// Usage:
//   CLOUDFLARE_API_TOKEN=... \
//   node scripts/clone-kv-namespace.mjs \
//     --account-id <cf-account-id> \
//     --source-namespace-id <staging-kv-id> \
//     --dest-namespace-id <preview-kv-id>

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) {
    console.error(`Missing required --${name}`);
    process.exit(1);
  }
  return process.argv[i + 1];
}

const accountId = arg("account-id");
const sourceId = arg("source-namespace-id");
const destId = arg("dest-namespace-id");
const token = process.env.CLOUDFLARE_API_TOKEN;
if (!token) {
  console.error("CLOUDFLARE_API_TOKEN env var is required");
  process.exit(1);
}

const API = `https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces`;
const HEADERS = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

async function cf(path, init = {}) {
  const res = await fetch(`${API}${path}`, { ...init, headers: { ...HEADERS, ...(init.headers ?? {}) } });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`${init.method ?? "GET"} ${path} → ${res.status}: ${body}`);
  }
  return res.json();
}

// Page through the source namespace's key listing. Each entry comes back as
// { name, expiration?, metadata? } — we'll attach the value in the next pass.
async function listAllKeys() {
  const keys = [];
  let cursor;
  do {
    const params = new URLSearchParams({ limit: "1000" });
    if (cursor) params.set("cursor", cursor);
    const page = await cf(`/${sourceId}/keys?${params}`);
    keys.push(...(page.result ?? []));
    cursor = page.result_info?.cursor || undefined;
  } while (cursor);
  return keys;
}

// Bulk-read up to 100 keys per call; merge the returned values back onto the
// listing entries so we preserve each key's expiration + metadata. Returns
// entries shaped for the bulk-write endpoint.
async function fetchValues(keys) {
  const out = [];
  for (let i = 0; i < keys.length; i += 100) {
    const batch = keys.slice(i, i + 100);
    const resp = await cf(`/${sourceId}/bulk/get`, {
      method: "POST",
      body: JSON.stringify({ keys: batch.map((k) => k.name), type: "text" }),
    });
    const values = resp.result?.values ?? {};
    for (const k of batch) {
      const v = values[k.name];
      if (v == null) continue; // key expired between listing and read
      const entry = { key: k.name, value: typeof v === "string" ? v : v.value };
      if (k.expiration) entry.expiration = k.expiration;
      if (k.metadata) entry.metadata = k.metadata;
      out.push(entry);
    }
  }
  return out;
}

// Bulk-write up to 10000 entries per call. We size batches at 1000 so a
// single failure has a smaller blast radius.
async function writeAll(entries) {
  for (let i = 0; i < entries.length; i += 1000) {
    const batch = entries.slice(i, i + 1000);
    await cf(`/${destId}/bulk`, { method: "PUT", body: JSON.stringify(batch) });
  }
}

const t0 = Date.now();
const keys = await listAllKeys();
console.log(`Listed ${keys.length} keys from ${sourceId} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
if (keys.length === 0) {
  console.log("Source namespace is empty — nothing to clone.");
  process.exit(0);
}
const t1 = Date.now();
const entries = await fetchValues(keys);
console.log(`Fetched ${entries.length} values in ${((Date.now() - t1) / 1000).toFixed(1)}s`);
const t2 = Date.now();
await writeAll(entries);
console.log(`Wrote ${entries.length} entries to ${destId} in ${((Date.now() - t2) / 1000).toFixed(1)}s`);
console.log(`Clone complete in ${((Date.now() - t0) / 1000).toFixed(1)}s total.`);
