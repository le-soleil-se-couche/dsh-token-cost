/**
 * The /api/dsh-token-cost route family: status, time-window summary, session
 * listing, per-session detail and resync. Every route carries the loopback
 * trust fence plus browser same-origin markers (same pattern as dsh-ssh):
 * these endpoints expose usage/cost facts, so LAN-exposed deployments must
 * not serve them.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { buildModelCatalog, collectModelUsage } from './catalog.ts'
import type { SessionLedger } from './ledger.ts'
import { parseCustomPrices, PRICE_SCHEMES, priceRecord, totalsFor } from './pricing.ts'
import type { CustomPriceStore } from './price-store.ts'
import type { CostGroupRow, ModelPrice, PriceScheme, UsageRecord } from './protocol.ts'
import { TOKEN_COST_API } from './protocol.ts'

/** Pricing facts resolved from plugin settings per request. */
export interface PricingSource {
  priceMode: string
  currency: string
}

/** Route dependencies. */
export interface TokenCostRoutesDeps {
  ledger: SessionLedger
  /** Resolve pricing facts; called per request so settings edits land live. */
  pricing: () => PricingSource
  /** Rebuild the catalog: schemes + custom overrides. */
  schemes: () => PriceScheme[]
  /** Raw custom prices (unmerged) so /models can tell builtin from override. */
  customPrices: () => Record<string, ModelPrice>
  /** Persist custom prices independently of the settings document. */
  priceStore: CustomPriceStore
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => { chunks.push(chunk) })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim()
      if (raw === '') {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(raw) as unknown)
      } catch (error) {
        reject(error)
      }
    })
    req.on('error', reject)
  })
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'referrer-policy': 'no-referrer',
  })
  res.end(payload)
}

/** Loopback check plus browser same-origin markers. */
function isLoopbackRequest(request: IncomingMessage): boolean {
  const address = request.socket.remoteAddress
  if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') return false
  const host = request.headers.host
  if (typeof host !== 'string') return false
  let hostUrl: URL
  try {
    hostUrl = new URL(`http://${host}`)
  } catch {
    return false
  }
  if (hostUrl.hostname !== '127.0.0.1' && hostUrl.hostname !== 'localhost' && hostUrl.hostname !== '[::1]') return false
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

function readQuery(url: URL): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of url.searchParams.entries()) out[key] = value
  return out
}

/** Number query helper: absent or unparsable returns the fallback. */
function queryNumber(query: Record<string, string>, key: string, fallback: number): number {
  const raw = query[key]
  if (raw === undefined) return fallback
  const value = Number(raw)
  return Number.isFinite(value) ? value : fallback
}

/** Group records by a key/label pair, sorted by cost descending. */
function groupBy(
  records: UsageRecord[],
  labelOf: (record: UsageRecord) => { key: string; label: string },
  schemes: PriceScheme[],
  forcedId?: string,
): CostGroupRow[] {
  const groups = new Map<string, { label: string; records: UsageRecord[] }>()
  for (const record of records) {
    const { key, label } = labelOf(record)
    let group = groups.get(key)
    if (group === undefined) {
      group = { label, records: [] }
      groups.set(key, group)
    }
    group.records.push(record)
  }
  const rows: CostGroupRow[] = []
  for (const group of groups.values()) {
    const { totals, priced } = totalsFor(group.records, schemes, forcedId)
    rows.push({ key: group.label, label: group.label, totals, priced })
  }
  rows.sort((a, b) => b.totals.costCny - a.totals.costCny)
  return rows
}

/**
 * Local day label for a timestamp under a UTC offset (minutes): the viewer's
 * date, so midnight-crossing conversations split on the viewer's midnight.
 * @param time - epoch ms.
 * @param tzOffsetMinutes - client UTC offset, e.g. 480 for UTC+8.
 */
