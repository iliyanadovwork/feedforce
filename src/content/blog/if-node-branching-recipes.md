---
title: "If Node Recipes: 6 Branching Rules for Content Automations"
description: "The If node is one condition, two paths — true and false. Six real conditions worth wiring, from relevance filtering to threshold-based posting rules."
date: "2026-07-05"
cluster: "automation-nodes"
keywords:
  - if node automation
  - conditional automation workflow
  - branching logic content automation
  - automation relevance filter
  - workflow condition rules
faq:
  - q: "What does the If node's condition actually look like?"
    a: "A single expression string, like {{ $json.value > 0 }} — it evaluates against the upstream data and the node has exactly two outputs, True and False, so your workflow branches into two paths from there."
  - q: "Can the If node check more than one thing at once?"
    a: "Write a single expression that combines conditions (e.g. relevance AND recency) rather than chaining multiple If nodes for things that should be evaluated together — chaining works but reads worse and is harder to debug than one clear combined condition."
  - q: "What happens to items that fail the condition?"
    a: "They flow out the False output and nothing downstream runs for them unless you've wired something to that output specifically. Most workflows leave False disconnected — the point of the filter is to stop items there, not process them differently."
---

The If node is the smallest node in the automation canvas — one condition, two outputs — and also the one that turns a workflow from "does a thing every time it runs" into "does the right thing." Here are six conditions that come up across almost every content automation, adapted from real workflows.

## The shape

An If node takes one condition expression — `{{ $json.value > 0 }}` is the canonical example — and routes each item to its **True** or **False** output based on whether it matches. Everything downstream of True runs for matching items; everything downstream of False runs for the rest (most workflows just leave False unconnected, letting non-matching items quietly stop there).

## 1. Relevance filtering

The single most common use: don't act on every item a signal source returns, only the ones that matter.

```
{{ $json.title.toLowerCase().includes('ai') || $json.category === 'tech' }}
```

Pairs naturally with an HTTP Request node polling a broad news source — the If node is what turns "everything in tech news" into "only the stories worth a post."

## 2. Threshold-based posting

For recap or alert-style posts — only post when something crossed a bar worth mentioning:

```
{{ Math.abs($json.pct_change) > 5 }}
```

A daily price-check automation that posts every single day produces noise; one that only posts when the move is actually notable produces something worth following.

## 3. Recency check

Signal sources sometimes return stale items (a cached response, a feed that re-lists old entries) — guard against posting about something that already happened:

```
{{ (Date.now() - new Date($json.publishedAt).getTime()) < 1000 * 60 * 60 * 6 }}
```

This example keeps only items published in the last 6 hours — adjust the window to how time-sensitive your format actually is.

## 4. Duplicate/already-posted guard

If your workflow runs on a timer and the same story might appear across multiple polls, gate on whether you've already handled it (paired with a Code node or external check that sets an `alreadyPosted` flag upstream):

```
{{ !$json.alreadyPosted }}
```

## 5. Data completeness check

Before a Custom Agent or Apply Template node runs, make sure the fields they need actually exist — an incomplete upstream response shouldn't silently produce a post with blank slides:

```
{{ $json.headline && $json.summary && $json.imageUrl }}
```

## 6. Sentiment or category gate

When a Custom Agent node upstream has already classified something (a schema field like `sentiment` or `category`), branch on its output rather than re-deriving the classification:

```
{{ $json.sentiment === 'positive' }}
```

Useful for accounts that only want to react to good news, or that route positive vs. negative stories into two different template styles entirely — one If node, two Apply Template nodes downstream, each styled for its branch.

## Writing conditions that don't rot

- **Reference fields that actually exist on every possible input**, including the edge cases — an expression that assumes a field is always present will throw on the one response that omits it.
- **Combine related checks into one expression** rather than chaining If nodes for conditions that are really one decision (see recency + completeness above) — easier to read, easier to debug when a run behaves unexpectedly.
- **Name the node for the decision, not the mechanism** — "If: worth posting" is more useful at a glance than "If: pct_change check."
- **Test against a real recent response**, not a hand-typed example — the "Test this node" run against actual upstream output catches field-name mismatches before they cost you a broken scheduled run.

None of these six need to be exact — swap the field names for your own data shape, and the If node stops being the node people skip past on their way to the interesting parts of a workflow.
