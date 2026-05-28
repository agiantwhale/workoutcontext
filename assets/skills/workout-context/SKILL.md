---
name: workout-context
description: Onboarding companion for the WorkoutContext MCP. Use on first interaction to walk the athlete through what the MCP does, connect their providers, learn their training history and goals, and build a personalized training plan. Also use when transitioning between training blocks, when the athlete wants to audit or update their setup, or when they mention drift between their plan and what's actually scheduled.
---

# WorkoutContext

WorkoutContext is an MCP that turns your AI assistant into a coach that actually knows you — your training data, your numbers, your plan. It connects Claude to Intervals.icu, Hevy, Oura, and Withings so advice is grounded in real data, not generic templates.

## What you can do with it

Tailor the pitch to the athlete's ecosystem and experience level — lead with features relevant to their sports and devices, skip the rest. For beginners, use plain language (avoid jargon like CTL, FTP, threshold pace until they're ready for it).

- **Training playbooks** — playbooks for any discipline (running, cycling, strength, swimming, triathlon, etc.) built from your actual data — or from a guided conversation if you're just getting started. Stored as dated NOTE events on your Intervals.icu calendar so every conversation starts with context.
- **Structured workouts synced to your watch** — ask for a tempo run or threshold intervals and the assistant writes it as a structured Intervals.icu workout with proper warm-up / main set / cool-down. From there, Intervals.icu's Garmin and Coros integrations push it to your watch. *(Apple Watch and other watches don't support structured workout push from Intervals.icu — the workout still lives on the calendar, but execution is manual.)*
- **Strength templates with real weights** — the assistant builds Hevy routines informed by your recent set history, not guesses. You execute from the Hevy app; the assistant pairs it with a calendar event for schedule and training-load tracking. *(Requires Hevy Pro.)*
- **Automatic Hevy → Intervals.icu sync** — finished Hevy sessions are mirrored into Intervals.icu as structured activities (duration, exercises, set-level detail) via webhook in real time. Your training load chart reflects strength work alongside runs and rides.
- **Withings → Intervals.icu body composition sync** — weight, body fat %, lean mass, and optional custom fields (muscle mass, bone mass, body water) synced on every weigh-in.
- **Withings → Hevy body weight sync** — keeps Hevy's body measurement log current automatically.
- **Oura recovery signals** — sleep, readiness, HRV, SpO₂, and resilience data to inform recovery decisions and playbook rules.

## First-time setup

When the athlete first invokes this skill or asks about getting started, walk them through setup in order.

### 1. Check the MCP connection

Call `setup_status`. This is the single source of truth for what's connected.

- If the tool isn't found, the MCP isn't connected at all. Direct the athlete to https://workoutcontext.fit/ for setup instructions — they need to add the connector URL and sign in. Stop here until that's done.
- If it returns, read the `connected` and `needs_connection` lists to see which providers are live.

### 2. Connect providers

The athlete needs at least one **primary sign-in provider** to create their account:

- **Intervals.icu** — the calendar and fitness spine. Needed for structured workouts, playbooks, activity history, and training load. This is the one provider every athlete should connect. If the athlete doesn't have an Intervals.icu account yet, they'll create one during the OAuth sign-in flow — it's free for everyone.
- **Strava** — activities, segments, routes, and gear. An alternative sign-in path. If the athlete signs in via Strava, they should also connect Intervals.icu afterward from /settings since Intervals.icu is needed for playbooks and structured workouts.

Once signed in, they can optionally connect **secondary providers** from /settings. Only mention providers that are relevant to the athlete's training — don't list all of them:

- **Hevy** — strength workouts and routines. Requires a Hevy Pro subscription. Connect if they do structured strength training and want templates with real working weights.
- **Oura** — sleep, readiness, HRV, activity, SpO₂. Connect if they want recovery data informing their plan.
- **Withings** — body composition, weight, sleep, blood pressure. Connect if they want body metrics tracked and synced.

