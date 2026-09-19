---
title: "How to Review Auto-Posted Content Before It Goes Live"
description: "There's no separate approval step in the canvas — here's the actual way people keep control of an automated posting workflow before trusting it to a timer."
date: "2026-07-09"
cluster: "automation-nodes"
keywords:
  - review auto posted content
  - approve automated social media posts
  - control social media automation
  - auto posting safety check
  - automation review before publish
faq:
  - q: "Is there a dedicated approval or review node?"
    a: "No — the canvas has eight node types (Trigger, HTTP Request, Custom Agent, Code, If, Apply Template, Element, Post) and none of them is a review gate. Review happens through how you run the Trigger, not a separate approval step."
  - q: "So how do people actually catch a bad post before it publishes?"
    a: "By setting the Trigger to manual and running the workflow yourself, checking the drafted slides in the editor before the Post node fires — the same review a human would do, just performed deliberately instead of automatically skipped."
  - q: "Once I switch to a timer, do I lose the ability to review?"
    a: "You lose the per-run manual check, yes — that's the actual tradeoff of switching from manual to timer, not a limitation to work around. Only flip it once enough manual runs have convinced you the output is consistently trustworthy."
---

If you're looking for the "approval" or "review" step in an auto-posting workflow before you trust it, it's worth saying plainly: there isn't a dedicated one. That's not a gap to route around — it's a deliberate design, and understanding the actual mechanism matters more than searching for a button that doesn't exist.

## What actually functions as review

The Trigger node has two modes: manual and timer. On manual, running the workflow drafts the post and stops there for you to look at — the slides, the caption, whatever the Apply Template step produced — before anything reaches the Post node. That look *is* the review. There's no separate gate node sitting between Apply Template and Post; the review happens by choosing when you press run, not by a checkpoint the workflow enforces on its own.

## Why this is worth knowing before you build anything

If you assume there's an automated safety net catching bad output, you'll switch to a timer too early, on the assumption something else is watching for mistakes. There isn't. The actual safety net is however many manual runs you do first — see [debugging a failed automation run](/blog/debugging-a-failed-automation-run) for what a bad run actually looks like when you catch it this way, and [the pre-launch checklist](/blog/automation-pre-launch-checklist) for what to verify before flipping to a timer at all.

## How many manual runs is "enough"

There's no fixed number, but the honest signal is boredom, not a count — once you're running it manually and consistently thinking "yeah, that's right" without needing to correct anything, you've probably seen enough variation in the underlying data to trust it unattended. A data source that only shows one kind of value in your first three test runs hasn't actually been stress-tested yet, even if all three looked fine.

## Higher-stakes content deserves a longer manual phase

Not every format carries the same risk if it's wrong — [financial or factual content](/blog/automate-crypto-price-posts) is worth a longer manual run-in than a low-stakes daily special, because the cost of a mistake is genuinely different. Match how long you stay on manual to what's actually at risk if this specific automation gets something wrong, not to a one-size-fits-all rule.

## After you switch to a timer

Moving to a timer doesn't mean review is over forever — it means the per-run check moves from before publish to after. Spot-check the account periodically, and if you [edit the workflow later](/blog/safely-editing-a-live-automation), drop it back to manual for a few runs before trusting the edited version unattended again, the same caution you'd apply to a brand-new automation.
