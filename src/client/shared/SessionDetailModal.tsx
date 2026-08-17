/**
 * Session cost detail modal: one session's per-request usage records with the
 * running totals. Shared by the composer dock chip and the settings card.
 * Renders through a body portal so it floats above the shell's layout.
 */

import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import type { SessionDetailResponse } from '../../protocol.ts'
import type { TokenCostApi } from '../api.ts'
import { formatClock, formatMoney, formatPercent, formatTokens } from '../format.ts'
import type { TokenCostKey } from '../locales.ts'
import css from './session-detail.module.css'

/** Modal props. */
export interface SessionDetailModalProps {
  sessionId: string
  api: TokenCostApi
  currency: 'cny' | 'usd'
  t: (key: TokenCostKey, params?: Record<string, unknown>) => string
  onClose: () => void
}

/** Fetch one session detail and render it in a portal modal. */
export function SessionDetailModal(props: SessionDetailModalProps) {
  const { sessionId, api, currency, t, onClose } = props
  const [detail, setDetail] = useState<SessionDetailResponse | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    api.session(sessionId).then((response) => {
      if (!alive) return
      if (response.ok) {
        setDetail(response)
        setError(null)
      } else {
        setError(response.error ?? 'unknown')
      }
    }).catch((cause: unknown) => {
      if (alive) setError(cause instanceof Error ? cause.message : String(cause))
    })
    return () => { alive = false }
  }, [sessionId, api])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const money = (value: number): string => formatMoney(value, currency)
  const costOf = (costCny: number, costUsd: number, schemeId: string): string => {
    if (schemeId === '') return t('table.unpriced')
    return money(currency === 'cny' ? costCny : costUsd)
  }
  // Zip before sort: costs[] is aligned with the unsorted records array.
  const recordsSorted = (detail?.records ?? []).map((record, index) => ({
    record,
    cost: detail?.costs[index] ?? { costCny: 0, costUsd: 0, schemeId: '', peak: null },
  })).sort((left, right) => right.record.time - left.record.time)

  return createPortal(
    <div className={css.overlay} onClick={onClose} role="presentation">
      <div className={css.dialog} role="dialog" aria-modal="true" aria-label={t('detail.title')} onClick={(event) => event.stopPropagation()}>
        <div className={css.header}>
          <span className={css.title}>{t('detail.title')}</span>
          <button type="button" className={css.close} onClick={onClose} aria-label={t('detail.close')}>×</button>
        </div>
        {error !== null ? (
          <div className={css.error}>{t('load.failed', { error })}</div>
        ) : detail === null ? (
          <div className={css.loading}>…</div>
        ) : (
          <div className={css.body}>
            <div className={css.meta}>
              <span className={css.metaTitle} title={detail.meta.title}>{detail.meta.title || t('common.unknown')}</span>
              <span className={css.metaCwd} title={detail.meta.cwd}>{detail.meta.cwd}</span>
            </div>
            <div className={css.statRow}>
              <div className={css.stat}>
                <span className={css.statValue}>{money(currency === 'cny' ? detail.totals.costCny : detail.totals.costUsd)}</span>
                <span className={css.statLabel}>{t('stat.cost')}</span>
              </div>
              <div className={css.stat}>
                <span className={css.statValue}>{formatTokens(detail.totals.inputTokens + detail.totals.cacheReadTokens)}</span>
                <span className={css.statLabel}>{t('stat.input')}</span>
              </div>
              <div className={css.stat}>
                <span className={css.statValue}>{formatTokens(detail.totals.outputTokens)}</span>
                <span className={css.statLabel}>{t('stat.output')}</span>
              </div>
              <div className={css.stat}>
                <span className={css.statValue}>{formatPercent(detail.totals.cacheHitRate)}</span>
                <span className={css.statLabel}>{t('stat.cache')}</span>
              </div>
            </div>
            <div className={css.tableWrap}>
              <table className={css.table}>
                <thead>
                  <tr>
                    <th>{t('detail.time')}</th>
                    <th>{t('table.model')}</th>
                    <th className={css.num}>{t('table.miss')}</th>
                    <th className={css.num}>{t('table.hit')}</th>
                    <th className={css.num}>{t('table.output')}</th>
                    <th className={css.num}>{t('table.cost')}</th>
                  </tr>
                </thead>
                <tbody>
                  {recordsSorted.map(({ record, cost }, index) => (
                      <tr key={`${record.turn}-${record.step}-${index}`}>
                        <td className={css.mono}>{formatClock(record.time)}</td>
                        <td>{record.model || t('common.unknown')}</td>
                        <td className={css.num}>{formatTokens(record.inputTokens)}</td>
                        <td className={css.num}>{formatTokens(record.cacheReadTokens)}</td>
                        <td className={css.num}>{formatTokens(record.outputTokens)}</td>
                        <td className={css.num}>{costOf(cost.costCny, cost.costUsd, cost.schemeId)}</td>
                      </tr>
                  ))}
                  {recordsSorted.length === 0 ? (
                    <tr><td colSpan={6} className={css.empty}>{t('common.na')}</td></tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body,
  )
}