For each provider the athlete wants to connect, call the corresponding `connect_<name>` tool — it returns a single-use link the athlete opens in their browser to authorize via OAuth or paste an API key. **The tool list doesn't refresh mid-conversation** — after connecting, the athlete needs to send a follow-up message so the new tools appear. If the athlete connects a provider mid-session (e.g., adds Hevy after Intervals is already live), pause, walk them through the connection, tell them to send a follow-up message, then resume where you left off once the new tools load.

### 3. Check for an activity source on Intervals.icu

Intervals.icu doesn't generate activity data on its own — it ingests from Garmin, Strava, Polar, Wahoo, Coros, Zwift, etc. Call `intervals_get_athlete` and check whether any upstream source is connected:

- `strava_authorized: true` (Strava)
- `icu_garmin_health: true` or `icu_garmin_training: true` (Garmin)
- Non-null `<provider>_user_id` for suunto, coros, wahoo, zwift, concept2, zepp, huawei
- Non-null `<provider>_scope` for polar, oura, whoop, google, dropbox

**If none are populated:**

- **For athletes who do cardio (running, cycling, triathlon, etc.):** an activity source is important but not a blocker. If they have a GPS watch (Garmin, Coros, Polar, Suunto, etc.), direct them to connect it at https://intervals.icu/settings/connections. If they use a Garmin or Coros watch, mention that Intervals.icu can push structured workouts directly to their watch — it's one of the most useful features. **If they don't have a watch or tracker yet**, suggest the free Strava phone app as an entry point — phone GPS records runs and syncs to Intervals.icu. If they plan to buy a watch later, the calendar and playbook work fine in the meantime. Don't block setup waiting for a device — proceed with the onboarding conversation and build the plan from self-reported data.
- **For strength-only athletes:** an activity source is optional. Hevy → Intervals.icu sync (enabled from /settings) will feed completed strength sessions into Intervals as activities. The calendar works fine as a planning spine without a watch — they just won't have auto-synced cardio activities. Don't block setup waiting for a device connection that isn't needed.

**For newly connected activity sources:** initial sync can take minutes to hours depending on history depth. One synced activity is enough to proceed — you can check via `intervals_list_activities`.

## Onboarding conversation

Once providers are connected, learn about the athlete through conversation. Don't dump a questionnaire — ask naturally, one topic at a time. Skip topics that clearly don't apply (don't ask a pure lifter about running PRs, don't ask a runner about dumbbell conventions).

### Training disciplines

What do they actively train — or want to start? Running, cycling, strength, swimming, triathlon, other? "I want to start running" or "I've never lifted but want to" are first-class answers — they shape the plan toward a beginner ramp-up rather than standard periodization. This determines which playbooks to build and which data to pull.

### Goals and targets

- **Near-term** — target race(s) and date(s), current training block focus, strength milestones
- **Long-term** — next season's race, qualifying times, body composition goals, multi-year progression
- If they don't have a specific target, that's fine — "stay consistent" or "general fitness" is a valid goal that shapes the plan differently

### Injury, medical context, or deconditioning

- Any current or recent injuries, surgeries, or medical restrictions
- If returning from injury: what was it, when were they cleared, are there load restrictions from a doctor or PT?
- If coming from a long sedentary period (months/years of inactivity), treat them with similar conservatism to a return-from-injury case — musculoskeletal readiness is low regardless of general health
- This shapes the plan significantly — a return-to-run or walk-to-run progression is fundamentally different from a standard training block

### Training history and PRs

Ask only about the athlete's active disciplines. **If they're a complete beginner in a discipline, that's the answer** — don't push for PRs or history that don't exist. Note their experience level so the plan is calibrated appropriately.

- **Running** — PRs at distances they care about (5K, 10K, HM, marathon, ultra), recency, recent weekly volume. If beginner: have they ever run continuously? What's the longest they've walked/run?
- **Cycling** — FTP history, key event times, current weekly hours. If beginner: do they own a bike? Indoor/outdoor?
- **Swimming** — CSS/threshold pace, weekly volume, pool vs. open water. If beginner: can they swim continuously? Any lessons/background?
- **Strength** — current working weights or recent rep-max bests on main lifts, training age, methodology background. If beginner: have they ever used free weights? Any gym experience at all?
- Recent rhythm: sessions/week, hours/week, any recent time off

