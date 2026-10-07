/**
 * dsh-token-cost — host half. Maintains the incremental usage ledger over
 * DSH session generations (`$DSH_HOME/sessions/<cwd>/<session-id>/session[.vN].jsonl[.zstd]`), serves the
 * /api/dsh-token-cost route family (status / summary / sessions / session /
 * resync), and owns the `token-cost` settings namespace (currency, pricing
 * scheme mode, custom prices, API key aliases). Everything rides official
 * NPM SDK packages — no dsh source changes.
 */

import type { Context, Volatile } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { homedir } from 'node:os'
import { join } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { SessionLedger } from './ledger.ts'
import { CustomPriceStore } from './price-store.ts'
import { PRICE_SCHEMES, parseCustomPrices, withCustomPrices } from './pricing.ts'
import type { ModelPrice, PriceScheme } from './protocol.ts'
import { makeRoutes } from './routes.ts'

/** Stable cordis plugin name. */
export const name = 'token-cost'

/** Services required before the routes can mount. */
export const inject = ['webServer']

/**
 * Settings namespace of the token-cost capability — the section the web
 * settings surface edits. Spelled here rather than imported: the browser
 * half spells the same value and must not depend on a Host package.
 */
export const TOKEN_COST_SETTINGS_NAMESPACE = 'token-cost'

/** Plugin config, validated by the same-named schemastery schema. */
export interface Config {
  /** Master switch for the plugin (routes + surfaces). */
  enabled: Volatile<boolean>
  /** Display currency for every cost figure. */
  currency: Volatile<'cny' | 'usd'>
  /** Pricing scheme selection: auto (by record time) or a forced scheme. */
  priceMode: Volatile<'auto' | 'scheme-a' | 'scheme-b' | 'scheme-c' | 'scheme-d'>
  /** Custom model prices as JSON text; empty string = none. */
  customPrices: Volatile<string>
}

export const Config = z.object({
  enabled: z.boolean().default(true).volatile(),
  currency: z.union([z.const('cny'), z.const('usd')]).default('cny').volatile(),
  priceMode: z.union([
    z.const('auto'),
    z.const('scheme-a'),
    z.const('scheme-b'),
    z.const('scheme-c'),
    z.const('scheme-d'),
  ]).default('auto').volatile(),
  customPrices: z.string().default('').volatile(),
})

/** Resolve the harness home: $DSH_HOME, else ~/.dsh. */
function resolveDshHome(): string {
  const env = process.env['DSH_HOME']
  return typeof env === 'string' && env.trim() !== '' ? env : join(homedir(), '.dsh')
}

/**
 * Mount the ledger, routes, and the settings section.
 * @param ctx - host plugin context carrying webServer.
 * @param config - resolved plugin config (schema defaults applied by the loader).
 */
export function apply(ctx: Context, config: Config = Config({})): void {
  const home = resolveDshHome()
  const storageDir = join(home, 'storages', 'dsh-token-cost')
  const ledger = new SessionLedger(
    join(home, 'sessions'),
    join(storageDir, 'ledger.json'),
  )
  const priceStore = new CustomPriceStore(join(storageDir, 'custom-prices.json'))

  let disposeRoutes: (() => void) | undefined
  /** Rebuild the route registration to match the current settings source. */
  const rebuild = (): void => {
    if (disposeRoutes !== undefined) {
      disposeRoutes()
      disposeRoutes = undefined
    }
    if (!config.enabled.get()) return
    /** Resolve the pricing facts per request (settings edits land live). */
    const pricing = (): { priceMode: string; currency: string } => ({
      priceMode: config.priceMode.get(),
      currency: config.currency.get(),
    })
    const customPrices = (): Record<string, ModelPrice> => {
      const stored = priceStore.get()
      if (Object.keys(stored).length > 0) return stored
      try {
        return parseCustomPrices(config.customPrices.get())
      } catch {
        return {}
      }
    }
    const schemes = (): PriceScheme[] => withCustomPrices(PRICE_SCHEMES, customPrices())
    disposeRoutes = ctx.effect(
      () => {
        const routes = makeRoutes({ ledger, pricing, schemes, customPrices, priceStore })
        const disposers = routes.map((route) => ctx.webServer.register(route))
        return () => { for (const dispose of disposers) dispose() }
      },
      'dsh-token-cost: routes',
    )
  }

  // DSH 0.2 commits volatile edits into stable references without remounting.
  // Only the switch changes route registration; pricing is read per request.
  ctx.events.on('loader/volatile-update', (paths: readonly (readonly string[])[]) => {
    if (paths.some((path) => path[0] === 'enabled')) rebuild()
  })
  rebuild()
  void priceStore.whenReady().then(() => { rebuild() })
}
