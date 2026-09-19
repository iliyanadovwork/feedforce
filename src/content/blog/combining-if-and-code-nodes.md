---
title: "Combining If and Code Nodes for Logic the Canvas Doesn't Have Built In"
description: "One If node handles a single condition. Real decisions are often compound — here's how a Code node upstream turns a messy multi-factor check into one clean If."
date: "2026-07-05"
cluster: "automation-nodes"
keywords:
  - complex automation logic
  - compound conditions automation
  - if node code node combination
  - multi factor automation rule
  - advanced workflow branching
faq:
  - q: "Why not just write a complicated expression directly in the If node?"
    a: "You can for simple combinations, but once a decision depends on several weighted factors rather than one or two direct checks, a Code node computing a single clear score first keeps the If node's own condition simple and readable."
  - q: "Does a Code node before an If node slow the workflow down noticeably?"
    a: "No — it's a fast, synchronous transform, not an external call. The performance cost is negligible; the benefit is a workflow that's actually readable months later."
  - q: "Can the Code node itself branch, instead of using an If node at all?"
    a: "Technically you could return different shapes and branch downstream some other way, but keeping the decision itself in an If node (fed a clean value from the Code node) keeps the branch visible on the canvas rather than buried inside a script."
---

An If node handles exactly one condition cleanly — `value > 5`, `sentiment === 'positive'`. Real editorial decisions are often messier than that: "post this if it's relevant, AND recent, AND we haven't covered it already, weighted by how big a deal it actually is." Cramming that into one expression is possible but unreadable. The cleaner pattern: a Code node computes a single clear value first, and the If node makes the actual decision on that value.

## The problem with one big expression

You can technically write `{{ $json.relevant && $json.recent && !$json.alreadyPosted && $json.impact > 3 }}` directly in an If node, and it'll work. The problem shows up later, when you're debugging why a specific item didn't post and have to mentally trace four conditions at once inside a single line — exactly the situation [debugging a failed automation run](/blog/debugging-a-failed-automation-run) is meant to make fast, undone by a condition that isn't actually legible at a glance.

## The pattern: Code computes, If decides

Put a Code node upstream that reduces all your factors into one clean, named value:

```js
export default function run(ctx) {
  const { relevant, recent, alreadyPosted, impact } = ctx.input;
  const worthPosting = relevant && recent && !alreadyPosted && impact > 3;
  return { worthPosting, impact }; // pass impact through too, useful downstream
}
```

Then the If node's condition becomes `{{ $json.worthPosting }}` — one clear check, self-documenting by its own field name, with all the actual logic sitting in one reviewable place upstream rather than buried in an expression.

## Where this earns its keep beyond readability

Beyond legibility, this pattern lets you compute something an If node's simple expression syntax genuinely can't — a weighted score, a comparison against a running average, a check against multiple thresholds with different logic per threshold. The Code node can do arbitrary JavaScript; the If node stays a single, clean gate on whatever that computation decided.

## A real example: a weighted "worth posting" score

For a monitoring workflow (see [always-on news monitoring](/blog/always-on-news-monitoring-automation)) where "relevant" isn't binary but a matter of degree:

```js
export default function run(ctx) {
  const { keywordMatches, sourceTrust, hoursOld } = ctx.input;
  const score = keywordMatches * 2 + sourceTrust - hoursOld * 0.5;
  return { score, worthPosting: score > 5 };
}
```

The If node downstream checks `{{ $json.worthPosting }}` — simple, stable, and the actual scoring logic lives somewhere you can read and adjust as one unit, rather than as an increasingly baroque single expression that got harder to touch every time a new factor got added to it.

## When one plain If node is still the right call

Not every decision needs this pattern — a single, direct check (`{{ $json.pct_change > 5 }}`) is already as clear as it needs to be, and adding a Code node in front of it for one condition is unnecessary ceremony. Reach for this combination specifically when a decision genuinely depends on several factors together, not as a default habit for every branch in every workflow.
