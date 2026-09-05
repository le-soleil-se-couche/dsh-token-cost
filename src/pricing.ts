/**
 * Price engine for dsh-token-cost: the built-in DeepSeek official price
 * catalog as an ordered list of pricing schemes, each with an effective-from
 * instant. Billing picks, per record, the newest scheme whose effectiveFrom
 * is not after the record's time — so when DeepSeek changes prices again,
 * shipping one more scheme entry is the whole adaptation, no code changes.
 *
 * Catalog source: https://api-docs.deepseek.com/quick_start/pricing
 * (fetched 2026-08-14; the CNY table and the USD table agree).
 *
 * Scheme A (flat, until 2026-08-16T16:00Z):
 *   deepseek-v4-flash  cny miss 1 / hit 0.02 / out 2     usd 0.14 / 0.0028 / 0.28
 *   deepseek-v4-pro    cny miss 3 / hit 0.025 / out 6     usd 0.435 / 0.003625 / 0.87
 *   deepseek-chat      cny miss 2 / hit 0.5 / out 8       usd 0.27 / 0.07 / 1.10   (legacy flat)
 *   deepseek-reasoner  cny miss 4 / hit 1 / out 16        usd 0.55 / 0.14 / 2.19   (legacy flat)
 *
 * Scheme B (peak/off-peak, from 2026-08-16T16:00Z = 2026-08-17 00:00 Beijing):
 *   peak hours Beijing 09:00-12:00 and 14:00-18:00 (UTC+8); off-peak bills half.
 *   deepseek-v4-flash  peak cny miss 3 / hit 0.10 / out 9     usd 0.44 / 0.014 / 1.32
 *   deepseek-v4-pro    peak cny miss 9 / hit 0.30 / out 27    usd 1.32 / 0.044 / 3.96
 *   legacy models keep their flat prices (not covered by the announcement).
 *
 * Prices are per 1M tokens; cost = tokens / 1e6 * price.
 */

import type { ModelPrice, PriceScheme, PriceSet, UsageRecord } from './protocol.ts'

/** UTC instant the peak/off-peak scheme starts billing. */
export const SCHEME_B_EFFECTIVE_FROM = Date.UTC(2026, 7, 16, 16, 0, 0)

/** Official DeepSeek peak clock: Beijing / UTC+8. */
export const PEAK_TZ_OFFSET_MINUTES = 8 * 60

/**
 * Reference FX used only to fill the other display currency when the user
 * types a single-currency custom price. Not a live market quote.
 */
export const FX_CNY_PER_USD = 7.25

/** Normalize a model id for catalog lookup (case-insensitive, trimmed). */
export function normalizeModel(model: string): string {
  return model.trim().toLowerCase()
}

/** Built-in catalog keys (scheme-a and scheme-b share the same model set). */
export function builtinModelIds(schemes: PriceScheme[] = PRICE_SCHEMES): Set<string> {
  const ids = new Set<string>()
  for (const scheme of schemes) {
    for (const id of Object.keys(scheme.models)) ids.add(id)
  }
  return ids
}

/** Convert a per-1M price set across the plugin's two display currencies. */
export function convertPriceSet(set: PriceSet, from: 'cny' | 'usd'): PriceSet {
  const factor = from === 'cny' ? 1 / FX_CNY_PER_USD : FX_CNY_PER_USD
  return {
    miss: set.miss * factor,
    hit: set.hit * factor,
    output: set.output * factor,
  }
}

/** The built-in catalog: newest last. */
export const PRICE_SCHEMES: PriceScheme[] = [
  {
    id: 'scheme-a',
    label: 'flat-2026-08',
    effectiveFrom: 0,
    models: {
      'deepseek-v4-flash': {
        cny: { miss: 1, hit: 0.02, output: 2 },
        usd: { miss: 0.14, hit: 0.0028, output: 0.28 },
      },
      'deepseek-v4-pro': {
        cny: { miss: 3, hit: 0.025, output: 6 },
        usd: { miss: 0.435, hit: 0.003625, output: 0.87 },
      },
      'deepseek-chat': {
        cny: { miss: 2, hit: 0.5, output: 8 },
        usd: { miss: 0.27, hit: 0.07, output: 1.1 },
        flat: true,
      },
      'deepseek-reasoner': {
        cny: { miss: 4, hit: 1, output: 16 },
        usd: { miss: 0.55, hit: 0.14, output: 2.19 },
        flat: true,
      },
    },
  },
  {
    id: 'scheme-b',
    label: 'peak-offpeak-2026-08-17',
    effectiveFrom: SCHEME_B_EFFECTIVE_FROM,
    peakOffsetMinutes: PEAK_TZ_OFFSET_MINUTES,
    peak: [
      { start: 9, end: 12 },
      { start: 14, end: 18 },
    ],
    models: {
      'deepseek-v4-flash': {
        cny: { miss: 3, hit: 0.1, output: 9 },
        usd: { miss: 0.44, hit: 0.014, output: 1.32 },
      },
      'deepseek-v4-pro': {
        cny: { miss: 9, hit: 0.3, output: 27 },
        usd: { miss: 1.32, hit: 0.044, output: 3.96 },
      },
      'deepseek-chat': {
        cny: { miss: 2, hit: 0.5, output: 8 },
        usd: { miss: 0.27, hit: 0.07, output: 1.1 },
        flat: true,
      },
      'deepseek-reasoner': {
        cny: { miss: 4, hit: 1, output: 16 },
        usd: { miss: 0.55, hit: 0.14, output: 2.19 },
        flat: true,
      },
    },
  },
]

