// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StatsCostBridge, type StatsCostBridgeProps } from '../src/client/stats/StatsCostBridge.tsx'
import { TokenCostApi } from '../src/client/api.ts'
import type { SessionDetailResponse } from '../src/protocol.ts'

vi.mock('../src/client/shared/SessionDetailModal.tsx', () => ({
  SessionDetailModal: ({ sessionId }: { sessionId: string }) => React.createElement('div', { role: 'dialog' }, sessionId),
}))

const response = (costCny = 0.123456, priced = 3): SessionDetailResponse => ({
  ok: true, priced, totals: { records: 3, costCny, costUsd: costCny / 7 },
} as SessionDetailResponse)

describe('official composer dock cost', () => {
  let root: Root
  let box: HTMLDivElement
  const snapshot = { value: { currency: 'cny', enabled: true } }
  const usdSnapshot = { value: { currency: 'usd', enabled: true } }
  const props = (sessionId: string, enabled = true, currency: 'cny' | 'usd' = 'cny') => ({
    sessionId,
    settings: { subscribe: () => () => {}, getSnapshot: () => enabled ? (currency === 'cny' ? snapshot : usdSnapshot) : disabledSnapshot },
    t: (key: string, args?: { cost: string }) => key === 'stats.cost' ? `费用 ${args?.cost}` : '费用明细',
  } as unknown as StatsCostBridgeProps)
  const disabledSnapshot = { value: { enabled: false, currency: 'cny' } }
  const render = async (id = 'a', enabled = true, currency: 'cny' | 'usd' = 'cny') => {
    await act(async () => { root.render(React.createElement(StatsCostBridge, props(id, enabled, currency))) })
  }
  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    box = document.createElement('div')
    // Mirrors the new host: contenteditable composer, two metric spans with SVG.
    document.body.innerHTML = '<div contenteditable="true" role="textbox"></div><div data-composer-stats="true"><span><svg></svg>23 tok/s</span><span><svg></svg>缓存命中 50%</span></div>'
    document.body.append(box)
    root = createRoot(box)
  })
  afterEach(async () => {
    await act(async () => { root.unmount() })
    vi.restoreAllMocks()
    document.body.innerHTML = ''
  })
  it('renders without a textarea or legacy stats spans and opens the right details', async () => {
    vi.spyOn(TokenCostApi.prototype, 'session').mockResolvedValue(response())
    await render()
    expect(box.textContent).toBe('费用 ¥0.1235')
    expect(document.querySelector('[data-composer-stats]')?.textContent).toBe('23 tok/s缓存命中 50%')
    await act(async () => { box.querySelector('button')?.click() })
    expect(box.querySelector('[role="dialog"]')?.textContent).toBe('a')
  })
  it('ignores a stale response after changing sessions', async () => {
    let resolveOld!: (data: SessionDetailResponse) => void
    vi.spyOn(TokenCostApi.prototype, 'session').mockImplementation(id => id === 'a' ? new Promise(resolve => { resolveOld = resolve }) : Promise.resolve(response(1.5)))
    await render('a')
    await render('b')
    await act(async () => { resolveOld(response(99)) })
    expect(box.textContent).toBe('费用 ¥1.50')
    await act(async () => { box.querySelector('button')?.click() })
    expect(box.querySelector('[role="dialog"]')?.textContent).toBe('b')
  })
  it('shows unavailable on a failed request rather than stale or zero cost', async () => {
    vi.spyOn(TokenCostApi.prototype, 'session').mockRejectedValue(new Error('offline'))
    await render()
    expect(box.textContent).toBe('费用 暂不可用')
    expect(box.querySelector('button')?.disabled).toBe(true)
  })
  it('ignores an old currency response after switching the display currency', async () => {
    let resolveOld!: (data: SessionDetailResponse) => void
    vi.spyOn(TokenCostApi.prototype, 'session')
      .mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve }))
      .mockResolvedValue(response(7))
    await render('a', true, 'cny')
    await render('a', true, 'usd')
    await act(async () => { resolveOld(response(999)) })
    expect(box.textContent).toBe('费用 $1.00')
  })
  it('preserves unknown pricing and the display setting', async () => {
    const api = vi.spyOn(TokenCostApi.prototype, 'session').mockResolvedValue(response(0, 0))
    await render()
    expect(box.textContent).toBe('费用 未知')
    await render('a', false)
    expect(box.textContent).toBe('')
    expect(api).toHaveBeenCalledOnce()
  })
})
