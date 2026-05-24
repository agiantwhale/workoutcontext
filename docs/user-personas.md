# User Personas

Five representative user profiles for WorkoutContext. Each persona exercises a different combination of providers, goals, and onboarding paths — useful for validating the skill's first-run flow and identifying gaps.

## Validation results

These personas were walked through the SKILL.md onboarding flow to identify gaps. Key issues found and fixed:

1. **Activity source check was a hard blocker for strength-only users** (Jake) — no fallback when the only activity source is Hevy webhook sync. Fixed: added strength-only path that skips the device requirement.
2. **No guidance for athletes new to Intervals.icu** (Sarah) — no mention of account creation during OAuth, no handling of empty sport settings. Fixed: added account creation note and thin-data handling section.
3. **No swim playbook template** (Diana) — triathletes hit a dead end for their third sport. Fixed: added guidance to create freeform playbooks for disciplines without templates.
4. **No multi-playbook merging** (Marcus) — no guidance on combining running + strength into a unified weekly schedule. Fixed: added multi-discipline scheduling guidance.
5. **No injury/medical context in onboarding** (Priya) — return-from-injury is the most common non-standard scenario. Fixed: added dedicated injury/medical section and rehab-style playbook guidance.
6. **Recovery integration too shallow** (Diana, Priya) — one example rule was insufficient. Fixed: added specific Oura/Withings API endpoints, reactive + proactive rule patterns, and sleep data overlap guidance.
7. **Endurance-first language alienated strength-only users** (Jake) — features, conventions, and audit items were unconditionally cardio-focused. Fixed: added conditional gating throughout.
8. **Structured workout push only works for Garmin/Coros** (Marcus) — Apple Watch users would hit a dead end. Fixed: added watch compatibility note.
9. **Suggestions not gated** (Sarah, Jake) — auto-syncs, Garmin connection, and doc migration were offered unconditionally. Fixed: each suggestion now has an explicit relevance condition.

---

## 1. Sarah — Marathon runner, Garmin ecosystem

**Background:** 34, software engineer, has run 3 marathons. Uses a Garmin Forerunner 265 for all runs. Trains 5 days/week with one long run, two quality sessions, two easy days. No strength training currently.

**Devices & apps:** Garmin watch, Garmin Connect, Strava (auto-synced from Garmin). Has heard of Intervals.icu but never used it.

**Goals:** Sub-3:30 marathon in October (current PR 3:42). Wants a structured 18-week plan with proper periodization.

**What she'd connect:** Intervals.icu (new), Garmin → Intervals.icu sync. No Hevy, no Oura, no Withings.

**Why she's interesting:** Tests the "new to Intervals.icu" onboarding path. Needs help connecting Garmin as an activity source. Pure running — single-discipline playbook. No strength component to manage.

---

## 2. Marcus — Hybrid athlete, runs + lifts

**Background:** 28, personal trainer, runs 3x/week and lifts 4x/week. Uses Hevy religiously to track all strength work. Runs with an Apple Watch synced to Strava.

**Devices & apps:** Apple Watch, Strava, Hevy (Pro subscriber). Has an Intervals.icu account linked to Strava already.

**Goals:** Run a sub-20 5K (current PR 21:12) while maintaining a 315 lb squat and 225 lb bench. Doesn't want running to eat into his strength gains.

**What he'd connect:** Intervals.icu (existing), Hevy, Strava. No Oura, no Withings.

**Why he's interesting:** Tests the full Hevy + Intervals flow — routine creation, strength playbook, Hevy → Intervals.icu sync setup. Dual-discipline playbook (running + strength). Needs convention confirmation (DB weight, display units). Existing Intervals account means skipping some setup steps.

---

## 3. Diana — Data-driven triathlete, all the sensors

**Background:** 41, product manager, trains for Olympic-distance triathlon. Wears an Oura ring 24/7, weighs in daily on a Withings Body+ scale, rides with a power meter, runs with a Garmin Fenix 8.

**Devices & apps:** Garmin watch, Oura ring, Withings scale, Intervals.icu (power user — already has sport settings dialed in for cycling and running). Uses Strava socially.

**Goals:** Qualify for Age Group Nationals next season. Current FTP 210W, threshold pace 5:05/km. Wants to use HRV and sleep data to auto-adjust training intensity.

**What she'd connect:** Intervals.icu (existing, well-configured), Oura, Withings. No Hevy (does bodyweight/band work, doesn't log it).

**Why she's interesting:** Tests the full wellness integration path — Oura recovery signals, Withings body composition sync. Multi-sport with existing sport settings. Wants data-driven recovery rules in the playbook. Tests the suggestion to enable Withings → Intervals.icu auto-sync.

---

## 4. Jake — Casual lifter going structured

**Background:** 23, graduate student, has been lifting 3x/week for 2 years but never followed a program. Just does "chest day, back day, legs day" with whatever weights feel right. Recently downloaded Hevy to start tracking.

**Devices & apps:** Hevy (just started Pro trial). No watch, no Strava, no Intervals.icu account.

**Goals:** Wants to actually follow a program. Interested in a hypertrophy block (3-day upper/lower or PPL). Doesn't run or do cardio. Would like to start tracking body weight.

**What he'd connect:** Intervals.icu (new — needs it for the playbook spine), Hevy. Possibly Withings later if he gets a scale.

**Why he's interesting:** Tests the strength-only onboarding path. New to Intervals.icu — needs the full setup walkthrough. No activity source from a watch (Intervals calendar is plan-only, no completed activities syncing in). Tests whether the skill gracefully handles "no cardio, no watch" without pushing irrelevant features. Hevy has existing workout history but no routines — needs to build from scratch.

---

## 5. Priya — Returning from injury, rebuilding

**Background:** 37, physical therapist, was a competitive 10K runner (PR 38:40) before a stress fracture 4 months ago. Just cleared to run again. Also started light strength work during recovery.

**Devices & apps:** Garmin Venu 3, Intervals.icu (linked to Garmin, has historical data from before injury), Oura ring (got it during recovery to monitor sleep/HRV). Considering Hevy for the strength side.

**Goals:** Return to 40 km/week safely over 12 weeks without re-injury. Rebuild to race-ready by spring. Use HRV to gate progression — only increase volume when recovery metrics are green.

**What she'd connect:** Intervals.icu (existing, with gap in activity history), Oura (existing), Hevy (new). No Withings.

**Why she's interesting:** Tests the return-from-injury narrative — the playbook needs to encode conservative progression rules, not just standard periodization. Has a historical Intervals account with a gap (injury period). Oura data is central to the plan, not decorative. Tests connecting a new provider (Hevy) mid-setup while others are already live.
