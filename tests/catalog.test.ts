/**
 * Model catalog: built-in + custom overrides + ledger-discovered unpriced ids.
 */

import { describe, expect, it } from 'vitest'
import { buildModelCatalog, collectModelUsage } from '../src/catalog.ts'
import { PRICE_SCHEMES } from '../src/pricing.ts'
import type { UsageRecord } from '../src/protocol.ts'

function record(partial: Partial<UsageRecord>): UsageRecord {
  return {
    time: 1_700_000_000_000,
    turn: 1,
    step: 1,
    provider: 'openai-compat',
    model: 'gpt-4o',
    inputTokens: 100,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 20,
    reasoningTokens: 0,
    sessionId: 's1',
    sessionLabel: 'S1',
    ...partial,
  }
}

describe('collectModelUsage', () => {
  it('folds by normalized model id and keeps the newest display name', () => {
    const usage = collectModelUsage([
      record({ model: 'GPT-4o', time: 1, provider: 'a' }),
      record({ model: 'gpt-4o', time: 2, provider: 'b' }),
      record({ model: 'kimi-k2', time: 3, provider: 'moonshot' }),
    ])
    const gpt = usage.find((row) => row.model.toLowerCase() === 'gpt-4o')
    const kimi = usage.find((row) => row.model === 'kimi-k2')
    expect(gpt?.records).toBe(2)
    expect(gpt?.model).toBe('gpt-4o')
    expect(gpt?.provider).toBe('b')
    expect(kimi?.provider).toBe('moonshot')
  })
})

describe('buildModelCatalog', () => {
  it('marks ledger-only models as unpriced and lists them first', () => {
    const rows = buildModelCatalog(
      collectModelUsage([record({ model: 'gpt-4o' })]),
      {},
      PRICE_SCHEMES,
    )
    expect(rows[0]?.source).toBe('unpriced')
    expect(rows[0]?.model).toBe('gpt-4o')
    expect(rows.some((row) => row.model === 'deepseek-v4-flash' && row.source === 'builtin')).toBe(true)
  })

  it('promotes an unpriced model to custom once a price exists', () => {
    const rows = buildModelCatalog(
      collectModelUsage([record({ model: 'gpt-4o' })]),
      {
        'gpt-4o': {
          cny: { miss: 18, hit: 0, output: 72 },
          usd: { miss: 2.5, hit: 0, output: 10 },
          flat: true,
        },
      },
      PRICE_SCHEMES,
    )
    const gpt = rows.find((row) => row.model === 'gpt-4o')
    expect(gpt?.source).toBe('custom')
    expect(gpt?.records).toBe(1)
    expect(gpt?.price?.usd.output).toBe(10)
  })

  it('keeps custom models that have not been called yet', () => {
    const rows = buildModelCatalog(
      [],
      {
        'future-model': {
          cny: { miss: 1, hit: 0, output: 2 },
          usd: { miss: 0.14, hit: 0, output: 0.28 },
          flat: true,
        },
      },
      PRICE_SCHEMES,
    )
    const future = rows.find((row) => row.model === 'future-model')
    expect(future?.source).toBe('custom')
    expect(future?.records).toBe(0)
  })
})
