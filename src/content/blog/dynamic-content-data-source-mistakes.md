---
title: "Dynamic Content Creation Mistakes: When the Data Source Breaks Your Template"
description: "A dynamic template is only as reliable as what feeds it — here's what a bad data value actually looks like once it reaches a placeholder, and how to catch it."
date: "2026-07-09"
cluster: "automation-nodes"
keywords:
  - dynamic content creation
  - broken automation template
  - data source errors automation
  - automation placeholder empty
  - dynamic template mistakes
faq:
  - q: "What does a broken data source actually look like on a published post?"
    a: "Often a literal placeholder showing on the design — the raw {price} text instead of an actual number — or a blank space where a value should be, because the source returned nothing usable and the template had no fallback for that case."
  - q: "How do I catch this before it publishes?"
    a: "Running the Trigger manually and checking the drafted output before switching to a timer is the actual safety net — there's no automated validation step separate from looking at what the workflow produced yourself."
  - q: "Can a Code node help prevent this?"
    a: "Yes — a Code node reshaping the data before it reaches Apply Template is a natural place to check for missing or malformed fields and handle them deliberately, rather than letting bad data flow straight into the template unexamined."
---

A dynamic template is only as reliable as whatever feeds it, and the ways a data source can go quietly wrong are worth knowing before you're staring at a published post with a literal `{price}` placeholder showing where a number should be.

## What a broken source actually produces

The most common failure isn't a dramatic error — it's a data source returning something the template wasn't built to handle: a missing field, an unexpectedly empty response, a value in the wrong format (text where a number was expected). The result on the published post is usually one of two things: the raw placeholder text showing through unfilled, or a blank space where content should be. Neither looks like an obvious "error" from the outside — it looks like a slightly broken post, which is arguably worse, since it's easy to miss at a glance.

## Where to catch this before it publishes

There's no separate validation step checking data quality automatically — the actual safety net is [running the Trigger manually and looking at the drafted output](/blog/review-auto-posted-content-before-publish) before trusting the workflow to a timer. This is worth doing across more than one run, specifically because a data source that looks fine on your first test might return something different — and more revealing — on a later check, especially for a source with real variability.

## Using a Code node as a deliberate checkpoint

A Code node between your data source and Apply Template is a natural place to catch this kind of problem before it reaches the template — checking whether an expected field is actually present and reshaping or filtering accordingly, rather than letting whatever the source returned flow straight through unexamined. See [the Code node transforms cookbook](/blog/code-node-transforms-cookbook) for concrete reshaping patterns, several of which double as this kind of defensive check.

## An If node as a last line of defense

For a source prone to occasionally returning something clearly unusable, an If node checking that a critical field exists and looks reasonable before continuing to Apply Template — and simply not publishing that run if it doesn't — is a legitimate pattern. A skipped run is a much smaller problem than a published post with a visibly broken placeholder.

## The maintenance habit that actually prevents this

APIs change shape over time without warning — a field gets renamed, a response format shifts. A workflow that ran perfectly for months can start producing broken output the day its source changes underneath it. Periodic spot checks, not just the initial testing phase, are what catch this — see [debugging a failed automation run](/blog/debugging-a-failed-automation-run) for what to check first when output that used to look right suddenly doesn't.
