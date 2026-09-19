---
title: "How to Write Prompts for the Custom Agent Node"
description: "The Custom Agent node returns structured data, not slide copy. Here's how to write a prompt and schema pair that produces consistent output every run."
date: "2026-07-05"
cluster: "automation-nodes"
keywords:
  - ai prompt automation node
  - custom agent node prompt
  - structured output ai prompt
  - gemini automation prompt
  - ai node schema design
faq:
  - q: "What model does the Custom Agent node use?"
    a: "Gemini 2.5, with a choice between Flash (faster, cheaper, fine for most classification/summarization) and Pro (stronger reasoning, worth it for nuanced writing tasks). Both support an optional web-search grounding toggle."
  - q: "Why does my Custom Agent node sometimes skip a field in its output?"
    a: "Almost always a prompt that doesn't explicitly require every field the schema expects. A schema describes the shape you want; it doesn't force the model to fill every field with meaningful content if the prompt doesn't clearly ask for it."
  - q: "When should I turn on web-search grounding?"
    a: "Whenever the task depends on information more current than the model's training — reacting to breaking news, checking a live fact, referencing something that happened this week. Leave it off for tasks that are pure transformation of the data already flowing into the node (summarizing, classifying, rewriting)."
---

The Custom Agent node is easy to misuse in one specific way: treating it like a copywriter that hands back a finished caption. It doesn't — it's a data-generation step. You give it a prompt and a JSON schema; it returns structured data matching that schema, which an Apply Template node then binds into your design. Getting good, consistent output is entirely about how you write that prompt-and-schema pair.

## The two things you're actually configuring

**The prompt** — a plain-language instruction, up to a few lines. **The schema** — a JSON description of the exact fields you want back. Together they define a contract: the prompt tells the model *what to think about*, the schema tells it *what shape to hand back*. Weak results almost always trace to one of these being vague, not to the model itself.

## Write the prompt like a brief, not a question

A prompt like "summarize this" produces something different every run — sometimes a sentence, sometimes a paragraph, sometimes with an opinion baked in, sometimes without. A prompt that reads like an actual brief produces consistent output:

> Poor: `Summarize this story.`
>
> Better: `From the input story, extract: the single most newsworthy fact in one sentence, a one-word sentiment (positive/negative/neutral), and a headline under 60 characters in an energetic, non-corporate tone.`

The difference isn't length for its own sake — it's specificity about exactly what to extract, how long each piece should be, and what tone or constraint applies. Every one of those specifics is something the vague version left the model to guess at, differently, each run.

## Design the schema to match the prompt exactly

The schema is what becomes this node's output ports — what an Apply Template or Code node downstream can actually bind. A mismatch between what the prompt asks for and what the schema declares is the single most common source of inconsistent runs:

```json
{
  "headline": { "type": "string", "maxLength": 60 },
  "sentiment": { "type": "string", "enum": ["positive", "negative", "neutral"] },
  "keyFact": { "type": "string" }
}
```

Matched against the prompt above, every field the schema expects is something the prompt explicitly asked for — including the constraint (`maxLength: 60` mirrors "under 60 characters," `enum` mirrors "one-word sentiment"). When a schema declares a field the prompt never mentions, that field is the one that comes back empty, generic, or inconsistent across runs.

## Use web-search grounding deliberately, not by default

The grounding toggle lets the node pull in current information rather than relying solely on what's in the input data and the model's training. Turn it on when the task genuinely needs freshness — reacting to a story from this morning, checking a fact that changes over time. Leave it off for pure transformation tasks (summarizing input you already provided, classifying sentiment, rewriting tone) — grounding adds latency and cost for a task that doesn't need external information, since everything it needs is already in `ctx.input`.

## Iterate with "Test this node," not a live schedule

Because a Custom Agent node's output varies more than a deterministic node's (an HTTP Request always returns the same shape for the same input; an AI node can vary in phrasing even against identical input), the fastest way to tighten a prompt is running the same input several times via the node's own test-run and watching where the output drifts. If sentiment classification flips between runs on genuinely ambiguous input, that's the model being reasonably uncertain — a real signal to either accept "neutral" as the safe default or add a rule for how to break ties in your prompt.

## A worked example: news-reaction schema

Putting it together for the kind of workflow in [how to create content automations](/blog/how-to-create-content-automations):

**Prompt:** `From the input news story, write a one-sentence take from the perspective of a [your niche] account — informed, slightly opinionated, never neutral filler. Also extract the story's single most quotable fact.`

**Schema:**
```json
{
  "take": { "type": "string", "maxLength": 140 },
  "quotableFact": { "type": "string" }
}
```

`take` binds straight into a `{take}` placeholder on your template (see [how template placeholders work](/blog/how-template-placeholders-work)); `quotableFact` can bind into a supporting stat line. Two fields, two roles, both explicitly asked for — which is exactly why they come back reliably, run after run.
