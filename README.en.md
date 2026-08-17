# dsh-token-cost

<p align="center">
  <strong>English</strong> · <a href="README.md">中文</a>
</p>

Token usage, cache hits and cost statistics for DeepSeek Harness (DSH) Web GUI — per conversation and in aggregate. Built-in DeepSeek dual schemes (UTC+8 peak/off-peak), plus a form to price any other model you call.

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

The plugin reads DSH's durable session logs (`$DSH_HOME/sessions/<cwd>/<session-id>/session.jsonl.zstd`) and folds the provider-reported usage events into per-request billing records (last-wins per turn/step, mirroring the harness token-meter projection). A compact ledger (`$DSH_HOME/storages/dsh-token-cost/ledger.json`) caches parsed records; only changed logs are re-parsed. Custom unit prices live beside it in `custom-prices.json`. zstd decoding uses [fzstd](https://github.com/101arrowz/fzstd) (pure JS, zero deps).

Token fields follow the harness convention: `inputTokens` = cache-miss prompt tokens, `cacheReadTokens` = cache-hit prompt tokens (disjoint; together they are the billed input).

## Pricing engine (dual schemes, auto switch)

Built-in catalog from the official pricing page (api-docs.deepseek.com/quick_start/pricing, fetched 2026-08-14):

- **Scheme A** (flat, until 2026-08-16T16:00Z): deepseek-v4-flash / v4-pro flat prices in CNY and USD; legacy deepseek-chat / deepseek-reasoner at their flat rates.
- **Scheme B** (peak/off-peak, from 2026-08-16T16:00Z = 2026-08-17 00:00 Beijing time): peak hours 09:00–12:00 and 14:00–18:00 in UTC+8, off-peak at half price. Covers deepseek-v4-flash / v4-pro; legacy models stay flat. Peak detection uses the UTC+8 clock, not UTC.

Billing picks, per record, the newest scheme whose `effectiveFrom` is not after the record time. **When DeepSeek changes prices again, adding one scheme entry is the whole adaptation — no plugin update needed.** You can also force a scheme (`priceMode`), switch the display currency (CNY/USD), and add custom model rates in Settings.

Usage and prices stay separate: the ledger stores model / tokens / time only; cost is computed at query time from the built-in catalog plus `custom-prices.json`. You can call a model first and fill the price later, or pre-register a model you have not used yet. Writing a price recalculates history immediately. If you enter only the display currency, the other side is filled at `1 USD = 7.25 CNY`.

Cost = miss/1e6 × miss price + hit/1e6 × hit price + output/1e6 × output price (per-1M-token rates).

> Note: figures are an estimate from provider-reported usage; always reconcile against the official billing page. Day bucketing follows your browser timezone, so a conversation crossing midnight splits on your local days. Requests made with the same API key OUTSIDE DSH (other tools/processes) never enter DSH session logs and are not counted.

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