### Schedule and preferences

- Fixed weekly slots vs. flexible scheduling
- Any immovable sessions (e.g., "Tuesday is club run", "Thursday evenings are off")
- How many days/week they want to train
- Morning vs. evening preference
- For multi-discipline athletes: which days double up, how to order sessions on double days (e.g., run AM / lift PM), any interference concerns

### Existing setup to migrate

Only ask if it seems relevant — most athletes don't have stale docs. If they do: the MCP can read Google Drive files but can't update Docs in place — migrate content into Intervals NOTE events and treat the doc as archive.

## Building the plan

After the onboarding conversation, pull current state from the APIs and build the athlete's plan.

### Pull current data

From Intervals.icu (always):
- `intervals_get_athlete` — profile, sport configuration
- `intervals_list_sport_settings` — FTP, LTHR, max HR, threshold pace, `workout_order`
- `intervals_get_athlete_summary` — recent CTL, ATL, form, body weight
- `intervals_list_events` (next 4 weeks) — what's already scheduled

**Thin-data handling:** if sport settings are empty or default (common for new Intervals.icu accounts), populate zones from the athlete's self-reported PRs and thresholds from the onboarding conversation. If CTL/ATL are near zero (new account, returning from injury, or long gap), acknowledge it and base the plan on the athlete's self-reported recent volume instead of trusting fitness model numbers.

**Cold-start protocol (complete beginners with zero data):** when the athlete has no PRs, no threshold data, and no recent training volume at all:
- **Running:** skip zone tables initially — use conversational pace ("run at a pace where you can hold a conversation") and perceived effort. For complete beginners or deconditioned athletes, start with a walk/run progression (e.g., alternate 1 min run / 2 min walk, building toward continuous running over 6-8 weeks). Zones can be populated after the first few weeks once they have pace data from recorded runs or a timed effort.
- **Cycling:** use RPE-based targets (easy / moderate / hard) until they have enough rides for an estimated FTP.
- **Strength:** start with conservative weights — empty bar for barbell movements, light dumbbells for accessories. Frame the first 1-2 sessions as "weight discovery" where the goal is finding appropriate working weights, not hitting targets. Use RPE (rate of perceived exertion) rather than percentage-based loading.
- Estimate max HR from age (220 - age) only as a rough starting point if needed for HR zones.

If Hevy is connected:
- `hevy_list_routine_folders` + `hevy_list_routines` — existing routine structure
- `hevy_list_workouts` (last ~10) — actual training history for weight baselines

If Oura is connected:
- `oura_list_daily_readiness` — readiness scores and contributors
- `oura_list_daily_sleep` — sleep scores, total sleep, efficiency
- `oura_list_daily_stress` — stress levels
- Recent HRV trend via readiness contributors

If Withings is connected:
- `withings_get_measurements` — weight, body fat %, lean mass, bone mass
- `withings_get_sleep_summary` — sleep duration and quality

### Confirm conventions

Ask only about conventions relevant to the athlete's disciplines and connected providers:
- Display units — lb or kg?
- For runners/cyclists with a device: primary training metric — power, HR, or pace? (cross-check with `sport_settings.workout_order`). For beginners without a device, default to perceived effort / conversational pace — zones can be populated later once they have data.
- For Hevy users: dumbbell weight convention — combined total or per-dumbbell?
- Schedule preferences — fixed weekly slots or floating?
- Any session naming defaults (e.g., "Tuesday social = MRC, 5mi Z1")
- For athletes with Oura/Withings: how do they want recovery data surfaced? (daily check-in, threshold alerts only, embedded in playbook recovery rules)

### Create playbooks

A **playbook** is a Markdown-formatted NOTE event on the Intervals calendar that captures everything for a discipline: weekly structure, zones, working weights, progression rules, recovery levers. Athletes typically maintain one per discipline.

