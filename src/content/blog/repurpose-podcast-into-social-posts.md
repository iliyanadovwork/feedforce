---
title: "How to Repurpose a Podcast Episode Into a Week of Social Posts"
description: "A 45-minute podcast episode holds 3-5 clippable moments, a carousel, and a week of posts. The transcript-first extraction method, step by step."
date: "2026-07-05"
cluster: "repurposing"
keywords:
  - repurpose podcast
  - podcast to social media content
  - turn podcast into posts
  - podcast content repurposing
  - podcast clips social media
faq:
  - q: "How many social posts can one podcast episode realistically produce?"
    a: "A typical 30-60 minute conversational episode yields 5-7 solid posts: 2-3 audiogram clips, 2 quote cards, one carousel summary, and one text pull-quote. Interview episodes with a strong guest often yield more because there are two voices to pull from."
  - q: "Do I need video to repurpose a podcast, or does audio-only work?"
    a: "Audio-only works fine. Audiograms (a static or animated waveform image with captions over the audio) are the standard format for audio-only shows and perform comparably to video clips on Reels and TikTok because the captions carry the content."
  - q: "Should I repurpose every episode or just some?"
    a: "Repurpose every episode you publish, but not every minute of it. The extraction step is where you decide which 3-5 moments earned a second life — most of a 45-minute conversation is scaffolding, not content."
---

Most podcasts get repurposed badly: one episode becomes one square audiogram with the episode title slapped on it, posted once, forgotten. That's a fraction of what's actually in a recorded conversation. A single episode, treated as a pillar instead of a single asset, is enough raw material for a full week of platform-native posts — and the extraction takes less time than editing the episode did.

## Start with the transcript, not the audio

The audio file is hard to search and impossible to skim. The transcript is where the actual editing decision happens. Run the episode through any transcription tool (most podcast hosts and editors include one), then read it once, cold, marking anything that made you sit up: a specific number, a contrarian claim, a story with a clear beginning and end, a line you'd screenshot if you saw it out of context.

You're looking for **3-5 moments**, not fifteen. A moment qualifies if it stands alone — if someone with zero context on the episode would understand and feel something reading just that excerpt. Vague general wisdom ("consistency matters") doesn't qualify. A specific claim with a number or a named consequence does.

## Turn each moment into two formats

Once you have your 3-5 moments, each one becomes raw material for more than one post:

- **Quote card.** The exact line, verbatim, on a branded background. No paraphrasing — paraphrased quotes read as fake. If the guest said it, attribute it to the guest by name.
- **Audiogram clip.** The 20-60 second audio segment containing that moment, captioned, in the waveform-or-talking-head-photo format that works for audio-only shows. This is your Reels/TikTok/Shorts asset.

Two moments (out of your 3-5) are usually strong enough to also become a **text post**: the claim typed out as a standalone thought for X or LinkedIn, with no audio or image needed at all. Pick the ones that are most argument-shaped — a claim someone could agree or disagree with.

## Build one carousel from the episode's structure

Separately from the quotable moments, look at the episode's actual structure — the topics covered in order — and turn that into a carousel: slide one is the hook (what the episode is about and why it matters), each following slide is one topic or takeaway, last slide points to the full episode. This is the same [transcript-to-carousel method](/blog/turn-video-into-carousel) used for video, applied to an audio transcript instead — the technique doesn't care whether the source had a picture.

## Space it across a week, don't dump it

This is the part almost everyone gets wrong: they publish the episode and every derivative on the same day. That's one loud day of "podcast content" and then silence until the next episode. Instead:

- **Day 1** — episode goes live, plus one quote card announcing it.
- **Day 2** — first audiogram clip.
- **Day 3** — carousel summary.
- **Day 4** — second audiogram clip.
- **Day 5-6** — remaining quote cards and text posts, one per day.

That's five to seven touchpoints from one recording session, each one a legitimate standalone post rather than a rerun of yesterday's.

## Automating the extraction

The transcript-marking step is the one part of this that benefits most from a second pass, and it's exactly the kind of task a language model is good at: feed the full transcript to a Custom Agent node with a prompt asking for 3-5 quotable moments plus a section-by-section outline, and constrain the output to a JSON schema (quote, speaker, timestamp, one-line topic). The clips and quote card design still need a human eye, but the "which 15 seconds out of 45 minutes" decision gets made for you in seconds instead of an hour of scrubbing. It's the same pillar-and-derivatives logic covered in our [content repurposing guide](/blog/content-repurposing-guide), just applied to spoken-word source material instead of video or text.

If you're running the extraction as a repeatable pipeline rather than a one-off, see our [automation workflows roundup](/blog/social-media-automation-workflows) for how the Custom Agent and Apply Template nodes chain together end to end.
