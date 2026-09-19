---
title: "Debugging a Failed Automation Run, Node by Node"
description: "A red border, a green border, and a Test this node button — how to actually find and fix the node that broke, instead of re-running the whole workflow and hoping."
date: "2026-07-05"
cluster: "automation-nodes"
keywords:
  - debug automation workflow
  - fix broken automation node
  - automation run failed
  - test node before running
  - troubleshoot content automation
faq:
  - q: "How do I know which node in my workflow failed?"
    a: "The failed node's card gets a red border directly on the canvas — you don't need to open a log. A green border means that node's last run succeeded; no color means it hasn't run yet in this session."
  - q: "Can I test one node without running the whole workflow?"
    a: "Yes — select a node and use its \"Test this node\" button in the config panel. It runs just that node (using whatever upstream data is available from the last run) and shows the output or the error inline, without touching anything downstream."
  - q: "Why does my workflow fail on the Post node specifically?"
    a: "Most commonly a missing or expired Instagram connection, or the Apply Template node upstream not actually producing slides (check its own test output first — a template failure often surfaces one step later, at Post, rather than at its real source)."
---

A failed automation run is a much smaller problem than it feels like in the moment — the canvas tells you exactly which node broke, and you can re-test that one node in isolation without re-running everything else. Here's the actual debugging loop.

## Read the canvas before anything else

Every node's card carries a live status, right on the canvas: a **red border** means that node's last run failed, a **green border** means it last succeeded, and no color means it simply hasn't run yet this session. Run a full workflow and something breaks, and you'll see it immediately — no need to open a log file or guess which of six nodes was the problem. A banner at the top of the canvas also shows "Run failed: [message]" for the whole run, but the red node card is what tells you *where*.

## Isolate the node — don't re-run everything

Once you've spotted the red node, select it. Its config panel has a **"Test this node"** button that runs just that node — using whatever upstream data is already available from the last run — and shows either the raw JSON it produced or the error message, right there in the panel. This is the entire debugging loop: you don't need to re-trigger the whole workflow (and wait for every upstream step to re-run) just to see if your fix worked. Fix, test that one node, repeat.

## Common failures by node type

**HTTP Request fails.** Almost always the URL, an expired or wrong API key credential, or the upstream API itself returning an error status. Test the node in isolation and read the raw response — a 401 means the credential, a 404 means the URL, a 200 with unexpected shape means your downstream bindings are reaching for fields that don't exist in the actual response.

**Custom Agent produces the wrong shape.** If your output schema expects a field the model didn't return, check the prompt — a vague instruction produces an inconsistent shape across runs even with a schema defined. Tightening the prompt to explicitly name every required field usually fixes this faster than adjusting the schema.

**Code node throws.** Since it's unsandboxed JavaScript, an error here is a normal JS error — read the message like you would in any project. The most common cause is assuming a field exists on `ctx.input` that isn't there for every possible upstream response; guard with `ctx.input?.field ?? fallback` rather than assuming.

**Apply Template produces no slides, or blank ones.** Usually a binding pointing at a field that doesn't exist in the merged upstream data — double-check the exact path, especially after a [multi-source merge](/blog/join-multiple-data-sources-automation) where a typo in a node's label silently breaks every binding path that references it.

**Post fails.** Most often a missing or expired Instagram connection (reconnect it from the Schedule panel) — but check the Apply Template node's own test output first. A template that quietly produced zero slides will make Post fail with a confusing message, when the real problem was one step upstream.

## Build workflows that fail loudly, early

The habits that make future debugging faster, not just this one fix:

- **Test each node once as you build it**, rather than wiring six nodes and running the whole chain for the first time. A workflow assembled node-by-node with each one verified rarely produces a confusing multi-node failure.
- **Name every node for its job**, not its type — "If: worth posting" tells you what broke; "If 2" makes you open it to remember.
- **Keep the trigger on manual while iterating.** A timer trigger firing every hour while you're still debugging just produces more failed runs to sort through — see [node-based automation, explained](/blog/node-based-automation-explained) for why this matters even more given there's no dedicated approval-gate node to catch bad output before it reaches Post.
- **Re-test the whole chain once, after fixing the one node**, before trusting it back to a schedule — a fix to one node occasionally exposes a second issue one step further downstream that a full run will catch and an isolated node test won't.

Most "my automation is broken" moments turn out to be one node, one bad assumption about what its input looks like, and a five-minute fix once you know to look at the red border instead of the whole canvas.