/** Apply user custom-price overrides onto a catalog copy. */
export function withCustomPrices(
  schemes: PriceScheme[],
  custom: Record<string, ModelPrice> | undefined,
): PriceScheme[] {
  if (custom === undefined || Object.keys(custom).length === 0) return schemes
  return schemes.map((scheme) => {
    const models = { ...scheme.models }
    for (const [raw, price] of Object.entries(custom)) {
      models[normalizeModel(raw)] = price
    }
    return { ...scheme, models }
  })
}

/** Read a {miss,hit,output} object; undefined when missing or malformed. */
export function readPriceSet(value: unknown): PriceSet | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const entry = value as { miss?: unknown; hit?: unknown; output?: unknown }
  if (typeof entry.miss !== 'number' || typeof entry.hit !== 'number' || typeof entry.output !== 'number') {
    return undefined
  }
  if (!Number.isFinite(entry.miss) || !Number.isFinite(entry.hit) || !Number.isFinite(entry.output)) {
    return undefined
  }
  if (entry.miss < 0 || entry.hit < 0 || entry.output < 0) return undefined
  return { miss: entry.miss, hit: entry.hit, output: entry.output }
}

/**
 * Third-party custom models default to flat billing so DeepSeek peak/off-peak
 * windows do not silently halve their rates. Built-in DeepSeek overrides keep
 * peak behaviour unless the user sets `flat: true`.
 */
export function defaultCustomFlat(model: string, schemes: PriceScheme[] = PRICE_SCHEMES): boolean {
  return !builtinModelIds(schemes).has(normalizeModel(model))
}

/** Build a dual-currency ModelPrice from one currency's unit rates. */
export function modelPriceFromRates(
  model: string,
  rates: PriceSet,
  currency: 'cny' | 'usd',
  flat?: boolean,
): ModelPrice {
  const cny = currency === 'cny' ? rates : convertPriceSet(rates, 'usd')
  const usd = currency === 'usd' ? rates : convertPriceSet(rates, 'cny')
  const resolvedFlat = flat ?? defaultCustomFlat(model)
  return {
    cny,
    usd,
    // An explicit false is semantic: it opts a custom price into a scheme's
    // peak/off-peak multiplier and must survive JSON persistence.
    ...(flat !== undefined || resolvedFlat ? { flat: resolvedFlat } : {}),
  }
}

/** Parse a custom-prices JSON text; throws on invalid input. */
export function parseCustomPrices(text: string): Record<string, ModelPrice> {
  const trimmed = text.trim()
  if (trimmed === '') return {}
  const parsed: unknown = JSON.parse(trimmed)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('custom prices must be a JSON object keyed by model id')
  }
  const out: Record<string, ModelPrice> = {}
  for (const [raw, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error(`custom price for "${raw}" needs cny or usd { miss, hit, output } numbers`)
    }
    const entry = value as Partial<ModelPrice> & { flat?: unknown }
    const cny = readPriceSet(entry.cny)
    const usd = readPriceSet(entry.usd)
    if (cny === undefined && usd === undefined) {
      throw new Error(`custom price for "${raw}" needs cny or usd { miss, hit, output } numbers`)
    }
    const id = normalizeModel(raw)
    if (id === '') throw new Error('custom price model id must be non-empty')
    const hasFlat = Object.hasOwn(entry, 'flat')
    if (hasFlat && typeof entry.flat !== 'boolean') {
      throw new Error(`custom price for "${raw}" flat must be boolean when present`)
    }
    const resolvedFlat = hasFlat ? entry.flat as boolean : defaultCustomFlat(id)
    out[id] = {
      cny: cny ?? convertPriceSet(usd as PriceSet, 'usd'),
      usd: usd ?? convertPriceSet(cny as PriceSet, 'cny'),
      ...(hasFlat || resolvedFlat ? { flat: resolvedFlat } : {}),
    }
  }
  return out
}

/** Stable pretty-JSON for the settings field; empty catalog becomes ''. */
export function serializeCustomPrices(custom: Record<string, ModelPrice>): string {
  const keys = Object.keys(custom).sort()
  if (keys.length === 0) return ''
  const ordered: Record<string, ModelPrice> = {}
  for (const key of keys) {
    const price = custom[key]
    if (price !== undefined) ordered[key] = price
  }
  return JSON.stringify(ordered, null, 2)
}