Use the templates in this skill's `references/` directory as scaffolds:
- `references/running-playbook-template.md`
- `references/cycling-playbook-template.md`
- `references/strength-playbook-template.md`

For disciplines without a template (swimming, triathlon, etc.), create a playbook freeform following the same structure: block & target, PRs & background, weekly structure, zones/paces, progression rules, recovery levers. A triathlete may want one combined playbook or separate ones per discipline — ask.

For **beginners**: simplify the playbook template significantly. Omit zone tables (mark as "TBD — populate after first few weeks of data"). Replace advanced workout taxonomies (tempo, threshold, VO2 intervals) with beginner-appropriate session types (easy run, walk/run intervals, strides). Frame the target as a consistency or volume milestone ("run 5K continuously", "lift 3x/week for 8 weeks") rather than a race with a time goal. Progression should be simple and conservative (e.g., add 5-10% volume per week, step back every 4th week).

For **athletes adding a new discipline** (e.g., runner starting to lift, lifter starting to run): the new discipline needs a beginner-appropriate ramp-up even if they're advanced in their primary sport. Key principles:
- Start the new discipline at minimal volume and build gradually — don't bolt a full program onto an existing training load from day one
- The existing discipline may need to shift to a maintenance phase temporarily to create recovery capacity. For strength, this means reduced volume (fewer sets) while preserving intensity (same weights). For running/cycling, this means holding mileage steady or reducing slightly.
- Address interference explicitly: leg-day/run-day conflicts, caloric needs, accumulated fatigue across disciplines. Put session ordering rules in the playbook (e.g., "hard run and heavy squat on the same day is fine if the run is AM and squat is PM — but don't do the reverse").

For **multi-discipline athletes**: after creating individual playbooks, produce a combined weekly schedule view that shows how disciplines interleave. Address session ordering on double days and interference management.

For **return-from-injury or deconditioned athletes**: the playbook should encode conservative progression rules (volume caps, step-back frequency, walk/run progressions if applicable) rather than standard periodization. The "target" may be a volume milestone, not a race.

Fill in placeholders using the onboarding conversation and API data. Save each as a NOTE event dated today with a descriptive title and stable `external_id`.

**Change tracking:** when the athlete changes something later:
- Same-day change → update the existing playbook in place
- New-day change → create a new NOTE dated that day with full current state plus a `## Changes — <date>` section. Old playbooks remain as historical snapshots.

### Create Hevy routines (if applicable)

If strength training is in play and Hevy is connected:

- **Experienced lifters:** ask about their methodology (set/rep scheme, progression model, warmup philosophy) and match it. Seed working weights from recent history via `hevy_get_exercise_history`.
- **Beginner lifters:** don't ask about methodology they don't understand — recommend a beginner-appropriate program (e.g., 2-3 day full-body, compound-focused, simple linear progression, 3x8-12). Offer 2-3 options framed for their goal and let them pick. If Hevy history is empty, leave weights blank or use conservative estimates — frame the first session as "weight discovery" where they find appropriate working weights.
- Pair each routine with an Intervals calendar event for scheduling and training-load tracking. **Link the two:** set the event's `external_id` to `hevy-<routineId>` (so the pair is back-linkable and `intervals_create_events_bulk` upsert is idempotent on retry), and put `[Hevy routine](https://hevy.com/routine/<routineId>)` plus the prescription in the description — `### <Exercise Name>` heading per exercise, `- <weight>kg x <reps>` bullet per working set. Same Markdown shape the Hevy → Intervals webhook writes for completed sessions, so the planned event and the synced activity read identically on the calendar.
- **Encourage RPE logging.** When the Hevy → Intervals.icu sync is enabled, training load for strength is computed as: `icu_training_load = round(session_RPE × minutes ÷ 10)` (Foster sRPE formula). Session RPE is the average RPE across working sets (warmups excluded). Without RPE on sets, the synced activity gets no training load — it appears on the calendar but doesn't contribute to the fitness/fatigue curve. Remind the athlete to log RPE (1-10) on every working set so their strength work counts toward load tracking. Typical ranges: 6-7 easy/technique, 7-8 hypertrophy, 8-9 heavy strength, 9-10 peak/AMRAP.

