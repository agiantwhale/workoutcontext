---
name: workout-context
description: Set up and maintain training context for athletes using the WorkoutContext MCP (which connects Claude to Intervals.icu, Hevy, Oura, and Withings). Use whenever the user references their training plan, Intervals calendar, Hevy routines, working weights, strength templates, or training playbook; whenever they want to plan, audit, update, or migrate their training setup; whenever they're transitioning between blocks (post-race, build, peak, taper); or whenever they mention drift between their plan and what's actually scheduled. Covers the source-of-truth architecture, the dated-NOTE playbook pattern with read-before-plan / write-after-plan discipline, change-tracking conventions, Hevy data conventions you must verify with each athlete (set type labels, DB weight convention), and the Intervals workout DSL gotchas.
---

# WorkoutContext Setup

A guide for setting up and maintaining athlete training context with the WorkoutContext MCP. The MCP requires **Intervals.icu** (the calendar + fitness spine) and optionally connects to **Hevy** (strength training), **Oura** (sleep, readiness, HRV), and **Withings** (body composition, weight, sleep). Most athletes use Intervals plus one or two of the optional providers — the skill adapts to what's connected.

## When to consult this skill

- New athlete onboarding to the MCP
- Building a new training block
- Auditing Hevy templates and Intervals calendar for drift
- Updating working weights, schedules, or volume targets
- Transitioning between phases (post-race, build, peak, taper)
- Migrating context off stale docs / spreadsheets / training apps

## Core architecture

### 1. Source of truth: Intervals.icu is the spine

The canonical plan always lives on the Intervals.icu calendar — workout events plus NOTE-category events for persistent context. This is true whether or not the athlete connects any other provider.

Optional providers play supporting roles:

- **Hevy** (if connected) — strength templates here are the canonical record of what the athlete actually lifts; Intervals event descriptions for strength sessions should mirror them
- **Oura** (if connected) — read-only wellness signals (sleep, readiness, HRV) that inform recovery decisions but don't drive scheduling
- **Withings** (if connected) — read-only body composition, weight, sleep

Avoid using Google Docs, Notion pages, or other external documents as the *source* of truth — the MCP can read them but can't update them in place, so they go stale fast. Read-only references (race PDFs, coach handouts) are fine; just don't try to keep them in sync.

### 2. Playbook NOTE events

A **playbook** is a Markdown-formatted NOTE-category event on the Intervals calendar. It's a single date-anchored document that captures everything for a discipline:

- Weekly schedule structure
- Current zones, thresholds, working weights
- Load / volume / pace progression rules
- Volume targets per muscle group (strength) or per phase (running)
- Recent changes
- Recovery levers

Athletes typically maintain **one playbook per discipline** (e.g., Strength Training, Running, Cycling). Create them with descriptive titles like `💪 Strength Training Playbook` or `🏃 Running Playbook` — not internal jargon like "Source of Truth".

NOTE descriptions render Markdown. Use headers, tables, bold, italics — it pays off in legibility.

### 3. Change tracking via dated NOTEs

The playbook lives on a specific calendar date. When the athlete changes something:

- **Same-day change** → update the existing playbook in place
- **New-day change** → CREATE a new NOTE dated that day. Copy the full current state, then add a `## Changes — <date>` section at the bottom describing just that day's deltas

Old playbooks remain on their original dates as historical snapshots. Scrolling back through the calendar becomes a built-in changelog. The latest dated playbook is always the current source of truth.

### 4. Plans always read from and write to the playbook

Whenever the athlete asks for any new or modified training plan — a strength routine, a running week, a cycling block, a single workout swap — do two things, in order:

1. **Read the latest playbook for that discipline FIRST.** Pull its `external_id` from user memory (see Memory hygiene) or query `intervals_list_events` for category-NOTE events with the discipline emoji in the title. Use it as context: the current phase, weekly structure, working weights, zones, paces, and recent changes shape every new decision. Don't plan in a vacuum.
2. **Write the playbook for today AFTER committing the plan.** Same-day edits update the current playbook in place (see section 3); new-day edits create a new dated NOTE that copies the full current state plus a `## Changes — <date>` section for the day's deltas. Whatever the assistant decided — new working weight, swapped session, added strides, dropped a day — lands in the playbook so the next session can see it.

