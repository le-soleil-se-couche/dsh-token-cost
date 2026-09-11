# dsh-token-cost

<p align="center">
  <strong>English</strong> · <a href="README.md">中文</a>
</p>

Token usage, cache hits and cost statistics for DeepSeek Harness (DSH) Web GUI — per conversation and in aggregate. Built-in DeepSeek official schemes (including the V4.1 Flash price cut and the V4 Pro rerouting, UTC+8 peak/off-peak), plus a form to price any other model you call.

2026-08-17 update: you can enter unit prices for other models you call. **Add model** writes a local price file immediately (survives refresh) and history recalculates.

2026-08-25 update: the accounting core now uses an attempt-aware fold covering retries after failed calls, `compaction/summary.usage`, and fork `seedLength` boundaries. Ledger schema v2 automatically refolds stale cached totals from the authoritative session logs.

2026-08-28 update: retry boundaries now follow the official `llm/retry-started` event, official session-id directory encoding is supported, and the comparison with `0.1.2-alpha.1` is current. Ledger schema v3 automatically refolds existing v2 caches.

2026-09-05 update: this release uses the official npm `0.1.2-rc.1` SDK and its native settings and plugin-card types. It also reads session format v2, with ledger schema v4; fixes ledger-directory creation on Windows paths; preserves an explicit `flat: false` custom price through the settings form and local file; and refreshes an existing stats-line cost marker when new cost data arrives. Host SDK compatibility and log protocol support are verified separately: passing v2 synthetic fixtures does not establish runtime acceptance on a `0.1.3-alpha.1` host.

2026-09-11 update: official price changes are in. Scheme C covers the V4.1 Flash cut effective 2026-09-10 12:00 Beijing (peak windows now workdays only), and scheme D bills `deepseek-v4-pro` at the Flash rate from 2026-09-14 12:00 Beijing. The retired `deepseek-v4-flash` / `deepseek-v4-flash-vision-exp` names bill at the Flash rate from scheme C, and vision-exp now has a rate in scheme B. History switches automatically by record time; no configuration change needed.

## What it gives you

- **Per-conversation view**: the session's total cost is embedded directly into the official stats line at the bottom of the conversation (right after `TTFT avg … · … tok/s`); clicking it opens the per-request detail modal (time / model / cache miss / cache hit / output / cost, newest first).

<p align="center">
  <img src="docs/screenshots/conversation-bottom.png" alt="Cost in the conversation stats line" width="90%">
</p>

<p align="center">
  <img src="docs/screenshots/cost-detail.png" alt="Cost detail modal" width="80%">
</p>

- **Overall summary** (Settings > Plugins > Plugin configuration > Token Cost): time-filtered totals with today / yesterday / last 7 days / last 30 days / this month / last month / custom (up to 30 days), grouped by model, session and day.
- **Pricing status**: peak windows shown and billed in UTC+8 (09:00–12:00, 14:00–18:00). Since 2026-09-10 the official peak window is workdays only (weekends are fully off-peak), which the UI labels as "Workdays only".
- **Custom model prices**: Settings discovers unpriced models from the ledger, or you can add a model that has not been called yet. Enter per-1M cache-miss / cache-hit / output rates; **Add model** writes the local price file immediately (survives refresh) and history recalculates. Cache-hit may be left blank (billed as 0). Third-party models stay flat (DeepSeek peak/off-peak does not apply).

## Data source

The plugin reads DSH's durable session generations. Current v2 is `$DSH_HOME/sessions/<project-key>/<encoded-session-id>/session.v2.jsonl` (or `.zstd`); v1 `session.v1.jsonl(.zstd)` and v0 `session.jsonl(.zstd)` remain supported. Migration can retain several immutable generations for one session, so the plugin selects the highest canonical numeric generation exactly once and never settles migrated copies twice. If that highest generation is newer than supported v2, it warns and skips the session instead of falling back to stale bytes.

