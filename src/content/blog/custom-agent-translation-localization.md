---
title: "How to Use the Custom Agent Node for Translation and Localization"
description: "Translation is a schema field, not a separate workflow. How to add a second-language output to a Custom Agent node without losing the original."
date: "2026-07-05"
cluster: "automation-nodes"
keywords:
  - ai translation automation
  - localize content automatically
  - custom agent node translation
  - automated content localization
  - multilingual content automation
faq:
  - q: "Does translating a post with the Custom Agent node replace the original text?"
    a: "Not unless you design it that way. The reliable pattern is a schema with separate fields for the original and each translation, so both exist as distinct outputs an Apply Template node can bind independently."
  - q: "Is machine translation good enough for a brand's social content?"
    a: "For literal meaning, usually yes. For tone and cultural fit, only if the prompt explicitly asks for adaptation rather than a word-for-word rendering — a schema alone doesn't make the model localize instead of translate."
  - q: "Can one Custom Agent node output more than two languages?"
    a: "Yes — add one schema field per language. The tradeoff is a longer, more complex prompt to keep every field's instructions distinct, so past three or four languages it's often cleaner to split into parallel Custom Agent nodes instead."
---

Translation looks like a natural fit for the Custom Agent node, and it is — but the naive version of this workflow quietly overwrites the original text with a translated version, which is rarely what you actually want. The reliable pattern treats each language as its own named field in the output schema, so the original and the translation both exist afterward, as separate things an [Apply Template node](/blog/how-template-placeholders-work) can bind independently.

## Add a language, don't replace one

If your workflow already drafts a caption or slide copy upstream — via an earlier Custom Agent node, or copy you've written directly into a template — the translation step should read that text as input and return a *new* field alongside it, not overwrite it. Practically: your schema needs a field for the source text (even if it's just passed through unchanged) and a separate field per target language. This matters most when you're posting the same content to two audiences from one template — an English slide and a Spanish slide side by side, both bound from the same run, rather than one overwriting the other on a re-run.

## Localization is a different instruction than translation

A literal translation and a good localized version diverge exactly where idiom, tone, and cultural reference live. "Break the internet" translates word-for-word into most languages and means nothing in several of them. A prompt that only says "translate this into French" will get you grammatically correct French that still reads like it was translated — because that's literally what you asked for. Getting a version that reads like it was *written* in the target language requires naming the adaptation explicitly:

> Poor: `Translate this caption into French.`
>
> Better: `Translate this caption into French for a French social media audience. Adapt idioms and cultural references rather than translating literally — if a reference or phrase doesn't land the same way in French, replace it with an equivalent that does. Keep the tone casual and energetic, matching the English original.`

The second version tells the model what "good" means for this task beyond word-for-word accuracy — which is exactly the gap between translation and localization.

## A worked example: two-language output

**Prompt:** `From the input caption, produce two outputs. First, pass the original English text through unchanged. Second, a French adaptation for a French social audience — adapt idioms and cultural references rather than translating literally, and keep the same casual, energetic tone as the English version.`

**Schema:**
```json
{
  "captionEn": { "type": "string" },
  "captionFr": { "type": "string" }
}
```

`captionEn` and `captionFr` bind into two separate `{placeholders}` — on two different slides of the same carousel, on two separate templates entirely, or wherever your design calls for both languages to exist at once. See [how template placeholders work](/blog/how-template-placeholders-work) for the binding mechanics this depends on, and [automation data types explained](/blog/automation-data-types-explained) for how string outputs like these flow between nodes.

## Test each language separately before trusting either

A Custom Agent node's output varies more between runs than a deterministic node's, and that variance doesn't always show up the same way in every field — an English pass-through can look perfect for five runs while the French field drifts in tone on the sixth. Run the node's own test-run a few times and check both fields, not just the one you're less confident about. If you're layering this onto an existing prompting workflow, [the Custom Agent prompting guide](/blog/custom-agent-node-prompting-guide) covers the general discipline of matching a schema tightly to a prompt — the same rule applies here field by field, just doubled.
