/**
 * Price engine tests: scheme resolution by record time (the price-increase
 * auto-switch), peak/off-peak billing, custom price overrides and totals.
 */

import { describe, expect, it } from 'vitest'
import {
  FX_CNY_PER_USD,
  PEAK_WORKDAYS,
  PRICE_SCHEMES,
  SCHEME_B_EFFECTIVE_FROM,
  SCHEME_C_EFFECTIVE_FROM,
  SCHEME_D_EFFECTIVE_FROM,
  convertPriceSet,
  formatPeakWindows,
  isPeakHour,
  modelPriceFromRates,
  normalizeModel,
  parseCustomPrices,
  peakLimitsWeekdays,
  priceRecord,
  resolveScheme,
  serializeCustomPrices,
  totalsFor,
  weekdayInOffset,
  withCustomPrices,
} from '../src/pricing.ts'
import type { UsageRecord } from '../src/protocol.ts'

function record(partial: Partial<UsageRecord>): UsageRecord {
  return {
    time: 1_700_000_000_000,
    turn: 1,
    step: 1,
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash',
    inputTokens: 1_000_000,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    sessionId: 's1',
    sessionLabel: 'S1',
    ...partial,
  }
}

describe('resolveScheme', () => {
  it('uses scheme-a before the switch instant and scheme-b after', () => {
    expect(resolveScheme(PRICE_SCHEMES, SCHEME_B_EFFECTIVE_FROM - 1).id).toBe('scheme-a')
    expect(resolveScheme(PRICE_SCHEMES, SCHEME_B_EFFECTIVE_FROM).id).toBe('scheme-b')
    expect(resolveScheme(PRICE_SCHEMES, SCHEME_B_EFFECTIVE_FROM + 86_400_000).id).toBe('scheme-b')
  })

  it('honours a forced scheme id', () => {
    expect(resolveScheme(PRICE_SCHEMES, SCHEME_B_EFFECTIVE_FROM + 1, 'scheme-a').id).toBe('scheme-a')
    expect(resolveScheme(PRICE_SCHEMES, 0, 'scheme-b').id).toBe('scheme-b')
  })

  it('switches to scheme-c at the 2026-09-10 12:00 Beijing price cut', () => {
    expect(resolveScheme(PRICE_SCHEMES, SCHEME_C_EFFECTIVE_FROM - 1).id).toBe('scheme-b')
    expect(resolveScheme(PRICE_SCHEMES, SCHEME_C_EFFECTIVE_FROM).id).toBe('scheme-c')
    expect(resolveScheme(PRICE_SCHEMES, SCHEME_D_EFFECTIVE_FROM - 1).id).toBe('scheme-c')
    expect(resolveScheme(PRICE_SCHEMES, SCHEME_D_EFFECTIVE_FROM).id).toBe('scheme-d')
  })
})

