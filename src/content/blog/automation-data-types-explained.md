---
title: "How Data Types Work in FeedForce Automations"
description: "Every port on every node carries a type — string, number, image, series — and the canvas won't let you connect two that don't match. What that actually means in practice."
date: "2026-07-05"
cluster: "automation-nodes"
keywords:
  - automation data types
  - node port types
  - workflow data compatibility
  - automation type coercion
  - node canvas ports explained
faq:
  - q: "What happens if I try to connect two incompatible port types?"
    a: "The canvas won't let the connection form — ports only connect when their types match, when either side is \"any,\" or when an allowed coercion exists between them (like a number filling a text slot)."
  - q: "Can a number automatically become text?"
    a: "Yes — number and boolean values both coerce into string automatically, since a number or true/false reads fine as text in a headline or caption. The reverse isn't automatic; a string doesn't become a number without an explicit step."
  - q: "What does the 'any' type mean on a port?"
    a: "It's a wildcard — a port typed \"any\" connects to a port of any other type, since the node doesn't care what shape the data is (an HTTP Request node's raw response is a common example)."
---

Every port on every node in the automation canvas — the little dots you drag connections between — carries a specific data type, and the canvas enforces it: try to connect two ports whose types genuinely don't fit, and the connection simply won't form. This isn't a restriction to fight against; it's what catches a mismatched binding before a run, rather than after a post goes out wrong.

## The types you'll actually see

- **string** — text: a headline, a name, a caption.
- **number** — a price, a percentage, a count.
- **boolean** — true/false: a sentiment flag, a threshold check result.
- **image / video** — media.
- **series** — an ordered sequence of points, the shape a chart plots.
- **array / object** — structured data: a list of items, a nested response.
- **any** — the wildcard; connects to anything, since the node doesn't constrain what shape the data takes (a raw HTTP Request response is typically `any`).

## What connects to what automatically

Most types only connect to their exact match — a `string` port to a `string` port, an `image` port to an `image` port. Three coercions happen automatically, because they're safe and genuinely useful:

- **number → string** — a price binds straight into a text placeholder as its printed value.
- **boolean → string** — `true`/`false` renders as text where that's useful.
- **series → array** — a chart's ordered points are, underneath, just an array; anything expecting an array can take a series.

Nothing coerces the other direction automatically — a `string` doesn't become a `number` on its own, because "the price" as text could be "$142.50" or "TBD," and only one of those is actually a number. That's a deliberate gap, not an oversight — the safe direction (number reads fine as text) is allowed; the risky direction (text might not actually be a number) isn't.

## Where this shows up in a real workflow

The type system is invisible until a binding doesn't quite fit — and when it doesn't, the fix is usually a [Code node](/blog/code-node-transforms-cookbook) doing the explicit conversion the canvas won't do silently. A common example: an API returns a price as a string (`"142.50"`) rather than a true number, and you need an actual numeric comparison in an [If node](/blog/if-node-branching-recipes) (`value > 100`). A short Code node — `Number(ctx.input.price)` — bridges exactly that gap, turning a type the canvas won't auto-coerce into one it will.

## Reading a port's type at a glance

Ports are color-coded by type in the canvas, so a mismatched connection is often visible before you even try to make it — a blue string port and an amber number port look different on purpose. Getting familiar with the palette (string, number, boolean, image/video, series, array/object all read as distinct colors) turns "why won't this connect" into something you can often answer just by looking, rather than guessing.

## Why this is worth understanding, not working around

It's tempting to treat the type system as friction to route around with `any` everywhere it's available — but the type checking is what turns a wrong binding into an immediately visible "these don't connect" instead of a run that quietly produces garbage output three nodes later. Respecting types (and reaching for a Code node when a genuine conversion is needed) is what keeps [debugging a failed run](/blog/debugging-a-failed-automation-run) rare instead of routine.
