---
title: "Multi-Template Fan-Out: One Data Source, Several Post Formats"
description: "The same price or story doesn't have to become just one post. Wiring one source into multiple Apply Template nodes turns a single run into a whole day's content."
date: "2026-07-05"
cluster: "automation-nodes"
keywords:
  - multi template automation
  - one data source multiple posts
  - automation fan out pattern
  - content repurposing automation
  - multiple post formats automation
faq:
  - q: "Can one HTTP Request node feed more than one Apply Template node?"
    a: "Yes — a node's output can connect to as many downstream nodes as you want. The same price data, for instance, can feed a candlestick-chart carousel and a plain text-stat carousel from the same run."
  - q: "Does fanning out to multiple templates mean multiple runs of the source?"
    a: "No — the source node runs once per trigger; its output is simply wired to multiple Apply Template nodes in parallel. You're not re-fetching the same data multiple times."
  - q: "Should every automation fan out to multiple formats?"
    a: "No — only when the underlying data is genuinely rich enough to support more than one angle. A single number rarely needs three different post formats; a week of data with a story behind it often does."
---

A node's output isn't limited to feeding one downstream node — the same data can wire into several Apply Template nodes at once, each bound to a different template. One trigger, one data fetch, several distinct posts. This is the highest-leverage pattern in the whole canvas once you have a data source worth reusing.

## Why this beats running the source multiple times

The naive way to get multiple formats from one story is multiple separate workflows, each re-fetching the same data. That works but wastes a call to your source every time, and worse, risks the two workflows seeing slightly different data if anything changes between their separate fetches (a price ticking, a story updating). Fanning out from one source node inside a single workflow guarantees every format is built from the exact same snapshot.

## What a fan-out actually looks like

One HTTP Request node (or a Custom Agent node's output) connects to two or more Apply Template nodes, each pointed at a different saved template:

- A **candlestick-chart carousel** for the visual-first audience.
- A **plain-text stat card** for a faster, simpler read.
- A **quote-style banner** (see [Twitter-style captions](/blog/twitter-style-captions-for-reels)) pulling just the single most notable number.

Each Apply Template node binds the fields it needs from the same shared data — one might use the full price series for its chart, another might only need the single percentage change.

## Where this earns its keep

Fan-out is most valuable when the underlying data is rich enough to support more than one legitimate angle — a week of price history genuinely supports both a chart-led post and a text-led one, because there's enough there for two different readers to prefer different formats. A single flat number (today's temperature, say) doesn't usually justify three templates fighting over the same fact.

The other place it pays off directly: multi-platform variety without multi-platform complexity. Post two different formats from the same run to the same Instagram account at different times of day, rather than the same design twice — you get variety in your feed without touching the data-fetching side of the workflow at all.

## Building one without overcomplicating the canvas

Keep the source and any shared transform (a [Code node](/blog/code-node-transforms-cookbook) computing a delta, say) upstream of the fork, so every template downstream binds from the same clean, already-processed data — rather than duplicating a transform per branch. The fork point should be right before the Apply Template nodes, not before the raw source, so you're not solving the same reshaping problem multiple times in parallel.

## The single question that tells you whether to fan out

Before adding a second template to a workflow, ask: would a human editor genuinely make two different posts from this same fact? If the honest answer is "no, one post covers it," a fan-out just doubles your posting cadence with redundant content. If the answer is "yes, there's a chart story and a punchline story here," fan-out turns one data fetch into a stronger day of content than either format alone would produce.
