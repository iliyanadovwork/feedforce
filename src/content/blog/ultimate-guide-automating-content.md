---
title: "The Ultimate Guide to Automating Content With FeedForce"
description: "Design a template, add placeholders and a live chart, wire up real-world data through nodes, map it to your template, and publish automatically. Start to finish."
date: "2026-07-05"
cluster: "automation-guides"
featured: true
keywords:
  - automate social media content
  - content automation tutorial
  - dynamic template automation
  - ai content workflow tutorial
  - node based content automation
faq:
  - q: "Do I need to know how to code to build this?"
    a: "No. Every step here — template design, placeholders, the node canvas, binding data to placeholders — is visual. The one optional exception is the Code node, and even that's short, reusable JavaScript rather than an application you're building from scratch."
  - q: "Can I bind a live image URL into a template the same way I bind text?"
    a: "Not yet. Text placeholders and chart/table elements both bind to live data today; image boxes on a slide don't have an equivalent binding path — they stay whatever you set at design time. It's a real gap, not something this guide is glossing over."
  - q: "What happens if I run this automation before I trust it?"
    a: "Nothing gets published without you choosing to — as long as you keep the Trigger on manual while you're building and reviewing, rather than switching it to a timer. There's no dedicated approval-gate node in the canvas, so manual mode is what stands in for one."
figures:
  - type: nodeflow
    steps:
      - nodeType: trigger
        note: "Manual, for now"
      - nodeType: http
        note: "Your real-world data source"
      - nodeType: code
        note: "Reshape the response (optional)"
      - nodeType: template
        note: "Scans for placeholders + chart inputs"
  - type: bindingMap
    bindings:
      - target: "{headline}"
        source: "data.title"
        kind: text
      - target: "{price}"
        source: "data.value"
        kind: text
      - target: "chart.prices"
        source: "data.history"
        kind: chart
  - type: nodeflow
    steps:
      - parallel:
          - nodeType: http
            note: "\"News\" — a second source"
          - nodeType: ai
            note: "\"Take\" — writes the reaction"
      - nodeType: template
        note: "{headline} ← News.title · {take} ← Take.summary"
      - nodeType: post
        note: "Publish to Instagram"
---

Every automated post starts life as two separate things built independently, then wired together: a **template** (the design) and an **automation** (the data and the trigger to publish it). Most guides jump straight to the node canvas and skip the part that actually determines whether the result looks designed or generated. This one doesn't. We'll build a real pipeline start to finish — a template with placeholders and a live chart, a node workflow that pulls real-world data into it, a second data source merged in for good measure, and a Post node that ships it — with an honest note on the one thing that doesn't work yet.

## Step 1: Design the template first

Open the template editor and build a carousel the way you'd design anything — pick a layout, set your brand colors and fonts from your [brand kit](/blog/social-media-brand-kit-guide), lay out your slides. The only thing that makes this template *automatable* rather than just reusable is what you type into the text.

**Add placeholders as literal text.** Wherever a value should change per run, type a curly-brace token directly into a headline, subheadline, or text box — `{headline}`, `{price}`, `{take}`. Nothing special happens yet; it's just text sitting in your design, exactly as visible and editable as anything else. (The full mechanics: [how template placeholders work](/blog/how-template-placeholders-work).)

**Add a chart as a custom element.** For anything that should be *seen* rather than *read* — a price history, a comparison — place a chart, table, or candlestick element on the slide the same way you'd place an image. This is a genuinely different binding path from text placeholders, covered in Step 3.

**Build more than one slide if the format calls for it.** A single-stat card might be one slide; a "this week in X" digest might be six, each with its own placeholders. The template holds as many as your format needs — the automation binds all of them in a single run.

Save the template. This is the design half of the system, complete on its own — you could fill it by hand forever if you wanted to. The automation half is what makes it fill itself.

## Step 2: Build the automation canvas

Switch to the automation canvas and start a new workflow. Right-click to add your first node.

**Trigger.** Every workflow starts with exactly one — set it to **manual** for now (press Run yourself) rather than a timer. You'll flip this once the whole pipeline is proven; see [Trigger timing](/blog/trigger-node-timing-guide) for when and how.

