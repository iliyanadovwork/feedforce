---
title: "How to Join Multiple Data Sources Into One Automated Post"
description: "When two or more upstream nodes feed one post, FeedForce joins them by node label instead of fanning out separately. How the merge actually works and when to use it."
date: "2026-07-05"
cluster: "automation-nodes"
keywords:
  - combine multiple data sources automation
  - merge api data social post
  - multi source automation workflow
  - join data feeds content automation
  - automation data merge
faq:
  - q: "What happens if I connect two HTTP Request nodes to one Apply Template node?"
    a: "Instead of running twice (once per source), FeedForce detects the distinct sources and merges them into one input, keyed by each source node's own label. One post gets generated, with bindings able to address each source by name — e.g. \"Prices.bitcoin.gbp\"."
  - q: "What is a binding path like 'Prices.bitcoin.gbp' actually referencing?"
    a: "The first segment is the label of the source node in your canvas (rename a node to \"Prices\" and that becomes the prefix). Everything after it is a field path into that source's own data shape — so it's literally \"the node called Prices, then its bitcoin field, then gbp within that.\""
  - q: "Does this work with more than two sources?"
    a: "Yes — any number of distinct sources feeding the same downstream node get merged the same way, each addressable by its own label. Naming your nodes clearly matters more as this grows, since the label is the only thing distinguishing one source's data from another's in a binding path."
figures:
  - type: nodeflow
    steps:
      - parallel:
          - nodeType: http
            note: "\"Prices\" — the price feed"
          - nodeType: ai
            note: "\"Take\" — the commentary"
      - nodeType: template
        note: "{price} ← Prices.bitcoin.gbp · {commentary} ← Take.summary"
      - nodeType: post
        note: "Publish to Instagram"
---

Most automations have one clear signal — a single news feed, a single price source. But some of the best posts genuinely need two: a price feed *and* separate commentary, a sports score *and* a separate stats API, a weather reading *and* a separate air-quality feed. FeedForce handles this without extra plumbing — it's a property of how the Apply Template node treats its inputs, not a separate node type you have to learn.

## What happens with more than one source

Connect a single HTTP Request node to an Apply Template node, and each item that source returns becomes its own post — the standard fan-out, one post per item. Connect **two or more distinct source nodes** to the same Apply Template node, and the behavior changes: instead of fanning out per source, FeedForce merges them into a single combined input, addressable by each source's own node label, and produces one post per run rather than one per source.

This distinction — fan-out for one source, merge for several — is automatic. You don't flag it anywhere; it falls out of however many distinct upstream nodes you've actually wired in.

## Reading a binding path

Once sources are merged, a binding for a template placeholder or chart input looks like a dotted path: `Prices.bitcoin.gbp`. Breaking that down:

- **`Prices`** — the *label* of the source node in your canvas. Node labels default to something generic ("HTTP request 2"); rename it to something meaningful and that name becomes the prefix every binding from it uses.
- **`bitcoin.gbp`** — a field path into whatever that node actually returned, exactly like you'd write `data.bitcoin.gbp` in code.

So a binding path is literally sentence-readable: "from the node called Prices, take bitcoin, then gbp." This is also the single best argument for naming your nodes deliberately rather than leaving them as "HTTP request 3" — the label isn't cosmetic here, it's part of the data address every downstream binding depends on.

## A concrete example: price plus commentary

The workflow that motivates this feature — a post that needs a hard number from one source and a written take from another:

<!--figure-->

Both the HTTP Request node (renamed "Prices") and the Custom Agent node (renamed "Take") feed the same Apply Template node. Because there are two distinct sources, they merge rather than fan out — one post per run, with `{price}` bound to `Prices.bitcoin.gbp` and `{commentary}` bound to `Take.summary`. Without this merge behavior, you'd need a Code node in between just to flatten two shapes into one — see [transform #4 in the Code node cookbook](/blog/code-node-transforms-cookbook) for that manual version, useful when a merge needs actual logic (a computed delta, a conditional pick) rather than a straight join.

## When to reach for a Code node instead

The automatic merge is enough when you're binding fields straight through — a price here, a caption there. Add a Code node in between when you need to actually *compute* something from the combined data (a delta between two sources, a conditional choice of which source wins, a reformatted combination) rather than just address two sources' fields independently. The merge gets you the data together in one place; a Code node is for when "together" isn't enough and you need "combined."

## Why this matters for the posts that are actually hard to build

Single-source automations — a news trigger, a template, a publish — are the easy 80%. The remaining 20%, the posts that feel genuinely smart (a price with real commentary, a score with contextual stats, a weather reading with an actual recommendation), almost always need two sources working together. That this merges automatically by label, rather than forcing every multi-source workflow through a manual join step, is what makes the hard 20% only a little harder than the easy 80% — not an entirely different category of workflow to build.