export function dayLabelForTime(time: number, tzOffsetMinutes: number): string {
  const day = new Date(time + tzOffsetMinutes * 60_000)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${day.getUTCFullYear()}-${pad(day.getUTCMonth() + 1)}-${pad(day.getUTCDate())}`
}

/** Build the route list. */
export function makeRoutes(deps: TokenCostRoutesDeps): WebRoute[] {
  const { ledger } = deps

  /** Fence + method check, writing the error response on failure. */
  const guard = (req: IncomingMessage, res: ServerResponse, method: string): boolean => {
    if (!isLoopbackRequest(req)) {
      writeJson(res, 403, { error: 'forbidden: loopback-only' })
      return false
    }
    if (req.method !== method) {
      writeJson(res, 405, { error: `method not allowed: ${req.method}` })
      return false
    }
    return true
  }

  return [
    {
      kind: 'exact',
      path: `${TOKEN_COST_API}/status`,
      handler: async (req, res) => {
        if (!guard(req, res, 'GET')) return
        await ledger.sync()
        const schemes = deps.schemes()
        const pricing = deps.pricing()
        const now = Date.now()
        const active = schemes
          .filter((scheme) => scheme.effectiveFrom <= now)
          .at(-1)
        const next = schemes.find((scheme) => scheme.effectiveFrom > now)
        writeJson(res, 200, {
          ok: true,
          ledger: ledger.stats(),
          pricing: {
            schemes,
            activeNow: active?.id ?? schemes[0]?.id ?? '',
            nextSwitchAt: next?.effectiveFrom ?? 0,
            priceMode: pricing.priceMode,
            currency: pricing.currency,
          },
        })
      },
    },
    {
      kind: 'exact',
      path: `${TOKEN_COST_API}/summary`,
      handler: async (req, res) => {
        if (!guard(req, res, 'GET')) return
        await ledger.sync()
        const url = new URL(req.url ?? '/', 'http://localhost')
        const query = readQuery(url)
        const from = queryNumber(query, 'from', 0)
        const to = queryNumber(query, 'to', Number.MAX_SAFE_INTEGER)
        const modelFilter = (query.model ?? '').trim().toLowerCase()
        const sessionFilter = (query.session ?? '').trim()
        // Client timezone offset in minutes (UTC+8 is +480): day bucketing
        // follows the requesting client, not UTC, so midnight-crossing and
        // timezone-switching conversations land on the viewer's days.
        const tzOffsetMinutes = queryNumber(query, 'tz', 0)
        const pricing = deps.pricing()
        const schemes = deps.schemes()
        const selected: UsageRecord[] = []
        for (const { meta, records } of ledger.sessions()) {
          if (sessionFilter !== '' && meta.sessionId !== sessionFilter) continue
          for (const record of records) {
            if (record.time < from || record.time >= to) continue
            if (modelFilter !== '' && record.model.toLowerCase() !== modelFilter) continue
            selected.push(record)
          }
        }
        const { totals, priced, unpricedModels } = totalsFor(selected, schemes, pricing.priceMode)
        const byModel = groupBy(selected, (record) => ({
          key: record.model,
          label: record.model,
        }), schemes, pricing.priceMode)
        const bySession = groupBy(selected, (record) => ({
          key: record.sessionId,
          label: record.sessionLabel,
        }), schemes, pricing.priceMode)
        const byDay = groupBy(selected, (record) => {
          const label = dayLabelForTime(record.time, tzOffsetMinutes)
          return { key: label, label }
        }, schemes, pricing.priceMode)
        writeJson(res, 200, {
          ok: true,
          from,
          to,
          totals,
          priced,
          unpricedModels,
          byModel,
          bySession,
          byDay,
        })
      },
    },
    {
      kind: 'exact',
      path: `${TOKEN_COST_API}/sessions`,
      handler: async (req, res) => {
        if (!guard(req, res, 'GET')) return
        await ledger.sync()
        const pricing = deps.pricing()
        const schemes = deps.schemes()
        const rows = ledger.sessions()
          .map(({ meta, records }) => {
            const { totals } = totalsFor(records, schemes, pricing.priceMode)
            return {
              sessionId: meta.sessionId,
              cwd: meta.cwd,
              title: meta.title,
              createdAt: meta.createdAt,
              lastActivity: meta.lastActivity,
              totals,
            }
          })
          .sort((a, b) => b.lastActivity - a.lastActivity)
        writeJson(res, 200, { ok: true, sessions: rows })
      },
    },
    {
      kind: 'prefix',
      path: `${TOKEN_COST_API}/session`,
      handler: async (req, res) => {
        if (!guard(req, res, 'GET')) return
        await ledger.sync()
        const url = new URL(req.url ?? '/', 'http://localhost')
        const id = url.pathname.slice(`${TOKEN_COST_API}/session/`.length)
        const session = ledger.session(id)
        if (session === undefined) {
          writeJson(res, 404, { ok: false, error: `no such session: ${id}` })
          return
        }
        const pricing = deps.pricing()
        const schemes = deps.schemes()
        const { totals, priced } = totalsFor(session.records, schemes, pricing.priceMode)
        const costs = session.records.map((record) => {
          const cost = priceRecord(record, schemes, pricing.priceMode)
          return cost ?? { costCny: 0, costUsd: 0, schemeId: '', peak: null }
        })
        writeJson(res, 200, {
          ok: true,
          meta: session.meta,
          totals,
          priced,
          records: session.records,
          costs,
        })
      },
    },
    {
      kind: 'exact',
      path: `${TOKEN_COST_API}/models`,
      handler: async (req, res) => {
        if (!guard(req, res, 'GET')) return
        await deps.priceStore.whenReady()
        await ledger.sync()
        const records: UsageRecord[] = []
        for (const session of ledger.sessions()) records.push(...session.records)
        writeJson(res, 200, {
          ok: true,
          models: buildModelCatalog(collectModelUsage(records), deps.customPrices(), PRICE_SCHEMES),
        })
      },
    },
    {
      kind: 'exact',
      path: `${TOKEN_COST_API}/prices`,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        let body: unknown
        try {
          body = await readJsonBody(req)
        } catch {
          writeJson(res, 400, { ok: false, error: 'invalid JSON body' })
          return
        }
        const raw = typeof body === 'object' && body !== null
          ? (body as { customPrices?: unknown }).customPrices
          : undefined
        if (typeof raw !== 'string') {
          writeJson(res, 400, { ok: false, error: 'customPrices string required' })
          return
        }
        let parsed: Record<string, ModelPrice>
        try {
          parsed = parseCustomPrices(raw)
        } catch (error) {
          writeJson(res, 400, {
            ok: false,
            error: error instanceof Error ? error.message : 'invalid custom prices',
          })
          return
        }
        try {
          await deps.priceStore.replace(parsed)
        } catch (error) {
          writeJson(res, 500, {
            ok: false,
            error: error instanceof Error ? error.message : 'failed to persist prices',
          })
          return
        }
        await ledger.sync()
        const records: UsageRecord[] = []
        for (const session of ledger.sessions()) records.push(...session.records)
        writeJson(res, 200, {
          ok: true,
          models: buildModelCatalog(collectModelUsage(records), deps.priceStore.get(), PRICE_SCHEMES),
        })
      },
    },
    {
      kind: 'exact',
      path: `${TOKEN_COST_API}/resync`,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        await ledger.sync(true)
        writeJson(res, 200, { ok: true, ledger: ledger.stats() })
      },
    },
  ]
}