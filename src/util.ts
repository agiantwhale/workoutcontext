// Compresses MCP tool JSON responses to save tokens.
//
// Rules:
//   1. No pretty-print indent — pure whitespace, no info loss.
//   2. Inside array elements, drop fields whose value is null. The schema
//      repeats N times across N items, so the first item is enough discovery
//      and the rest is noise.
//   3. At the response root (single-object getters), keep nulls. They double
//      as schema documentation: "this field exists but isn't set on this
//      record" tells the model the field is askable.
//
// Net effect: getters preserve discovery; lists/searches compress.
function stripNullsInArrays(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(compactArrayElement);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = stripNullsInArrays(v);
    }
    return out;
  }
  return value;
}

function compactArrayElement(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(compactArrayElement);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === null) continue;
      out[k] = compactArrayElement(v);
    }
    return out;
  }
  return value;
}

export function ok(data: unknown) {
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(stripNullsInArrays(data)) },
    ],
  };
}
