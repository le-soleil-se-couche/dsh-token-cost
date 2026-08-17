/**
 * Stats cost bridge: a renderless composer-dock entry that feeds the
 * official stats line with the current session's total cost.
 *
 * It renders nothing of its own (the dock row stays exactly as the shell
 * paints it); its effect polls the host session route and publishes the
 * formatted cost into the stats-line injector, which places it between the
 * speed group and the cache-hit group of the official line.
 */

import { useEffect, useRef, useState } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SettingsScope } from '@deepseek-ai/dsh-client-runtime/client'
import type { SessionDetailResponse } from '../../protocol.ts'
import { TokenCostApi } from '../api.ts'
import { SessionDetailModal } from '../shared/SessionDetailModal.tsx'
import { resolveSettings, useSettingsValue, type TokenCostSettings } from '../settings-schema.ts'
import {
  formatCostText,
  publishCostState,
  registerDetailOpener,
  startStatsLineInjector,
} from './stats-line-injector.ts'

/** The bridge's injected share: the bound settings scope for currency. */
export interface StatsCostBridgeFace {
  settings: SettingsScope<TokenCostSettings>
}

/** Full props the renderer binds for a composer.dock entry. */
export type StatsCostBridgeProps =
  PropsRuntime<'conversation.composer.dock'>
  & PropsLocale<'token-cost'>
  & InjectFace<StatsCostBridgeFace>

/** Poll interval for the session cost (same cadence as the shell's stats). */
const POLL_MS = 10_000

/** Renderless bridge: data flows into the stats line, nothing is painted. */
export function StatsCostBridge(props: StatsCostBridgeProps) {
  const { sessionId } = props
  const raw = useSettingsValue(props.settings)
  const { enabled, currency } = resolveSettings(raw)
  const apiRef = useRef<TokenCostApi | null>(null)
  const [openId, setOpenId] = useState<string | null>(null)

  useEffect(() => {
    startStatsLineInjector()
    registerDetailOpener((id) => { setOpenId(id) })
    publishCostState({ costText: '', disabled: !enabled })
    if (!enabled) return
    let alive = true
    const api = new TokenCostApi()
    apiRef.current = api
    const load = (): void => {
      api.session(sessionId).then((response: SessionDetailResponse) => {
        if (!alive || !response.ok) return
        const unpricedOnly = response.priced === 0 && response.totals.records > 0
        publishCostState({
          costText: unpricedOnly
            ? (currency === 'cny' ? '未知' : 'n/a')
            : formatCostText(response.totals.costCny, response.totals.costUsd, currency),
          disabled: false,
          sessionId,
          currency,
        })
      }).catch(() => {
        // Transient host states self-heal on the next poll.
      })
    }
    load()
    const timer = setInterval(load, POLL_MS)
    return () => {
      alive = false
      clearInterval(timer)
      publishCostState({ costText: '', disabled: false })
    }
  }, [sessionId, enabled, currency])

  return (
    <>
      {openId !== null ? (
        <SessionDetailModal
          sessionId={openId}
          api={apiRef.current ?? new TokenCostApi()}
          currency={currency}
          t={props.t}
          onClose={() => { setOpenId(null) }}
        />
      ) : null}
    </>
  )
}