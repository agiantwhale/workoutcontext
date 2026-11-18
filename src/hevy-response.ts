// Pure helper for Hevy API response bodies.
//
// Hevy returns JSON for nearly every endpoint, but POST /v1/exercise_templates
// answers a successful create with the new template's ID as a bare UUID string,
// not a JSON object. Parsing that unconditionally throws a SyntaxError even
// though the create succeeded (the template exists in Hevy; the tool just
// reports failure, and the caller retries into duplicates).
// Parse JSON when the body is JSON; otherwise return the raw text.
export function parseHevyResponseBody(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
