/**
 * The dsh-token-cost settings card: the summary dashboard (time-filtered
 * totals, grouped tables), the per-session browser, and the pricing/alias
 * configuration. Registers into the `web-ui.plugin.item` slot the Web UI
 * plugin group renders inside the settings page.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SettingsScope } from '@deepseek-ai/dsh-client-runtime/client'
import type {
  CostGroupRow,
  ModelCatalogRow,
  SessionSummaryRow,
  SessionsResponse,
  StatusResponse,
  SummaryResponse,
} from '../../protocol.ts'
import { formatPeakWindows } from '../../pricing.ts'
import { TokenCostApi } from '../api.ts'
import { formatMoney, formatPercent, formatTokens } from '../format.ts'
import type { TokenCostKey } from '../locales.ts'
import { resolveSettings, useSettingsValue, type TokenCostSettings } from '../settings-schema.ts'
import { SessionDetailModal } from '../shared/SessionDetailModal.tsx'
import { presetRange, validCustomRange, type TimePreset } from '../time-filters.ts'
import css from './card.module.css'
import { CustomPricesPanel } from './CustomPricesPanel.tsx'

/** The card's injected share: the bound settings scope. */
export interface TokenCostSettingsCardFace {
  settings: SettingsScope<TokenCostSettings>
}

/** Full props the renderer binds for the web-ui.plugin.item card. */
export type TokenCostSettingsCardProps =
  PropsRuntime<'web-ui.plugin.item'>
  & PropsLocale<'token-cost'>
  & InjectFace<TokenCostSettingsCardFace>

type Tab = 'summary' | 'sessions' | 'config'

const TABS: Array<{ id: Tab; key: TokenCostKey }> = [
  { id: 'summary', key: 'tabs.summary' },
  { id: 'sessions', key: 'tabs.sessions' },
  { id: 'config', key: 'tabs.config' },
]

/** Render the settings card. */
export function TokenCostSettingsCard(props: TokenCostSettingsCardProps) {
  const { t } = props
  const raw = useSettingsValue(props.settings)
  const resolved = resolveSettings(raw)
  const [tab, setTab] = useState<Tab>('summary')
  const api = useMemo(() => new TokenCostApi(), [])

  return (
    <li className={css.card}>
      <div className={css.head}>
        <span className={css.title}>{t('card.title')}</span>
        <span className={css.desc}>{t('card.description')}</span>
        {!resolved.enabled ? <span className={css.disabled}>{t('config.disabled')}</span> : null}
      </div>
      <div className={css.tabs} role="tablist">
        {TABS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            role="tab"
            aria-selected={tab === entry.id}
            className={tab === entry.id ? css.tabActive : css.tab}
            onClick={() => { setTab(entry.id) }}
          >
            {t(entry.key)}
          </button>
        ))}
      </div>
      <div className={css.body}>
        {!resolved.enabled ? (
          <div className={css.empty}>{t('config.disabled')}</div>
        ) : tab === 'summary' ? (
          <SummaryTab t={t} api={api} currency={resolved.currency} />
        ) : tab === 'sessions' ? (
          <SessionsTab t={t} api={api} currency={resolved.currency} />
        ) : (
          <ConfigTab t={t} scope={props.settings} api={api} currency={resolved.currency} />
        )}
      </div>
    </li>
  )
}

/** Props shared by the tab bodies. */
interface TabProps {
  t: (key: TokenCostKey, params?: Record<string, unknown>) => string
  api: TokenCostApi
  currency: 'cny' | 'usd'
}

const PRESETS: Array<{ id: TimePreset; key: TokenCostKey }> = [
  { id: 'today', key: 'filter.today' },
  { id: 'yesterday', key: 'filter.yesterday' },
  { id: 'd7', key: 'filter.d7' },
  { id: 'd30', key: 'filter.d30' },
  { id: 'month', key: 'filter.month' },
  { id: 'last-month', key: 'filter.lastMonth' },
  { id: 'custom', key: 'filter.custom' },
]