/**
 * Pick the scheme a record bills under. Auto mode takes the newest scheme
 * whose effectiveFrom is not after the record time; a forced id applies that
 * scheme to every record (for comparison or pre-adaptation).
 */
export function resolveScheme(
  schemes: PriceScheme[],
  time: number,
  forcedId?: string,
): PriceScheme {
  if (forcedId !== undefined && forcedId !== 'auto') {
    const forced = schemes.find((scheme) => scheme.id === forcedId)
    if (forced !== undefined) return forced
  }
  let chosen = schemes[0]
  for (const scheme of schemes) {
    if (scheme.effectiveFrom <= time) chosen = scheme
    else break
  }
  return chosen
}

/** Clock hour 0-23 of an instant in a fixed UTC offset (minutes east of UTC). */
export function hourInOffset(time: number, offsetMinutes: number): number {
  return Math.floor((((time + offsetMinutes * 60_000) % 86_400_000) + 86_400_000) % 86_400_000 / 3_600_000)
}

/**
 * Whether an instant falls inside a scheme's peak window.
 * Hours are evaluated in the scheme's official clock (DeepSeek: UTC+8).
 */
export function isPeakHour(scheme: PriceScheme, time: number): boolean {
  if (scheme.peak === undefined || scheme.peak.length === 0) return false
  const offset = scheme.peakOffsetMinutes ?? PEAK_TZ_OFFSET_MINUTES
  const hour = hourInOffset(time, offset)
  for (const window of scheme.peak) {
    if (window.start <= hour && hour < window.end) return true
  }
  return false
}

/** Human label for peak windows, e.g. `09:00-12:00、14:00-18:00`. */
export function formatPeakWindows(scheme: PriceScheme): string {
  if (scheme.peak === undefined || scheme.peak.length === 0) return ''
  const pad = (n: number): string => String(n).padStart(2, '0')
  return scheme.peak.map((window) => `${pad(window.start)}:00-${pad(window.end)}:00`).join('、')
}

/** What one record cost, in both currencies, under the resolved scheme. */
export interface RecordCost {
  costCny: number
  costUsd: number
  schemeId: string
  /** True while the record billed at a peak rate; false on off-peak; null when flat. */
  peak: boolean | null
}

/** Price a usage record; null when no catalog entry covers its model. */
export function priceRecord(
  record: UsageRecord,
  schemes: PriceScheme[],
  forcedId?: string,
): RecordCost | null {
  const scheme = resolveScheme(schemes, record.time, forcedId)
  const entry = scheme.models[normalizeModel(record.model)]
  if (entry === undefined) return null
  const peak = scheme.peak !== undefined && !entry.flat && isPeakHour(scheme, record.time)
  const factor = peak ? 1 : 0.5
  // When the scheme is flat or the model is flat, factor must be 1.
  const multiplier = (scheme.peak !== undefined && !entry.flat) ? factor : 1
  const scale = (n: number): number => n / 1_000_000 * multiplier
  return {
    costCny: scale(record.inputTokens * entry.cny.miss + record.cacheReadTokens * entry.cny.hit + record.outputTokens * entry.cny.output),
    costUsd: scale(record.inputTokens * entry.usd.miss + record.cacheReadTokens * entry.usd.hit + record.outputTokens * entry.usd.output),
    schemeId: scheme.id,
    peak: scheme.peak !== undefined && !entry.flat ? peak : null,
  }
}

/** Build totals over records, pricing each with the active catalog. */
export function totalsFor(
  records: UsageRecord[],
  schemes: PriceScheme[],
  forcedId?: string,
): { totals: import('./protocol.ts').CostTotals; priced: number; unpricedModels: string[] } {
  let recordsCount = 0
  let inputTokens = 0
  let cacheReadTokens = 0
  let cacheWriteTokens = 0
  let outputTokens = 0
  let reasoningTokens = 0
  let costCny = 0
  let costUsd = 0
  let priced = 0
  const unpriced = new Map<string, string>()
  for (const record of records) {
    recordsCount += 1
    inputTokens += record.inputTokens
    cacheReadTokens += record.cacheReadTokens
    cacheWriteTokens += record.cacheWriteTokens
    outputTokens += record.outputTokens
    reasoningTokens += record.reasoningTokens
    const cost = priceRecord(record, schemes, forcedId)
    if (cost !== null) {
      priced += 1
      costCny += cost.costCny
      costUsd += cost.costUsd
    } else if (record.model.trim() !== '') {
      const key = normalizeModel(record.model)
      if (!unpriced.has(key)) unpriced.set(key, record.model)
    }
  }
  const billedInput = inputTokens + cacheReadTokens
  return {
    totals: {
      records: recordsCount,
      inputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      outputTokens,
      reasoningTokens,
      cacheHitRate: billedInput > 0 ? cacheReadTokens / billedInput : 0,
      costCny,
      costUsd,
    },
    priced,
    unpricedModels: [...unpriced.values()],
  }
}
