---
title: "The HTTP Request Node: Authentication, Methods, and Real Limits"
description: "Every HTTP Request node field explained — method, auth, credentials, body — plus an honest look at what it doesn't do yet, like pagination."
date: "2026-07-05"
cluster: "automation-nodes"
keywords:
  - http request node
  - api authentication automation
  - connect api to social media automation
  - automation api credentials
  - no-code api call
faq:
  - q: "How do I authenticate an API call in the HTTP Request node?"
    a: "Set Authentication to \"API key\" and pick a stored credential from the credential dropdown — your key is encrypted server-side and only its id is saved in the workflow, never the raw key itself."
  - q: "Does the HTTP Request node support pagination?"
    a: "Not natively — each run is a single call to one URL. For a paginated API, either use an endpoint that returns everything in one response if the provider offers one, or accept that you're working with the first page."
  - q: "Can I send a JSON body with my request?"
    a: "Yes, for POST, PUT, and PATCH — toggle \"Send body\" on and write the JSON directly. It's hidden for GET and DELETE since those methods don't carry a body."
---

The HTTP Request node is the one that makes FeedForce's automation canvas open-ended — anything with an API becomes a usable signal or data source, not just the handful of sources the product ships built-in support for. It's also a deliberately simple node: one call, one response, no hidden magic. Here's every field, and an honest look at what it currently can't do.

## The fields

**Method** — GET, POST, PUT, PATCH, or DELETE. Most signal-watching and data-fetching workflows only need GET; POST/PUT/PATCH matter when you're pushing data somewhere, not just pulling it.

**URL** — the full endpoint, required. This is a static field per node — if you need to call a different URL each run based on upstream data, that's a case for templating the URL from bound values rather than the node computing it dynamically.

**Authentication** — "None" or "API key." Most public data APIs and many commercial ones authenticate this way; OAuth-style flows (where you'd need a token exchange and refresh) aren't a built-in authentication mode here — you'd handle a token as a stored API-key credential if the provider issues long-lived tokens, or the call falls outside what this node handles cleanly.

**Credential** — when Authentication is "API key," you pick a stored credential rather than typing the key into the node itself. It's encrypted server-side; the workflow config only ever holds the credential's id, not the raw secret. This matters if you ever share, duplicate, or export a workflow — the key itself never travels with it.

**Send body / Body (JSON)** — appears only for POST, PUT, and PATCH (GET and DELETE don't carry a body, so the fields hide themselves for those methods). Write the JSON payload directly; it's sent as-is.

## What it returns

The node's single output is the API's response, available to every downstream node exactly as the API returned it — nested objects and all. This is why naming the node clearly matters the moment you're binding fields from it: a binding path like `Prices.bitcoin.gbp` (see [joining multiple data sources](/blog/join-multiple-data-sources-automation)) is walking directly into this raw response shape, so knowing what the API actually returns — not what you assume it returns — is the difference between a binding that works and one that silently reaches for a field that isn't there.

## What it doesn't do (yet)

Worth being upfront about, since assuming a missing feature exists is how workflows fail quietly:

- **No native pagination.** Each run is one call to one URL. If an API paginates its results across multiple requests, this node calls the first one; there's no built-in "fetch every page and combine" behavior.
- **No automatic retries or backoff.** A failed call fails the node — see [debugging a failed automation run](/blog/debugging-a-failed-automation-run) for how to spot and fix it, since there's no silent retry masking the failure.
- **No rate-limit awareness.** If you're polling an API on a tight timer and it enforces a rate limit, that's on you to respect by choosing a sensible polling interval — the node itself doesn't throttle or queue calls.
- **Static URL per node.** For genuinely dynamic endpoints (different URL per upstream item), you're working within a single node's fixed configuration, not a templated URL that changes per run.

None of these are unusual for a first-class HTTP node — they're the same honest limits you'd hit with the equivalent node in most automation tools. The practical takeaway: pick data sources that return what you need in one call where possible, and treat multi-page or rate-limited APIs as a case where this node covers the first, most useful slice rather than the whole dataset.

## A pattern that works well within these limits

Most content automations don't actually need pagination — they need *the latest N items*, and most APIs designed for this purpose (news feeds, price endpoints, sports scores) return exactly that in a single call by default. Where the HTTP Request node's simplicity shows its value is composability: pair it with an [If node](/blog/if-node-branching-recipes) to filter what it returns, a [Custom Agent](/blog/how-to-create-content-automations) to interpret it, and an [Apply Template node](/blog/how-template-placeholders-work) to publish it — one clean call feeding a whole pipeline, rather than a complex node trying to do all of that itself.