/** Summary tab: filters, stat cards, scheme banner and grouped tables. */
function SummaryTab(props: TabProps) {
  const { t, api, currency } = props
  const [preset, setPreset] = useState<TimePreset>('d7')
  const [customFrom, setCustomFrom] = useState('')
  const [customTo, setCustomTo] = useState('')
  const [customInvalid, setCustomInvalid] = useState(false)
  const [summary, setSummary] = useState<SummaryResponse | null>(null)
  const [sessionTimes, setSessionTimes] = useState<Record<string, number>>({})
  const [status, setStatus] = useState<StatusResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  /** Browser timezone offset in minutes (e.g. UTC+8 -> 480). */
  const tzOffset = -new Date().getTimezoneOffset()
  const load = useCallback((range: { from: number; to: number }): void => {
    setLoading(true)
    setError(null)
    api.summary(range.from, range.to, tzOffset).then((response) => {
      if (response.ok) {
        setSummary(response)
      } else {
        setError(response.error ?? 'unknown')
      }
    }).catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : String(cause))
    }).finally(() => {
      setLoading(false)
    })
  }, [api])

  useEffect(() => {
    load(presetRange(preset))
  }, [preset, load])

  useEffect(() => {
    api.status().then((response) => { if (response.ok) setStatus(response) }).catch(() => {})
    api.sessions().then((response) => {
      if (!response.ok) return
      const times: Record<string, number> = {}
      for (const row of response.sessions) times[row.sessionId] = row.lastActivity
      setSessionTimes(times)
    }).catch(() => {})
  }, [api])

  const applyCustom = (): void => {
    const from = new Date(customFrom + 'T00:00:00').getTime()
    const to = new Date(customTo + 'T00:00:00').getTime() + 86_400_000
    if (customFrom === '' || customTo === '' || !validCustomRange(from, to)) {
      setCustomInvalid(true)
      return
    }
    setCustomInvalid(false)
    load({ from, to })
  }

  const money = (value: { costCny: number; costUsd: number }): string =>
    formatMoney(currency === 'cny' ? value.costCny : value.costUsd, currency)
  const activeScheme = status?.pricing.schemes.find((scheme) => scheme.id === status.pricing.activeNow)
  // 时间倒序：会话按最后活动时间、日期按标签（YYYY-MM-DD）倒序
  const sessionsSorted = [...summary?.bySession ?? []].sort((a, b) => (sessionTimes[b.key] ?? 0) - (sessionTimes[a.key] ?? 0))
  const daysSorted = [...summary?.byDay ?? []].sort((a, b) => (a.label < b.label ? 1 : a.label > b.label ? -1 : 0))

  return (
    <>
      {activeScheme?.peak !== undefined ? (
        <div className={css.schemeBanner}>
          <span>{t('config.peakHours')}: <strong>{formatPeakWindows(activeScheme)}</strong></span>
        </div>
      ) : null}
      <div className={css.filterRow}>
        {PRESETS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            className={preset === entry.id ? css.presetActive : css.preset}
            onClick={() => { setPreset(entry.id) }}
          >
            {t(entry.key)}
          </button>
        ))}
      </div>
      {preset === 'custom' ? (
        <div className={css.customBox}>
          <input type="date" className={css.dateInput} value={customFrom} onChange={(event) => { setCustomFrom(event.target.value) }} />
          <span>–</span>
          <input type="date" className={css.dateInput} value={customTo} onChange={(event) => { setCustomTo(event.target.value) }} />
          <button type="button" className={css.applyBtn} onClick={applyCustom} disabled={customFrom === '' || customTo === ''}>
            {t('filter.apply')}
          </button>
          {customInvalid ? <span className={css.invalid}>{t('filter.invalid')}</span> : null}
          <span className={css.fieldHint}>{t('filter.customHint')}</span>
        </div>
      ) : null}
      {error !== null ? <div className={css.error}>{t('load.failed', { error })}</div> : null}
      {loading && summary === null ? <div className={css.loading}>…</div> : null}
      {summary !== null ? (
        <>
          <div className={css.statGrid}>
            <div className={css.stat}>
              <span className={css.statValue}>{money(summary.totals)}</span>
              <span className={css.statLabel}>{t('stat.cost')}</span>
            </div>
            <div className={css.stat}>
              <span className={css.statValue}>{formatTokens(summary.totals.inputTokens + summary.totals.cacheReadTokens)}</span>
              <span className={css.statLabel}>{t('stat.input')}</span>
              <span className={css.statDetail}>
                {t('stat.inputDetail', { miss: formatTokens(summary.totals.inputTokens), hit: formatTokens(summary.totals.cacheReadTokens) })}
              </span>
            </div>
            <div className={css.stat}>
              <span className={css.statValue}>{formatTokens(summary.totals.outputTokens)}</span>
              <span className={css.statLabel}>{t('stat.output')}</span>
            </div>
            <div className={css.stat}>
              <span className={css.statValue}>{formatPercent(summary.totals.cacheHitRate)}</span>
              <span className={css.statLabel}>{t('stat.cache')}</span>
              <span className={css.statDetail}>{t('stat.requests')} {summary.totals.records}</span>
            </div>
          </div>
          {(summary.unpricedModels ?? []).length > 0 ? (
            <div className={css.unpricedBanner}>
              {t('stat.unpricedBanner', { count: summary.unpricedModels.length, models: summary.unpricedModels.join(', ') })}
            </div>
          ) : null}
          <GroupTable t={t} title={t('group.byModel')} rows={summary.byModel} money={money} />
          <GroupTable t={t} title={t('group.bySession')} rows={sessionsSorted} money={money} />
          <GroupTable t={t} title={t('group.byDay')} rows={daysSorted} money={money} dateRows />
          <span className={css.groupNote}>{t('scope.note')}</span>
        </>
      ) : null}
    </>
  )
}

