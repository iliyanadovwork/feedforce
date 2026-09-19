# FeedForce

A content-automation platform: build a workflow on a node graph, have it run on a
schedule, and publish the result to social accounts. Design happens on an in-browser
canvas; media is rendered client-side rather than on a server.

Next.js 16 / React 19 / TypeScript over Supabase and Stripe. ~76,000 lines across
54 API routes. **1,001 tests in 68 files**, running in CI alongside `tsc --noEmit`,
`eslint` and a production build.

Built by two founders. This README flags which parts are whose where it matters.

---

## The parts worth reading

### Money, and what happens when it is retried

`src/app/api/billing/stripe-webhook/route.ts`

The interesting decision is that the handler **does not trust the event payload**. A
Stripe event tells it *which* subscription changed; the row is then written from state
fetched fresh from Stripe. That makes the endpoint order-independent, not merely
idempotent, replaying an event, or receiving them out of order, converges on the same
row either way.

It matters because the failure it prevents is permanent. A late
`customer.subscription.updated` arriving after `customer.subscription.deleted` would
otherwise flip a cancelled row back to active with no end date, and since the
subscription no longer exists at Stripe, no later event would ever correct it. Free
access forever, from one out-of-order delivery.

There is one deliberate exception, documented at the call site: when the Stripe API is
itself unreachable, the handler falls back to the event snapshot rather than returning
500. Retries are finite, and a dropped `subscription.deleted` (access kept) or
`subscription.created` (a paying customer locked out) is worse than the rare
out-of-order-*and*-API-down coincidence the guard would otherwise catch.

31 tests on this file alone, including the two that matter:
- *"a late stale `active` event cannot resurrect a deleted subscription"*
- *"the same subscription event delivered twice performs two IDENTICAL upserts... no duplicate rows, no drift"*

### The workflow engine

`src/lib/automations/`

Nodes execute in dependency order (topological sort with cycle detection). Each node
carries its own error policy, bounded retry, or continue-on-fail, and **retry is
refused for requests that may already have applied remotely**, because retrying a
non-idempotent HTTP write is how one scheduled run becomes two published posts.

Scheduling is five-field cron expressions, evaluated against wall-clock time in the
user's own timezone through the platform timezone database, so a daylight-saving
change does not shift a scheduled run.

*Primarily my co-founder's work; I contributed to the execution core.*

### Client-side media

`src/app/components/TikTokCanvas/`, `src/lib/`

Video export runs in the browser via WebCodecs with mediabunny for MP4 muxing, decoded frames flow through a bounded queue with backpressure, and a watchdog fails a
silently stalled decoder rather than hanging. Background removal runs on a lazily
fetched ONNX model on the **WASM** backend, deliberately: the WebGPU backend loads
cleanly and then fails at inference with no way back.

Perspective image distortion is done by rendering the image as a textured quad in
WebGL, because a 2D canvas transform is affine and can only ever turn a rectangle into
a parallelogram, never an arbitrary four-sided shape.

## Running it

```bash
npm install
cp .env.example .env.local     # fill in what you need
npm run dev
```

```bash
npm test            # vitest, 1,001 tests across 68 files
npx tsc --noEmit
npx eslint src
npm run build
```

CI runs all four on every push (`.github/workflows/`).

## Configuration

`.env.example` lists every variable with a comment on what it enables. Nothing is
required to boot; each missing key disables a specific feature.

Broadly: Supabase for auth, storage and the database; Stripe and Lemon Squeezy for
billing; an LLM provider key for the AI copilot; and per-platform credentials for
whichever social accounts you connect.

## Layout

```
src/app/api/            54 route handlers
src/app/components/     canvas, editor, automation UI
src/lib/automations/    the node-graph execution engine
src/lib/                billing, LLM providers, media, shared logic
supabase/               schema and migrations
QA_CHECKLIST.md         manual QA pass, enumerated
```

## Note

Built with a co-founder. The billing correctness work, the client-side media pipeline
and the canvas are mine; the automation engine is largely his.