Skip either step only if the athlete explicitly says so ("don't touch the playbook", "this is a one-off, just give me the workout", "skip the playbook lookup"). In all other cases, an updated calendar without an updated playbook is half-finished — the next conversation won't know the plan changed.

## Working with Hevy templates

*This section applies only if the athlete has connected Hevy. If not, skip it — strength sessions can still be captured as prose in Intervals event descriptions.*

### Match the athlete's training approach

Training methodology is personal — powerlifters, bodybuilders, runners doing supplemental strength, CrossFitters, and Olympic lifters all structure templates differently. **Don't impose a default structure.** Ask the athlete (or infer from their existing templates / history) before editing:

- **Set/rep scheme** — straight sets? pyramid? double-progression? RPE-based? 5×5? 3×8–12?
- **Warmup philosophy** — pre-filled warmup sets in the template? feel-based ramp-up? none logged?
- **Progression model** — linear (add weight weekly), double-progression (reps first, then weight), block periodization, autoregulated (RPE)?
- **Volume preferences** — sets per muscle per week? bias toward compounds or isolation?
- **Rep ranges** — strength (1–5), hypertrophy (6–12), endurance (12+), mixed?

Once you've established the athlete's approach, **enforce it consistently** across every routine. The skill's job is consistency and accurate logging — not picking a methodology.

If the athlete asks you to choose, give them 2–3 reasonable options framed for their goal and let them pick. Don't quietly default.

### Pre-filling working weights

If the athlete wants weights pre-filled in templates (vs. entered live each session), seed initial values from recent training history via `hevy_list_workouts` or `hevy_get_exercise_history`. Confirm the convention first — some athletes prefer empty templates and dislike stale numbers.

### Critical: warmup sets must use `type: "warmup"`

Hevy stores each set's type as `"warmup"` or `"normal"`. **Sets typed `"normal"` count as working volume** in Hevy's analytics. If a template has light ramp-up sets tagged `"normal"`, the athlete's weekly working-set count is inflated and volume tracking is wrong.

When auditing a routine, check the type field on every set. If the weight is significantly lighter than the athlete's recent working weight for that exercise, it's almost certainly a warmup — relabel accordingly.

### DB weight convention: combined total (verify with the athlete)

**Hevy's standard convention is to log the combined total weight** for two-dumbbell exercises — e.g., "100 lb DB Bench" means 50 lb in each hand. Single-DB or one-handed entries (goblet squat, single-arm row) log just the one DB's weight.

Even though this is the standard, surface it explicitly to the athlete on first interaction. Some users carry over a per-dumbbell habit from other apps or coaches, and a 2× off-by-convention error is silent but ruinous. Once confirmed, store the answer in user memory so it persists.

This affects:
- Interpretation of historical log values
- Numbers written into calendar event descriptions
- The lb/kg values seeded into new templates
- Any weight math you do on the athlete's behalf (% loads for reintro, progression deltas, etc.)

### Hevy API gotchas

- `hevy_update_routine` **fully replaces the exercise list** — you must include all exercises, not just the ones you're changing. Always fetch first, then submit the full updated list.
- Hevy stores weights in **kg internally** regardless of display units. Send kg values via the API. Conversion factor: `lb × 0.4535929094... = kg`. Match this precision to keep displayed lb values clean.
- Exercise template IDs (like `3D0C7C75`) are stable. Look them up via `hevy_list_exercise_templates` when adding a new movement. Don't guess.
- Notes on exercises (form cues, build-to targets) are preserved across updates if you include them in the update payload — but dropped if you don't. Preserve them when editing.

## Working with Intervals.icu

### Workout event content

