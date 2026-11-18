// Guard: structured log lines must go through the bound logger
// (src/logging.ts), so every line carries the WorkoutContext user id.
// Run with: npm test (node --test, type stripping)
//
// Bare console.log is allowed only in logging.ts itself (the choke point)
// and in the grandfathered files below, whose sites predate the logger
// and don't have a user id in scope (Hevy/Withings webhook handlers and
// one sync helper). The per-file counts are frozen: adding a console.log
// anywhere — including inside a grandfathered file — fails this test,
// and the fix is to use createLogger, not to bump the count.
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

// file -> frozen number of `console.log(` occurrences. logging.ts is the
// choke point itself (1: inside createLogger).
const ALLOWED: Record<string, number> = {
  "logging.ts": 1,
  "auth-handler.ts": 8,
  "hevy-webhook.ts": 2,
  "hevy-intervals-sync.ts": 1,
};

test("no bare console.log outside the logger and grandfathered sites", () => {
  const found: Record<string, number> = {};
  for (const file of readdirSync(SRC_DIR).filter((f) => f.endsWith(".ts"))) {
    const text = readFileSync(join(SRC_DIR, file), "utf8");
    const count = (text.match(/console\.log\s*\(/g) ?? []).length;
    if (count > 0) found[file] = count;
  }
  assert.deepEqual(
    found,
    ALLOWED,
    "console.log sites changed — new structured logging must go through " +
      "createLogger in src/logging.ts (see the comment at the top of this test)",
  );
});
