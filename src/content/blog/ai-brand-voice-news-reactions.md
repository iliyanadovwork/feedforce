---
title: "How to Make an AI React to News in Your Brand's Actual Voice"
description: "Generic AI news commentary reads like a press release. The fix is almost entirely in the prompt — a concrete method for reactions that sound like your account."
date: "2026-07-05"
cluster: "news-to-content"
keywords:
  - ai brand voice content
  - automated commentary social media
  - ai news reaction
  - brand voice prompt engineering
  - on-brand ai content
faq:
  - q: "Why does AI-written news commentary usually sound corporate?"
    a: "Because a vague prompt like \"write a reaction to this story\" gives the model nothing to imitate, so it defaults to a safe, neutral register that reads as a company statement. Specific voice traits and a real point of view fix this, not a different model."
  - q: "Do I need examples of my own writing for this to work?"
    a: "It helps a lot but isn't required — a clearly described voice (tone words, what you'd never say, the kind of opinion you'd actually hold) gets you most of the way. Real examples sharpen it further if you have them."
  - q: "Should every automated reaction go out exactly as drafted?"
    a: "No — review before publish regardless of how good the prompt gets. The prompt gets you a strong first draft consistently; it doesn't replace the judgment call on whether this specific reaction, to this specific story, is one you actually want to have made publicly."
---

The most common complaint about AI-generated news reactions isn't that they're wrong — it's that they're bland. "We're closely monitoring developments in this space" is a sentence no human account actually writes, and it's exactly what you get from a vague prompt. The fix isn't a better model; every major model can write in a specific voice when asked to. The fix is asking specifically.

## Why the generic version happens

A prompt like "write a reaction to this news story" gives the model no voice to imitate, so it reaches for the safest, most neutral register available — which reads exactly like a corporate statement, because that's the least-risky output for an unconstrained request. This isn't a model limitation; it's what happens when you don't specify what you actually want, on any writing task, with any writer.

## The four things a voice-accurate prompt actually needs

**1. Tone words, specifically.** Not "professional" or "friendly" — those describe almost every brand and constrain nothing. "Skeptical, a little dry, doesn't hedge" narrows the output; "warm but blunt, allergic to corporate phrasing" narrows it differently. Pick words that would actually distinguish your account from a competitor's.

**2. A real point of view.** Ask for an opinion, not a summary. "Summarize this story" produces a neutral recap; "give the one-sentence take that a skeptical industry insider would have" produces something with an actual position — which is what makes commentary read as human in the first place.

**3. An explicit "never say" list.** Naming what to avoid is often more powerful than naming what to include — "never say 'closely monitoring,' 'exciting developments,' or 'we're thrilled'" directly blocks the exact phrases that make output read as generic AI commentary, because those phrases are precisely what an unconstrained model reaches for.

**4. Length as a constraint, not a suggestion.** "One sentence, under 140 characters" produces punchy commentary; "a paragraph" produces something that reads like a blog excerpt. Match the constraint to the format you're actually filling.

## Putting it together

A vague prompt: `Write a reaction to this news story.`

A voice-accurate one: `Give the one-sentence take on this story that a skeptical, slightly dry industry insider would post — an actual opinion, not a summary. Never use "closely monitoring," "exciting," or "thrilled." Under 140 characters.`

Run the same story through both, and the difference isn't subtle — the second version has a point of view, a register, and a length that fits a real post, because every one of those was named explicitly rather than left to the model's default.

## Making this repeatable, not a one-off prompt

Write your voice constraints once, as a reusable block, and prepend it to every Custom Agent node's prompt across every news-reaction workflow you build — rather than re-describing your voice from scratch each time and getting slightly different results per workflow. This is also where feeding in a few real examples of posts you'd actually written helps: not as a rigid template to copy, but as a concrete reference for the tone words you chose. (Full mechanics of the prompt-and-schema pair: [the Custom Agent prompting guide](/blog/custom-agent-node-prompting-guide).)

## Voice consistency still needs a human checkpoint

A strong prompt gets you a consistently on-brand *draft* — it doesn't remove the judgment call on whether this particular reaction, to this particular story, is one your account should be making publicly. Keep a review step before publish regardless of how good the prompt gets (see [automating newsjacking](/blog/automate-newsjacking) for why this matters even more once the drafts start sounding convincingly like you). The prompt solves "does this sound like us"; it was never meant to solve "should we say this."