**Strength events** (`category: "WORKOUT"`, `type: "WeightTraining"`): description should list every movement with target weight × reps. Match the user's Hevy weight convention. The athlete glances at the calendar event to see "what am I doing today" — keep it scannable.

**Run events**: use the structured workout DSL. Check `sport_settings.workout_order` to know which metric is primary (POWER, HR, or PACE). When power is primary, write `Z2 Power` etc. in the DSL.

### Workout DSL gotchas

When creating a run event:
- The DSL goes in the **description field**. Intervals auto-parses it into structured `workout_doc.steps`.
- DSL shorthand: `m` = minutes, `km` / `mi` = distance. Section headers don't use `-` prefix.

When updating a run event:
- Send the structured JSON directly: `{steps: [{duration: N, power: {units: 'power_zone', value: 1-7}}]}`
- Units that work: `power_zone`, `pace_zone`, `hr_zone`
- Units that DON'T render correctly: `%ftp`, `%pace` — avoid these
- Don't include `type` field on input steps — the server adds warmup/cooldown booleans itself
- Run events default to **pace** as the metric. If the athlete trains by power or HR, override explicitly per step (`Z2 Power`, `Z2 HR`).

Reference: zonepace.cc has DSL examples and a calculator.

### Date format

Intervals event timestamps require a time component:
- ❌ `2026-05-21` → returns 422 error
- ✅ `2026-05-21T00:00:00` (all-day NOTE events)
- ✅ `2026-05-21T18:00:00` (evening workouts)

### NOTE event quirks

- A NOTE event has no `type` field. If you update an existing NOTE and forget to re-pass `category: "NOTE"`, Intervals will default it back to WORKOUT and demand a `type`.
- NOTE events render their description with full Markdown.
- Give each NOTE a stable `external_id` (e.g., `strength-context-2026-05-21`) so it's easy to find via search later.

## Setup workflow for a new athlete

### Step 1: Discover the current state

**Prerequisite — the WorkoutContext MCP must be connected as a connector AND Intervals.icu must be linked through it.** Intervals is the calendar + fitness spine that the rest of this workflow runs on; both halves are non-negotiable. Validate this **before** asking any of the discovery questions below — there's no value in collecting targets, history, or preferences if you can't write them anywhere.

You can't reliably introspect your own tool list, so probe in two steps — each one's a tool call, observe the result:

**Step A — probe the MCP itself.** Call `check_server_version`. This tool is registered globally for every authenticated MCP session and is the cheapest "is this connector connected" signal.

- Tool not found → the WorkoutContext MCP isn't connected as a connector in this client at all (or the OAuth flow never completed). Stop. Tell the athlete: *"It looks like the WorkoutContext MCP isn't connected to your AI client yet. Visit <https://workoutcontext.fit/> for setup instructions — you'll add a connector URL and sign in. Come back once that's done."* Do NOT proceed to Step B until this resolves.
- Tool returns a build hash → MCP is authenticated, continue to Step B.

