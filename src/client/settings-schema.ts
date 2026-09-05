/**
 * Settings namespace of the dsh-token-cost capability, spelled identically
 * on host (schemastery schema in src/index.ts) and browser (this module).
 */

import { useSyncExternalStore } from 'react'

/** The namespace string both halves spell. */
export const TOKEN_COST_NS = 'token-cost'

/** Browser view of the settings section. */
export interface TokenCostSettings {
  /** Master switch: hides the dock chip and the summary dashboard. */
  enabled?: boolean
  /** Display currency for every cost figure. */
  currency?: 'cny' | 'usd'
  /** Pricing scheme selection: auto (by record time) or a forced scheme. */
  priceMode?: 'auto' | 'scheme-a' | 'scheme-b'
  /** Custom model prices as JSON text; empty string = none. */
  customPrices?: string
}

/**
 * Structural settings scope shared by DSH 0.1.2-rc.1 and 0.1.3-alpha.1.
 * The owning package moved this type from dsh-client-runtime to
 * dsh-client-ui-settings in 0.1.3; keeping the narrow consumer contract local
 * avoids a runtime/package dependency on either type home.
 */
export interface TokenCostSettingsScope {
  getSnapshot(): {
    value: TokenCostSettings | undefined
    writable: boolean
  }
  subscribe(listener: () => void): () => void
  set(field: string, value: unknown): Promise<void>
  unset(field: string): Promise<void>
}

/** Resolved display facts with defaults applied. */
export interface ResolvedSettings {
  enabled: boolean
  currency: 'cny' | 'usd'
  priceMode: 'auto' | 'scheme-a' | 'scheme-b'
}

/** Apply defaults to a raw section value. */
export function resolveSettings(value: TokenCostSettings | undefined): ResolvedSettings {
  return {
    enabled: value?.enabled ?? true,
    currency: value?.currency ?? 'cny',
    priceMode: value?.priceMode ?? 'auto',
  }
}

/** Reactively read the current section value of a bound settings scope. */
export function useSettingsValue(scope: TokenCostSettingsScope): TokenCostSettings | undefined {
  const snapshot = useSyncExternalStore(
    (listener) => scope.subscribe(listener),
    () => scope.getSnapshot(),
  )
  return snapshot.value
}
