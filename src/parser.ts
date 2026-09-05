/**
 * Pure parser for DSH session logs.
 *
 * Released v0/v1 logs keep provider chunks as top-level `assistant/chunk`
 * events. Released v2 stores one settled attempt per `assistant/message` or
 * `assistant/attempt`, with its exact provider stream embedded in `data.stream`.
 * In every format the last usage sample inside one provider attempt wins, and
 * `llm/retry-started` opens the next billable attempt for the same turn/step.
 */

import type { SessionMeta, UsageRecord } from './protocol.ts'

export interface ParsedSession {
  meta: SessionMeta
  records: UsageRecord[]
}

/** Session generations whose released accounting grammar this parser knows. */
export const SUPPORTED_SESSION_FORMAT_VERSIONS = [0, 1, 2] as const
type SupportedSessionFormatVersion = (typeof SUPPORTED_SESSION_FORMAT_VERSIONS)[number]

/** Stable base key shared by every provider attempt of one loop step. */
function stepKey(turn: number | undefined, step: number | undefined): string {
  return `${turn ?? 0}:${step ?? 0}`
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function supportedVersion(value: unknown): SupportedSessionFormatVersion {
  if (value === 0 || value === 1 || value === 2) return value
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    throw new Error(`unsupported session format version v${value}`)
  }
  throw new Error('session header version must be a supported non-negative integer')
}

/**
 * Return the last usage chunk in a released-v2 embedded Assistant stream.
 * Packed text/reasoning/tool-call runs cannot carry usage; the official
 * grammar keeps usage as `{type:'chunk', time, chunk:{type:'usage', usage}}`.
 */
function lastEmbeddedUsage(stream: unknown): Record<string, unknown> | undefined {
  if (!Array.isArray(stream)) return undefined
  let usage: Record<string, unknown> | undefined
  for (const member of stream) {
    const record = objectRecord(member)
    if (record?.type !== 'chunk') continue
    const chunk = objectRecord(record.chunk)
    if (chunk?.type !== 'usage') continue
    const sample = objectRecord(chunk.usage)
    if (sample !== undefined) usage = sample
  }
  return usage
}

function messageRoute(data: Record<string, unknown> | undefined): {
  provider?: string
  model?: string
} {
  const message = objectRecord(data?.message)
  const source = objectRecord(message?.source)
  return {
    ...(typeof source?.provider === 'string' && source.provider !== ''
      ? { provider: source.provider }
      : {}),
    ...(typeof source?.model === 'string' && source.model !== ''
      ? { model: source.model }
      : {}),
  }
}

/**
 * Parse one complete session log into metadata and per-attempt usage records.
 * `expectedVersion` is the generation encoded in the selected canonical
 * filename; a mismatch refuses the artifact instead of silently reclassifying
 * it or falling back to an older migrated copy.
 */