**HTTP Request.** This is where real-world data enters — point it at any API that returns JSON: a price feed, a sports API, your own product data. Set the method (GET for most data-fetching), the URL, and authentication if the API needs a key (stored as an encrypted credential, never typed in plain). Full field reference: [the HTTP Request node guide](/blog/http-request-node-guide).

**Code.** Optional, but usually worth it — reshape whatever the API returned into exactly the fields your template needs. Compute a percentage change, format a date, flatten a nested response. Five ready-to-adapt examples: [the Code node cookbook](/blog/code-node-transforms-cookbook).

**Apply Template.** Point this node at the template you built in Step 1. It scans the template for every `{placeholder}` and every chart/table element, and exposes each one as something you can bind — which is exactly the next step.

Here's that chain so far, as an actual diagram:

<!--figure-->

## Step 3: Map each placeholder to a JSON value

This is the step that makes the whole system click. Select the Apply Template node and open its config panel — every placeholder from your template and every input your chart element needs shows up as a row waiting for a binding. Click into one, and you're choosing a path into the JSON your upstream nodes produced: `{headline}` might map to `data.title`, `{price}` to `data.value`, and your chart's `prices` input to `data.history` — an array, bound raw rather than stringified, so the chart actually has real points to draw (see [binding charts and tables](/blog/bind-charts-and-tables-into-posts) for why text and chart bindings work differently under the hood).

Here's what that mapping looks like once it's set:

<!--figure-->

Run the node once (its own "Test this node" button, not the whole workflow) and check the output — if a binding path is wrong, this is where you'll see it immediately as a missing or blank value rather than discovering it after a post already went out.

## Step 4: Add a second data source

The single-source version above already produces a real automated post. The version that feels genuinely smart usually needs two sources — a hard number from one, and a written take from another. Add a second branch:

**Another HTTP Request node** (rename it to something meaningful — its label becomes part of every binding path that references it, e.g. "News") pulling a story or data point from a different source.

**A Custom Agent node** reading that data and writing a short take in your voice — a headline, a one-line reaction, a sentiment. This node returns structured data matching a schema you define; it does not compose the finished slide copy itself; see [writing prompts for the Custom Agent node](/blog/custom-agent-node-prompting-guide) for getting consistent output from it.

Connect **both** to the same Apply Template node. Because there are now two distinct upstream sources, FeedForce merges them by each source's own label rather than fanning out separately — a binding path like `News.headline` or `Take.summary` addresses each one directly. The full mechanics, including why naming your nodes matters here specifically: [joining multiple data sources into one post](/blog/join-multiple-data-sources-automation).

The complete pipeline, with both sources feeding the template before it publishes:

<!--figure-->

## Step 5: Publish

Add a **Post** node after Apply Template, connect your Instagram account (feed, reels, or story), and you're done — every future run takes real data in one end and a published, on-brand post out the other. Before switching the Trigger from manual to a timer, run the whole chain a few times and actually look at the output; there's no dedicated approval-gate node in the canvas standing between a bad run and a real publish, so this manual review is what does that job (more on this habit in [node-based automation, explained](/blog/node-based-automation-explained) and [debugging a failed automation run](/blog/debugging-a-failed-automation-run) for when something doesn't look right).

## The honest gap: images aren't bindable yet

If you're picturing a fully dynamic template — a live chart *and* a live photo pulled from an image API, both changing every run — that second half isn't real yet. Text placeholders and chart/table elements both bind to live data today; an image box on a slide doesn't have an equivalent binding path, so whatever image you set at design time is what every run uses, regardless of what your data looks like. It's a genuine current limit, not a detail this guide is smoothing over — worth knowing before you design a template that depends on it.

## What you've actually built

Trace back through what just happened: a template with your brand baked in, filled by real data from one or two live sources, transformed if needed, checked against your own review, and published — with no per-run design work at all. Every node in this guide has its own deeper reference if you want to go further: [every automation node explained](/blog/feedforce-automation-nodes-explained), [If node branching recipes](/blog/if-node-branching-recipes) for when a run should skip publishing entirely, and [15 ideas for dynamic data automations](/blog/dynamic-data-automation-ideas) for what to build next now that you have the whole pattern.
