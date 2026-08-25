/**
 * Pure parser for DSH session logs (the zstd-compressed JSONL event stream
 * under `$DSH_HOME/sessions/<cwd-slug>/<session-id>/session.jsonl.zstd`).
 *
 * Billing-relevant events:
 * - `request/context` (`{provider, model}`) and `request/header`
 *   (`header.config.{provider, model}`) set the model of the current request;
 * - `assistant/chunk` with `chunk.type === 'usage'` reports per-step usage;
 * - `assistant/message` carries the final usage for the same turn/step.
 * - `assistant/chunk` with a failure finish closes one provider attempt;
 * - `compaction/summary.usage` reports an independent summarizer call.
 *
 * Within one provider attempt the LAST usage wins (message overrides its chunk
 * sample). A failure finish closes that attempt, so a retry under the same
 * (turn, step) adds another billable record. Forked children count only their
 * own events (`seq >= seedLength`) during cross-session aggregation.
 */

import type { SessionMeta, UsageRecord } from './protocol.ts'

export interface ParsedSession {
  meta: SessionMeta
  records: UsageRecord[]
}

/** Stable base key shared by every provider attempt of one loop step. */
function stepKey(turn: number | undefined, step: number | undefined): string {
  return `${turn ?? 0}:${step ?? 0}`
}

/** Current AgentLoop contract: only error/aborted finishes close an attempt. */
function closesAttempt(chunk: Record<string, unknown> | undefined): boolean {
  if (chunk?.type !== 'finish') return false
  const reason = chunk.reason as Record<string, unknown> | undefined
  if (reason === undefined) return false
  return reason.kind === 'error' || reason.kind === 'aborted'
}