export function parseSessionLog(
  text: string,
  sessionId: string,
  fallbackCwd: string,
  expectedVersion?: number,
): ParsedSession {
  let createdAt = 0
  let cwd = fallbackCwd
  let title = ''
  let lastActivity = 0
  let headerSeen = false
  let formatVersion: SupportedSessionFormatVersion | undefined
  let seedLength = 0
  let v2IsSeeded = false
  const events: Record<string, unknown>[] = []

  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line === '') continue
    let event: Record<string, unknown>
    try {
      const parsed = JSON.parse(line) as unknown
      const record = objectRecord(parsed)
      if (record === undefined) continue
      event = record
    } catch {
      continue
    }
    if (!headerSeen) {
      if (event.type !== 'session') throw new Error('first session event must be a session header')
      if (typeof event.id !== 'string' || event.id === '') {
        throw new Error('session header id must be a non-empty string')
      }
      if (event.id !== sessionId) {
        throw new Error(`session header id "${event.id}" does not match path id "${sessionId}"`)
      }
      formatVersion = supportedVersion(event.version)
      if (expectedVersion !== undefined && expectedVersion !== formatVersion) {
        throw new Error(
          `session filename identifies format v${expectedVersion}, but its header identifies v${formatVersion}`,
        )
      }
      headerSeen = true
      if (typeof event.createdAt === 'number' && event.createdAt > 0) createdAt = event.createdAt
      if (typeof event.cwd === 'string' && event.cwd !== '') cwd = event.cwd
      if (formatVersion < 2) {
        if (typeof event.seedLength === 'number'
          && Number.isSafeInteger(event.seedLength)
          && event.seedLength >= 0) {
          seedLength = event.seedLength
        }
      } else {
        if (typeof event.isSeeded !== 'boolean') {
          throw new Error('session format v2 header is missing boolean isSeeded')
        }
        v2IsSeeded = event.isSeeded
      }
      continue
    }
    if (event.type === 'session') throw new Error('session log contains more than one session header')
    events.push(event)
    const time = typeof event.time === 'number'
      ? event.time
      : typeof event.time0 === 'number' ? event.time0 : 0
    if (time > lastActivity) lastActivity = time
  }

  if (!headerSeen || formatVersion === undefined) {
    throw new Error('session log is missing its session header')
  }

  if (formatVersion === 2) {
    let inheritedCut: number | undefined
    for (const event of events) {
      if (event.type !== 'session/end-seed') continue
      const data = objectRecord(event.data)
      if (data?.inherited !== true) continue
      const seq = typeof event.seq === 'number' && Number.isSafeInteger(event.seq) && event.seq >= 0
        ? event.seq
        : undefined
      if (seq === undefined) throw new Error('session format v2 inherited end-seed marker needs a valid seq')
      inheritedCut = seq
    }
    if (v2IsSeeded && inheritedCut === undefined) {
      throw new Error('session format v2 seeded header lacks an inherited end-seed marker')
    }
    if (!v2IsSeeded && inheritedCut !== undefined) {
      throw new Error('session format v2 unseeded header contains an inherited end-seed marker')
    }
    seedLength = inheritedCut ?? 0
  }

  let provider = ''
  let model = ''
  const attemptByStep = new Map<string, number>()
  const byAttempt = new Map<string, UsageRecord>()
  const independent: UsageRecord[] = []

  const ownsBillingEvent = (event: Record<string, unknown>): boolean => {
    if (seedLength === 0) return true
    return typeof event.seq === 'number' && event.seq >= seedLength
  }

  const recordAttempt = (
    data: Record<string, unknown> | undefined,
    usage: Record<string, unknown> | undefined,
    time: number,
    route: { provider?: string; model?: string } = {},
  ): void => {
    if (usage === undefined) return
    const turn = typeof data?.turn === 'number' ? data.turn : 0
    const step = typeof data?.step === 'number' ? data.step : 0
    const base = stepKey(turn, step)
    const attempt = attemptByStep.get(base) ?? 0
    const key = `${base}:${attempt}`
    const previous = byAttempt.get(key)
    byAttempt.set(key, {
      time: Math.max(previous?.time ?? 0, time),
      turn,
      step,
      sessionId,
      sessionLabel: title !== '' ? title : sessionId,
      provider: previous?.provider || route.provider || provider || '',
      model: previous?.model || route.model || model || '',
      inputTokens: toCount(usage.inputTokens, previous?.inputTokens),
      cacheReadTokens: toCount(usage.cacheReadTokens, previous?.cacheReadTokens),
      cacheWriteTokens: toCount(usage.cacheWriteTokens, previous?.cacheWriteTokens),
      outputTokens: toCount(usage.outputTokens, previous?.outputTokens),
      reasoningTokens: toCount(usage.reasoningTokens, previous?.reasoningTokens),
    })
  }

  for (const event of events) {
    const time = typeof event.time === 'number' ? event.time : 0
    const seq = typeof event.seq === 'number' ? event.seq : undefined
    const owned = ownsBillingEvent(event)
    switch (event.type) {
      case 'session/title': {
        const data = objectRecord(event.data)
        if (typeof data?.title === 'string' && data.title !== '') title = data.title
        break
      }
      case 'request/context': {
        const data = objectRecord(event.data)
        if (typeof data?.model === 'string' && data.model !== '') {
          model = data.model
          if (typeof data.provider === 'string') provider = data.provider
        }
        break
      }
      case 'request/header': {
        const header = objectRecord(objectRecord(event.data)?.header)
        const config = objectRecord(header?.config)
        if (typeof config?.model === 'string' && config.model !== '') {
          model = config.model
          if (typeof config.provider === 'string') provider = config.provider
        }
        break
      }
      case 'assistant/chunk': {
        if (formatVersion === 2 || !owned) break
        const data = objectRecord(event.data)
        const chunk = objectRecord(data?.chunk)
        if (chunk?.type === 'usage') recordAttempt(data, objectRecord(chunk.usage), time)
        break
      }
      case 'assistant/message': {
        if (!owned) break
        const data = objectRecord(event.data)
        if (formatVersion === 2) {
          recordAttempt(
            data,
            objectRecord(data?.usage) ?? lastEmbeddedUsage(data?.stream),
            time,
            messageRoute(data),
          )
        } else {
          recordAttempt(data, objectRecord(data?.usage), time)
        }
        break
      }
      case 'assistant/attempt': {
        if (formatVersion !== 2 || !owned) break
        const data = objectRecord(event.data)
        recordAttempt(data, lastEmbeddedUsage(data?.stream), time)
        break
      }
      case 'llm/retry-started': {
        if (!owned) break
        const data = objectRecord(event.data)
        const turn = typeof data?.turn === 'number' ? data.turn : 0
        const step = typeof data?.step === 'number' ? data.step : 0
        const base = stepKey(turn, step)
        attemptByStep.set(base, (attemptByStep.get(base) ?? 0) + 1)
        break
      }
      case 'compaction/summary': {
        if (!owned) break
        const data = objectRecord(event.data)
        const usage = objectRecord(data?.usage)
        if (usage === undefined) break
        independent.push({
          time,
          // Compaction is outside the loop turn/step vocabulary. A negative
          // turn plus durable seq keeps the existing detail wire shape.
          turn: -1,
          step: seq ?? independent.length,
          sessionId,
          sessionLabel: title !== '' ? title : sessionId,
          provider: typeof data?.provider === 'string' ? data.provider : provider,
          model: typeof data?.model === 'string' ? data.model : model,
          inputTokens: toCount(usage.inputTokens, undefined),
          cacheReadTokens: toCount(usage.cacheReadTokens, undefined),
          cacheWriteTokens: toCount(usage.cacheWriteTokens, undefined),
          outputTokens: toCount(usage.outputTokens, undefined),
          reasoningTokens: toCount(usage.reasoningTokens, undefined),
        })
        break
      }
    }
  }

  const records = [...byAttempt.values(), ...independent].sort((a, b) => a.time - b.time)
  return {
    meta: {
      sessionId,
      cwd,
      title,
      createdAt,
      lastActivity,
    },
    records,
  }
}

function toCount(value: unknown, fallback: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : (fallback ?? 0)
}
