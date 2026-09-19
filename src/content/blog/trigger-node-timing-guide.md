---
title: "Trigger Node Timing: Manual, Timer, and Cron Recipes"
description: "Manual vs timer mode, the four interval options, and how to write cron expressions for the Trigger node — with real schedules for common content automations."
date: "2026-07-05"
cluster: "automation-nodes"
keywords:
  - trigger node automation
  - cron expression automation
  - schedule automation workflow
  - automation timing
  - workflow trigger schedule
faq:
  - q: "Should I start a new automation on manual or timer mode?"
    a: "Manual, always. Build and test with manual runs until the output looks right every time, then switch to timer. A timer trigger on an unfinished workflow just produces more failed or wrong-looking runs to clean up."
  - q: "What cron expression posts once a day at 9am?"
    a: "0 9 * * * — minute 0, hour 9, every day, every month, every day of week. It's also the field's default value, since a daily-morning post is the most common single schedule."
  - q: "Can I run a workflow more than once a day?"
    a: "Yes, via a custom cron expression — e.g. 0 */4 * * * runs every 4 hours. The built-in Hourly/Daily/Weekly options cover the common cases; anything more specific is a cron expression away."
---

Every workflow has exactly one entry point, and the Trigger node is it: manual (you press Run) or timer (hourly, daily, weekly, or a custom cron schedule). The choice sounds trivial but it's actually the single biggest factor in whether an automation earns your trust or produces a mess — here's how to use both modes well.

## Manual mode: where every workflow should start

Manual mode does exactly one thing: waits for you to click Run. No schedule, no surprises. This should be the mode every new workflow lives in until you've watched it produce correct output more than once — because there's no dedicated approval-gate node in the canvas (see [node-based automation, explained](/blog/node-based-automation-explained)), manual mode on the Trigger *is* your review step during development. Flip to a timer only once you trust what the workflow produces without you watching.

## Timer mode: the four options

**Hourly** — runs once every hour. Right for genuinely time-sensitive signals: breaking news, fast-moving prices, anything where a day-old post would already feel stale.

**Daily** — once every 24 hours. The most common choice for recap and digest formats — a morning weather card, an evening recap, a daily price snapshot.

**Weekly** — once every 7 days. Fits weekly-cadence formats: a "this week in X" digest, a weekly milestone check, a Monday price-recap post.

**Custom (cron)** — anything the three presets don't cover, written as a cron expression.

## Reading a cron expression

A cron expression is five fields: minute, hour, day of month, month, day of week — each either a number, a range, a step (`*/4`), or `*` for "any." The field defaults to `0 9 * * *`, which breaks down as: minute 0, hour 9, any day of month, any month, any day of week — plain-English, "every day at 9:00."

A few that come up constantly in content automations:

| Expression | Meaning |
|---|---|
| `0 9 * * *` | Every day at 9am (the default) |
| `0 */4 * * *` | Every 4 hours |
| `0 9 * * 1` | Every Monday at 9am |
| `0 9,17 * * *` | Twice daily, 9am and 5pm |
| `0 9 * * 1-5` | Weekdays only, 9am |
| `*/30 * * * *` | Every 30 minutes |

## Matching the schedule to the format, not the other way around

The most common timing mistake isn't a wrong cron expression — it's picking a schedule that doesn't match how often the underlying data actually changes. A few real pairings:

- **Breaking news reaction** → hourly, or a tight custom interval (`*/30 * * * *`) if your niche moves fast. Paired with an [If node](/blog/if-node-branching-recipes) filtering for genuinely new, relevant stories — polling often is fine as long as most polls simply find nothing worth posting.
- **Daily price/weather recap** → daily, timed for when your audience is actually online, not necessarily midnight or market-open.
- **Weekly digest** → weekly, on whatever day your format's "week" naturally ends (Friday for a work-week recap, Sunday for a weekend-inclusive one).
- **Milestone/threshold posts** (see [idea #12 in dynamic data automation ideas](/blog/dynamic-data-automation-ideas)) → checked more often than they'll actually fire (hourly or daily), relying entirely on an If node to suppress the vast majority of runs where nothing crossed the threshold.

## A habit that prevents the most common failure mode

Set the schedule *after* the workflow is proven on manual runs, not before. A workflow wired straight to an hourly timer from the start means an unnoticed bug produces 24 bad runs before you check on it the next day — the same bug caught during manual testing costs you one run. Timer mode is for automations you trust, not automations you're still building.
