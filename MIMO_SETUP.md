# MiMo V2.5 setup — ready for your key

Everything to A/B **Xiaomi MiMo V2.5** against Gemini is wired up. Nothing is committed, and nothing uses
MiMo until you add a key — so this is safe to sit until morning.

## 1. Add your key (`.env.local`)

Pick a backend and add its key:

```bash
# OpenRouter (easiest — one key, hosts MiMo)
MIMO_API_KEY=sk-or-...
# MIMO_BASE_URL defaults to https://openrouter.ai/api/v1 — leave it unset for OpenRouter.

# …or Xiaomi's own platform (mimo.mi.com): set BOTH
# MIMO_API_KEY=<your mimo.mi.com key>
# MIMO_BASE_URL=https://<mimo.mi.com OpenAI-compatible base>/v1
```

Available model ids (allow-listed): `xiaomi/mimo-v2.5`, `xiaomi/mimo-v2.5-pro`.
*(On mimo.mi.com the model ids may differ from OpenRouter's `xiaomi/...` strings — if a call 404s on the
model, that's why; tell me the platform's id and I'll add it to the registry.)*

**If MiMo 400s on `response_format`** (some models reject OpenAI's JSON mode): add `MIMO_JSON_MODE=off` to
`.env.local`. The prompt already demands JSON, so this only drops the belt-and-suspenders enforcement.

## 2. Run the head-to-head benchmark

```bash
npx tsx scripts/model-ab.mts                                 # gemini-2.5-flash vs xiaomi/mimo-v2.5
RUNS=5 npx tsx scripts/model-ab.mts                          # more iterations for a tighter number
npx tsx scripts/model-ab.mts gemini-2.5-flash xiaomi/mimo-v2.5-pro
```

It drives the **real** copilot funnel across simple / multi-action / image prompts and reports the three
things that actually decide the model:

- **UNREADABLE %** — stream produced JSON that won't parse (the "unreadable response" bug; want 0)
- **APPLIED %** — at least one action validated against the real schema (the edit lands)
- **median latency**

Gemini already benches at **0% unreadable / 100% applied / ~6.7s** (verified tonight). If MiMo matches on
reliability, the benchmark lead + price + instruction-following all point to switching.

## 3. Inspect a single MiMo response (raw output + where parsing breaks)

```bash
npx tsx scripts/copilot-cli.mts --model xiaomi/mimo-v2.5 "make the headline bigger"
npx tsx scripts/copilot-cli.mts --model xiaomi/mimo-v2.5 --image src/assets/opt/ex1.jpg "recreate this style"
```

## 4. If MiMo wins — how to actually switch

No code change needed; it's all model-string config:

- **Batch/buffered callers** → set `GEMINI_MODEL=xiaomi/mimo-v2.5` in `.env.local`.
- **Interactive copilots** (editor + reels) → set `COPILOT_MODEL=xiaomi/mimo-v2.5`.
- **Automations** (when built) → the funnel already routes per-call `model`, so each node can pick its own
  (e.g. `xiaomi/mimo-v2.5-pro` for the reasoning-heavy / tool-use nodes, cheaper tiers for simple ones).

## What changed (all uncommitted)

- `src/lib/llm/providers.ts` — **new** provider abstraction: `geminiProvider` + `openaiProvider` (MiMo) +
  a model→provider registry. A provider only builds requests and parses responses.
- `src/lib/gemini.ts` — the funnel now routes by model through a provider, keeping the **shared** budget
  gate, retry, stream abort + idle-timeout, and **metering** identical for every provider. (Public names
  `geminiChat` / `openGeminiStream` unchanged, so no caller had to change.)
- `src/lib/aiBudget.ts` — MiMo pricing rows so spend is metered at MiMo's real rate.
- `.env.example` — documents `MIMO_API_KEY` / `MIMO_BASE_URL`.
- `scripts/model-ab.mts` — the benchmark above. `scripts/copilot-cli.mts` — already MiMo-aware via `--model`.
- Tests: `src/lib/llm/providers.test.ts` (21) + `src/lib/llm/mimoStream.test.ts` (3, incl. a **metering**
  proof that no MiMo call spends unmetered).

## Verified tonight

- Full suite **402 pass**, tsc clean on the changed files.
- Refactored **Gemini path re-verified live** (3/3 applied, 0 unreadable) — the abstraction didn't regress it.
- MiMo path proven end-to-end **offline** (routing + OpenAI SSE parse + metering + budget gate) — the only
  thing that needs your key is the *live* MiMo quality/reliability numbers.
- **Adversarial review (5 lenses → verify): 8 raised, 7 confirmed, all addressed.** The one that mattered:
  a **buffered MiMo call could bill zero** if the gateway returned a 200 with no `usage` (Gemini always
  returns it, so it never bit the old code). Fixed — the buffered path now falls back to a usage estimate
  exactly like the streaming path, and a mutation-proven test locks it. The rest were missing test coverage
  (buffered metering, the estimate fallback, split-across-reads SSE frames, MiMo-Pro pricing) — all added.
  A reasoning-model under-billing edge (only if you point MIMO_BASE_URL at a gateway that ignores
  `include_usage`) is documented in the code; OpenRouter (the default) is unaffected.

## Reminder

You still need to **rotate the Gemini API key** you pasted in chat earlier.