For v0/v1, top-level `assistant/chunk` and `assistant/message` carry usage. For v2, `assistant/message.data.usage` wins, otherwise the last usage in `data.stream` is used; `assistant/attempt.data.stream` preserves failed or retried settlements. The v2 reader accepts the official packed text/reasoning/tool-call run grammar while usage remains a raw `chunk` record inside that stream. Values replace within one attempt; only `llm/retry-started` opens the next billing slot for the same turn/step. `compaction/summary.usage` remains an independent call. Fork exclusion uses v0/v1 `seedLength` or the last v2 `session/end-seed { inherited: true }` cut. The compact ledger (`$DSH_HOME/storages/dsh-token-cost/ledger.json`) only re-parses changed authoritative generations; ledger v4 invalidates older semantics. Custom prices live beside it in `custom-prices.json`, including an explicit `flat: false`. zstd decoding uses [fzstd](https://github.com/101arrowz/fzstd) (pure JS, zero deps).

Token fields follow the harness convention: `inputTokens` = cache-miss prompt tokens, `cacheReadTokens` = cache-hit prompt tokens (disjoint; together they are the billed input).

The upstream log remains the telemetry boundary: title generation, Web Search, interrupted calls, failed summaries, or other clients cannot be priced when they do not emit usage. The public synthetic fixture and its hand-computed expectations live in `tests/fixtures/usage-accounting/`.

### Supported SDK and log protocol boundary

The declared host and browser SDK version is official npm `0.1.2-rc.1`, with development dependencies pinned to that version. The settings namespace uses the native `register` / `watch` contract from `@deepseek-ai/dsh-settings`; browser scope and card-slot types come from `dsh-client-ui-settings/client` and `dsh-client-ui-settings-plugins/client`. Building requires no DSH source checkout, old `dsh-client-runtime` package, or fabricated local declarations.

The v2 reader follows the pinned DSH `0.1.3-alpha.1` source snapshot [`d347e70390`](https://github.com/deepseek-ai/deepseek-harness/commit/d347e703908d0406b7a7ef80e3a0e594d86b2215). Session format v2 persists each Assistant settlement as an `assistant/message` or `assistant/attempt` with an embedded stream, and its current generation is `session.v2.jsonl(.zstd)`; retained v0/v1 migration sources are not additional calls. Full installation and runtime acceptance on a `0.1.3-alpha.1` host remain incomplete; that host version is outside this package's declared peer range.

The plugin continues to settle official `compaction/summary.usage` independently and excludes inherited fork prefixes from cross-session totals. It is not a substitute for a provider bill and cannot recover usage upstream never logged. Fields such as `compaction/end` still are not priced without an official usage schema. Repository tests use synthetic fixtures only; no real session log is published.

## Installation

```sh
dsh plugin --profile web add github:le-soleil-se-couche/dsh-token-cost
```

Use the official `@deepseek-ai/dsh@0.1.2-rc.1` host. Installation and restart modify the selected profile. Restart its `dsh web`, then open Settings > Plugins > Plugin configuration > Token Cost. Existing session logs are backfilled on the first query. An isolated official host on macOS has verified the plugin settings entry, synthetic-log cost totals, custom-price persistence, and currency settings surviving a host restart; real model rounds and other platforms require separate verification.

## Built-in schemes

| Scheme | Effective (Beijing time) | Notes |
|---|---|---|
| A `flat-2026-08` | before 2026-08-17 00:00 | Flat: V4 Flash miss/hit/output = 1 / 0.02 / 2 CNY; V4 Pro = 3 / 0.025 / 6 CNY |
| B `peak-offpeak-2026-08-17` | from 2026-08-17 00:00 | Peak/off-peak every day: V4 Flash peak 3 / 0.1 / 9 CNY; V4 Pro peak 9 / 0.3 / 27 CNY |
| C `v4.1-flash-2026-09-10` | from 2026-09-10 12:00 | V4.1 Flash cut: peak 2 / 0.04 / 8 CNY; peak windows workdays only; retired `deepseek-v4-flash` names bill at the Flash rate |
| D `v4-pro-to-flash-2026-09-14` | from 2026-09-14 12:00 | `deepseek-v4-pro` is routed to V4.1 Flash and billed at the Flash rate (until V4.1 Pro ships) |

Rates are cache-miss / cache-hit / output CNY per 1M tokens at peak; off-peak bills half. From scheme C the peak window is Monday–Friday only (09:00–12:00, 14:00–18:00 UTC+8).

## Configuration

| Key | Type | Default | Meaning |
|---|---|---|---|
| `enabled` | boolean | `true` | Master switch (stats-line cost + summary card) |
| `currency` | `'cny'` \| `'usd'` | `'cny'` | Display currency |
| `priceMode` | `'auto'` \| `'scheme-a'` \| `'scheme-b'` \| `'scheme-c'` \| `'scheme-d'` | `'auto'` | Auto switches by record time, or force one scheme |
| `customPrices` | string (JSON) | `''` | Legacy settings field; the form now persists to `storages/dsh-token-cost/custom-prices.json` |

All editable from the card's Settings tab; a "Rescan session logs" action forces a full re-parse.

## Development

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
pnpm pack
```

The development baseline is Node.js `22.22.1` and pnpm `9.15.9`. Git installation runs `prepare` to build both JavaScript and declarations. The source checkout includes `src/`, `build/`, tests, and the lockfile; the install archive contains `lib/`, the bundle patch, and both READMEs. Entries are `lib/index.js` for the host and `lib/client.js` for the browser (`window.__ModuleLoader__.load` factory), with declarations at `lib/types/index.d.ts` and `lib/types/client/index.d.ts`. Use `npm pack --dry-run --ignore-scripts` to inspect the package file list after building.

After a local build, install with `dsh plugin --profile web add link:/absolute/path/to/dsh-token-cost`. Installation and restart modify that profile, so select your own development profile.

See DESIGN.md for the architecture.

---

*[中文版本](README.md)*
