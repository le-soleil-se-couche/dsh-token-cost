/**
 * Form for custom model prices: discover unpriced ledger models, edit
 * per-1M rates in the display currency, and keep the settings JSON in sync.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import type { ModelCatalogRow, ModelPrice } from '../../protocol.ts'
import {
  builtinModelIds,
  modelPriceFromRates,
  normalizeModel,
  parseCustomPrices,
  serializeCustomPrices,
} from '../../pricing.ts'
import type { TokenCostKey } from '../locales.ts'
import css from './card.module.css'

/** One editable custom-price row. */
interface DraftRow {
  key: string
  model: string
  miss: string
  hit: string
  output: string
  /** Preserve an explicit flat:false through form edits and persistence. */
  flat?: boolean
}

/** Props for the custom-price editor. */
export interface CustomPricesPanelProps {
  t: (key: TokenCostKey, params?: Record<string, unknown>) => string
  currency: 'cny' | 'usd'
  initialText: string
  models: ModelCatalogRow[]
  onChange: (text: string, valid: boolean) => void
  /** Persist a valid catalog immediately (add / delete / blur). */
  onCommit: (text: string) => Promise<void>
}

function parseRate(raw: string, fallback = Number.NaN): number {
  const trimmed = raw.trim()
  if (trimmed === '') return fallback
  const value = Number(trimmed)
  return Number.isFinite(value) ? value : Number.NaN
}

function rowsFromText(text: string, currency: 'cny' | 'usd'): DraftRow[] {
  try {
    const parsed = parseCustomPrices(text)
    return Object.entries(parsed).map(([model, price]) => {
      const set = currency === 'cny' ? price.cny : price.usd
      return {
        key: model,
        model,
        miss: String(set.miss),
        hit: String(set.hit),
        output: String(set.output),
        ...(price.flat === undefined ? {} : { flat: price.flat }),
      }
    })
  } catch {
    return []
  }
}

function rowsFromModels(models: ModelCatalogRow[], currency: 'cny' | 'usd'): DraftRow[] {
  return models.flatMap((row) => {
    if (row.source !== 'custom' || row.price === null) return []
    const set = currency === 'cny' ? row.price.cny : row.price.usd
    return [{
      key: normalizeModel(row.model),
      model: row.model,
      miss: String(set.miss),
      hit: String(set.hit),
      output: String(set.output),
      ...(row.price.flat === undefined ? {} : { flat: row.price.flat }),
    }]
  })
}

function serializeRows(rows: DraftRow[], currency: 'cny' | 'usd'): { text: string; valid: boolean } {
  const custom: Record<string, ModelPrice> = {}
  const seen = new Set<string>()
  for (const row of rows) {
    const model = row.model.trim()
    if (model === '') return { text: serializeCustomPrices(custom), valid: false }
    const id = normalizeModel(model)
    if (seen.has(id)) return { text: serializeCustomPrices(custom), valid: false }
    seen.add(id)
    const miss = parseRate(row.miss)
    const hit = parseRate(row.hit)
    const output = parseRate(row.output)
    if (!Number.isFinite(miss) || !Number.isFinite(hit) || !Number.isFinite(output) || miss < 0 || hit < 0 || output < 0) {
      return { text: serializeCustomPrices(custom), valid: false }
    }
    custom[id] = modelPriceFromRates(model, { miss, hit, output }, currency, row.flat)
  }
  return { text: serializeCustomPrices(custom), valid: true }
}

let nextRowKey = 1

