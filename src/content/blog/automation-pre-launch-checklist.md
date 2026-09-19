---
title: "A Pre-Launch Checklist Before You Flip a Workflow to a Timer"
description: "Nine checks worth running through before an automation goes from manual to scheduled — because there's no approval-gate node standing between a bad run and a real publish."
date: "2026-07-05"
cluster: "automation-nodes"
keywords:
  - automation launch checklist
  - before scheduling automation
  - workflow testing checklist
  - automation best practices
  - content automation quality check
faq:
  - q: "How many times should I manually run a workflow before scheduling it?"
    a: "Enough times to see it handle a genuinely different input each time — three near-identical test runs prove less than one clean run and one messy, real-world edge case. Keep testing until you've seen it handle something imperfect, not just the easy case."
  - q: "What's the single most common thing this checklist catches?"
    a: "A binding pointing at a field that exists in your test data but isn't always present in real responses — it works in testing and breaks on the one run where a field happens to be missing."
  - q: "Should every workflow eventually go on a timer?"
    a: "No — some are fine staying manual forever, especially low-frequency or judgment-heavy ones. A timer is for workflows where you've built enough trust that unattended running is actually a time save, not a risk you're accepting for its own sake."
---

There's no dedicated approval-gate node in FeedForce's automation canvas — the Trigger's manual mode is what stands in for one while you're building. Before flipping it to a timer, run through this checklist. Every item here has caused a real bad run somewhere; catching them in review costs a minute each, catching them in production costs a published post you didn't mean to send.

## 1. Test each node individually, not just the full chain

Use each node's own "Test this node" run as you build, rather than wiring everything and running once at the end. A workflow assembled and verified node-by-node rarely produces a confusing multi-node failure — see [debugging a failed automation run](/blog/debugging-a-failed-automation-run).

## 2. Run it against more than one real input

A workflow tested once, on one clean example, has only proven it handles that one case. Run it against a few genuinely different real inputs — including an awkward one if you can find it (a missing field, an unusually long title, a zero value) — before trusting the shape of every future run to look like your first test.

## 3. Check every binding path against the actual response shape

Not the shape you assumed — the shape the source actually returns. A binding path like `News.title` only works if the HTTP Request node labeled "News" genuinely has a `title` field in its real response, not a field you expected it to have. See [how template placeholders work](/blog/how-template-placeholders-work) for the binding mechanics this depends on.

## 4. Confirm your If node conditions handle missing fields

An expression like `{{ $json.value > 0 }}` throws if `value` is ever absent rather than zero — test against a response missing the field, not just one that has it. [If node recipes](/blog/if-node-branching-recipes) covers a completeness-check pattern for exactly this.

## 5. Verify the Custom Agent's schema matches its prompt

Run the AI step a few times and check that every field the schema expects actually comes back populated and sensible — a mismatch between what the prompt asks for and what the schema declares is the most common source of inconsistent output. See [the Custom Agent prompting guide](/blog/custom-agent-node-prompting-guide).

## 6. Look at the actual generated post, not just the JSON

A binding that "looks right" in a JSON preview can still produce a slide with awkward text wrapping, an overflowing number, or a chart with too few data points to read clearly. Open the actual generated post before trusting the pipeline — the node output and the finished design are different checks.

## 7. Pick a polling interval that matches reality, not ambition

A timer set tighter than the source actually updates just produces more empty or duplicate-feeling runs. Match the interval to how often the underlying data genuinely changes — see [Trigger timing recipes](/blog/trigger-node-timing-guide).

## 8. Name every node for its job

"If: worth posting" tells you what broke at a glance; "If 3" doesn't. This matters even more once a workflow is running unattended and you're debugging it days later with less context than you have right now.

## 9. Decide, explicitly, whether this workflow gets a timer at all

Not every workflow needs to move off manual — a low-frequency or judgment-heavy format (see [when not to automate your content](/blog/when-not-to-automate-content)) can stay manual indefinitely and that's a legitimate end state, not an unfinished automation.

## The habit this checklist replaces

Without something like this, the default failure mode is finding out a workflow has a problem from the published post itself — the most expensive possible place to catch it. Running through these nine checks costs a few minutes once, before the timer goes on; skipping them costs however long it takes to notice, explain, and clean up whatever the first bad scheduled run produced.