/** Parse one session log text into meta + per-step usage records. */
export function parseSessionLog(text: string, sessionId: string, fallbackCwd: string): ParsedSession {
  let createdAt = 0
  let cwd = fallbackCwd
  let title = ''
  let lastActivity = 0
  let provider = ''
  let model = ''
  let seedLength = 0
  let headerSeen = false
  let eventCount = 0
  const attemptByStep = new Map<string, number>()
  const closedFinishBySeq = new Map<number, {
    base: string
    attempt: number
    provider: string
    model: string
  }>()
  const byAttempt = new Map<string, UsageRecord>()
  const independent: UsageRecord[] = []

  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line === '') continue
    let event: Record<string, unknown>
    try {
      event = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }
    if (eventCount === 0 && event.type !== 'session') {
      throw new Error('first session event must be a session header')
    }
    eventCount += 1
    const time = typeof event.time === 'number' ? event.time : 0
    const seq = typeof event.seq === 'number' ? event.seq : undefined
    // A seeded child physically carries the parent's prefix. Metadata from the
    // prefix may still establish the route/title, but its billable events belong
    // to the parent and must not be emitted again for this session.
    const ownsBillingEvent = seedLength === 0 || (seq !== undefined && seq >= seedLength)
    if (time > lastActivity) lastActivity = time
    switch (event.type) {
      case 'session': {
        // The session envelope carries createdAt/cwd at the top level.
        if (headerSeen) throw new Error('session log contains more than one session header')
        if (typeof event.id !== 'string' || event.id === '') {
          throw new Error('session header id must be a non-empty string')
        }
        if (event.id !== sessionId) {
          throw new Error(`session header id "${event.id}" does not match path id "${sessionId}"`)
        }
        headerSeen = true
        if (typeof event.createdAt === 'number' && event.createdAt > 0) createdAt = event.createdAt
        if (typeof event.cwd === 'string' && event.cwd !== '') cwd = event.cwd
        if (typeof event.seedLength === 'number'
          && Number.isSafeInteger(event.seedLength)
          && event.seedLength >= 0) {
          seedLength = event.seedLength
        }
        break
      }
      case 'session/title': {
        const data = event.data as Record<string, unknown> | undefined
        if (typeof data?.title === 'string' && data.title !== '') title = data.title
        break
      }
      case 'request/context': {
        const data = event.data as Record<string, unknown> | undefined
        if (typeof data?.model === 'string' && data.model !== '') {
          model = data.model
          if (typeof data.provider === 'string') provider = data.provider
        }
        break
      }
      case 'request/header': {
        const header = (event.data as Record<string, unknown> | undefined)?.header as
          | Record<string, unknown>
          | undefined
        const config = header?.config as Record<string, unknown> | undefined
        if (typeof config?.model === 'string' && config.model !== '') {
          model = config.model
          if (typeof config.provider === 'string') provider = config.provider
        }
        break
      }
      case 'assistant/chunk': {
        const data = event.data as Record<string, unknown> | undefined
        const chunk = data?.chunk as Record<string, unknown> | undefined
        if (!ownsBillingEvent) break
        if (chunk?.type === 'usage') {
          recordAttempt(data, chunk.usage, time)
        } else if (closesAttempt(chunk)) {
          closeAttempt(data, seq)
        }
        break
      }
      case 'assistant/message': {
        const data = event.data as Record<string, unknown> | undefined
        if (!ownsBillingEvent || data?.usage === undefined) break
        const sourceEventSeqs = Array.isArray(event.sourceEventSeqs)
          ? event.sourceEventSeqs.filter((value): value is number => typeof value === 'number')
          : undefined
        recordAttempt(data, data.usage, time, sourceEventSeqs)
        break
      }
      case 'compaction/summary': {
        const data = event.data as Record<string, unknown> | undefined
        if (!ownsBillingEvent || data?.usage === undefined) break
        recordIndependent(data, data.usage, time, seq)
        break
      }
    }
  }

  if (!headerSeen) throw new Error('session log is missing its session header')

  function recordAttempt(
    data: Record<string, unknown> | undefined,
    usage: unknown,
    time: number,
    sourceEventSeqs?: number[],
  ): void {
    const u = usage as Record<string, unknown> | undefined
    if (u === undefined) return
    const turn = typeof data?.turn === 'number' ? data.turn : 0
    const step = typeof data?.step === 'number' ? data.step : 0
    const base = stepKey(turn, step)
    const closed = sourceEventSeqs
      ?.map((seq) => closedFinishBySeq.get(seq))
      .find((entry) => entry?.base === base)
    const attempt = closed !== undefined
      ? closed.attempt
      : (attemptByStep.get(base) ?? 0)
    const key = `${base}:${attempt}`
    const previous = byAttempt.get(key)
    byAttempt.set(key, {
      time: Math.max(previous?.time ?? 0, time),
      turn,
      step,
      sessionId,
      sessionLabel: title !== '' ? title : sessionId,
      provider: previous?.provider || closed?.provider || provider || '',
      model: previous?.model || closed?.model || model || '',
      inputTokens: toCount(u.inputTokens, previous?.inputTokens),
      cacheReadTokens: toCount(u.cacheReadTokens, previous?.cacheReadTokens),
      cacheWriteTokens: toCount(u.cacheWriteTokens, previous?.cacheWriteTokens),
      outputTokens: toCount(u.outputTokens, previous?.outputTokens),
      reasoningTokens: toCount(u.reasoningTokens, previous?.reasoningTokens),
    })
  }

  function closeAttempt(
    data: Record<string, unknown> | undefined,
    seq: number | undefined,
  ): void {
    const turn = typeof data?.turn === 'number' ? data.turn : 0
    const step = typeof data?.step === 'number' ? data.step : 0
    const base = stepKey(turn, step)
    const attempt = attemptByStep.get(base) ?? 0
    if (seq !== undefined) {
      closedFinishBySeq.set(seq, { base, attempt, provider, model })
    }
    attemptByStep.set(base, attempt + 1)
  }

  function recordIndependent(
    data: Record<string, unknown> | undefined,
    usage: unknown,
    time: number,
    seq: number | undefined,
  ): void {
    const u = usage as Record<string, unknown> | undefined
    if (u === undefined) return
    independent.push({
      time,
      // Compaction is outside the loop turn/step vocabulary. A negative turn
      // plus its durable seq keeps the existing wire shape without colliding
      // with ordinary step keys in the detail table.
      turn: -1,
      step: seq ?? independent.length,
      sessionId,
      sessionLabel: title !== '' ? title : sessionId,
      provider: typeof data?.provider === 'string' ? data.provider : provider,
      model: typeof data?.model === 'string' ? data.model : model,
      inputTokens: toCount(u.inputTokens, undefined),
      cacheReadTokens: toCount(u.cacheReadTokens, undefined),
      cacheWriteTokens: toCount(u.cacheWriteTokens, undefined),
      outputTokens: toCount(u.outputTokens, undefined),
      reasoningTokens: toCount(u.reasoningTokens, undefined),
    })
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
