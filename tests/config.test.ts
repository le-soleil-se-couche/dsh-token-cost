/** SDK 0.2 form projection and live config updates, without any real profile I/O. */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { SettingsForms } from '@deepseek-ai/dsh-settings'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply, Config, inject, name } from '../src/index.ts'
import type { ModelPrice, PriceScheme } from '../src/protocol.ts'

// Keep the host plugin's storage constructors away from the real harness home.
vi.mock('../src/ledger.ts', () => ({
  SessionLedger: class {
    async sync() { return this.stats() }
    stats() { return { sessionCount: 0, recordCount: 0, syncedAt: 0 } }
    sessions() { return [] }
  },
}))
vi.mock('../src/price-store.ts', () => ({
  CustomPriceStore: class {
    async whenReady() {}
    get() { return {} }
  },
}))

// Use the Loader already installed by the official settings SDK, with no
// additional package dependency or assumptions about its node_modules layout.
const require = createRequire(import.meta.url)
const settingsRequire = createRequire(require.resolve('@deepseek-ai/dsh-settings'))
const { Loader, EntryTree } = await import(pathToFileURL(settingsRequire.resolve('@deepseek-ai/cordis-plugin-loader')).href)
class SyntheticProfile extends EntryTree {
  constructor(ctx: Context) { super(ctx) }
  write() {}
}
const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function harness(raw: Record<string, unknown> = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-token-cost-config-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  const routes = new Map<string, WebRoute>()
  ctx.provide('webServer', {
    register(route: WebRoute) {
      if (routes.has(route.path)) throw new Error(`duplicate route: ${route.path}`)
      routes.set(route.path, route)
      return () => { routes.delete(route.path) }
    },
  })
  ctx.provide('profileContext', { home: dir })
  const loader = new Loader(ctx)
  await Promise.all([...ctx.registry.values()].flatMap((runtime) => [...runtime.fibers]).map((fiber) => fiber.await()))
  const run = vi.fn(apply)
  loader.builtins['token-cost'] = { name, inject, Config, apply: run }
  loader.builtins['synthetic-profile'] = {
    async apply(child: Context) {
      const profile = new SyntheticProfile(child)
      await profile.create({ id: 'token-cost', name: 'cordis:token-cost', config: raw })
    },
  }
  await loader.create({ id: 'include', name: 'cordis:synthetic-profile' })
  await loader.await()
  const entry = loader.resolve('include:token-cost')
  const documentPath = join(dir, 'profile.json')

  // This synthetic editor adapter persists only in the temporary directory;
  // SettingsForms and Loader validation/reference updates are the real SDK.
  ctx.provide('configEditor', {
    documentPath,
    entries: () => [entry],
    configuration: () => [{ entry, inherited: {}, override: entry.options.config ?? {} }],
    async edit(_entry: unknown, change: (raw: Record<string, unknown>, inherited: Record<string, unknown>) => object) {
      const next = change(structuredClone(entry.options.config ?? {}), {})
      Config(next)
      await writeFile(documentPath, JSON.stringify({ id: entry.options.id, config: next }), 'utf8')
      await entry.update({ config: next })
      await loader.await()
    },
  })
  const settings = new SettingsForms(ctx)
  return { settings, entry, run, routes, documentPath }
}

async function status(routes: Map<string, WebRoute>) {
  const route = routes.get('/api/dsh-token-cost/status')
  expect(route).toBeDefined()
  let body = ''
  const req = {
    method: 'GET',
    url: '/api/dsh-token-cost/status',
    socket: { remoteAddress: '127.0.0.1' },
    headers: { host: 'localhost' },
  } as IncomingMessage
  const res = {
    writeHead: vi.fn(),
    end(value: string) { body = value },
  } as unknown as ServerResponse
  await route!.handler(req, res)
  expect(res.writeHead).toHaveBeenCalledWith(200, expect.anything())
  return JSON.parse(body) as { pricing: { currency: string; priceMode: string; schemes: PriceScheme[] } }
}

describe('SDK 0.2 live configuration', () => {
  it('projects and saves every field through SettingsForms without reapplying the plugin', async () => {
    const { settings, entry, run, routes, documentPath } = await harness()
    expect(entry.id).toBe('include:token-cost')
    const before = settings.describe().find((row) => row.ns === 'token-cost')
    expect(before?.value).toEqual({ enabled: true, currency: 'cny', priceMode: 'auto', customPrices: '' })
    const fiber = entry.fiber
    const refs = { ...fiber.config }
    const price: ModelPrice = {
      cny: { miss: 5, hit: 1, output: 10 },
      usd: { miss: 0.7, hit: 0.14, output: 1.4 },
      flat: true,
    }
    const next = {
      enabled: true,
      currency: 'usd',
      priceMode: 'scheme-b',
      customPrices: JSON.stringify({ 'synthetic-model': price }),
    }
    const existingStatus = routes.get('/api/dsh-token-cost/status')
    await settings.update('token-cost', next, before!.revision)

    expect(JSON.parse(await readFile(documentPath, 'utf8'))).toEqual({ id: 'token-cost', config: next })
    expect(settings.describe().find((row) => row.ns === 'token-cost')?.value).toEqual(next)
    expect(entry.fiber).toBe(fiber)
    for (const key of Object.keys(refs)) expect(fiber.config[key]).toBe(refs[key])
    expect(run).toHaveBeenCalledTimes(1)
    expect(routes.get('/api/dsh-token-cost/status')).toBe(existingStatus)
    const response = await status(routes)
    expect(response.pricing.currency).toBe('usd')
    expect(response.pricing.priceMode).toBe('scheme-b')
    expect(response.pricing.schemes.every((scheme) => scheme.models['synthetic-model']?.cny.output === 10)).toBe(true)

    await settings.update('token-cost', { currency: 'cny', priceMode: 'auto', customPrices: '' })
    const restored = await status(routes)
    expect(restored.pricing.currency).toBe('cny')
    expect(restored.pricing.priceMode).toBe('auto')
    expect(restored.pricing.schemes.every((scheme) => scheme.models['synthetic-model'] === undefined)).toBe(true)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('mounts and removes routes when the live enabled reference changes', async () => {
    const { settings, entry, run, routes } = await harness({ enabled: false })
    const fiber = entry.fiber
    expect(routes.size).toBe(0)
    await settings.update('token-cost', { enabled: true })
    expect((await status(routes)).pricing.currency).toBe('cny')
    await settings.update('token-cost', { enabled: false })
    expect(routes.size).toBe(0)
    await settings.update('token-cost', { enabled: true })
    expect((await status(routes)).pricing.priceMode).toBe('auto')
    expect(entry.fiber).toBe(fiber)
    expect(run).toHaveBeenCalledTimes(1)
  })
})