/** One grouped table. */
function GroupTable(props: {
  t: (key: TokenCostKey, params?: Record<string, unknown>) => string
  title: string
  note?: string
  rows: CostGroupRow[]
  money: (value: { costCny: number; costUsd: number }) => string
  dateRows?: boolean
}) {
  const { t, title, note, rows, money, dateRows } = props
  return (
    <div className={css.group}>
      <span className={css.groupTitle}>{title}</span>
      {note !== undefined ? <span className={css.groupNote}>{note}</span> : null}
      <div className={css.tableWrap}>
        <table className={css.table}>
          <thead>
            <tr>
              <th>{title}</th>
              <th className={css.num}>{t('table.input')}</th>
              <th className={css.num}>{t('table.hit')}</th>
              <th className={css.num}>{t('table.miss')}</th>
              <th className={css.num}>{t('table.output')}</th>
              <th className={css.num}>{t('table.cacheRate')}</th>
              <th className={css.num}>{t('table.cost')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key}>
                <td className={dateRows === true ? css.mono : undefined}>
                  {dateRows === true ? row.label : row.label || t('common.unknown')}
                </td>
                <td className={css.num}>{formatTokens(row.totals.inputTokens + row.totals.cacheReadTokens)}</td>
                <td className={css.num}>{formatTokens(row.totals.cacheReadTokens)}</td>
                <td className={css.num}>{formatTokens(row.totals.inputTokens)}</td>
                <td className={css.num}>{formatTokens(row.totals.outputTokens)}</td>
                <td className={css.num}>{formatPercent(row.totals.cacheHitRate)}</td>
                <td className={css.num}>
                  {row.priced === 0 && row.totals.records > 0 ? t('table.unpriced') : money(row.totals)}
                </td>
              </tr>
            ))}
            {rows.length === 0 ? (
              <tr><td colSpan={7} className={css.empty}>{t('common.na')}</td></tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/** Sessions tab: all sessions with totals; click opens the detail modal. */
function SessionsTab(props: TabProps) {
  const { t, api, currency } = props
  const [sessions, setSessions] = useState<SessionsResponse | null>(null)
  const [openId, setOpenId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback((): void => {
    setError(null)
    api.sessions().then((response) => {
      if (response.ok) setSessions(response)
      else setError(response.error ?? 'unknown')
    }).catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : String(cause))
    })
  }, [api])

  useEffect(load, [load])

  const money = (value: { costCny: number; costUsd: number }): string =>
    formatMoney(currency === 'cny' ? value.costCny : value.costUsd, currency)

  return (
    <>
      {error !== null ? <div className={css.error}>{t('load.failed', { error })}</div> : null}
      {sessions !== null ? (
        <div className={css.tableWrap}>
          <table className={css.table}>
            <thead>
              <tr>
                <th>{t('table.session')}</th>
                <th className={css.num}>{t('table.input')}</th>
                <th className={css.num}>{t('table.output')}</th>
                <th className={css.num}>{t('table.cacheRate')}</th>
                <th className={css.num}>{t('table.cost')}</th>
                <th>{t('sessions.open')}</th>
              </tr>
            </thead>
            <tbody>
              {sessions.sessions.map((row) => (
                <SessionRow key={row.sessionId} row={row} money={money} onOpen={() => { setOpenId(row.sessionId) }} />
              ))}
              {sessions.sessions.length === 0 ? (
                <tr><td colSpan={6} className={css.empty}>{t('sessions.empty')}</td></tr>
              ) : null}
            </tbody>
          </table>
        </div>
      ) : null}
      {openId !== null ? (
        <SessionDetailModal
          sessionId={openId}
          api={api}
          currency={currency}
          t={t}
          onClose={() => { setOpenId(null) }}
        />
      ) : null}
    </>
  )
}

