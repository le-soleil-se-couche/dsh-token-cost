/**
 * Session-log parser tests: usage folding per (turn, step) with last-wins,
 * model attribution from request/context, and session meta extraction.
 */

import { describe, expect, it } from 'vitest'
import { parseSessionLog } from '../src/parser.ts'

const LOG = [
  JSON.stringify({ type: 'session', version: 0, id: 'session-abc', createdAt: 1_700_000_000_000, cwd: '/tmp/work' }),
  JSON.stringify({ type: 'session/title', seq: 1, time: 1_700_000_000_100, data: { title: '成本统计' } }),
  JSON.stringify({ type: 'request/context', seq: 2, time: 1_700_000_000_200, data: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } }),
  JSON.stringify({ type: 'assistant/chunk', seq: 3, time: 1_700_000_000_300, data: { turn: 1, step: 1, chunk: { type: 'usage', usage: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 5000 } } } }),
  JSON.stringify({ type: 'assistant/message', seq: 4, time: 1_700_000_000_400, data: { turn: 1, step: 1, usage: { inputTokens: 1000, outputTokens: 120, cacheReadTokens: 5000, reasoningTokens: 30 } } }),
  JSON.stringify({ type: 'request/context', seq: 5, time: 1_700_000_000_500, data: { provider: 'deepseek-official', model: 'deepseek-v4-pro' } }),
  JSON.stringify({ type: 'assistant/message', seq: 6, time: 1_700_000_000_600, data: { turn: 2, step: 1, usage: { inputTokens: 2000, outputTokens: 50 } } }),
  'not json line',
].join('\n')