/** Custom model price table plus unpriced discovery. */
export function CustomPricesPanel(props: CustomPricesPanelProps) {
  const { t, currency, initialText, models, onChange, onCommit } = props
  const [rows, setRows] = useState<DraftRow[]>(() => rowsFromText(initialText, currency))
  const [addModel, setAddModel] = useState('')
  const [addMiss, setAddMiss] = useState('')
  const [addHit, setAddHit] = useState('')
  const [addOutput, setAddOutput] = useState('')
  const [jsonOpen, setJsonOpen] = useState(false)
  const [jsonDraft, setJsonDraft] = useState(initialText)
  const [jsonError, setJsonError] = useState(false)
  const builtin = useMemo(() => builtinModelIds(), [])
  const rowsRef = useRef(rows)
  rowsRef.current = rows
  const seeded = useRef(initialText.trim() !== '')

  const emit = (next: DraftRow[], commit: boolean): void => {
    rowsRef.current = next
    setRows(next)
    const serialized = serializeRows(next, currency)
    setJsonDraft(serialized.text)
    setJsonError(false)
    onChange(serialized.text, serialized.valid)
    if (commit && serialized.valid) void onCommit(serialized.text)
  }

  useEffect(() => {
    if (seeded.current) return
    if (models.length === 0) return
    seeded.current = true
    if (rowsRef.current.length > 0) return
    const next = rowsFromModels(models, currency)
    if (next.length === 0) return
    emit(next, false)
  }, [models, currency])

  const drafted = new Set(rows.map((row) => normalizeModel(row.model)).filter((id) => id !== ''))
  const unpriced = models.filter((row) => row.source === 'unpriced' && !drafted.has(normalizeModel(row.model)))
  const builtinRows = models.filter((row) => row.source === 'builtin')

  const fillUnpriced = (model: string): void => {
    if (drafted.has(normalizeModel(model))) return
    emit([...rows, { key: `new-${nextRowKey++}`, model, miss: '', hit: '', output: '' }], false)
  }

  /** Seed an override draft from a built-in row's current (latest) rates. */
  const overrideBuiltin = (row: ModelCatalogRow): void => {
    if (drafted.has(normalizeModel(row.model))) return
    const set = row.price === null ? undefined : currency === 'cny' ? row.price.cny : row.price.usd
    emit([...rows, {
      key: `new-${nextRowKey++}`,
      model: row.model,
      miss: set === undefined ? '' : String(set.miss),
      hit: set === undefined ? '' : String(set.hit),
      output: set === undefined ? '' : String(set.output),
    }], false)
  }

  const addReady = addModel.trim() !== ''
    && Number.isFinite(parseRate(addMiss))
    && Number.isFinite(parseRate(addOutput))
    && parseRate(addMiss) >= 0
    && parseRate(addOutput) >= 0

  const addManual = (): void => {
    const model = addModel.trim()
    const miss = parseRate(addMiss)
    const output = parseRate(addOutput)
    const hitRaw = parseRate(addHit)
    const hit = Number.isFinite(hitRaw) && hitRaw >= 0 ? hitRaw : 0
    if (model === '' || !Number.isFinite(miss) || !Number.isFinite(output) || miss < 0 || output < 0) {
      return
    }
    const next = rows.filter((row) => normalizeModel(row.model) !== normalizeModel(model))
    emit([...next, {
      key: `new-${nextRowKey++}`,
      model,
      miss: String(miss),
      hit: String(hit),
      output: String(output),
    }], true)
    setAddModel('')
    setAddMiss('')
    setAddHit('')
    setAddOutput('')
  }

  const applyJson = (text: string): void => {
    setJsonDraft(text)
    try {
      const parsed = parseCustomPrices(text)
      const next = rowsFromText(serializeCustomPrices(parsed), currency)
      rowsRef.current = next
      setRows(next)
      const committed = serializeCustomPrices(parsed)
      setJsonError(false)
      onChange(committed, true)
      void onCommit(committed)
    } catch {
      setJsonError(true)
      onChange(text, false)
    }
  }

  const unit = currency === 'cny' ? 'CNY' : 'USD'

  return (
    <div className={css.pricePanel}>
      <div className={css.field}>
        <span className={css.fieldLabel}>{t('config.customPrices')}</span>
        <span className={css.fieldHint}>{t('config.customPricesHint')}</span>
      </div>

      <div className={css.priceSection}>
        <span className={css.groupTitle}>{t('config.unpricedTitle')}</span>
        {unpriced.length === 0 ? (
          <span className={css.fieldHint}>{t('config.unpricedEmpty')}</span>
        ) : (
          <ul className={css.unpricedList}>
            {unpriced.map((row) => (
              <li key={row.model} className={css.unpricedItem}>
                <span className={css.mono}>{row.model}</span>
                {row.provider !== '' ? <span className={css.fieldHint}>{row.provider}</span> : null}
                <span className={css.fieldHint}>{t('config.unpricedCalls', { count: row.records })}</span>
                <span className={css.badgeUnpriced}>{t('config.sourceUnpriced')}</span>
                <button type="button" className={css.rowBtn} onClick={() => { fillUnpriced(row.model) }}>
                  {t('config.unpricedFill')}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className={css.priceSection}>
        <span className={css.groupTitle}>{t('config.customTableTitle')} · {t('config.priceUnit')} ({unit})</span>
        {rows.length === 0 ? (
          <span className={css.fieldHint}>{t('config.customEmpty')}</span>
        ) : (
          <div className={css.tableWrap}>
            <table className={css.table}>
              <thead>
                <tr>
                  <th>{t('table.model')}</th>
                  <th className={css.num}>{t('config.priceMiss')}</th>
                  <th className={css.num}>{t('config.priceHit')}</th>
                  <th className={css.num}>{t('config.priceOutput')}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const overridesBuiltin = builtin.has(normalizeModel(row.model))
                  const patch = (partial: Partial<DraftRow>): DraftRow[] =>
                    rows.map((item) => item.key === row.key ? { ...item, ...partial } : item)
                  return (
                    <tr key={row.key}>
                      <td>
                        <input
                          className={css.priceInput}
                          value={row.model}
                          spellCheck={false}
                          onChange={(event) => { emit(patch({ model: event.target.value }), false) }}
                          onBlur={() => { emit(rowsRef.current, true) }}
                        />
                        {overridesBuiltin ? <div className={css.fieldHint}>{t('config.overrideBuiltin')}</div> : null}
                      </td>
                      <td className={css.num}>
                        <input
                          className={css.priceInput}
                          inputMode="decimal"
                          value={row.miss}
                          onChange={(event) => { emit(patch({ miss: event.target.value }), false) }}
                          onBlur={() => { emit(rowsRef.current, true) }}
                        />
                      </td>
                      <td className={css.num}>
                        <input
                          className={css.priceInput}
                          inputMode="decimal"
                          value={row.hit}
                          onChange={(event) => { emit(patch({ hit: event.target.value }), false) }}
                          onBlur={() => { emit(rowsRef.current, true) }}
                        />
                      </td>
                      <td className={css.num}>
                        <input
                          className={css.priceInput}
                          inputMode="decimal"
                          value={row.output}
                          onChange={(event) => { emit(patch({ output: event.target.value }), false) }}
                          onBlur={() => { emit(rowsRef.current, true) }}
                        />
                      </td>
                      <td>
                        <button
                          type="button"
                          className={css.rowBtn}
                          onClick={() => { emit(rows.filter((item) => item.key !== row.key), true) }}
                        >
                          {overridesBuiltin ? t('config.resetBuiltin') : t('config.removePrice')}
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}

        <div className={css.addForm}>
          <label className={css.addField}>
            <span className={css.addFieldLabel}>{t('config.addModelId')}</span>
            <input
              className={css.priceInput}
              placeholder={t('config.addModelPlaceholder')}
              value={addModel}
              spellCheck={false}
              onChange={(event) => { setAddModel(event.target.value) }}
            />
          </label>
          <div className={css.addRates}>
            <label className={css.addField}>
              <span className={css.addFieldLabel}>{t('config.priceMiss')}</span>
              <input
                className={css.priceInput}
                inputMode="decimal"
                placeholder="0"
                value={addMiss}
                onChange={(event) => { setAddMiss(event.target.value) }}
              />
            </label>
            <label className={css.addField}>
              <span className={css.addFieldLabel}>{t('config.priceHit')}</span>
              <input
                className={css.priceInput}
                inputMode="decimal"
                placeholder="0"
                value={addHit}
                onChange={(event) => { setAddHit(event.target.value) }}
              />
            </label>
            <label className={css.addField}>
              <span className={css.addFieldLabel}>{t('config.priceOutput')}</span>
              <input
                className={css.priceInput}
                inputMode="decimal"
                placeholder="0"
                value={addOutput}
                onChange={(event) => { setAddOutput(event.target.value) }}
              />
            </label>
            <button type="button" className={css.secondaryBtn} onClick={addManual} disabled={!addReady}>
              {t('config.addModel')}
            </button>
          </div>
        </div>
      </div>

      {builtinRows.length > 0 ? (
        <details className={css.priceSection}>
          <summary className={css.groupTitle}>{t('config.builtinTitle')}</summary>
          <div className={css.fieldHint}>{t('config.overrideHint')}</div>
          <div className={css.tableWrap}>
            <table className={css.table}>
              <thead>
                <tr>
                  <th>{t('table.model')}</th>
                  <th className={css.num}>{t('config.priceMiss')}</th>
                  <th className={css.num}>{t('config.priceHit')}</th>
                  <th className={css.num}>{t('config.priceOutput')}</th>
                  <th className={css.num}>{t('table.requests')}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {builtinRows.map((row) => {
                  const set = currency === 'cny' ? row.price?.cny : row.price?.usd
                  return (
                    <tr key={row.model}>
                      <td className={css.mono}>
                        {row.model}
                        <span className={css.badgeBuiltin}>{t('config.sourceBuiltin')}</span>
                      </td>
                      <td className={css.num}>{set?.miss ?? t('common.na')}</td>
                      <td className={css.num}>{set?.hit ?? t('common.na')}</td>
                      <td className={css.num}>{set?.output ?? t('common.na')}</td>
                      <td className={css.num}>{row.records}</td>
                      <td>
                        <button type="button" className={css.rowBtn} onClick={() => { overrideBuiltin(row) }}>
                          {t('config.overrideAction')}
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </details>
      ) : null}

      <details className={css.priceSection} open={jsonOpen} onToggle={(event) => { setJsonOpen(event.currentTarget.open) }}>
        <summary className={css.fieldHint}>{t('config.advancedJson')}</summary>
        <textarea
          className={css.textarea}
          value={jsonDraft}
          spellCheck={false}
          onChange={(event) => { applyJson(event.target.value) }}
        />
        {jsonError ? <div className={css.failed}>{t('config.invalidJson')}</div> : null}
      </details>
    </div>
  )
}