**Step B — probe Intervals specifically.** Call `intervals_get_athlete` (which Step 2 needs anyway, so this isn't a wasted turn).

- Returns the athlete record → Intervals is connected, proceed to the discovery questions.
- Tool not found, or returns an auth / not-connected error → the MCP is authenticated but the athlete hasn't linked Intervals.icu to it yet. Recover the connection:
  - If a `connect_intervals` shim tool is exposed in your tool list, call it. It returns a single-use magic-link URL the athlete opens in a browser to authorize Intervals.icu.
  - Otherwise direct them to <https://workoutcontext.fit/settings> to connect Intervals there.
  - Remind them: **the tool list doesn't refresh mid-conversation** — once they've connected, they need to send a follow-up message so the real `intervals_*` tools appear in your tool list. Confirm `intervals_get_athlete` succeeds on the next turn before resuming.

Once both probes succeed, ask about three things — current targets, training history, and existing setup.

**Current and future targets:**
- Primary target race(s) and date(s) for the current block
- Longer-term goals beyond this block — next season's marathon, qualifying time, multi-year progression, body-composition goals, lifestyle goals
- Training disciplines actively in play (running, strength, cycling, swimming)

**Training history:**
- **Running** — PRs at the distances they care about (5K, 10K, HM, M, ultra), recency of those PRs, recent volume
- **Strength** — current 1RM or recent rep-max bests on the main lifts, returning-from-injury or detraining context
- **Cycling** — FTP history, key event times, current weekly hours
- Recent rhythm: sessions/week or hours/week before this conversation
- Any time off, injuries, or restart context

**Existing setup:**
- Stale docs / spreadsheets / old apps to retire

Then check which optional providers are connected. Hevy / Oura / Withings each may or may not be (Intervals.icu was already validated as a prerequisite above). Quick detection: try a lightweight read from each — `hevy_user_info`, `oura_personal_info`, `withings_list_devices`. A failure (auth error or empty response) means not connected.

For each provider that is *not* connected, ask whether the athlete uses that service and wants to connect it:

- **Hevy** — if they want strength templates + logs reflected in the plan
- **Oura** — if they want sleep, readiness, and HRV signals feeding recovery decisions
- **Withings** — if they want body composition, weight, or sleep tracking

If they say no to any, skip the relevant sections of the workflow and don't surface those tools later.

If they say yes, the athlete connects the provider through Claude's connectors / settings UI. **The conversation's tool list does not refresh automatically after connection** — Claude won't see the new provider's tools until the athlete sends a new message (which triggers a fresh tool load) or restarts the conversation. Let them know to send a follow-up message once the provider is connected, then continue the workflow.

**Then verify Intervals.icu itself has at least one upstream activity source connected.** Intervals.icu doesn't generate activity data on its own — it ingests from Garmin, Strava, Polar, Wahoo, Zwift, etc. If none of those are linked, the calendar is empty and the rest of this workflow has nothing to work with. Detection: call `intervals_get_athlete` and look at the per-provider fields on the response — Intervals has no dedicated `/connections` endpoint, but the athlete record carries connection state inline. Any one of these counts as "connected":

- `strava_authorized: true` (Strava)
- `icu_garmin_health: true` or `icu_garmin_training: true` (Garmin)
- Non-null `<provider>_user_id` for any of: `suunto`, `coros`, `wahoo`, `zwift`, `concept2`, `zepp`, `huawei`
- Non-null `<provider>_scope` for any of: `polar`, `oura`, `whoop`, `google`, `dropbox`

If *none* are populated, stop the workflow and tell the athlete: *"Intervals.icu doesn't have any activity source connected yet, so there's no training history to plan from. Add one (Garmin, Strava, Polar, Wahoo, Zwift, etc.) at <https://intervals.icu/settings/connections>, wait for at least one recent activity to sync over, and let me know when that's done."* Resume only once they confirm a connection completed and at least one activity has appeared on their calendar.

### Step 2: Pull current state from the APIs

Before designing anything, query Intervals (always):

- `intervals_get_athlete` — profile, sport configuration
- `intervals_list_sport_settings` — FTP, LTHR, max HR, threshold pace, `workout_order`
- `intervals_get_athlete_summary` — recent CTL, ATL, form, body weight
- `intervals_list_events` (next 4 weeks) — what's already scheduled

If Hevy is connected:
- `hevy_list_routine_folders` — existing folder structure
- `hevy_list_routines` — all routines (current + legacy)
- `hevy_list_workouts` (last ~10) — actual training history for weight baselines

If Oura is connected: pull recent readiness / sleep / HRV summaries to inform the recovery section of the playbook.

If Withings is connected: pull recent weight / body composition / sleep summaries for the snapshot.

### Step 3: Confirm conventions

Ask and then store in user memory:

- Hevy DB weight convention — combined or per-dumbbell?
- Display units — lb or kg?
- Primary run metric — power, HR, or pace?
- Schedule preferences — fixed weekly slots, or floating?
- Any sessions that have fixed names (e.g., "Tuesday is club run")?

### Step 4: Create the playbook(s)

For each discipline, draft a Markdown NOTE with these sections (adapt per discipline):

- 🎯 **Block & target** — race date, phase structure, and longer-term goals beyond this block
- 🏆 **Personal records & background** — notable PRs (race times, lift maxes), training history context, returning-from-injury notes (optional but valuable for goal-setting and reference)
- 📅 **Weekly structure** — what each day's role is
- ⚡ **Zones / weights** — current thresholds and working weights, in tables
- 📊 **Current snapshot** — CTL/ATL/form, body weight, any other markers
- 🏃 / 🏋️ **Workout taxonomy** — what each kind of session is for
- 📈 **Progression** — long run / volume / load progression rules
- ✏️ **Changes — `<date>`** — day-of changes
- 🩹 **Recovery levers** — what to drop first when fatigue accumulates

Title format: `<emoji> <Discipline> Playbook` (e.g., `💪 Strength Training Playbook`). Date the NOTE to today.

For ready-to-adapt scaffolds, see this skill's `references/` directory:

- `references/strength-playbook-template.md` — for strength, weightlifting, hypertrophy, GPP blocks
- `references/running-playbook-template.md` — for running blocks (5K through ultra)
- `references/cycling-playbook-template.md` — for road, gravel, MTB, or TT blocks

Copy the relevant template, fill in placeholders using the discovery and API state from Steps 1–2, and save the result as a NOTE event on the Intervals calendar.

### Step 5: Align Hevy routines with the athlete's approach (skip if Hevy not connected)

For each active routine:
- Verify exercises, sets, reps match the playbook and the athlete's stated approach
- Confirm set types — relabel any sets that are clearly warmups but tagged `"normal"`
- Pre-fill or leave empty per the athlete's preference
- Add notes for new exercises (form cues, build-to targets, anything specific the athlete cares about)
- Make all routines in the folder follow the same conventions — consistency is the win

### Step 6: Encode the conventions in memory

Add to user memory:

> Plan source of truth = Intervals.icu (NOTE events for context) + Hevy. NOTE descriptions render Markdown — use headers, tables, bold. Change-tracking: same-day change → update existing note; new-day change → CREATE new note dated that day with full state + `Changes — <date>` section. Old notes = snapshots. Latest playbooks: `<external_ids>`.

Also record:
- Hevy DB weight convention
- Excluded docs/sources
- Any session naming defaults

## Audit workflow

When the athlete asks to audit their setup:

1. **Pull templates** — `hevy_list_routines`
2. **Pull recent logs** — `hevy_list_workouts` (last 5–10 sessions)
3. **Cross-reference** template values vs actual training history:
   - Are working weights current? (templates go stale)
   - Do rep ranges match actual practice?
   - Are set types correct? (warmup vs normal)
4. **Check the playbook** — does it reflect what's actually in the templates?
5. **Calendar event descriptions** — do they match the Hevy templates?

**Templates beat calendar event descriptions for the athlete.** What's in Hevy is what gets lifted. If they drift apart, align them — usually by updating the calendar event to match the template, since the template reflects reality.

## Common pitfalls

### Mislabeled warmup sets
The most common audit finding: light ramp-up sets tagged `"normal"` inflate working-set volume counts. Always check the `type` field.

### Hevy app caching
After updating a routine via the API, the Hevy mobile app may need a pull-to-refresh or full restart to display the changes. If the athlete says "I don't see the update", check the API first to confirm it persisted; usually it has, and they just need to refresh.

### Workout logs are immutable snapshots
Updating a template doesn't retroactively change past workout logs. If the athlete is looking at a logged session, they'll see the old values; only the template reflects new values.

### Stale FTP / threshold
Athletes often forget to update `sport_settings` after a fitness change. Check `eFTP` in the athlete summary against the configured FTP — large gaps suggest recalibration is overdue. Flag it but don't update FTP without confirmation; athletes usually have reasons for their settings.

### Multiple "Push" or "Pull" routines
Athletes accumulate old routines from previous blocks. Confirm which folder / routine the athlete is actively using before editing. Look at the most recent workout log to disambiguate.

### Trying to edit Google Docs
The MCP can read Drive files but cannot update Google Docs in place. If the athlete has a planning doc, migrate its content into Intervals NOTE events and treat the doc as archive.

### Newly connected provider tools aren't immediately available
After an athlete connects a new provider (Hevy, Oura, Withings) mid-conversation, the tool list doesn't refresh in flight. Claude won't see the new tools until the athlete sends a new message — which triggers a fresh tool load — or restarts the conversation. If you try to call a just-connected tool and it fails with "tool not found" or similar, this is almost certainly why. Ask the athlete to send a follow-up message and try again.

### Adding events without confirming intent
If the athlete names a specific connector or app, use it. If they describe an intent without naming a connector ("track my runs"), don't pre-pick a partner — surface options and let them choose.

## Memory hygiene

Useful items to encode in user memory for future sessions:

- Hevy DB weight convention (combined vs per-dumbbell)
- Primary run metric and `workout_order`
- Default names for recurring sessions (e.g., "Tuesday social = MRC, 5mi Z1")
- Change-tracking rule for playbooks
- Latest playbook `external_id`s for fast retrieval
- **Notable PRs** — race times by distance, lift maxes — for goal calibration and reference
- **Long-term goals** beyond the current target race (next season's race, qualifying times, multi-year arcs)
- Any external docs/spreadsheets to exclude
- Intervals DSL conventions (power_zone vs %ftp, type field caveat, etc.)

## Optional: wellness integration (Oura, Withings)

If the athlete uses Oura or Withings:

- Pull recent readiness / sleep / HRV via `oura_list_daily_readiness`, `oura_list_daily_sleep`, etc.
- Pull weight, body composition, sleep via `withings_get_measurements`, `withings_get_sleep_summary`
- Reference wellness signals in playbook recovery rules (e.g., "If HRV drops ≥10% for 3 days, swap next quality for easy")
- Don't automate decisions off wellness data — surface signals, let the athlete decide

Wellness data is also useful in calendar event descriptions: "Yesterday's Oura readiness was 62 — consider easy if it stays low."

## When something goes wrong: file a debug trace

The WorkoutContext MCP ships a `debug_trace` tool that files a structured bug report as a GitHub Issue in the maintainer's private feedback repo. **Use it.** It is the primary feedback channel — silent failure is worse than a noisy report.

### When to offer

- You've made 3+ attempts on the same request without making progress
- The athlete shows frustration ("forget it", "this isn't working", "ugh")
- You're about to say "I can't do that" / "I don't have a tool for that" — offer to file a trace first so the maintainer can consider adding it
- A tool returns data that's structurally surprising (missing fields, wrong units, empty when populated data was expected)

Phrase the offer as a way to help everyone, not an apology: *"Want me to file a debug trace so the maintainer can improve this?"*

### Always include version SHAs for drift triage

Three commit hashes can drift independently; the maintainer needs all three to tell a real bug from a stale-cache artifact. Always pass these when filing:

- **`mcpToolBaseline`** — the build hash baked into the `check_server_version` tool's description. Read it straight out of that tool description (no need to actually call the tool). It's the SHA the LLM saw at tool-load time; if it differs from the server's live SHA, the worker was redeployed mid-session and your cached tool schemas may be stale.
- **`skillVersion`** — the short SHA from the very bottom of this `SKILL.md` file (look for the line starting with `Built from`). It's the commit the skill release was built from; if it differs from the server SHA, this skill copy is older than the server's current code.

The server fills in its own current build hash automatically — you only need to provide the two above.

### Privacy

A human reviews these reports. Do **not** paste raw athlete messages, raw tool-call response bodies, or biometric numbers verbatim. Paraphrase. Treat report fields as if they could be read by a third party.
