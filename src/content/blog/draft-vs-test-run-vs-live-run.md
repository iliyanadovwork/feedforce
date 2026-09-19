---
title: "Draft, Test Run, and Live Run: The Three States of an Automation"
description: "A workflow that tested clean isn't automatically ready to go live. The three real states an automation passes through, and where people conflate them."
date: "2026-07-05"
cluster: "automation-nodes"
keywords:
  - automation test run
  - workflow draft vs live
  - testing automation before publishing
  - automation run states explained
  - understand automation testing
faq:
  - q: "What's the difference between a test run and a live run?"
    a: "A test run is triggered manually and inspected node by node or as a whole; a live run happens unattended because the Trigger is set to a timer. The nodes and logic are identical — what changes is whether a human is watching before anything reaches Post."
  - q: "Does a successful test run mean a workflow is ready to go live?"
    a: "Not by itself. A single clean test proves the workflow handles one input correctly — it doesn't prove it handles the range of real, sometimes messy inputs it will see once it's running unattended on a schedule."
  - q: "Is a draft workflow the same as a workflow with the Trigger set to manual?"
    a: "No — a draft is still being built and hasn't necessarily been run at all. A manual-Trigger workflow is finished and tested, just deliberately not moved to a timer yet, often as a permanent choice rather than a temporary one."
---

An automation moves through three distinct states on its way to running unattended, and a lot of avoidable trouble comes from treating two of them as the same thing. Naming them separately makes it obvious where the actual risk sits.

## Draft: still being built

A draft is a workflow that isn't finished — nodes are being added, connected, and configured, but it hasn't necessarily been run at all, and if it has, it's been run against placeholder or incomplete data. Nothing about a draft is a promise of correctness; it's a workspace, not a result. The relevant question at this stage isn't "does this work" — it's "is this the shape I want," which is a design question, not a testing one.

## Test run: watched, on real data, nothing necessarily published

A test run means actually executing the workflow — a single node via its own "Test this node" button, or the full chain — against real or realistic data, with a human looking at the output. This is where a draft earns confidence: does the [HTTP Request node](/blog/http-request-node-guide) actually return the shape you expected, does the [Custom Agent node](/blog/custom-agent-node-prompting-guide) fill every schema field sensibly, does the [Apply Template node](/blog/how-template-placeholders-work) produce a slide that reads correctly. Critically, a test run doesn't automatically publish anything — Post only runs, and only actually posts, when it's deliberately part of the run you triggered and you've let it execute. Keeping the Trigger on manual during this whole stage is what makes testing genuinely low-stakes: you can run the chain as many times as you need without anything unattended slipping through.

## Live run: unattended, on a schedule

A live run means the Trigger is set to a timer rather than manual, and the whole chain — including Post — executes on its own, on whatever interval you configured, without a human looking at each individual run. This is the state a workflow is actually built toward, and it's also the state where a mistake costs the most, because nobody is necessarily watching the specific run that goes wrong. See [Trigger timing recipes](/blog/trigger-node-timing-guide) for choosing an interval that matches how often your underlying data actually changes, rather than one that's just aggressive for its own sake.

## The mistake: treating "it ran successfully" as "it's ready"

The most common way this goes wrong isn't a workflow that never got tested — it's a workflow that got tested once, ran cleanly, and got flipped to a timer on the strength of that one clean run. A single successful test run proves the workflow handles *that specific input* correctly. It doesn't prove it handles the awkward, unusual, or malformed input that real unattended running will eventually throw at it — a missing field, an empty API response, a title three times longer than anything in your test data. [The pre-launch checklist](/blog/automation-pre-launch-checklist) exists specifically to close this gap: running against more than one real input, checking binding paths against the actual response shape rather than the one you assumed, and confirming conditional nodes handle missing fields rather than just the happy path.

## What to do when a live run does go wrong

Even a workflow that earned its way to a timer through real testing will eventually hit something it wasn't built for — that's not a sign testing failed, it's a sign live data is more varied than any test set. [Debugging a failed automation run](/blog/debugging-a-failed-automation-run) covers reading the canvas for which node broke and re-testing that one node in isolation, which is the same skill from the test-run stage, just applied after the fact instead of before. The three states aren't a one-way door — a workflow that breaks in live running can always drop back to manual while you fix and re-test it, rather than staying live and hoping the next scheduled run goes better.
