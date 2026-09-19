---
title: "Every FeedForce Automation Node, Explained"
description: "Trigger, HTTP Request, Custom Agent, Code, If, Apply Template, Element, Post — what each node in FeedForce's automation canvas actually does and when to use it."
date: "2026-07-05"
cluster: "automation-nodes"
keywords:
  - feedforce automation nodes
  - ai agent node for content
  - content automation node canvas
  - custom code node automation
  - no-code ai content workflow
faq:
  - q: "What AI model powers the Custom Agent node?"
    a: "Gemini 2.5 (Flash or Pro, selectable) with an optional web-search grounding toggle. You give it a prompt and a JSON output schema, and it returns structured data — not slide copy directly, since the Apply Template node is what meshes that data into your design."
  - q: "Does the Custom Agent node write my slide text for me?"
    a: "It writes the data — a headline, a stat, a research summary, whatever your schema defines. The Apply Template node then binds that data into your saved template's identifiers. Splitting research from layout keeps the design consistent even as the AI's output varies."
  - q: "Is the Code node safe to run untrusted scripts in?"
    a: "It runs plain JavaScript against your workflow's input and config, so treat it like any other script you'd paste into your own project: fine for logic you wrote or reviewed, not a place to paste code from a source you don't trust."
figures:
  - type: nodeflow
    steps:
      - nodeType: trigger
        note: "Hourly timer"
      - nodeType: http
        note: "Poll a news source"
      - nodeType: if
        note: "Relevant to my niche?"
      - nodeType: ai
        note: "Research + draft (structured output)"
      - nodeType: template
        note: "Bind into a news-reaction carousel"
      - nodeType: post
        note: "Publish to Instagram"
---

FeedForce's automation canvas is a node graph: right-click to drop a node, drag to reposition it, connect typed ports, click a node to configure it in the side panel. If you've used n8n or Make, the shape is familiar — [the mental model is the same one we cover in our node-automation primer](/blog/node-based-automation-explained). What's different is which nodes exist. Here's every one, what it actually does, and where it fits in a real workflow.

## Trigger — when the workflow runs

Every workflow starts with exactly one Trigger node: either **manual** (you press Run) or **timer** (hourly, daily, weekly, or a custom schedule). There's no dedicated "watch this webhook" or "watch this RSS feed" trigger type — for event-driven signals, pair a timer with an HTTP Request node that polls the source on each tick.

## HTTP Request — talk to anything

A general-purpose API caller: GET, POST, PUT, PATCH, DELETE, with an optional stored API-key credential (encrypted server-side, picked from a credential dropdown rather than pasted in plaintext each time). This is the node that makes the canvas open-ended — poll a news API, hit a stock-price endpoint, call a platform you're not natively connected to. It's the same tool n8n workflows lean on for everything; here it sits next to the design and publishing nodes instead of standing alone.

## Custom Agent — the AI research/drafting step

An AI node (Gemini 2.5 Flash or Pro) that takes a prompt plus a JSON schema you define, and returns structured data matching that schema — a headline, a summary, a stat, a sentiment score, whatever the next node needs. Deliberately, it does **not** write finished slide copy: the design decision of what goes where lives in your template, not in the AI's output. Optional web-search grounding lets it pull in current information rather than relying on the model's training data alone — relevant for anything time-sensitive, like [a news-to-post pipeline](/blog/how-to-create-content-automations).

## Code — custom logic

A JavaScript step: it receives `ctx.input` and `ctx.config`, and returns an object for the next node. Use it for anything the other nodes don't cover directly — reshaping a payload, computing a derived value, filtering an array by a rule too specific for the If node. FeedForce's own docs note the code editor is a plain textarea today (a full Monaco-style editor is planned) and that unsandboxed script execution is a known constraint worth being deliberate about — write or review the code yourself rather than pasting in scripts from an untrusted source.

## If — branching logic

Conditional routing on an expression like `{{ $json.value > 0 }}`. Use it to gate a workflow on relevance ("only continue if this story mentions my industry") or to split a path ("if engagement is above X, do this; otherwise, do that").

## Apply Template — where data becomes a designed post

Takes the structured data flowing in and binds it into a saved FeedForce template's identifiers — the same templates you build by hand in the carousel or reel editor. This is the node that turns "a JSON object with a headline and a stat" into an actual branded slide, with your brand kit's fonts, colors, and logo already applied because they're baked into the template, not re-specified per run.

## Element — dynamic charts and data views

Similar idea, scoped to a single AI Element (a chart, table, or candlestick view) rather than a whole template. Ports are generated automatically from that element's own input schema, so wiring data into a live chart is as direct as wiring it into a template.

## Post — publish to Instagram

Takes the slides an Apply Template node produced and publishes them to your connected Instagram account — feed, reels, or story. This is the one node in the canvas that's platform-native; anything beyond Instagram routes back through the HTTP Request node with your own developer credentials, the same pattern you'd use in a general-purpose tool.

## A minimal real workflow

Putting the pieces together — the actual node chain for a simple automated news post:

<!--figure-->

Six nodes, each doing one job, visible end to end on one canvas — no external design API, no separately-maintained posting script. There's no dedicated approval-gate node here, so before wiring the Trigger to a timer, run it manually once and check what the Apply Template step produced. For the broader pattern this fits into, see [how to create content automations](/blog/how-to-create-content-automations); for how it stacks up against building the same thing in n8n, see [our n8n comparison](/blog/n8n-alternative-for-content-automation).
