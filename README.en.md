# dsh-token-cost

<p align="center">
  <strong>English</strong> · <a href="README.md">中文</a>
</p>

Token usage, cache hits and cost statistics for DeepSeek Harness (DSH) Web GUI — per conversation and in aggregate. Built-in DeepSeek dual schemes (UTC+8 peak/off-peak), plus a form to price any other model you call.

2026-08-17 update: you can enter unit prices for other models you call. **Add model** writes a local price file immediately (survives refresh) and history recalculates.

2026-08-25 update: the accounting core now uses an attempt-aware fold covering retries after failed calls, `compaction/summary.usage`, and fork `seedLength` boundaries. Ledger schema v2 automatically refolds stale cached totals from the authoritative session logs.

2026-08-28 update: retry boundaries now follow the official `llm/retry-started` event, official session-id directory encoding is supported, and the comparison with `0.1.2-alpha.1` is current. Ledger schema v3 automatically refolds existing v2 caches.

2026-09-05 source preview: this branch adds session format v2 reading and newer settings interfaces, with ledger schema v4. Full installation and runtime acceptance on the target `0.1.3-alpha.1` host remain incomplete, and some exact-version dependencies are unavailable. Tests against the older SDK do not establish target-host compatibility. Use `main` for normal installation; this branch is for compatibility review.

## What it gives you

- **Per-conversation view**: the session's total cost is embedded directly into the official stats line at the bottom of the conversation (right after `TTFT avg … · … tok/s`); clicking it opens the per-request detail modal (time / model / cache miss / cache hit / output / cost, newest first).

<p align="center">
  <img src="docs/screenshots/conversation-bottom.png" alt="Cost in the conversation stats line" width="90%">
</p>

<p align="center">
  <img src="docs/screenshots/cost-detail.png" alt="Cost detail modal" width="80%">
</p>

- **Overall summary** (Settings > Plugins > Plugin configuration > Token Cost): time-filtered totals with today / yesterday / last 7 days / last 30 days / this month / last month / custom (up to 30 days), grouped by model, session and day.
- **Pricing status**: peak windows shown and billed in UTC+8 (09:00–12:00, 14:00–18:00).
- **Custom model prices**: Settings discovers unpriced models from the ledger, or you can add a model that has not been called yet. Enter per-1M cache-miss / cache-hit / output rates; **Add model** writes the local price file immediately (survives refresh) and history recalculates. Cache-hit may be left blank (billed as 0). Third-party models stay flat (DeepSeek peak/off-peak does not apply).

## Data source

The plugin reads DSH's durable session generations. Current v2 is `$DSH_HOME/sessions/<project-key>/<encoded-session-id>/session.v2.jsonl` (or `.zstd`); v1 `session.v1.jsonl(.zstd)` and v0 `session.jsonl(.zstd)` remain supported. Migration can retain several immutable generations for one session, so the plugin selects the highest canonical numeric generation exactly once and never settles migrated copies twice. If that highest generation is newer than supported v2, it warns and skips the session instead of falling back to stale bytes.

For v0/v1, top-level `assistant/chunk` and `assistant/message` carry usage. For v2, `assistant/message.data.usage` wins, otherwise the last usage in `data.stream` is used; `assistant/attempt.data.stream` preserves failed or retried settlements. The v2 reader accepts the official packed text/reasoning/tool-call run grammar while usage remains a raw `chunk` record inside that stream. Values replace within one attempt; only `llm/retry-started` opens the next billing slot for the same turn/step. `compaction/summary.usage` remains an independent call. Fork exclusion uses v0/v1 `seedLength` or the last v2 `session/end-seed { inherited: true }` cut. The compact ledger (`$DSH_HOME/storages/dsh-token-cost/ledger.json`) only re-parses changed authoritative generations; ledger v4 invalidates older semantics. Custom prices live beside it in `custom-prices.json`, including an explicit `flat: false`. zstd decoding uses [fzstd](https://github.com/101arrowz/fzstd) (pure JS, zero deps).

Token fields follow the harness convention: `inputTokens` = cache-miss prompt tokens, `cacheReadTokens` = cache-hit prompt tokens (disjoint; together they are the billed input).

The upstream log remains the telemetry boundary: title generation, Web Search, interrupted calls, failed summaries, or other clients cannot be priced when they do not emit usage. The public synthetic fixture and its hand-computed expectations live in `tests/fixtures/usage-accounting/`.

### Compatibility boundary with DSH 0.1.3-alpha.1

This compatibility pass is based on the pinned DSH `0.1.3-alpha.1` source snapshot [`d347e70390`](https://github.com/deepseek-ai/deepseek-harness/commit/d347e703908d0406b7a7ef80e3a0e594d86b2215). Session format v2 persists each Assistant settlement as an `assistant/message` or `assistant/attempt` with an embedded stream, and its current generation is `session.v2.jsonl(.zstd)`; retained v0/v1 migration sources are not additional calls. The settings card registers in the same official `settings.plugin.item` keyed slot used by that release, under Plugins > Plugin configuration.

The plugin continues to settle official `compaction/summary.usage` independently and excludes inherited fork prefixes from cross-session totals. It is not a substitute for a provider bill and cannot recover usage upstream never logged. Fields such as `compaction/end` still are not priced without an official usage schema. Repository tests use synthetic fixtures only; no real session log is published.

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
