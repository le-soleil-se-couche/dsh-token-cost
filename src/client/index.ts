/**
 * Browser-half entry for the dsh-token-cost plugin — runs inside the dsh web
 * GUI. Registers the per-session cost chip in the composer dock (next to the
 * shipped Input/Output stats line) and the summary dashboard card in the
 * official configurable-plugin settings tab. Mounting problems are logged,
 * never thrown: an external plugin must not take the GUI down.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the locale namespace map and the slot registry merge.
import type {} from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the conversation slot declaration and settingsScope service.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { StatsCostBridge, type StatsCostBridgeFace } from './stats/StatsCostBridge.tsx'
import { en, zh, type TokenCostKey } from './locales.ts'
import {
  TokenCostSettingsCard,
  type TokenCostSettingsCardFace,
} from './settings/TokenCostSettingsCard.tsx'
import { TOKEN_COST_NS, type TokenCostSettings } from './settings-schema.ts'

/** Locale namespace this plugin owns. */
const NS = 'token-cost'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** dsh-token-cost surface copy. */
    'token-cost': TokenCostKey
  }

  interface SlotMap {
    /**
     * Official keyed card slot declared by dsh-client-ui-settings-plugins.
     * Spelled structurally here so the browser bundle has no value dependency
     * on the sibling package while still targeting its released contract.
     */
    'settings.plugin.item': { kind: 'keyed'; scope: 'root'; owner: SettingsPluginItemOwnerProps }
  }
}

/** Owner share of a plugin card (the section supplies nothing). */
export interface SettingsPluginItemOwnerProps {
  /** Marker field: card owner props are intentionally empty. */
  children?: never
}

/** Required services (fiber inject waiting — the runtime must be up first). */
export const inject = ['slots', 'locale', 'connection', 'settingsScope', 'remote']

/**
 * Mount the two dsh-token-cost surfaces: the composer-dock chip and the
 * settings-page summary card. Both read the same settings scope.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'token-cost: dictionaries')

  const scope = ctx.settingsScope.bind<TokenCostSettings>({ namespace: TOKEN_COST_NS })

  const disposers: Array<() => void> = []
  try {
    disposers.push(ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
      name: 'conversation.composer.dock',
      id: 'token-cost',
      order: 110,
      locale: NS,
      inject: (): StatsCostBridgeFace => ({ settings: scope }),
    }, StatsCostBridge)))
    disposers.push(ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
      name: 'settings.plugin.item',
      key: TOKEN_COST_NS,
      locale: NS,
      inject: (): TokenCostSettingsCardFace => ({ settings: scope }),
    }, TokenCostSettingsCard)))
  } catch (error) {
    console.warn('[dsh-token-cost] mount failed:', error)
  }
  ctx.effect(() => () => {
    for (const dispose of disposers.splice(0)) dispose()
  }, 'token-cost: ui mounts')
}
