---
title: "How Template Placeholders Work: Binding Live Data Into Your Posts"
description: "Placeholders are literal {curly-brace} tokens in your template text. Here's exactly how the Apply Template node finds them, fills them, and bakes a real post."
date: "2026-07-05"
cluster: "automation-nodes"
keywords:
  - template placeholders
  - dynamic template binding
  - live data social media template
  - bind data into template
  - dynamic content template
faq:
  - q: "How do I create a placeholder in a FeedForce template?"
    a: "Type a curly-brace token directly into a headline, subheadline, or text box while designing your template — e.g. {price} or {team_name}. No special mode or toggle; the text box just holds that literal text until a workflow binds it."
  - q: "What's the difference between a text placeholder and an Element binding?"
    a: "A text placeholder gets a stringified value — numbers, booleans, and objects are all converted to text and dropped into the slide. An Element binding (for a chart, table, or candlestick you've added as a custom element) carries the raw value — arrays and objects intact — because the element needs real structured data to render, not a string."
  - q: "Does binding data into a template change my saved template?"
    a: "No. Each automation run creates a new post as a snapshot — your saved template stays untouched, reusable for the next run and for manual editing. The placeholders in the template are permanent; only the generated post's copy of them gets filled in."
---

The feature that makes automated content look designed instead of generated is almost invisible once you know it: **placeholders are just text you type**. No special binding mode, no drag-and-drop field mapper glued on top of the design — you write `{price}` into a headline the same way you'd write any other word, and a workflow later decides what `{price}` becomes. Here's exactly how that works under the hood, because understanding the mechanism is what lets you use it well.

## The mechanism: curly braces in real text

Open any template — headline, subheadline, or a text box on a slide — and type a token like `{headline}`, `{price}`, or `{team_name}` directly into the text. That's the whole authoring step. The template doesn't know or care yet what will fill it; it's just literal text, which means you can preview and manually edit the template exactly like any other, with the placeholder sitting there as visible text until something replaces it.

When an **Apply Template** node in your automation canvas points at that template, it scans every headline, subheadline, and text box across all slides for these tokens and turns each distinct one into a bindable input — you map `{price}` to whatever upstream field holds a price, `{team_name}` to whatever field holds a team name, and so on. Every run substitutes real values in; your saved template itself is never modified.

## Text placeholders vs. Element bindings

There are two different binding paths, because two different kinds of content need different handling:

**Text placeholders** (`{price}`, `{headline}`, anything in a text box) always resolve to a **string**. If the upstream value is a number, boolean, or even a whole object, it gets stringified before it lands in the slide — a price of `42.5` becomes the text "42.5", an object becomes its JSON representation if you bind it directly (so in practice, bind a specific field, not a whole object, into a text placeholder).

**Element bindings** work differently, and exist for a reason: if you've added a chart, table, or candlestick as a custom element on your slide, that element needs *structured* data — an array of price points, a set of rows — not a string. These bindings carry the raw value through untouched, so the chart actually has real data to draw instead of a stringified blob it can't parse. (More on this in [binding a chart or table into your posts](/blog/bind-charts-and-tables-into-posts).)

Practically: use `{curly-brace}` placeholders for anything that reads as a sentence or a number on the slide — headlines, captions, stats. Use an Element for anything that needs to be *visualized* — a trend line, a comparison table, a candlestick.

## What happens on each run

Every time the Apply Template node runs, it produces a brand-new post — a full snapshot with that run's values baked into the slides permanently. This matters for two reasons:

1. **Your template stays reusable.** Running the automation ten times produces ten distinct posts; the template you designed once is untouched and ready for the eleventh.
2. **Posts don't need live re-resolution.** Because the values are baked in at generation time, previewing, scheduling, or publishing a generated post later shows exactly what was true when it was made — not a placeholder trying to fetch fresh data again and potentially showing something different than what you approved.

If your workflow's upstream data produces multiple items in one run (say, ten news stories passed a relevance filter), the Apply Template node fans out automatically — one post per item, each with its own values filled in, rather than one post overwritten ten times.

## Binding from more than one source at once

If a workflow pulls from two or more distinct upstream nodes — say, an HTTP Request node for a price feed and a separate Custom Agent node for commentary — the binding step can address each by that node's own label, joined into one post rather than fanned out separately. A binding path in that situation looks like `Prices.bitcoin.gbp`: the source node's label, then the field path within its data. This is what lets a single post pull "today's price" from one source and "today's take" from another, filled into the same template. (The full mechanics: [joining multiple data sources into one post](/blog/join-multiple-data-sources-automation).)

## Designing templates with placeholders in mind

A few habits make placeholder-driven templates hold up across hundreds of automated runs, not just the one you tested with:

- **Name placeholders for what they hold, not where they sit.** `{price}` survives a redesign; `{slide2_bignum}` doesn't.
- **Design for your longest realistic value.** If `{team_name}` might be "Bayern Munich" or it might be "IF Elfsborg," test the layout with both — text placeholders don't truncate themselves.
- **Keep one placeholder, one meaning, across a whole template.** If `{date}` means "today" on slide 1, don't reuse it to mean "event date" on slide 4 — use `{event_date}` instead. The Apply Template node treats every distinct token as one bindable input, so overloading a name just means you can only bind it to one thing.
- **Reserve Elements for genuinely structured data.** If a stat is really just one number, a text placeholder is simpler to bind and easier to restyle than a chart with one bar.

Once a template's placeholders are named well, filling it is the easy part — the whole point of the system in the first place. For the broader automation picture this fits into, see [every FeedForce automation node explained](/blog/feedforce-automation-nodes-explained).
