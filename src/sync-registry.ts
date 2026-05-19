// Per-user provider-to-provider sync registry.
//
// Each SyncDescriptor describes one *unidirectional* sync the worker can run:
// "when <source> emits a webhook for <contentLabel>, write it into <dest>".
// The registry is the single source of truth used by three call sites:
//
//   1. /settings UI — renderProviderSyncRows iterates the registry to build
//      the click-anywhere toggle rows at the bottom of each provider card.
//   2. POST /settings/sync-toggle — validates that the (source, dest) pair
//      the form is asking about actually exists in the registry, so users
//      can't write arbitrary keys into their UserSettings.syncs dict.
//   3. Webhook handlers — call isSyncEnabled(syncs, source, dest) to gate
//      the write path. The toggle key shape lives in syncKey() so callers
//      never construct the string by hand.
//
// To add a new sync (e.g. Hevy workouts → Intervals.icu):
//   - Append a SyncDescriptor entry below with the right contentLabel.
//   - Implement the source-side webhook handler that calls isSyncEnabled
//     and then performs the actual sync via its own helper.
// The UI, the POST handler, and the storage layer all light up for free.

import type { ProviderName } from "./storage.js";

export interface SyncDescriptor {
  source: ProviderName;
  dest: ProviderName;
  // Human-readable subject of the sync, rendered in the UI as
  // "<contentLabel> → <Destination label>". Keep concise — it's the
  // button text the user clicks.
  contentLabel: string;
}

export const SYNCS: readonly SyncDescriptor[] = [
  {
    source: "withings",
    dest: "intervals",
    contentLabel: "Body composition",
  },
] as const;

// "<source>.<dest>" — the key shape used inside UserSettings.syncs.
// Keep callers out of the business of building this string.
export function syncKey(source: ProviderName, dest: ProviderName): string {
  return `${source}.${dest}`;
}

// Default off: a missing key, a missing dict, or an explicit false all
// resolve to false. Webhook handlers and the UI both depend on this.
export function isSyncEnabled(
  syncs: Record<string, boolean> | undefined,
  source: ProviderName,
  dest: ProviderName,
): boolean {
  return syncs?.[syncKey(source, dest)] === true;
}

// Lookup is by (source, dest) since the pair is unique within the registry.
// Returns undefined when the pair isn't registered — POST handler treats
// that as "reject the request" (don't persist arbitrary keys).
export function lookupSync(
  source: ProviderName,
  dest: ProviderName,
): SyncDescriptor | undefined {
  return SYNCS.find((s) => s.source === source && s.dest === dest);
}

// All syncs that originate from a given source provider. Used by the
// settings page to render the rows under each provider card.
export function syncsForSource(source: ProviderName): SyncDescriptor[] {
  return SYNCS.filter((s) => s.source === source);
}