/** One session row. */
function SessionRow(props: {
  row: SessionSummaryRow
  money: (value: { costCny: number; costUsd: number }) => string
  onOpen: () => void
}) {
  const { row, money, onOpen } = props
  return (
    <tr>
      <td>
        <span title={row.title}>{row.title || row.sessionId}</span>
        {row.cwd !== '' ? <span className={css.fieldHint}> · {row.cwd}</span> : null}
      </td>
      <td className={css.num}>{formatTokens(row.totals.inputTokens + row.totals.cacheReadTokens)}</td>
      <td className={css.num}>{formatTokens(row.totals.outputTokens)}</td>
      <td className={css.num}>{formatPercent(row.totals.cacheHitRate)}</td>
      <td className={css.num}>{money(row.totals)}</td>
      <td><button type="button" className={css.rowBtn} onClick={onOpen}>{'>'}</button></td>
    </tr>
  )
}

/** Config tab: staged form over the settings scope plus pricing status. */
function ConfigTab(props: TabProps & { scope: SettingsScope<TokenCostSettings> }) {
  const { t, scope, api, currency } = props
  const raw = useSettingsValue(scope)
  const value = raw ?? {}
  const [enabled, setEnabled] = useState(value.enabled ?? true)
  const [currencyDraft, setCurrencyDraft] = useState(value.currency ?? 'cny')
  const [priceMode, setPriceMode] = useState(value.priceMode ?? 'auto')
  const [customPrices, setCustomPrices] = useState(value.customPrices ?? '')
  const [pricesValid, setPricesValid] = useState(true)
  const [panelKey, setPanelKey] = useState(0)
  const [dirty, setDirty] = useState(false)
  const [saved, setSaved] = useState(false)
  const [failed, setFailed] = useState(false)
  const [jsonInvalid, setJsonInvalid] = useState(false)
  const [status, setStatus] = useState<StatusResponse | null>(null)
  const [models, setModels] = useState<ModelCatalogRow[]>([])
  const [resyncing, setResyncing] = useState(false)
  const [resynced, setResynced] = useState<string | null>(null)

  const loadCatalog = useCallback((): void => {
    api.status().then((response) => { if (response.ok) setStatus(response) }).catch(() => {})
    api.models().then((response) => { if (response.ok) setModels(response.models) }).catch(() => {})
  }, [api])

  useEffect(loadCatalog, [loadCatalog])

  const persistPrices = useCallback(async (text: string): Promise<void> => {
    setFailed(false)
    setSaved(false)
    try {
      const response = await api.savePrices(text)
      if (!response.ok) {
        setFailed(true)
        return
      }
      setCustomPrices(text)
      setPricesValid(true)
      setJsonInvalid(false)
      setSaved(true)
      if (response.models.length > 0) setModels(response.models)
      else loadCatalog()
    } catch {
      setFailed(true)
    }
  }, [api, loadCatalog])

  const jsonFieldsValid = (): boolean => {
    const trimmed = customPrices.trim()
    if (trimmed === '') return true
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return false
    } catch {
      return false
    }
    return true
  }

  const save = async (): Promise<void> => {
    if (!jsonFieldsValid()) {
      setJsonInvalid(true)
      return
    }
    setJsonInvalid(false)
    setFailed(false)
    setSaved(false)
    try {
      if (enabled !== (value.enabled ?? true)) await scope.set('enabled', enabled)
      if (currencyDraft !== (value.currency ?? 'cny')) await scope.set('currency', currencyDraft)
      if (priceMode !== (value.priceMode ?? 'auto')) await scope.set('priceMode', priceMode)
      if (customPrices !== (value.customPrices ?? '')) await scope.set('customPrices', customPrices.trim())
      setDirty(false)
      setSaved(true)
      loadCatalog()
    } catch {
      setFailed(true)
    }
  }

  const discard = (): void => {
    setEnabled(value.enabled ?? true)
    setCurrencyDraft(value.currency ?? 'cny')
    setPriceMode(value.priceMode ?? 'auto')
    setCustomPrices(value.customPrices ?? '')
    setPricesValid(true)
    setPanelKey((key) => key + 1)
    setDirty(false)
    setJsonInvalid(false)
    setFailed(false)
    setSaved(false)
  }

  const resync = async (): Promise<void> => {
    setResyncing(true)
    setResynced(null)
    try {
      const response = await api.resync()
      if (response.ok) {
        setResynced(t('config.resynced', { sessions: response.ledger.sessionCount, records: response.ledger.recordCount }))
        loadCatalog()
      }
    } catch {
      setResynced(null)
    } finally {
      setResyncing(false)
    }
  }

  const activeScheme = status?.pricing.schemes.find((scheme) => scheme.id === status.pricing.activeNow)
  const writeable = scope.getSnapshot().writable

  return (
    <>
      <div className={css.statusGrid}>
        {activeScheme?.peak !== undefined ? (
          <div className={css.statusItem}>
            <span className={css.statusLabel}>{t('config.peakHours')}</span>
            <span className={css.statusValue}>{formatPeakWindows(activeScheme)}</span>
          </div>
        ) : null}
        <div className={css.statusItem}>
          <span className={css.statusLabel}>{t('config.currency')}</span>
          <span className={css.statusValue}>{currency === 'cny' ? t('config.currencyCny') : t('config.currencyUsd')}</span>
        </div>
      </div>
      <div className={css.form}>
        <label className={css.checkRow}>
          <input type="checkbox" checked={enabled} onChange={(event) => { setEnabled(event.target.checked); setDirty(true) }} />
          <span>{t('config.enabled')}</span>
          <span className={css.fieldHint}>{t('config.enabledHint')}</span>
        </label>
        <div className={css.field}>
          <label className={css.fieldLabel} htmlFor="token-cost-currency">{t('config.currency')}</label>
          <select
            id="token-cost-currency"
            className={css.select}
            value={currencyDraft}
            onChange={(event) => { setCurrencyDraft(event.target.value as 'cny' | 'usd'); setDirty(true) }}
          >
            <option value="cny">{t('config.currencyCny')}</option>
            <option value="usd">{t('config.currencyUsd')}</option>
          </select>
        </div>
        <div className={css.field}>
          <label className={css.fieldLabel} htmlFor="token-cost-price-mode">{t('config.priceMode')}</label>
          <select
            id="token-cost-price-mode"
            className={css.select}
            value={priceMode}
            onChange={(event) => { setPriceMode(event.target.value as 'auto' | 'scheme-a' | 'scheme-b'); setDirty(true) }}
          >
            <option value="auto">{t('config.priceModeAuto')}</option>
            <option value="scheme-a">{t('config.priceModeA')}</option>
            <option value="scheme-b">{t('config.priceModeB')}</option>
          </select>
          <span className={css.fieldHint}>{t('config.priceModeHint')}</span>
        </div>
        <CustomPricesPanel
          key={panelKey}
          t={t}
          currency={currencyDraft}
          initialText={customPrices}
          models={models}
          onChange={(text, valid) => {
            setCustomPrices(text)
            setPricesValid(valid)
            setJsonInvalid(!valid)
          }}
          onCommit={persistPrices}
        />
        {jsonInvalid ? <div className={css.failed}>{t('config.invalidJson')}</div> : null}
        {failed ? <div className={css.failed}>{t('config.saveFailed')}</div> : null}
        {saved ? <div className={css.saved}>{t('config.saved')}</div> : null}
        <div className={css.actions}>
          <button type="button" className={css.saveBtn} disabled={!dirty || !writeable || !pricesValid} onClick={() => { void save() }}>
            {t('config.save')}
          </button>
          <button type="button" className={css.secondaryBtn} disabled={!dirty} onClick={discard}>
            {t('config.discard')}
          </button>
          <button type="button" className={css.secondaryBtn} disabled={resyncing} onClick={() => { void resync() }}>
            {resyncing ? t('config.resyncing') : t('config.resync')}
          </button>
          {resynced !== null ? <span className={css.saved}>{resynced}</span> : null}
        </div>
      </div>
    </>
  )
}