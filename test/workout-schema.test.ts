// Tests for the schema-discovery tool (issue #176): the JSON Schema
// generated from workoutJsonSchema must describe the same shape the Zod
// validator enforces. Structural assertions only — the generated schema is
// for discovery, and the superRefine rules stay server-side.
// Run with: npm test   (node --test, type stripping — no build step)
import test from "node:test";
import assert from "node:assert/strict";
import {
  parseWorkoutJson,
  workoutJsonSchemaDocument,
} from "../src/workout-render.ts";

type SchemaNode = Record<string, unknown>;

function doc(): SchemaNode {
  return workoutJsonSchemaDocument();
}

function props(node: SchemaNode, key: string): SchemaNode {
  const properties = node.properties as Record<string, SchemaNode>;
  assert.ok(properties && typeof properties[key] === "object", `missing property ${key}`);
  return properties[key];
}

function anyOf(node: SchemaNode): SchemaNode[] {
  assert.ok(Array.isArray(node.anyOf), `expected anyOf, got ${JSON.stringify(node).slice(0, 80)}`);
  return node.anyOf as SchemaNode[];
}

const THRESHOLD: Record<string, unknown> = {
  version: 1,
  sport: "Run",
  target_metric: "power",
  sections: [
    {
      name: "Warmup",
      steps: [{ distance: { mi: 2 }, target: { zone: 1 }, type: "recovery" }],
    },
    {
      name: "Main",
      repeat: 3,
      steps: [
        { distance: { mi: 1 }, target: { zone: 4 }, type: "work", label: "Rep {n}" },
        { distance: { mi: 0.5 }, target: { zone: 1 }, type: "recovery", label: "Rest {n}" },
      ],
    },
    {
      name: "Cooldown",
      steps: [{ distance: { mi: 1 }, target: { zone: 1 }, type: "recovery" }],
    },
  ],
  meta: { planned_load: 42 },
};

test("document is a JSON Schema draft 2020-12 object, JSON-round-trippable", () => {
  const d = doc();
  assert.equal(d.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(d.type, "object");
  assert.equal(d.additionalProperties, false);
  assert.deepEqual(JSON.parse(JSON.stringify(d)), d);
  // Generated at runtime from the same schema — two calls agree.
  assert.deepEqual(workoutJsonSchemaDocument(), d);
});

test("top level: version const 1, target_metric enum, sections required", () => {
  const d = doc();
  assert.deepEqual(d.required, ["version", "sport", "target_metric", "sections"]);
  assert.equal(props(d, "version").const, 1);
  assert.deepEqual(props(d, "target_metric").enum, ["power", "hr", "pace"]);
  assert.equal(props(d, "sport").type, "string");
  assert.equal(props(d, "sections").minItems, 1);
});

test("sections: name + steps required, repeat is an integer capped at 99", () => {
  const section = (props(doc(), "sections").items as SchemaNode);
  assert.deepEqual(section.required, ["name", "steps"]);
  assert.equal(section.additionalProperties, false);
  assert.equal(props(section, "repeat").type, "integer");
  assert.equal(props(section, "repeat").maximum, 99);
  assert.equal((props(section, "steps").items as SchemaNode).required?.includes("target"), true);
});

test("steps: distance/duration keys, target forms, cadence, label", () => {
  const step = (props(props(doc(), "sections").items as SchemaNode, "steps").items as SchemaNode);
  assert.deepEqual(step.required, ["target"]);
  assert.equal(step.additionalProperties, false);
  // Length objects carry all six keys, positive.
  for (const key of ["distance", "duration"]) {
    const length = props(step, key);
    for (const unit of ["mi", "km", "m", "minutes", "seconds", "hours"]) {
      assert.equal(props(length, unit).exclusiveMinimum, 0, `${key}.${unit}`);
    }
  }
  // Target: zone (1-7 int, [lo,hi], "SS"), pct, pct_of, watts, pace regex, ramp.
  const target = props(step, "target");
  const zone = props(target, "zone");
  const zoneForms = anyOf(zone);
  assert.ok(zoneForms.some((f) => f.type === "integer" && f.minimum === 1 && f.maximum === 7));
  assert.ok(zoneForms.some((f) => f.const === "SS"));
  assert.deepEqual(props(target, "pct_of").enum, ["lthr", "max"]);
  const paceForms = anyOf(props(target, "pace"));
  assert.equal(paceForms.length, 2);
  assert.match(String(paceForms[0].pattern), /\(mi\|km\)/);
  const ramp = props(target, "ramp");
  assert.deepEqual(ramp.required, ["from", "to"]);
  assert.ok(props(props(ramp, "from"), "pct") && props(props(ramp, "from"), "watts"));
  // Cadence is an rpm number or a [lo,hi] range; label is a non-empty string.
  assert.equal(anyOf(props(step, "cadence")).length, 2);
  assert.equal(props(step, "label").minLength, 1);
  assert.deepEqual(props(step, "type").enum, ["work", "recovery"]);
});

test("meta carries planned_load; the fixture the schema describes parses", () => {
  const d = doc();
  assert.equal(props(props(d, "meta"), "planned_load").type, "integer");
  // The document's subject is valid per the validator it was generated from.
  assert.doesNotThrow(() => parseWorkoutJson(THRESHOLD));
});

test("superRefine rules are annotated as description text on the relevant nodes", () => {
  const d = doc();
  // Top level points at the annotated nodes.
  assert.match(String(d.description), /Cross-field rules/);
  const step = (props(props(d, "sections").items as SchemaNode, "steps").items as SchemaNode);
  assert.equal(step.description, "Each step needs exactly one of distance or duration.");
  // Length objects: exactly one key.
  for (const key of ["distance", "duration"]) {
    assert.equal(
      props(step, key).description,
      "Exactly one of mi/km/m/minutes/seconds/hours.",
    );
  }
  // Target: exactly one key; metric consistency per field.
  const target = props(step, "target");
  assert.equal(target.description, "Exactly one of zone/pct/watts/pace/ramp.");
  assert.match(String(props(target, "zone").description), /'SS'.*requires target_metric 'power'/);
  assert.match(String(props(target, "pct_of").description), /Requires target_metric 'hr'/);
  assert.equal(props(target, "watts").description, "Requires target_metric 'power'.");
  assert.equal(props(target, "pace").description, "Requires target_metric 'pace'.");
  // Ramp: same kind both ends; ends are exactly one of pct/watts, pct single-valued.
  const ramp = props(target, "ramp");
  assert.equal(ramp.description, "from and to must be the same kind (both pct or both watts).");
  for (const end of ["from", "to"]) {
    const endNode = props(ramp, end);
    assert.equal(
      endNode.description,
      "Exactly one of pct/watts; pct must be a single value, not a range.",
    );
    assert.match(String(props(endNode, "pct_of").description), /Requires target_metric 'hr'/);
    assert.equal(props(endNode, "watts").description, "Requires target_metric 'power'.");
  }
  // Label rules.
  assert.match(
    String(props(step, "label").description),
    /Single line.*\{n\} only inside a repeat block.*DSL-parseable token/,
  );
});
