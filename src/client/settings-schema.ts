/**
 * Settings namespace of the dsh-token-cost capability, spelled identically
 * on host (schemastery schema in src/index.ts) and browser (this module).
 */

import { useSyncExternalStore } from 'react'
import type { SettingsScope } from '@deepseek-ai/dsh-client-ui-settings/client'

/** The namespace string both halves spell. */
export const TOKEN_COST_NS = 'token-cost'

/** Browser view of the settings section. */
export interface TokenCostSettings {
  /** Master switch: hides the dock chip and the summary dashboard. */
  enabled?: boolean
  /** Display currency for every cost figure. */
  currency?: 'cny' | 'usd'
  /** Pricing scheme selection: auto (by record time) or a forced scheme. */
  priceMode?: 'auto' | 'scheme-a' | 'scheme-b' | 'scheme-c' | 'scheme-d'
  /** Custom model prices as JSON text; empty string = none. */
  customPrices?: string
}

/** Bound settings namespace from the official browser SDK. */
export type TokenCostSettingsScope = SettingsScope<TokenCostSettings>

/** Resolved display facts with defaults applied. */
export interface ResolvedSettings {
  enabled: boolean
  currency: 'cny' | 'usd'
  priceMode: 'auto' | 'scheme-a' | 'scheme-b' | 'scheme-c' | 'scheme-d'
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
