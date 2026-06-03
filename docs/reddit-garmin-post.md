# r/garmin launch post — WorkoutContext

Draft for posting WorkoutContext to /r/garmin. Angle: plan a workout in plain English and it pushes to your Garmin watch (via Intervals.icu's Garmin Connect integration).

## Title options

- *I built WorkoutContext — describe a workout in plain English, it syncs to your Garmin watch* **(recommended)**
- *Free tool: plan structured workouts by chatting, they push to your Garmin ready to run*
- *WorkoutContext — skip Garmin's workout builder, just describe the session and it lands on your watch*

## Body

> *Disclosure: I'm the dev. Sharing because this leans on Garmin's structured-workout push. Mods, take it down if it's not allowed.*

Garmin's workout builder is fine but slow, and Garmin Coach is pretty one-size-fits-all. I wanted to just *say* "45 min easy with 6×20s strides" and have it on my watch. So I built **WorkoutContext**.

It's an MCP connector that lets Claude build real structured workouts from plain language and write them to your **Intervals.icu** calendar — which, if you've linked Intervals to Garmin Connect, **pushes them straight to your watch** with guided steps, targets, and alerts. Same path Garmin/Coros users already use for structured workouts; this just makes *creating* them conversational.

A few things it does:
- **Builds proper structure** — warmup / main set / intervals / cooldown, with pace, HR, or power targets depending on your settings.
- **Knows your data** — it reads the activities, HR, and fitness numbers Garmin has already synced into Intervals, so the workouts fit your actual training, not a generic template.
- **Optional extras** — strength (Hevy) and recovery (Oura/Withings) if you use them; ignore otherwise.

Honest bit: Garmin doesn't take workouts directly, so this needs a **free Intervals.icu account linked to Garmin Connect** — Intervals is the bridge both directions (activities in, planned workouts out to your watch).

**Free and open-source** ([github.com/agiantwhale/workoutcontext](https://github.com/agiantwhale/workoutcontext)) — set up at [workoutcontext.fit](https://workoutcontext.fit).

Curious whether the workouts it generates land cleanly on people's watches across different Garmin models — would appreciate reports.

## Pre-post checklist

- [ ] Confirm the GitHub repo is **public** — the open-source link 404s for readers if it's still private.
- [ ] Check r/garmin self-promotion rules (Reddit's 10% rule; some subs gate it to a thread or require flair).
- [ ] Watch compatibility: structured-workout push works on most modern Garmin watches but not very old/basic models — state the model cutoff if known, otherwise keep the "would appreciate reports" framing.
