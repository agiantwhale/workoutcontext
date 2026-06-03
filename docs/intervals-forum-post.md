# Intervals.icu forum post — WorkoutContext

Draft for the Intervals.icu forums. Angle: it's an MCP server only — no baked-in methodology, the user drives the plan, very adaptable.

## Title

*WorkoutContext — an MCP server for Intervals.icu (you build the plan, not the tool)*

## Body

Hi all — sharing a project I've been building on top of the Intervals.icu API, in case it's useful to others here.

**What it is:** WorkoutContext is an **MCP server** — nothing more. It doesn't have its own app, UI, or opinions about how you should train. It simply gives an MCP-capable AI assistant (Claude, today) authenticated access to your Intervals.icu account: reading your activities, wellness, sport settings, fitness numbers, and writing structured workouts, events, and NOTEs back to your calendar.

**Why MCP-only matters:** because there's no coaching engine baked in, *you* drive the plan entirely through conversation. There's no fixed methodology, no "our system says do 80/20," no preset templates you have to bend to. You describe how you actually train — your periodization, your zones, your constraints, your weird Tuesday club run — and the assistant works within Intervals.icu to build and maintain exactly that. It adapts to you instead of the other way around:

- Any discipline or mix — run, bike, swim, strength, triathlon, whatever.
- Your own progression rules, recovery logic, and naming conventions.
- Workouts written as Intervals' DSL so they render on the chart and push to Garmin/Coros like any structured workout.
- Plans stored as dated NOTEs on your calendar, so context carries between conversations rather than living in a separate app.

Because it's a thin, faithful bridge to the API, it's only as good as the API — which is why I've genuinely appreciated how capable and well-documented it is. (Optional extras: it can also pull in Hevy, Oura, and Withings if you connect them, but Intervals.icu is the spine.)

It's **free and open-source** ([github.com/agiantwhale/workoutcontext](https://github.com/agiantwhale/workoutcontext)); you connect it with your Intervals.icu login at [workoutcontext.fit](https://workoutcontext.fit). Auth is standard OAuth — you grant access, and can revoke it anytime.

Would love feedback from this community in particular, since you all push the API harder than most. Happy to answer questions about how it works under the hood.

## Notes
- Keep the DSL-quirks list (`docs/intervals-dsl-feedback.md`) out of the public post — better as a direct note to David.
- Post thanks the API obliquely; name David directly if posting where he'll obviously see it.
- Optional Hevy/Oura/Withings line can be cut if you want it Intervals-pure.