describe('isPeakHour', () => {
  const schemeB = PRICE_SCHEMES[1]!
  // Official windows are Beijing 09:00-12:00 and 14:00-18:00 (end exclusive).
  it('window boundaries are start-inclusive, end-exclusive in UTC+8', () => {
    const utc = (h: number): number => Date.UTC(2026, 7, 17, h, 0, 0)
    expect(isPeakHour(schemeB, utc(0))).toBe(false) // Beijing 08:00
    expect(isPeakHour(schemeB, utc(1))).toBe(true) // Beijing 09:00
    expect(isPeakHour(schemeB, utc(3))).toBe(true) // Beijing 11:00
    expect(isPeakHour(schemeB, utc(4))).toBe(false) // Beijing 12:00
    expect(isPeakHour(schemeB, utc(6))).toBe(true) // Beijing 14:00
    expect(isPeakHour(schemeB, utc(9))).toBe(true) // Beijing 17:00
    expect(isPeakHour(schemeB, utc(10))).toBe(false) // Beijing 18:00
  })

  it('treats 08:59 Beijing as off-peak and 09:00 as peak', () => {
    expect(isPeakHour(schemeB, Date.UTC(2026, 7, 17, 0, 59, 0))).toBe(false)
    expect(isPeakHour(schemeB, Date.UTC(2026, 7, 17, 1, 0, 0))).toBe(true)
  })

  it('keeps scheme-b peak windows on weekends (every day)', () => {
    // Saturday 2026-08-22 10:00 Beijing.
    expect(isPeakHour(schemeB, Date.UTC(2026, 7, 22, 2, 0, 0))).toBe(true)
    expect(peakLimitsWeekdays(schemeB)).toBe(false)
  })

  it('restricts scheme-c peak windows to workdays', () => {
    const schemeC = PRICE_SCHEMES.find((scheme) => scheme.id === 'scheme-c')!
    expect(schemeC.peakDays).toEqual(PEAK_WORKDAYS)
    expect(peakLimitsWeekdays(schemeC)).toBe(true)
    // Monday 2026-09-14 10:00 Beijing is peak.
    expect(isPeakHour(schemeC, Date.UTC(2026, 8, 14, 2, 0, 0))).toBe(true)
    // Saturday 2026-09-12 10:00 Beijing and Sunday 2026-09-13 10:00 Beijing are not.
    expect(isPeakHour(schemeC, Date.UTC(2026, 8, 12, 2, 0, 0))).toBe(false)
    expect(isPeakHour(schemeC, Date.UTC(2026, 8, 13, 2, 0, 0))).toBe(false)
    // Off-peak hours stay off-peak on workdays (08:00 Beijing).
    expect(isPeakHour(schemeC, Date.UTC(2026, 8, 14, 0, 0, 0))).toBe(false)
  })

  it('resolves the UTC+8 weekday across the UTC date boundary', () => {
    // 2026-09-13 23:00Z is Monday 07:00 Beijing.
    expect(weekdayInOffset(Date.UTC(2026, 8, 13, 23, 0, 0), 8 * 60)).toBe(1)
    expect(weekdayInOffset(Date.UTC(2026, 8, 12, 16, 0, 0), 8 * 60)).toBe(0)
  })

  it('labels windows in the UTC+8 clock', () => {
    expect(formatPeakWindows(schemeB)).toBe('09:00-12:00、14:00-18:00')
  })
})

describe('priceRecord', () => {
  it('bills 1M miss tokens at the scheme-a flash rate (CNY 1)', () => {
    const cost = priceRecord(record({ inputTokens: 1_000_000 }), PRICE_SCHEMES, 'scheme-a')
    expect(cost).not.toBeNull()
    expect(cost!.costCny).toBeCloseTo(1, 6)
    expect(cost!.costUsd).toBeCloseTo(0.14, 6)
    expect(cost!.peak).toBeNull()
  })

  it('bills cache hits at the hit rate', () => {
    const cost = priceRecord(record({ inputTokens: 0, cacheReadTokens: 1_000_000 }), PRICE_SCHEMES, 'scheme-a')
    expect(cost!.costCny).toBeCloseTo(0.02, 6)
  })

  it('scheme-b charges half off-peak and full at peak for v4-flash', () => {
    const offpeak = record({ inputTokens: 0, time: Date.UTC(2026, 7, 17, 0, 0, 0), outputTokens: 1_000_000 })
    const peak = record({ inputTokens: 0, time: Date.UTC(2026, 7, 17, 2, 0, 0), outputTokens: 1_000_000 })
    expect(priceRecord(offpeak, PRICE_SCHEMES)!.costCny).toBeCloseTo(4.5, 6)
    expect(priceRecord(peak, PRICE_SCHEMES)!.costCny).toBeCloseTo(9, 6)
    expect(priceRecord(peak, PRICE_SCHEMES)!.peak).toBe(true)
    expect(priceRecord(offpeak, PRICE_SCHEMES)!.peak).toBe(false)
  })

  it('keeps legacy models flat inside scheme-b', () => {
    const chat = record({ model: 'deepseek-chat', inputTokens: 1_000_000, time: Date.UTC(2026, 7, 17, 2, 0, 0) })
    const cost = priceRecord(chat, PRICE_SCHEMES)!
    expect(cost.costCny).toBeCloseTo(2, 6)
    expect(cost.peak).toBeNull()
  })

  it('bills deepseek-flash at the scheme-c cut rates, peak and off-peak', () => {
    // Monday 2026-09-14: 10:00 Beijing peak, 08:00 Beijing off-peak.
    const peak = record({ model: 'deepseek-flash', inputTokens: 1_000_000, time: Date.UTC(2026, 8, 14, 2, 0, 0) })
    const offpeak = record({ model: 'deepseek-flash', inputTokens: 1_000_000, time: Date.UTC(2026, 8, 14, 0, 0, 0) })
    expect(priceRecord(peak, PRICE_SCHEMES)!.costCny).toBeCloseTo(2, 6)
    expect(priceRecord(peak, PRICE_SCHEMES)!.costUsd).toBeCloseTo(0.3, 6)
    expect(priceRecord(peak, PRICE_SCHEMES)!.peak).toBe(true)
    expect(priceRecord(offpeak, PRICE_SCHEMES)!.costCny).toBeCloseTo(1, 6)
    expect(priceRecord(offpeak, PRICE_SCHEMES)!.peak).toBe(false)
  })

  it('bills scheme-c weekend daytime at off-peak (workdays only)', () => {
    // Saturday 2026-09-12 10:00 Beijing.
    const cost = priceRecord(
      record({ model: 'deepseek-flash', inputTokens: 0, outputTokens: 1_000_000, time: Date.UTC(2026, 8, 12, 2, 0, 0) }),
      PRICE_SCHEMES,
    )!
    expect(cost.costCny).toBeCloseTo(4, 6)
    expect(cost.peak).toBe(false)
  })

  it('routes the retired V4 Flash names to the Flash rate from scheme-c', () => {
    const cut = Date.UTC(2026, 8, 10, 6, 0, 0) // Thursday 14:00 Beijing, scheme-c peak
    const rerouted = Date.UTC(2026, 8, 14, 6, 0, 0) // Monday 14:00 Beijing, scheme-d peak
    for (const model of ['deepseek-v4-flash', 'deepseek-v4-flash-vision-exp']) {
      const c = priceRecord(record({ model, inputTokens: 1_000_000, time: cut }), PRICE_SCHEMES)!
      expect(c.costCny).toBeCloseTo(2, 6)
      expect(c.schemeId).toBe('scheme-c')
      const d = priceRecord(record({ model, inputTokens: 1_000_000, time: rerouted }), PRICE_SCHEMES)!
      expect(d.costCny).toBeCloseTo(2, 6)
      expect(d.schemeId).toBe('scheme-d')
    }
  })

  it('keeps V4 Pro pricing until scheme-d, then bills it at the Flash rate', () => {
    const before = record({ model: 'deepseek-v4-pro', inputTokens: 1_000_000, time: Date.UTC(2026, 8, 14, 2, 0, 0) })
    const after = record({ model: 'deepseek-v4-pro', inputTokens: 1_000_000, time: Date.UTC(2026, 8, 14, 6, 0, 0) })
    expect(priceRecord(before, PRICE_SCHEMES)!.costCny).toBeCloseTo(9, 6)
    expect(priceRecord(after, PRICE_SCHEMES)!.costCny).toBeCloseTo(2, 6)
    expect(priceRecord(after, PRICE_SCHEMES)!.schemeId).toBe('scheme-d')
  })

  it('returns null for unknown models', () => {
    expect(priceRecord(record({ model: 'gpt-4o' }), PRICE_SCHEMES)).toBeNull()
  })
})

