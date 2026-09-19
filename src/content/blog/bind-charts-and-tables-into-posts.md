---
title: "How to Bind a Live Chart or Table Into Your Social Posts"
description: "Charts and tables in a template aren't images — they're Elements that take real structured data. How the el:id:key binding works and when to use it over a text placeholder."
date: "2026-07-05"
cluster: "automation-nodes"
keywords:
  - dynamic chart social media
  - live data chart template
  - candlestick chart template
  - data visualization social post
  - automated infographic
faq:
  - q: "Can I put a chart on a carousel slide?"
    a: "Yes — add it as a custom element (chart, table, or candlestick) on the slide, the same way you'd place a text box or image. Once it's there, the Apply Template node picks it up automatically as a bindable input alongside your text placeholders."
  - q: "Why can't I just bind a chart with a text placeholder?"
    a: "Text placeholders stringify their value — a price history array would arrive as an unreadable JSON blob rather than something the chart can plot. Elements exist specifically to receive structured data (arrays, objects) intact."
  - q: "Does the chart update automatically after the post is published?"
    a: "No, by design. Each automation run bakes that run's data into the post as a snapshot — the chart shows exactly what was true when it was generated, not a live feed that could change (and disagree with the caption) after you've published it."
figures:
  - type: nodeflow
    steps:
      - nodeType: http
        note: "Pull a week of price data"
      - nodeType: ai
        note: "Write the one-line take"
      - nodeType: template
        note: "Fill the headline + candlestick chart"
      - nodeType: post
        note: "Publish to Instagram"
---

A quote card and a candlestick chart look nothing alike, but on FeedForce's template canvas they're built the same way: place an element on the slide, then decide what fills it. For text, that's a `{placeholder}` token (see [how template placeholders work](/blog/how-template-placeholders-work)). For anything visual — a chart, a table, a candlestick — it's a different mechanism entirely, because visual elements need real structured data, not a sentence.

## Why charts get their own binding path

A text placeholder always resolves to a string — numbers, objects, everything gets stringified before it lands on the slide. That's fine for "{price}" becoming the text "142.50". It's useless for a price-history chart, which needs an actual array of `{date, value}` points to draw a line, or a candlestick needs open/high/low/close per period — data structures, not sentences.

So chart, table, and candlestick elements bind through a different path: instead of a placeholder name, the binding key looks like `el:<elementId>:<inputKey>` — the element's own id, plus which of its inputs you're filling (a candlestick element might expose `prices` and `dates` as two separate inputs, for instance). Whatever flows through that binding arrives **raw** — the array or object intact — because the element's own rendering logic needs to actually parse it, not read it as a string.

Worth knowing: there's also a standalone **Element** node in the canvas (separate from Apply Template), but as of today it resolves your mapped data into the right shape without yet turning that into rendered, postable media — that part is still landing in a future update. For actually getting a chart onto a real, published post, the path below (through Apply Template) is the one that works today.

## Setting one up

1. **Add the chart, table, or candlestick to your slide at design time**, the same way you'd add any visual — position it like an image or text box, right inside the template you'll reuse for every automated run.
2. **Point an Apply Template node at that template.** Because the chart is already sitting on one of the template's slides, the node reads its input schema automatically and exposes exactly those fields as bindable ports — a candlestick element shows up wanting `prices`/`dates`, a table wants `rows`, and so on. You're never guessing at a generic format; the element tells the node what it needs, right alongside any `{text}` placeholders on the same slides.
3. **Map upstream data to those inputs.** If an HTTP Request node returns a week of price data, map its array field to the chart's `prices` input; map the corresponding date array to `dates`.
4. **Run once and check the render.** Because the element renders from real data, a malformed upstream shape (wrong key names, unexpected nesting) shows up immediately as a broken or empty chart — the fastest signal that a binding is wrong.

## When to use an Element vs. a text placeholder

The decision is genuinely simple once you frame it this way: **is the value something you'd read aloud, or something you'd look at?**

| Content | Use |
|---|---|
| "$142.50", "Lakers 108–102", "up 3.2% today" | Text placeholder |
| A week of price history | Chart element |
| Head-to-head stats across 5 categories | Table element |
| Daily open/high/low/close | Candlestick element |

A single number dressed up as a one-bar chart is usually worse than the same number as large, well-styled text — reserve elements for data that actually benefits from being seen as a shape, not read as a fact.

## The snapshot behavior matters here more than anywhere else

Every automation run bakes that run's data into the generated post permanently — this is true for text placeholders too, but it matters more for charts. A price chart that "stayed live" after publishing would silently disagree with whatever caption you wrote about it the moment the market moved. Because FeedForce snapshots the chart's data at generation time, what you approved is what stays published — the chart is frozen at the moment of truth it was describing, not drifting from the story around it.

## A concrete example: a weekly price-recap post

Putting it together — the full chain for an automated "this week in [asset]" post:

<!--figure-->

The HTTP Request node pulls a week of price data; the Custom Agent node writes the one-line take ("up 4% on strong earnings"); the Apply Template node does the rest in one step — filling the headline's `{take}` placeholder with that text while binding the same week's price array straight into the candlestick chart already sitting on the slide. One node, two binding mechanisms, each doing the job it's actually suited for. For the broader pattern of turning any live data into a recurring post format, see [how to create content automations](/blog/how-to-create-content-automations).