describe('parseSessionLog', () => {
  it('extracts meta and folds per-step usage with last-wins', () => {
    const parsed = parseSessionLog(LOG, 'session-abc', '')
    expect(parsed.meta.sessionId).toBe('session-abc')
    expect(parsed.meta.cwd).toBe('/tmp/work')
    expect(parsed.meta.title).toBe('成本统计')
    expect(parsed.meta.createdAt).toBe(1_700_000_000_000)
    expect(parsed.meta.lastActivity).toBe(1_700_000_000_600)
    expect(parsed.records).toHaveLength(2)
  })

  it('the message usage replaces the chunk sample for the same step', () => {
    const parsed = parseSessionLog(LOG, 'session-abc', '')
    const first = parsed.records[0]!
    expect(first.turn).toBe(1)
    expect(first.outputTokens).toBe(120)
    expect(first.reasoningTokens).toBe(30)
    expect(first.cacheReadTokens).toBe(5000)
    expect(first.inputTokens).toBe(1000)
  })

  it('attributes each step to its request model', () => {
    const parsed = parseSessionLog(LOG, 'session-abc', '')
    expect(parsed.records[0]!.model).toBe('deepseek-v4-flash')
    expect(parsed.records[1]!.model).toBe('deepseek-v4-pro')
  })

  it('tolerates garbage lines after a valid header and rejects missing headers', () => {
    const parsed = parseSessionLog(LOG, 'session-abc', '')
    expect(parsed.records).toHaveLength(2)
    expect(() => parseSessionLog('', 'x', '')).toThrow('missing its session header')
    expect(() => parseSessionLog(JSON.stringify({
      type: 'request/context',
      seq: 0,
      time: 1,
      data: { provider: 'fixture', model: 'fixture' },
    }), 'x', '')).toThrow('first session event must be a session header')
    expect(() => parseSessionLog(JSON.stringify({
      type: 'session',
      version: 0,
      createdAt: 1,
      cwd: '/fixture',
    }), 'x', '')).toThrow('session header id must be a non-empty string')
  })

  it('rejects a session header whose id does not match its storage directory', () => {
    expect(() => parseSessionLog(LOG, 'copied-session', '')).toThrow('does not match path id')
  })

  it('adds message-only usage from a started retry after a failed attempt with usage', () => {
    const log = [
      { type: 'session', version: 0, id: 'session-retry', createdAt: 1, cwd: '/fixture' },
      { type: 'request/context', seq: 0, time: 1, data: { provider: 'fixture', model: 'fixture' } },
      { type: 'assistant/chunk', seq: 1, time: 2, data: { turn: 1, step: 1, chunk: { type: 'usage', usage: { inputTokens: 3, outputTokens: 2 } } } },
      { type: 'assistant/chunk', seq: 2, time: 3, data: { turn: 1, step: 1, chunk: { type: 'finish', reason: { kind: 'error', failure: { message: 'fixture', code: 'FIXTURE' } } } } },
      { type: 'llm/retry-started', seq: 3, time: 4, data: { retryId: 'fixture-retry', turn: 1, step: 1, retry: 1 } },
      { type: 'assistant/chunk', seq: 4, time: 5, data: { turn: 1, step: 1, chunk: { type: 'finish', reason: { kind: 'stop' } } } },
      { type: 'assistant/message', seq: 5, time: 6, sourceEventSeqs: [4], data: { turn: 1, step: 1, usage: { inputTokens: 5, outputTokens: 4 } } },
    ].map((event) => JSON.stringify(event)).join('\n')

    const records = parseSessionLog(log, 'session-retry', '').records
    expect(records.map((record) => [record.inputTokens, record.outputTokens])).toEqual([
      [3, 2],
      [5, 4],
    ])
  })

  it('uses retry-started as the boundary when a failure finish is absent', () => {
    const log = [
      { type: 'session', version: 0, id: 'session-explicit-retry', createdAt: 1, cwd: '/fixture' },
      { type: 'request/context', seq: 0, time: 1, data: { provider: 'fixture', model: 'fixture' } },
      { type: 'assistant/chunk', seq: 1, time: 2, data: { turn: 1, step: 1, chunk: { type: 'usage', usage: { inputTokens: 3, outputTokens: 2 } } } },
      { type: 'llm/retry-started', seq: 2, time: 3, data: { retryId: 'fixture-retry', turn: 1, step: 1, retry: 1 } },
      { type: 'assistant/message', seq: 3, time: 4, sourceEventSeqs: [], data: { turn: 1, step: 1, usage: { inputTokens: 5, outputTokens: 4 } } },
    ].map((event) => JSON.stringify(event)).join('\n')

    const records = parseSessionLog(log, 'session-explicit-retry', '').records
    expect(records.map((record) => [record.inputTokens, record.outputTokens])).toEqual([
      [3, 2],
      [5, 4],
    ])
  })

  it('does not invent usage when a no-usage abort is followed by a started retry', () => {
    const log = [
      { type: 'session', version: 0, id: 'session-aborted', createdAt: 1, cwd: '/fixture' },
      { type: 'request/context', seq: 0, time: 1, data: { provider: 'fixture', model: 'fixture' } },
      { type: 'assistant/chunk', seq: 1, time: 2, data: { turn: 1, step: 1, chunk: { type: 'finish', reason: { kind: 'aborted', failure: { message: 'fixture', code: 'FIXTURE' } } } } },
      { type: 'llm/retry-started', seq: 2, time: 3, data: { retryId: 'fixture-retry', turn: 1, step: 1, retry: 1 } },
      { type: 'assistant/chunk', seq: 3, time: 4, data: { turn: 1, step: 1, chunk: { type: 'finish', reason: { kind: 'stop' } } } },
      { type: 'assistant/message', seq: 4, time: 5, sourceEventSeqs: [3], data: { turn: 1, step: 1, usage: { inputTokens: 5, outputTokens: 4 } } },
    ].map((event) => JSON.stringify(event)).join('\n')

    const records = parseSessionLog(log, 'session-aborted', '').records
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ inputTokens: 5, outputTokens: 4 })
  })

  it('does not split an attempt on a failure finish without retry-started', () => {
    const log = [
      { type: 'session', version: 0, id: 'session-late-message', createdAt: 1, cwd: '/fixture' },
      { type: 'request/context', seq: 0, time: 1, data: { provider: 'fixture', model: 'fixture' } },
      { type: 'assistant/chunk', seq: 1, time: 2, data: { turn: 1, step: 1, chunk: { type: 'usage', usage: { inputTokens: 3, outputTokens: 2 } } } },
      { type: 'assistant/chunk', seq: 2, time: 3, data: { turn: 1, step: 1, chunk: { type: 'finish', reason: { kind: 'error', failure: { message: 'fixture', code: 'FIXTURE' } } } } },
      { type: 'assistant/message', seq: 3, time: 4, sourceEventSeqs: [1, 2], data: { turn: 1, step: 1, usage: { inputTokens: 4, outputTokens: 3 } } },
    ].map((event) => JSON.stringify(event)).join('\n')

    const records = parseSessionLog(log, 'session-late-message', '').records
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ inputTokens: 4, outputTokens: 3 })
  })

  it('preserves the attempt route when its final message follows a route change', () => {
    const log = [
      { type: 'session', version: 0, id: 'session-late-route', createdAt: 1, cwd: '/fixture' },
      { type: 'request/context', seq: 0, time: 1, data: { provider: 'provider-a', model: 'model-a' } },
      { type: 'assistant/chunk', seq: 1, time: 2, data: { turn: 1, step: 1, chunk: { type: 'usage', usage: { inputTokens: 3, outputTokens: 2 } } } },
      { type: 'assistant/chunk', seq: 2, time: 3, data: { turn: 1, step: 1, chunk: { type: 'finish', reason: { kind: 'error', failure: { message: 'fixture', code: 'FIXTURE' } } } } },
      { type: 'request/context', seq: 3, time: 4, data: { provider: 'provider-b', model: 'model-b' } },
      { type: 'assistant/message', seq: 4, time: 5, sourceEventSeqs: [1, 2], data: { turn: 1, step: 1, usage: { inputTokens: 3, outputTokens: 2 } } },
    ].map((event) => JSON.stringify(event)).join('\n')

    const records = parseSessionLog(log, 'session-late-route', '').records
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      provider: 'provider-a',
      model: 'model-a',
      inputTokens: 3,
      outputTokens: 2,
    })
  })

  it('counts official compaction summary usage and ignores unofficial end usage', () => {
    const log = [
      { type: 'session', version: 0, id: 'session-compaction', createdAt: 1, cwd: '/fixture' },
      { type: 'request/context', seq: 0, time: 1, data: { provider: 'provider-fallback', model: 'model-fallback' } },
      { type: 'compaction/summary', seq: 1, time: 2, data: { compactionId: 'summary-success', provider: 'provider-summary', model: 'model-summary', usage: { inputTokens: 31, outputTokens: 9, cacheReadTokens: 37, cacheWriteTokens: 6 } } },
      { type: 'compaction/end', seq: 2, time: 3, data: { compactionId: 'unofficial-carrier', turn: null, error: 'truncated', provider: 'provider-end', model: 'model-end', usage: { inputTokens: 60, outputTokens: 8 } } },
    ].map((event) => JSON.stringify(event)).join('\n')

    const records = parseSessionLog(log, 'session-compaction', '').records
    expect(records).toHaveLength(1)
    expect(records).toEqual([
      expect.objectContaining({
        turn: -1,
        step: 1,
        provider: 'provider-summary',
        model: 'model-summary',
        inputTokens: 31,
        outputTokens: 9,
      }),
    ])
  })

  it('folds released-v2 embedded streams, packed runs, and retry boundaries', () => {
    const log = [
      {
        type: 'session', version: 2, id: 'session-v2-retry', createdAt: 1,
        cwd: '/fixture', isSeeded: false, delegationDepth: 0,
      },
      { type: 'request/context', seq: 0, time: 1, data: { provider: 'provider-a', model: 'model-a' } },
      {
        type: 'assistant/attempt', seq: 1, time: 5, data: {
          turn: 1,
          step: 1,
          stream: [
            { type: 'text-chunks', time0: 2, index: 0, dt: [1], texts: ['a', 'b'] },
            { type: 'chunk', time: 3, chunk: { type: 'usage', usage: { inputTokens: 3, outputTokens: 1 } } },
            { type: 'reasoning-chunks', time0: 3, index: 1, dt: [], texts: ['r'] },
            { type: 'chunk', time: 4, chunk: { type: 'usage', usage: { inputTokens: 4, outputTokens: 2 } } },
          ],
        },
      },
      { type: 'llm/retry-started', seq: 2, time: 6, data: { retryId: 'retry-v2', turn: 1, step: 1, retry: 1 } },
      { type: 'request/context', seq: 3, time: 7, data: { provider: 'provider-b', model: 'model-b' } },
      {
        type: 'assistant/message', seq: 4, time: 9, surfaceOp: 'append', data: {
          turn: 1,
          step: 1,
          message: {
            role: 'assistant', content: [],
            source: { kind: 'model', provider: 'provider-message', model: 'model-message' },
            id: 'message-v2',
          },
          usage: { inputTokens: 8, outputTokens: 5, cacheReadTokens: 13 },
          stream: [
            { type: 'tool-call-chunks', time0: 8, index: 0, dt: [], id: 'tool', name: 'read', args: ['{}'] },
            { type: 'chunk', time: 8, chunk: { type: 'usage', usage: { inputTokens: 999, outputTokens: 999 } } },
          ],
        },
      },
    ].map((event) => JSON.stringify(event)).join('\n')

    const records = parseSessionLog(log, 'session-v2-retry', '', 2).records
    expect(records).toHaveLength(2)
    expect(records[0]).toMatchObject({
      provider: 'provider-a',
      model: 'model-a',
      inputTokens: 4,
      outputTokens: 2,
    })
    expect(records[1]).toMatchObject({
      provider: 'provider-message',
      model: 'model-message',
      inputTokens: 8,
      outputTokens: 5,
      cacheReadTokens: 13,
    })
  })

  it('uses the last embedded v2 usage when assistant/message has no direct usage', () => {
    const log = [
      { type: 'session', version: 2, id: 'session-v2-stream', createdAt: 1, isSeeded: false, delegationDepth: 0 },
      { type: 'request/context', seq: 0, time: 1, data: { provider: 'provider', model: 'model' } },
      {
        type: 'assistant/message', seq: 1, time: 4, surfaceOp: 'append', data: {
          turn: 1,
          step: 1,
          message: { role: 'assistant', content: [], source: { kind: 'model', provider: 'provider', model: 'model' }, id: 'm' },
          stream: [
            { type: 'chunk', time: 2, chunk: { type: 'usage', usage: { inputTokens: 5, outputTokens: 2 } } },
            { type: 'chunk', time: 3, chunk: { type: 'usage', usage: { inputTokens: 7, outputTokens: 4 } } },
          ],
        },
      },
    ].map((event) => JSON.stringify(event)).join('\n')

    expect(parseSessionLog(log, 'session-v2-stream', '', 2).records).toEqual([
      expect.objectContaining({ inputTokens: 7, outputTokens: 4 }),
    ])
  })

  it('excludes a v2 fork prefix using the last inherited end-seed marker', () => {
    const log = [
      {
        type: 'session', version: 2, id: 'session-v2-child', createdAt: 1,
        parentSession: 'parent', isSeeded: true, delegationDepth: 1,
      },
      { type: 'request/context', seq: 0, time: 1, data: { provider: 'parent-provider', model: 'parent-model' } },
      {
        type: 'assistant/message', seq: 1, time: 2, data: {
          turn: 1, step: 1, message: { source: { kind: 'model', provider: 'parent-provider', model: 'parent-model' } },
          usage: { inputTokens: 100, outputTokens: 10 }, stream: [],
        },
      },
      { type: 'session/end-seed', seq: 2, time: 3, data: { inherited: true } },
      { type: 'request/context', seq: 3, time: 4, data: { provider: 'child-provider', model: 'child-model' } },
      {
        type: 'assistant/message', seq: 4, time: 5, data: {
          turn: 2, step: 1, message: { source: { kind: 'model', provider: 'child-provider', model: 'child-model' } },
          usage: { inputTokens: 20, outputTokens: 5 }, stream: [],
        },
      },
    ].map((event) => JSON.stringify(event)).join('\n')

    const records = parseSessionLog(log, 'session-v2-child', '', 2).records
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ model: 'child-model', inputTokens: 20, outputTokens: 5 })
  })

  it('refuses unknown generations, filename/header mismatches, and malformed v2 seed metadata', () => {
    expect(() => parseSessionLog(JSON.stringify({
      type: 'session', version: 3, id: 'future', createdAt: 1,
    }), 'future', '', 3)).toThrow('unsupported session format version v3')

    expect(() => parseSessionLog(JSON.stringify({
      type: 'session', version: 1, id: 'mismatch', createdAt: 1,
    }), 'mismatch', '', 2)).toThrow('filename identifies format v2')

    expect(() => parseSessionLog(JSON.stringify({
      type: 'session', version: 2, id: 'seeded', createdAt: 1,
      isSeeded: true, delegationDepth: 1,
    }), 'seeded', '', 2)).toThrow('lacks an inherited end-seed marker')
  })
})
