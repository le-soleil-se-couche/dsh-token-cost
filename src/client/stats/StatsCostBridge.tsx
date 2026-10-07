/**
 * Session cost entry rendered by the official composer dock. It owns its
 * element instead of depending on the shell's editor or stats DOM shape.
 */

import { useEffect, useRef, useState } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionDetailResponse } from '../../protocol.ts'
import { TokenCostApi } from '../api.ts'
import { SessionDetailModal } from '../shared/SessionDetailModal.tsx'
import { resolveSettings, useSettingsValue, type TokenCostSettingsScope } from '../settings-schema.ts'
import { formatMoney } from '../format.ts'

/** The bridge's injected share: the bound settings scope for currency. */
export interface StatsCostBridgeFace {
  settings: TokenCostSettingsScope
}

/** Full props the renderer binds for a composer.dock entry. */
export type StatsCostBridgeProps =
  PropsRuntime<'conversation.composer.dock'>
  & PropsLocale<'token-cost'>
  & InjectFace<StatsCostBridgeFace>

/** Poll interval for the session cost (same cadence as the shell's stats). */
const POLL_MS = 10_000

/** Poll the active session and render its cost alongside the native metrics. */
export function StatsCostBridge(props: StatsCostBridgeProps) {
  const { sessionId } = props
  const raw = useSettingsValue(props.settings)
  const { enabled, currency } = resolveSettings(raw)
  const apiRef = useRef<TokenCostApi | null>(null)
  const [openId, setOpenId] = useState<string | null>(null)
  const [result, setResult] = useState<{
    sessionId: string
    currency: 'cny' | 'usd'
    text: string
    available: boolean
  } | null>(null)

  useEffect(() => {
    setResult(null)
    setOpenId(null)
    if (!enabled) return
    let alive = true
    const api = new TokenCostApi()
    apiRef.current = api
    const load = (): void => {
      api.session(sessionId).then((response: SessionDetailResponse) => {
        if (!alive) return
        if (!response.ok) throw new Error('Cost response unavailable')
        const unpricedOnly = response.priced === 0 && response.totals.records > 0
        setResult({
          text: unpricedOnly
            ? (currency === 'cny' ? '未知' : 'n/a')
            : formatMoney(currency === 'cny' ? response.totals.costCny : response.totals.costUsd, currency),
          available: true,
          sessionId,
          currency,
        })
      }).catch(() => {
        if (alive) setResult({ sessionId, currency, text: currency === 'cny' ? '暂不可用' : 'unavailable', available: false })
      })
    }
    load()
    const timer = setInterval(load, POLL_MS)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [sessionId, enabled, currency])

  if (!enabled) return null
  const activeResult = result?.sessionId === sessionId && result.currency === currency ? result : null
  const label = props.t('stats.cost', { cost: activeResult?.text ?? '…' })

  return (
    <>
      <button
        type="button"
        data-dsh-token-cost-price="group"
        title={props.t('detail.title')}
        aria-label={label}
        disabled={!activeResult?.available}
        onClick={() => { setOpenId(sessionId) }}
        style={{
          display: 'inline-flex', alignItems: 'center', boxSizing: 'border-box',
          border: 0, padding: '1px 8px', background: 'transparent',
          color: 'var(--dsw-alias-label-tertiary)', fontFamily: 'inherit',
          fontSize: 'calc(var(--dsh-content-font-size-secondary, 13px) - 1px)',
          lineHeight: 'calc(20px + var(--dsh-content-font-delta-secondary, 0px))',
          fontWeight: 'inherit', fontStyle: 'inherit', fontVariantNumeric: 'tabular-nums',
          textDecoration: 'underline dotted', textUnderlineOffset: '3px',
          cursor: activeResult?.available ? 'pointer' : 'default', whiteSpace: 'nowrap',
        }}
      >
        {label}
      </button>
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
