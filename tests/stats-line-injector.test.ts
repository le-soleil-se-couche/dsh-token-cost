// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  COST_NODE_MARKER,
  publishCostState,
  registerDetailOpener,
  stopStatsLineInjector,
} from '../src/client/stats/stats-line-injector.ts'

describe('stats-line cost injector', () => {
  let frames: FrameRequestCallback[]

  beforeEach(() => {
    frames = []
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      frames.push(callback)
      return frames.length
    })
    document.body.innerHTML = `
      <div id="composer">
        <div><textarea></textarea></div>
        <div id="stats">
          <span>TTFT avg 0.2s · 20 tok/s</span>
          <span>|</span>
          <span>Cache hit 50%</span>
        </div>
      </div>
    `
  })

  afterEach(() => {
    stopStatsLineInjector()
    registerDetailOpener(() => {})
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  const flushFrame = (): void => {
    const callback = frames.shift()
    expect(callback).toBeDefined()
    callback?.(0)
  }

  it('updates an existing marker when a later poll publishes a new cost', () => {
    const open = vi.fn()
    registerDetailOpener(open)
    publishCostState({ costText: '$0.12', disabled: false, sessionId: 'session-a', currency: 'usd' })
    flushFrame()

    const group = document.querySelector<HTMLElement>(`[${COST_NODE_MARKER}="group"]`)
    expect(group?.textContent).toBe('Cost $0.12')

    publishCostState({ costText: '$0.34', disabled: false, sessionId: 'session-b', currency: 'usd' })
    flushFrame()

    const groups = document.querySelectorAll<HTMLElement>(`[${COST_NODE_MARKER}="group"]`)
    expect(groups).toHaveLength(1)
    expect(groups[0]?.textContent).toBe('Cost $0.34')
    groups[0]?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    expect(open).toHaveBeenCalledOnce()
    expect(open).toHaveBeenCalledWith('session-b')
  })
})
