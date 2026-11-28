import test from "node:test";
import assert from "node:assert/strict";
import { makeAccessTokenGetter, type OAuthProviderConfig } from "../src/oauth.ts";

const CONFIG: OAuthProviderConfig = {
  label: "Strava",
  authorizeUrl: "https://www.strava.com/oauth/authorize",
  tokenUrl: "https://www.strava.com/oauth/token",
  scopes: "read,activity:read_all",
  scopeSeparator: ",",
  parseTokenResponse: () => ({
    accessToken: "x",
    refreshToken: "y",
    expiresAt: Date.now() + 3600_000,
  }),
  fetchIdentity: async () => ({ providerUserId: "1", displayName: "Test" }),
};

test("not-connected error without a settings URL keeps the short message", async () => {
  const get = makeAccessTokenGetter(
    CONFIG,
    "id",
    "secret",
    async () => null,
    async () => {},
    { pending: null },
  );
  await assert.rejects(
    get(),
    /Strava is not connected for this user\. Reconnect via \/settings\./,
  );
});

test("not-connected error with a settings URL names the full path and the session reconnect", async () => {
  const get = makeAccessTokenGetter(
    CONFIG,
    "id",
    "secret",
    async () => null,
    async () => {},
    { pending: null },
    "https://workoutcontext.fit",
  );
  await assert.rejects(
    get(),
    /Strava is not connected for this user\. Reconnect at https:\/\/workoutcontext\.fit\/settings, then reconnect this MCP session\./,
  );
});