### Suggestions to offer

Based on what you've learned, proactively suggest relevant items — skip anything that doesn't apply to this athlete:
- **Connect Garmin/Coros to Intervals.icu** — only if they have a compatible watch and haven't linked it. Enables pushing structured workouts to their wrist. If they're considering buying a watch, mention that Garmin and Coros get structured workout push from Intervals.icu — a strong reason to choose one of those brands.
- **Enable auto-syncs** from WorkoutContext /settings — only if they have the relevant providers connected. Hevy → Intervals.icu sync mirrors finished strength sessions as structured activities with training load (requires RPE logged on sets — explain this when suggesting the sync). Withings → Intervals.icu for body composition, Withings → Hevy for body weight.
- **Connect Oura** — only if they mention sleep or recovery concerns and don't have it linked
- **Connect Withings** — if they have a Withings scale or mention body composition tracking, suggest connecting even if they haven't stated explicit goals. The sync is useful for weight tracking regardless.
- **Retire stale docs** — only if they mention having training plans in Google Docs, spreadsheets, or other apps

## Ongoing use

### Updating the plan

Whenever the athlete asks for a new or modified plan, always:
1. **Read the latest playbook first** — pull the current playbook NOTE to understand the current phase, zones, weights, and recent changes. Don't plan in a vacuum.
2. **Write the playbook after committing changes** — update the playbook to reflect what changed so the next session has context.

Skip only if the athlete explicitly says so ("don't touch the playbook", "this is a one-off").

### Auditing for drift

Templates and playbooks go stale. When the athlete asks to audit, check what's relevant to their setup:
- **Hevy users:** cross-reference template weights vs. recent workout logs — are they current? Check set types — warmup sets tagged `"normal"` inflate volume counts. Compare calendar event descriptions to Hevy templates — if they've diverged, align to the template (it reflects reality).
- **Runners/cyclists:** check Intervals sport settings — has eFTP drifted from configured FTP? Are threshold paces still accurate?
- **All athletes:** does the playbook reflect what's actually happening? Are scheduled events consistent with the stated plan?

### Recovery integration

If Oura or Withings is connected, build recovery rules into the playbook:

**Oura signals to surface:**
- `oura_list_daily_readiness` — readiness score (below ~70 suggests accumulated fatigue), HRV balance and body temperature contributors
- `oura_list_daily_sleep` — sleep score, total sleep time, efficiency, REM/deep ratios
- `oura_list_daily_stress` — daytime stress levels

**Withings signals to surface:**
- `withings_get_measurements` — weight trends, body fat % trends
- `withings_get_sleep_summary` — sleep duration (note: if both Oura and Withings track sleep, pick one as primary to avoid contradictory signals — Oura is generally more granular)

**Recovery rule patterns:**
- **Reactive:** "If HRV drops ≥10% below baseline for 3+ days → swap next quality session for easy"
- **Proactive (progression gating):** "Only increase weekly volume when HRV trend is stable or improving and readiness score averages ≥70 over the past 7 days"
- **Load shedding:** "If sleep score < 60 for 2+ nights → drop the next session's intensity by one zone"

Don't automate decisions off wellness data — surface signals and rules, let the athlete decide.

### When something goes wrong

The MCP ships a `debug_trace` tool that files a structured bug report. Use it when:
- You've made 3+ attempts without progress
- The athlete shows frustration
- You're about to say "I can't do that" — offer to file a trace first
- A tool returns structurally surprising data

Phrase it as helpful, not apologetic: *"Want me to file a debug trace so the maintainer can improve this?"*

When filing, always include `mcpToolBaseline` (the build hash from `check_server_version`'s description) and `skillVersion` (the short SHA from the footer of this file) for drift triage. Do not paste raw athlete messages or biometric numbers — paraphrase.
