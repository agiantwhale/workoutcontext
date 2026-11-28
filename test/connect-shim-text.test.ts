import test from "node:test";
import assert from "node:assert/strict";
import {
  connectShimDescription,
  connectShimSteps,
} from "../src/connect-shim-text.ts";

test("connect shim description: Hevy (apikey) leads with what it unlocks and says paste the key", () => {
  const desc = connectShimDescription(
    "Hevy",
    "Strength workouts and routines.",
    "apikey",
  );
  assert.equal(
    desc,
    "Connect Hevy to this account — Strength workouts and routines. " +
      "Returns a single-use browser link; paste your Hevy API key on the website, never through this chat. " +
      "After connecting, reconnect this MCP session to see the new Hevy tools.",
  );
});

test("connect shim description: Strava (oauth) leads with what it unlocks and says sign in", () => {
  const desc = connectShimDescription(
    "Strava",
    "Activities, segments, routes, and gear. Read + write.",
    "oauth",
  );
  assert.equal(
    desc,
    "Connect Strava to this account — Activities, segments, routes, and gear. Read + write. " +
      "Returns a single-use browser link; sign in at Strava on the website to authorize. " +
      "After connecting, reconnect this MCP session to see the new Strava tools.",
  );
});

test("connect shim steps: Hevy (apikey) pastes the key and names where to find it", () => {
  const steps = connectShimSteps(
    "Hevy",
    "apikey",
    "https://workoutcontext.fit/onboard?token=abc",
    "hevy.com → Settings → Developer",
  );
  assert.equal(
    steps,
    "To connect Hevy:\n\n" +
      "1. Open this single-use link in a browser (valid for 10 minutes):\n" +
      "   https://workoutcontext.fit/onboard?token=abc\n\n" +
      "2. You'll be auto-signed-in to /settings. Paste your Hevy API key in the Hevy section and click Connect.\n" +
      "   Find the key at hevy.com → Settings → Developer.\n" +
      "3. Reconnect this MCP session — the Hevy tools will appear in the tool list.",
  );
});

test("connect shim steps: Strava (oauth) connects via button + provider sign-in, never a pasted key", () => {
  const steps = connectShimSteps(
    "Strava",
    "oauth",
    "https://workoutcontext.fit/onboard?token=abc",
  );
  assert.equal(
    steps,
    "To connect Strava:\n\n" +
      "1. Open this single-use link in a browser (valid for 10 minutes):\n" +
      "   https://workoutcontext.fit/onboard?token=abc\n\n" +
      "2. You'll be auto-signed-in to /settings. Click Connect next to Strava and sign in at Strava to authorize.\n" +
      "3. Reconnect this MCP session — the Strava tools will appear in the tool list.",
  );
  assert.ok(!steps.includes("API key"));
});
