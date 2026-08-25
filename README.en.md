# dsh-token-cost

<p align="center">
  <strong>English</strong> · <a href="README.md">中文</a>
</p>

Token usage, cache hits and cost statistics for DeepSeek Harness (DSH) Web GUI — per conversation and in aggregate. Built-in DeepSeek dual schemes (UTC+8 peak/off-peak), plus a form to price any other model you call.

2026-08-17 update: you can enter unit prices for other models you call. **Add model** writes a local price file immediately (survives refresh) and history recalculates.

2026-08-25 update: the accounting core now uses an attempt-aware fold covering retries after failed calls, `compaction/summary.usage`, and fork `seedLength` boundaries. Ledger schema v2 automatically refolds stale cached totals from the authoritative session logs.

## What it gives you

- **Per-conversation view**: the session's total cost is embedded directly into the official stats line at the bottom of the conversation (right after `TTFT avg … · … tok/s`); clicking it opens the per-request detail modal (time / model / cache miss / cache hit / output / cost, newest first).

<p align="center">
  <img src="docs/screenshots/conversation-bottom.png" alt="Cost in the conversation stats line" width="90%">
</p>

<p align="center">
  <img src="docs/screenshots/cost-detail.png" alt="Cost detail modal" width="80%">
</p>

- **Overall summary** (Settings > Plugin configuration > Web UI plugins > Token Cost): time-filtered totals with today / yesterday / last 7 days / last 30 days / this month / last month / custom (up to 30 days), grouped by model, session and day.
- **Pricing status**: peak windows shown and billed in UTC+8 (09:00–12:00, 14:00–18:00).
- **Custom model prices**: Settings discovers unpriced models from the ledger, or you can add a model that has not been called yet. Enter per-1M cache-miss / cache-hit / output rates; **Add model** writes the local price file immediately (survives refresh) and history recalculates. Cache-hit may be left blank (billed as 0). Third-party models stay flat (DeepSeek peak/off-peak does not apply).

## Data source

The plugin reads DSH's durable session logs (`$DSH_HOME/sessions/<cwd>/<session-id>/session.jsonl.zstd`) and folds provider-reported usage into per-attempt billing records: the final message replaces the chunk sample within one attempt; a failed finish closes that attempt so a retry under the same turn/step is added separately; `compaction/summary.usage` is an independent call; and a forked child excludes inherited events whose `seq < seedLength`. A compact ledger (`$DSH_HOME/storages/dsh-token-cost/ledger.json`) caches parsed records; only changed logs are re-parsed, and an accounting-semantics upgrade invalidates stale ledger versions for an authoritative refold. Custom unit prices live beside it in `custom-prices.json`. zstd decoding uses [fzstd](https://github.com/101arrowz/fzstd) (pure JS, zero deps).

Token fields follow the harness convention: `inputTokens` = cache-miss prompt tokens, `cacheReadTokens` = cache-hit prompt tokens (disjoint; together they are the billed input).

The upstream log remains the telemetry boundary: title generation, Web Search, interrupted calls, or other clients cannot be priced when they do not emit usage. The public synthetic fixture and its hand-computed expectations live in `tests/fixtures/usage-accounting/`.

### Accounting improvements versus official master

As of 2026-08-25, DSH official master `b150a551b8` still exposes `tokenUsage` with `stateVersion: 1`. It de-duplicates chunk/message samples within one attempt, but does not yet fold `compaction/summary.usage`; a retry under the same `(turn, step)` still replaces a failed attempt's usage; and cross-session consumers must separately exclude the inherited prefix where `seq < seedLength`.

This plugin covers those boundaries and uses ledger v2 to invalidate totals produced under the older semantics. In the narrowly defined scope of settling usage already present in DSH session logs, the plugin is currently ahead of official master. That does not make it a substitute for the official bill or recover usage that upstream never logged. All four buckets pass an independent synthetic conformance checker; see [deepseek-harness Discussion #1886](https://github.com/deepseek-ai/deepseek-harness/discussions/1886#discussioncomment-18141954).

## Installation

```sh
dsh plugin --profile web add github:le-soleil-se-couche/dsh-token-cost
```

Restart `dsh web`, open the settings page and expand "Web UI plugins". The plugin reads usage starting from the first query — existing session logs are backfilled automatically.

## Configuration

| Key | Type | Default | Meaning |
|---|---|---|---|
| `enabled` | boolean | `true` | Master switch (stats-line cost + summary card) |
| `currency` | 'cny' | 'usd' | `'cny'` | Display currency |
| `priceMode` | 'auto' | 'scheme-a' | 'scheme-b' | `'auto'` | Auto switches by record time |
| `customPrices` | string (JSON) | `''` | Legacy settings field; the form now persists to `storages/dsh-token-cost/custom-prices.json` |

All editable from the card's Settings tab; a "Rescan session logs" action forces a full re-parse.

## Development

```sh
pnpm install && pnpm -r build
pnpm --filter @deepseek-ai/dsh-token-cost test
pnpm --filter @deepseek-ai/dsh-token-cost typecheck
```

See DESIGN.md for the architecture.

---

*[中文版本](README.md)*
