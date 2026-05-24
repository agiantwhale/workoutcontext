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

### Round 2: Beginner and cross-discipline validation (Alex, Mia, Derek)

10. **Zero-data cold start not addressed** (Alex) — no protocol for athletes with zero PRs, zero zones, zero volume. Fixed: added cold-start protocol with walk/run progressions, conversational pace, RPE-based strength loading, and "populate zones later" guidance.
11. **"Don't impose a default" wrong for beginners** (Mia) — beginners need opinionated recommendations, not open-ended methodology questions. Fixed: split Hevy routine creation into experienced vs. beginner paths.
12. **No walk/run or beginner program pattern** (Alex, Derek) — templates assume periodized training. Fixed: added beginner playbook simplification guidance (consistency-first, simple session types, conservative progression).
13. **Empty Hevy history breaks weight seeding** (Mia) — "seed from exercise history" fails when history is empty. Fixed: added blank-weight and weight-discovery fallback for beginner lifters.
14. **No cross-discipline ramp-up** (Mia, Derek) — no guidance on introducing a new sport alongside an existing program. Fixed: added section on conservative ramp-up, maintenance mode for existing discipline, and interference management.
15. **No-device dead end for cardio athletes** (Alex) — activity source check blocked athletes without a watch. Fixed: added phone-based Strava suggestion and "proceed without device" path.
16. **Sedentary beginner not mapped to conservative progression** (Alex) — prolonged inactivity needs the same conservatism as return-from-injury. Fixed: added deconditioning to the injury/medical section.
17. **Jargon not gated by experience** (Alex) — CTL, FTP, threshold pace used without simplification note. Fixed: added "use plain language for beginners" instruction in the feature pitch.

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

---

## 6. Alex — Complete beginner, wants to start running

**Background:** 30, accountant, sedentary for 5 years. No exercise history at all. No watch, no apps, no accounts anywhere.

**Devices & apps:** Nothing. Phone only.

**Goals:** "Get into running" — heard about Couch-to-5K. No specific race goal yet.

**What he'd connect:** Intervals.icu (new). Nothing else initially. Might buy a Garmin later.

**Why he's interesting:** Tests the true cold-start: zero PRs, zero zones, zero volume history, no device for activity data. Validates whether the skill can handle "I've never exercised" without jargon overload or dead ends.

---

## 7. Mia — Experienced runner adding strength training

**Background:** 32, teacher, runs 5x/week (50 km/week), two half marathons (PR 1:48). Uses a Garmin Forerunner 255 synced to Intervals.icu (well-configured).

**Devices & apps:** Garmin watch, Intervals.icu (power user). Just signed up for Hevy Pro. Zero strength training history.

**Goals:** Add 2 days/week of strength to prevent injury and improve running performance. Doesn't know what exercises to do or what weight to start with.

**What she'd connect:** Intervals.icu (existing), Hevy (new, empty). No Oura, no Withings.

**Why she's interesting:** Tests the cross-discipline newcomer path — experienced in running, complete beginner in strength. Empty Hevy history means "seed from exercise history" fails. The "don't impose a default" guidance conflicts with her need for opinionated beginner recommendations.

---

## 8. Derek — Experienced lifter wanting to start running

**Background:** 26, software developer. Lifts 5x/week (PPL), training for 4 years. Squat 365, bench 275, deadlift 425. Uses Hevy Pro religiously.

**Devices & apps:** Hevy (full history), Garmin Forerunner 165 (just bought, connected to Intervals.icu yesterday — zero activities synced). No sport settings configured.

**Goals:** Run a 5K in 3 months. Worried about losing muscle and strength.

**What he'd connect:** Intervals.icu (existing but empty), Hevy (existing, full history). No Oura, no Withings.

**Why he's interesting:** Tests the opposite cross-discipline path — strong lifter, zero running history. No running PRs, no zones, no threshold pace. Empty Intervals.icu despite being "connected." Tests whether the skill handles concurrent training interference concerns ("will running kill my gains?") and maintenance-mode strength programming.
