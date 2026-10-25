import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { apply as installConnection, type PeerOptions } from '@deepseek-ai/dsh-client-connection'
import { WebServer } from '@deepseek-ai/dsh-host-webserver'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as tokenCost from '../src/index.ts'
import { TokenCostApi } from '../src/client/api.ts'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function setup(withHttp = false) {
  const home = await mkdtemp(join(tmpdir(), 'token-cost-021-'))
  cleanups.push(() => rm(home, { recursive: true, force: true }))
  vi.stubEnv('DSH_HOME', home)
  // Deliberately exercises URL encoding as well as the Windows directory codec.
  const id = 'fixture/中文+%?'
  const directoryId = [...id].map(c => /[A-Za-z0-9_-]/.test(c)
    ? c : `~${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`).join('')
  const dir = join(home, 'sessions', '--fixture--', directoryId)
  await mkdir(dir, { recursive: true })
  const time = Date.UTC(2026, 9, 19, 1)
  await writeFile(join(dir, 'session.v4.jsonl'), [
    { type: 'session', version: 4, id, createdAt: time, isSeeded: false },
    { type: 'assistant/message', seq: 1, time, data: {
      turn: 1, step: 1,
      message: { role: 'assistant', content: [], source: { provider: 'fixture', model: 'fixture-model' } },
      usage: { inputTokens: 1000000, cacheReadTokens: 500000, outputTokens: 200000 },
      stream: [],
    } },
  ].map(value => JSON.stringify(value)).join('\n') + '\n')
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  // Real Connection authentication, with a memory-only credential provider.
  ctx.provide('credentials', {
    modifyRecord: async (_key: unknown, update: (value: undefined) => Promise<unknown>) => update(undefined),
  })
  if (withHttp) await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 }).await()
  await installConnection(ctx)
  const plugin = ctx.plugin(tokenCost)
  await plugin.await()
  for (const runtime of ctx.registry.values()) {
    for (const fiber of runtime.fibers) await fiber.await()
  }
  const handler = ctx.connection.createSharedFetchHandler('/api')
  const carrier = (input: string | URL, init: RequestInit = {}) =>
    handler.fetch(new Request(new URL(input, 'http://localhost/'), init), ctx.connection.browserPeer)
  return { ctx, plugin, handler, carrier, id, dir }
}

describe('DSH 0.2.1 Connection integration', () => {
  it('serves all client operations without webServer, persists prices, and unloads cleanly', async () => {
    const { ctx, plugin, carrier, id, dir } = await setup()
    expect(ctx.get('webServer')).toBeUndefined()
    const fetchSpy = vi.fn(carrier)
    vi.stubGlobal('__DSH_TRANSPORT__', { fetch: fetchSpy, ownsHost: true })
    vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Desktop must use its carrier') }))
    const api = new TokenCostApi()
    expect((await api.status()).ledger.recordCount).toBe(1)
    expect((await api.sessions()).sessions[0]?.sessionId).toBe(id)
    expect((await api.models()).models.some(row => row.model === 'fixture-model')).toBe(true)
    await api.savePrices(JSON.stringify({ 'fixture-model': {
      cny: { miss: 2, hit: 1, output: 4 }, usd: { miss: 1, hit: 0.5, output: 2 }, flat: true,
    } }))
    const detail = await api.session(id)
    expect(detail.priced).toBe(1)
    expect(detail.totals.costCny).toBeCloseTo(3.3)
    expect((await api.summary(0, Date.now() + 86400000, 480)).totals.costCny).toBeCloseTo(3.3)
    expect((await api.resync()).ledger.recordCount).toBe(1)
    expect(fetchSpy.mock.calls.every(([path]) => String(path).startsWith('api/'))).toBe(true)
    await plugin.dispose()
    expect((await carrier('api/dsh-token-cost/status')).status).toBe(404)
    const reloaded = ctx.plugin(tokenCost)
    await reloaded.await()
    expect((await api.session(id)).totals.costCny).toBeCloseTo(3.3)
    // A newly settled request must appear in both views without counting the
    // existing generation again on the next poll or explicit rescan.
    await appendFile(join(dir, 'session.v4.jsonl'), JSON.stringify({
      type: 'assistant/message', seq: 2, time: Date.UTC(2026, 9, 19, 1, 1),
      data: {
        turn: 2, step: 1,
        message: { role: 'assistant', content: [], source: { provider: 'fixture', model: 'fixture-model' } },
        usage: { inputTokens: 100000, cacheReadTokens: 100000, outputTokens: 50000 },
        stream: [],
      },
    }) + '\n')
    const updated = await api.session(id)
    expect(updated.totals.records).toBe(2)
    expect(updated.totals.costCny).toBeCloseTo(3.8)
    expect((await api.summary(0, Date.now() + 86400000, 480)).totals.costCny).toBeCloseTo(3.8)
    expect((await api.resync()).ledger.recordCount).toBe(2)
    expect((await api.session(id)).totals.costCny).toBeCloseTo(3.8)
  })

  it('handles invalid requests and uses the SDK owner access check', async () => {
    const { ctx, handler, carrier } = await setup()
    expect((await carrier('api/dsh-token-cost/session')).status).toBe(400)
    expect((await carrier('api/dsh-token-cost/session?id=missing')).status).toBe(404)
    expect((await carrier('api/dsh-token-cost/prices', { method: 'POST', body: '{' })).status).toBe(400)
    expect((await carrier('api/dsh-token-cost/prices', { method: 'POST', body: '{}' })).status).toBe(400)
    expect((await carrier('api/dsh-token-cost/status', { method: 'POST' })).status).toBe(404)
    // Use the SDK principal contract rather than forging HTTP origin headers.
    // PrincipalMap is extensible by other host plugins. Simulate a non-owner.
    const peer = ctx.connection.createPeer({ principal: { kind: 'fixture' } as unknown as PeerOptions['principal'] })
    expect((await handler.fetch(new Request('http://localhost/api/dsh-token-cost/status'), peer)).status).toBe(403)
  })

  it('requires authentication on the actual HTTP carrier and accepts its signed cookie', async () => {
    const { ctx } = await setup(true)
    const origin = ctx.webServer.getOrigin()
    ctx.webServer.register({ kind: 'exact', path: '/', handler(req, res) {
      if (ctx.connection.authorizeIndex(req, res)) res.end('fixture')
    } })
    const statusUrl = `${origin}/api/dsh-token-cost/status`
    expect((await fetch(statusUrl)).status).toBe(401)
    const login = await fetch(ctx.connection.authenticatedUrl(`${origin}/`), { redirect: 'manual' })
    const cookie = login.headers.get('set-cookie')?.split(';')[0]
    expect(cookie).toBeTruthy()
    const response = await fetch(statusUrl, { headers: { cookie: cookie! } })
    expect(response.status).toBe(200)
    expect((await response.json()).ledger.recordCount).toBe(1)
    expect((await fetch(statusUrl, { headers: { cookie: cookie!, origin: 'https://foreign.example' } })).status).toBe(403)
  })
})
