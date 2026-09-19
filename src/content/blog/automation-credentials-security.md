---
title: "How API Credentials Are Kept Safe in Automation Workflows"
description: "The HTTP Request node never stores your raw API key in the workflow itself. How the credential system works, and the habits that keep it that way."
date: "2026-07-05"
cluster: "automation-nodes"
keywords:
  - automation api key security
  - workflow credential storage
  - safe api key automation
  - secure automation credentials
  - api credential best practices
faq:
  - q: "Where does the HTTP Request node's API key actually get stored?"
    a: "Encrypted, server-side, as a named credential. The workflow's own configuration only ever holds that credential's id — the raw key never travels with the workflow itself."
  - q: "Is it safe to export or duplicate a workflow that uses an API key?"
    a: "Yes, specifically because of how the credential system is built — the workflow config references a credential by id, not by value, so exporting or duplicating it doesn't carry the raw key along."
  - q: "How often should I rotate an API key used in an automation?"
    a: "On whatever schedule the provider recommends, or immediately if you suspect exposure. Rotating just means updating the stored credential once — every workflow referencing it by id picks up the new key automatically."
---

Every automation that reaches an external API runs through the [HTTP Request node](/blog/http-request-node-guide), and most of those calls need a key. Where that key actually lives — and what happens to it if you export, duplicate, or share the workflow around it — is worth understanding precisely, rather than assuming.

## The workflow never holds the raw key

When a node's Authentication field is set to "API key," you pick a stored credential from a dropdown rather than typing the key directly into the node. That credential is encrypted server-side; the workflow's own configuration only ever stores the credential's id, not the secret itself. Practically, this means the actual key value and the workflow definition live in two different places, and the workflow only ever points at the first by reference.

## Why this matters the moment a workflow leaves your hands

This distinction is invisible until you export a workflow, duplicate it, or hand a copy to someone else — and then it's the entire reason nothing goes wrong. A workflow definition that referenced the raw key directly would leak that key into every export, every duplicate, every screenshot of the canvas showing node configuration. Because the config only holds an id, a duplicated or exported workflow carries a pointer that means nothing without access to the original credential store — the key itself never rides along. If you're handing a workflow to a teammate, they'll need their own credential set up (or access to yours), not a copy of a secret embedded in JSON.

## The habit this doesn't protect you from

Storing keys as credentials protects the workflow's configuration. It doesn't protect a key you type somewhere else. The most common way a key still ends up exposed despite a proper credential system: pasting it directly into a URL query string or a request body field instead of using the credential dropdown. A URL like `https://api.example.com/data?key=sk_live_abc123` puts the raw key in a field that gets logged, previewed, and potentially exported in plain text right alongside the rest of the node's configuration — the credential system can't protect a secret that was never put into it. If an API requires the key as part of the URL rather than a header (some do), that's a case worth double-checking whether the provider offers a header-based alternative before defaulting to pasting it in visibly.

## Rotate keys on a schedule, not just after a scare

Treat key rotation as routine maintenance, not an incident response. Because the workflow only references a credential by id, rotating is a single update — swap the value stored against that credential, and every workflow referencing it by id automatically uses the new key on its next run, with nothing to edit in the workflows themselves. This is one of the more underused advantages of the reference-not-value design: rotation doesn't require touching every workflow that happens to use a given API, only the one place the key is actually stored.

## What to check before you trust a new integration

Before wiring a new API into a workflow: confirm you're using the credential dropdown rather than a raw value in any field, check whether the provider's key needs to go in a header versus a URL parameter, and note whether the provider gives you a way to scope the key's permissions narrowly (read-only where you don't need write access). None of this is specific to automation — it's the same discipline you'd apply to any API key anywhere — but an automation workflow is exactly the kind of thing that gets exported, duplicated, and shared more casually than a line of production code, which is precisely why the credential-by-reference design matters here. See [the pre-launch checklist](/blog/automation-pre-launch-checklist) for where credential checks fit alongside everything else worth verifying before a workflow goes live, and [debugging a failed automation run](/blog/debugging-a-failed-automation-run) for what an expired or wrong credential actually looks like when a node fails.