describe('totalsFor', () => {
  it('sums tokens and cost across mixed schemes', () => {
    const records = [
      record({ inputTokens: 1_000_000, time: SCHEME_B_EFFECTIVE_FROM - 1 }),
      record({ inputTokens: 1_000_000, outputTokens: 500_000, time: Date.UTC(2026, 7, 17, 0, 0, 0) }),
    ]
    const { totals, priced } = totalsFor(records, PRICE_SCHEMES)
    expect(totals.inputTokens).toBe(2_000_000)
    expect(totals.outputTokens).toBe(500_000)
    expect(totals.records).toBe(2)
    expect(priced).toBe(2)
    // 1 CNY (scheme-a miss) + 1.5 CNY (off-peak miss) + 4.5 * 0.5 (off-peak output)
    expect(totals.costCny).toBeCloseTo(1 + 1.5 + 2.25, 6)
  })

  it('computes cache hit rate over billed input', () => {
    const { totals } = totalsFor([
      record({ inputTokens: 300, cacheReadTokens: 700 }),
    ], PRICE_SCHEMES)
    expect(totals.cacheHitRate).toBeCloseTo(0.7, 6)
  })
})

describe('custom prices', () => {
  it('parses and overrides a model price', () => {
    const custom = parseCustomPrices('{"my-model":{"cny":{"miss":9,"hit":1,"output":18},"usd":{"miss":1.2,"hit":0.1,"output":2.4}}}')
    const schemes = withCustomPrices(PRICE_SCHEMES, custom)
    const cost = priceRecord(record({ model: 'MY-MODEL', inputTokens: 1_000_000 }), schemes, 'scheme-a')
    expect(cost!.costCny).toBeCloseTo(9, 6)
  })

  it('accepts a single currency and fills the other with the reference FX', () => {
    const custom = parseCustomPrices('{"kimi-k2":{"cny":{"miss":7.25,"hit":0,"output":14.5}}}')
    expect(custom['kimi-k2']!.usd.miss).toBeCloseTo(1, 6)
    expect(custom['kimi-k2']!.usd.output).toBeCloseTo(2, 6)
    expect(convertPriceSet({ miss: 1, hit: 0, output: 2 }, 'usd').miss).toBeCloseTo(FX_CNY_PER_USD, 6)
  })

  it('defaults third-party models to flat so scheme-b does not halve them', () => {
    const custom = parseCustomPrices('{"gpt-4o":{"usd":{"miss":2.5,"hit":1.25,"output":10}}}')
    expect(custom['gpt-4o']!.flat).toBe(true)
    const schemes = withCustomPrices(PRICE_SCHEMES, custom)
    const peak = record({
      model: 'gpt-4o',
      inputTokens: 0,
      outputTokens: 1_000_000,
      time: Date.UTC(2026, 7, 17, 2, 0, 0),
    })
    const offpeak = record({
      model: 'gpt-4o',
      inputTokens: 0,
      outputTokens: 1_000_000,
      time: Date.UTC(2026, 7, 17, 0, 0, 0),
    })
    expect(priceRecord(peak, schemes)!.costUsd).toBeCloseTo(10, 6)
    expect(priceRecord(offpeak, schemes)!.costUsd).toBeCloseTo(10, 6)
    expect(priceRecord(peak, schemes)!.peak).toBeNull()
  })

  it('keeps peak behaviour when overriding a built-in DeepSeek model without flat', () => {
    const custom = parseCustomPrices('{"deepseek-v4-flash":{"cny":{"miss":3,"hit":0.1,"output":9},"usd":{"miss":0.44,"hit":0.014,"output":1.32}}}')
    expect(custom['deepseek-v4-flash']!.flat).toBeUndefined()
    const schemes = withCustomPrices(PRICE_SCHEMES, custom)
    const peak = record({ inputTokens: 0, outputTokens: 1_000_000, time: Date.UTC(2026, 7, 17, 2, 0, 0) })
    expect(priceRecord(peak, schemes)!.costCny).toBeCloseTo(9, 6)
  })

  it('round-trips through serializeCustomPrices', () => {
    const price = modelPriceFromRates('claude-sonnet', { miss: 3, hit: 0.3, output: 15 }, 'usd')
    const text = serializeCustomPrices({ 'claude-sonnet': price })
    const parsed = parseCustomPrices(text)
    expect(parsed['claude-sonnet']!.usd.output).toBe(15)
    expect(parsed['claude-sonnet']!.flat).toBe(true)
  })

  it('preserves an explicit flat:false through parse and serialization', () => {
    const source = '{"gpt-4o":{"usd":{"miss":2.5,"hit":1.25,"output":10},"flat":false}}'
    const first = parseCustomPrices(source)
    expect(first['gpt-4o']!.flat).toBe(false)
    const second = parseCustomPrices(serializeCustomPrices(first))
    expect(second['gpt-4o']!.flat).toBe(false)

    const schemes = withCustomPrices(PRICE_SCHEMES, second)
    const offpeak = record({
      model: 'gpt-4o',
      inputTokens: 0,
      outputTokens: 1_000_000,
      time: Date.UTC(2026, 7, 17, 0, 0, 0),
    })
    expect(priceRecord(offpeak, schemes)!.costUsd).toBeCloseTo(5, 6)
  })

  it('rejects a non-boolean flat override', () => {
    expect(() => parseCustomPrices(
      '{"gpt-4o":{"usd":{"miss":2.5,"hit":1.25,"output":10},"flat":"false"}}',
    )).toThrow('flat must be boolean')
  })

  it('lists unpriced models in totalsFor', () => {
    const { priced, unpricedModels } = totalsFor([
      record({ model: 'deepseek-v4-flash' }),
      record({ model: 'gpt-4o' }),
    ], PRICE_SCHEMES)
    expect(priced).toBe(1)
    expect(unpricedModels).toEqual(['gpt-4o'])
  })

  it('rejects malformed input', () => {
    expect(() => parseCustomPrices('[]')).toThrow()
    expect(() => parseCustomPrices('{"x":{"cny":{"miss":-1}} }')).toThrow()
    expect(() => parseCustomPrices('not json')).toThrow()
  })
})

describe('normalizeModel', () => {
  it('lowercases and trims', () => {
    expect(normalizeModel(' DeepSeek-V4-Flash ')).toBe('deepseek-v4-flash')
  })
})
