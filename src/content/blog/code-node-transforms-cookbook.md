---
title: "The Code Node Cookbook: 5 Transforms You'll Actually Use"
description: "Five real JavaScript snippets for FeedForce's Code node — dedup, date formatting, computing deltas, merging sources, and currency formatting — with the exact ctx shape."
date: "2026-07-05"
cluster: "automation-nodes"
keywords:
  - code node automation
  - javascript automation transform
  - dedupe automation data
  - format data for social post
  - no-code automation custom logic
faq:
  - q: "What does the Code node actually receive as input?"
    a: "ctx.input holds the upstream data, already parsed and unwrapped. If several nodes feed into it, ctx.input is keyed by each source node's label (ctx.input[\"HTTP request\"], ctx.input[\"HTTP request 2\"]) so you can address each explicitly. ctx.config holds the node's own configuration."
  - q: "Can AI write the Code node for me?"
    a: "Yes — the node is designed so an AI node upstream, or the automation's own generation flow, can produce the script, and you edit it from there. You don't need to write JavaScript from scratch to get a working transform."
  - q: "Is the Code node sandboxed?"
    a: "No — it runs plain JavaScript against your workflow's input and config, so treat it like any script you'd paste into your own project. Fine for logic you wrote or reviewed; not a place to run code from a source you don't trust."
---

Most content automations need at least one step that isn't a clean fit for any single-purpose node — reshaping a payload, computing a value, filtering a list by a rule too specific for a dropdown. That's the Code node: a plain JavaScript function taking `ctx.input` (your upstream data, already parsed) and `ctx.config` (its own settings), returning whatever object the next node needs. Here are five transforms that come up constantly, ready to adapt.

## The shape to know first

Every Code node is a function like this:

```js
export default function run(ctx) {
  const data = ctx.input;
  return { result: data };
}
```

`ctx.input` is upstream data, already unwrapped — if a single node feeds in, it's that node's output directly; if several nodes feed in, it's keyed by each source's label (`ctx.input["HTTP request"]`, `ctx.input["Custom agent"]`). `ctx.inputs.<port>` gives you the raw items array if you need more than the unwrapped single value. Whatever object you return becomes this node's output for everything downstream.

## 1. Dedupe a list by a field

Common after any HTTP Request node that might return the same item twice across runs (a news source that re-lists a story, a feed that doesn't paginate cleanly):

```js
export default function run(ctx) {
  const items = ctx.input.items ?? [];
  const seen = new Set();
  const unique = items.filter(item => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
  return { items: unique };
}
```

## 2. Format a date for display

APIs return ISO timestamps (`2026-07-05T14:30:00Z`); posts need something a human reads naturally:

```js
export default function run(ctx) {
  const raw = ctx.input.publishedAt;
  const date = new Date(raw);
  const formatted = date.toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
  return { displayDate: formatted }; // "July 5"
}
```

## 3. Compute a delta (this week vs. last week)

For any recap or trend post — turning two raw numbers into the comparison that actually makes the post interesting:

```js
export default function run(ctx) {
  const { current, previous } = ctx.input;
  const delta = current - previous;
  const pct = previous ? ((delta / previous) * 100).toFixed(1) : '0';
  const direction = delta >= 0 ? 'up' : 'down';
  return { delta, pct, direction, summary: `${direction} ${Math.abs(pct)}%` };
}
```

Feed `summary` straight into a `{change}` template placeholder (see [how template placeholders work](/blog/how-template-placeholders-work)) and the post-writing part of your workflow is done.

## 4. Merge two sources into one object

When an HTTP Request node and a Custom Agent node both feed the same Code node (their outputs land keyed by label in `ctx.input`):

```js
export default function run(ctx) {
  const price = ctx.input["HTTP request"];
  const take = ctx.input["Custom agent"];
  return {
    price: price.value,
    currency: price.currency,
    commentary: take.summary,
  };
}
```

This flattens two differently-shaped upstream outputs into one clean object, so the Apply Template node downstream has simple, predictable field names to bind instead of reaching into two nested shapes. (For workflows that need this at the *source* level rather than after a Code node, see [joining multiple data sources into one post](/blog/join-multiple-data-sources-automation).)

## 5. Format currency properly

A raw number formatted with `Intl.NumberFormat` reads like a real product, not a debug log:

```js
export default function run(ctx) {
  const { amount, currency } = ctx.input;
  const formatted = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currency ?? 'USD',
  }).format(amount);
  return { formatted }; // "$1,284.50"
}
```

## Working with the Code node safely

A few habits, given it runs unsandboxed JavaScript against real workflow data:

- **Write or review every script yourself.** It's your code running against your data — treat it exactly like code you'd add to any other project, not a black box.
- **Return early on missing data** (`if (!ctx.input) return { items: [] }`) rather than letting a run throw on the first empty response.
- **Keep one Code node, one job.** A node that dedupes *and* formats *and* merges is harder to test than three small ones chained together.
- **Test with the node's own "Test this node" run** before wiring it into a live schedule — you'll see the exact JSON it returns before anything downstream depends on it.

None of these five need to be memorized — copy the shape, swap the field names for your own data, and the Code node stops being the intimidating part of the canvas.
