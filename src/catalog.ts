/**
 * Model catalog for the custom-price UI: union of built-in DeepSeek
 * prices, user overrides, and models actually seen in the usage ledger.
 */

import { builtinModelIds, normalizeModel } from './pricing.ts'
import type { ModelCatalogRow, ModelPrice, PriceScheme, UsageRecord } from './protocol.ts'

/** Aggregated usage for one model id. */
export interface ModelUsageStat {
  model: string
  provider: string
  records: number
  lastSeen: number
}

/** Fold usage records by normalized model id. */
export function collectModelUsage(records: UsageRecord[]): ModelUsageStat[] {
  const map = new Map<string, ModelUsageStat>()
  for (const record of records) {
    const key = normalizeModel(record.model)
    if (key === '') continue
    const current = map.get(key)
    if (current === undefined) {
      map.set(key, {
        model: record.model,
        provider: record.provider,
        records: 1,
        lastSeen: record.time,
      })
      continue
    }
    current.records += 1
    if (record.time >= current.lastSeen) {
      current.lastSeen = record.time
      current.model = record.model
      if (record.provider !== '') current.provider = record.provider
    } else if (current.provider === '' && record.provider !== '') {
      current.provider = record.provider
    }
  }
  return [...map.values()]
}

/** Rank: unpriced first (action needed), then custom, then built-in. */
function sourceRank(source: ModelCatalogRow['source']): number {
  if (source === 'unpriced') return 0
  if (source === 'custom') return 1
  return 2
}

/**
 * Build the settings catalog. Built-in ids always appear; custom overrides
 * win; ledger models with neither source are `unpriced`.
 */
export function buildModelCatalog(
  usage: ModelUsageStat[],
  custom: Record<string, ModelPrice>,
  schemes: PriceScheme[],
): ModelCatalogRow[] {
  const builtin = builtinModelIds(schemes)
  const latest = schemes[schemes.length - 1]
  const rows = new Map<string, ModelCatalogRow>()

  for (const id of builtin) {
    rows.set(id, {
      model: id,
      provider: '',
      records: 0,
      lastSeen: 0,
      source: 'builtin',
      price: latest?.models[id] ?? null,
    })
  }

  for (const [id, price] of Object.entries(custom)) {
    const current = rows.get(id)
    if (current !== undefined) {
      current.source = 'custom'
      current.price = price
    } else {
      rows.set(id, {
        model: id,
        provider: '',
        records: 0,
        lastSeen: 0,
        source: 'custom',
        price,
      })
    }
  }

  for (const stat of usage) {
    const id = normalizeModel(stat.model)
    const current = rows.get(id)
    if (current !== undefined) {
      current.model = stat.model
      if (stat.provider !== '') current.provider = stat.provider
      current.records = stat.records
      current.lastSeen = stat.lastSeen
    } else {
      rows.set(id, {
        model: stat.model,
        provider: stat.provider,
        records: stat.records,
        lastSeen: stat.lastSeen,
        source: 'unpriced',
        price: null,
      })
    }
  }

  return [...rows.values()].sort((left, right) => {
    const bySource = sourceRank(left.source) - sourceRank(right.source)
    if (bySource !== 0) return bySource
    if (right.records !== left.records) return right.records - left.records
    return left.model.localeCompare(right.model)
  })
}
