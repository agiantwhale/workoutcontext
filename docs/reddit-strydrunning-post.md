# r/strydrunning launch post — WorkoutContext

Draft for posting WorkoutContext to /r/strydrunning (power-first runners who plan in Intervals.icu).

## Title options

- *WorkoutContext: plan power-based Intervals.icu workouts in plain English (Stryd-friendly)*
- *I built WorkoutContext — plain-language structured workouts that target your power zones, not pace* **(recommended)**
- *WorkoutContext: a free tool that connects Claude to Intervals.icu and respects your power-based sport settings*
- *Made WorkoutContext — talk to Claude, get power-targeted Intervals.icu workouts on your calendar*

## Body

> *Disclosure: I'm the dev. Sharing here because a lot of you plan power workouts in Intervals.icu. Mods, take it down if it's not allowed.*

I run with a Stryd and plan everything in Intervals.icu with power. Turning "give me 5×1k at threshold power" into a properly structured workout — warmup/main/cooldown, zones, load estimate — got old, so I built **WorkoutContext**.

It's an MCP connector that lets Claude write real structured workouts onto your Intervals.icu calendar from plain language (and they push to your Garmin/Coros like normal). The part this sub will care about: **it targets power, not pace** — if your Run `workout_order` is POWER_HR_PACE, the workouts it builds use power zones, so the chart and training-load match what you'd expect.

Caveat worth stating up front: it uses **Intervals.icu's** power zones (off your Intervals FTP/eFTP), not Stryd's Critical Power model — keep your Intervals FTP synced to your CP and they line up. Or just ask for explicit watt ranges (e.g. "240–250W").

It's **free and open-source** ([github.com/agiantwhale/workoutcontext](https://github.com/agiantwhale/workoutcontext)) — connect from [workoutcontext.fit](https://workoutcontext.fit) with your Intervals.icu login.

Would love feedback from power runners on whether the generated workouts match how you'd actually structure them.

## Pre-post checklist

- [ ] Confirm the GitHub repo is **public** — the open-source link 404s for readers if it's still private.
- [ ] Check the sub's self-promotion rules (some niche subs gate it to a weekly thread or require flair).
- [ ] Optional: open with a concrete example of the DSL it generates, to show rather than tell.
