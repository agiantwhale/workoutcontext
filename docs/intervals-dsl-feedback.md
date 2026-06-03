# Intervals.icu structured-workout / DSL quirks

Feedback for David (Intervals.icu) — behaviors our MCP tool descriptions currently have to warn the model about or work around (see `src/intervals.ts`). Most would help any third-party app, not just WorkoutContext.

## Parser scope / phantom steps
- **No parser boundary** — DSL parser scans the whole description; any prose token with a DSL-like value becomes a phantom step.
- **`m` = minutes** — "first 400m" → a 400-*minute* (24,000s) phantom step, silently inflating `moving_time`.
- **Distance tokens re-parse on UPDATE** — "10 miles" in edited prose appends phantom distance steps (but standalone DSL lines don't re-parse — odd asymmetry).

## Update path (silent failures)
- **DSL not re-parsed once `workout_doc` exists** — only way to restructure is DELETE + re-create.
- **`workout_doc.steps` on UPDATE silently dropped** — returns `steps:[]`, `duration:0`, metrics null; no error, even though name/description/load on the same call save fine.
- **Edits flip target units** — `pace_zone → power_zone` on save, ignoring Sport Settings priority.

## Manual doc vs DSL
- **Manual `workout_doc` skips chart metrics** — `zoneTimes`/`normalized_power`/etc. only compute from DSL-parsed CREATE, so a valid manual doc renders an empty chart.
- **`type` field breaks manual steps** — passing `type` on a step can return an empty `workout_doc`.

## Training load
- **`icu_training_load` ignored on CREATE, sticks on UPDATE** — forces a two-call CREATE-then-UPDATE pattern.
- **NP auto-TSS inflates 3–4×** — sub-60s Z6+ steps blow up the 4th-power estimate (e.g. TSS 217 vs. realistic ~50).
- **RACE_A/B/C skip auto-load** even with a valid doc (likely intentional).

## Defaults
- **Run DSL defaults to pace, ignoring `workout_order`** — power-first runners need an explicit `' Power'` suffix (feature request, not a bug).

---

**Highest-value asks:** the manual-vs-DSL metric asymmetry, the silent step-drop on UPDATE (no error), and the parser having no scope boundary — those cause the most wrapper contortion and would benefit every integration.
