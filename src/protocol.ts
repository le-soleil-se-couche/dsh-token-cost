/**
 * Shared type boundary between the host half and the browser half of the
 * dsh-token-cost plugin. Everything here is plain data: the client bundle
 * inlines these types (no runtime identity), the host serves them over the
 * /api/dsh-token-cost route family.
 */

/** Route family root the browser half fetches. */
export const TOKEN_COST_API = '/api/dsh-token-cost'

/** One provider-reported usage sample folded to a billing record. */
export interface UsageRecord {
  /** Event wall time (epoch ms). */
  time: number
  turn: number
  step: number
  /** Owning session id (filled by the ledger). */
  sessionId: string
  /** Display label of the owning session (filled by the ledger). */
  sessionLabel: string
  /** Provider id from the request that reported this usage. */
  provider: string
  /** Model id from the request that reported this usage. */
  model: string
  /** Prompt tokens billed as cache miss (disjoint from cacheReadTokens). */
  inputTokens: number
  /** Prompt tokens served from cache (hit). */
  cacheReadTokens: number
  /** Prompt tokens written into cache (0 when the provider does not report them). */
  cacheWriteTokens: number
  /** Completion tokens. */
  outputTokens: number
  /** Reasoning portion of the completion tokens. */
  reasoningTokens: number
}

/** Durable session facts a ledger entry carries. */
export interface SessionMeta {
  sessionId: string
  cwd: string
  title: string
  createdAt: number
  /** Wall time of the newest event seen in the log. */
  lastActivity: number
}

/** Totals over one set of records, plus cost in both display currencies. */
export interface CostTotals {
  records: number
  inputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  outputTokens: number
  reasoningTokens: number
  /** Cache-hit share of billed prompt input, 0..1; 0 when no input was billed. */
  cacheHitRate: number
  costCny: number
  costUsd: number
}

/** One row of a grouped breakdown. */
export interface CostGroupRow {
  key: string
  label: string
  totals: CostTotals
  /** How many records in this group had a catalog/custom price. */
  priced: number
}

/** Per-request price entry, per display currency. */
export interface PriceSet {
  miss: number
  hit: number
  output: number
}

export interface ModelPrice {
  cny: PriceSet
  usd: PriceSet
  /** True when the model keeps a flat price even inside a peak/off-peak scheme. */
  flat?: boolean
}

/**
 * One peak hour window in the scheme's local clock (`peakOffsetMinutes`).
 * `start` inclusive, `end` exclusive, hour 0-24.
 */
export interface PeakWindow {
  start: number
  end: number
}

/** One pricing scheme (a "计价方案"). */
export interface PriceScheme {
  id: string
  label: string
  /** UTC instant the scheme starts billing; records before it use an older scheme. */
  effectiveFrom: number
  /**
   * Peak hour windows when present: model prices are PEAK prices and off-peak
   * billing charges half. Hours are in the clock of {@link peakOffsetMinutes}.
   * Absent on flat schemes.
   */
  peak?: PeakWindow[]
  /**
   * Minutes east of UTC for peak-hour evaluation. DeepSeek official billing
   * uses Beijing time, so scheme-b is 480 (UTC+8). Defaults to 480 when peak
   * windows are present.
   */
  peakOffsetMinutes?: number
  /**
   * Weekdays that bill at peak, 0 = Sunday .. 6 = Saturday, evaluated in the
   * `peakOffsetMinutes` clock. Absent or empty means every day. DeepSeek
   * restricted peak billing to workdays on 2026-09-10.
   */
  peakDays?: number[]
  /** Model id (normalized) -> prices. */
  models: Record<string, ModelPrice>
}

/** What the status endpoint reports about the pricing engine. */
export interface PricingStatus {
  schemes: PriceScheme[]
  /** Scheme id billing a request that starts right now under auto mode. */
  activeNow: string
  /** UTC instant of the next scheme switch, or 0 when none follows. */
  nextSwitchAt: number
  priceMode: string
  currency: string
}

/** Ledger facts the status endpoint reports. */
export interface LedgerStatus {
  sessionCount: number
  recordCount: number
  syncedAt: number
}

/** GET /api/dsh-token-cost/status */
export interface StatusResponse {
  ok: boolean
  ledger: LedgerStatus
  pricing: PricingStatus
  error?: string
}

/** One session row of the sessions listing. */
export interface SessionSummaryRow {
  sessionId: string
  cwd: string
  title: string
  createdAt: number
  lastActivity: number
  totals: CostTotals
}

/** GET /api/dsh-token-cost/sessions */
export interface SessionsResponse {
  ok: boolean
  sessions: SessionSummaryRow[]
  error?: string
}

/** GET /api/dsh-token-cost/summary */
export interface SummaryResponse {
  ok: boolean
  /** Requested window. */
  from: number
  to: number
  totals: CostTotals
  /** Records that matched a built-in or custom price. */
  priced: number
  /** Distinct model ids in the window that still have no price. */
  unpricedModels: string[]
  byModel: CostGroupRow[]
  bySession: CostGroupRow[]
  byDay: CostGroupRow[]
  error?: string
}

/** Where a model id's unit price comes from. */
export type ModelPriceSource = 'builtin' | 'custom' | 'unpriced'

/** One row of GET /api/dsh-token-cost/models. */
export interface ModelCatalogRow {
  /** Display model id (original casing from the newest usage, else the catalog key). */
  model: string
  provider: string
  records: number
  lastSeen: number
  source: ModelPriceSource
  price: ModelPrice | null
}

/** GET /api/dsh-token-cost/models */
export interface ModelsResponse {
  ok: boolean
  models: ModelCatalogRow[]
  error?: string
}

/** POST /api/dsh-token-cost/prices */
export interface SavePricesResponse {
  ok: boolean
  models: ModelCatalogRow[]
  error?: string
}

/** Per-record billing outcome, aligned by index with {@link SessionDetailResponse.records}. */
export interface RecordCost {
  costCny: number
  costUsd: number
  schemeId: string
  /** True on a peak rate; false on off-peak; null when the scheme/model is flat. */
  peak: boolean | null
}

/** GET /api/dsh-token-cost/session/:id */
export interface SessionDetailResponse {
  ok: boolean
  meta: SessionMeta
  totals: CostTotals
  /** Records in this session that matched a price. */
  priced: number
  records: UsageRecord[]
  /** Billing outcome per record, aligned by index. */
  costs: RecordCost[]
  error?: string
}

/** POST /api/dsh-token-cost/resync */
export interface ResyncResponse {
  ok: boolean
  ledger: LedgerStatus
  error?: string
}