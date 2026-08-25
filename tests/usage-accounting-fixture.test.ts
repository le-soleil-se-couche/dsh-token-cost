/**
 * Public usage-accounting fixture: hand-computed fold results plus a fail-closed
 * privacy shape check. The fixture is fully synthetic; only the separately
 * labelled reconciliation counters came from the authorized aggregate.
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { decompress } from 'fzstd'
import { describe, expect, it } from 'vitest'
import { parseSessionLog } from '../src/parser.ts'
import type { UsageRecord } from '../src/protocol.ts'

interface FixtureTotals {
  records: number
  inputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  outputTokens: number
  reasoningTokens: number
}

interface FixtureExpected {
  schemaVersion: number
  fixtureDataKind: string
  fold: Record<string, FixtureTotals>
}

const ROOT = join(__dirname, 'fixtures', 'usage-accounting')
const PARENT = join(ROOT, 'sessions', '--fixture--', 'session-fixture-parent', 'session.jsonl')
const CHILD = join(ROOT, 'sessions', '--fixture--', 'session-fixture-child', 'session.jsonl')
const OPAQUE_SOURCE = join(__dirname, 'fixtures', 'opaque-session.jsonl')
const OPAQUE_ZSTD = join(__dirname, 'fixtures', 'opaque-session.jsonl.zstd')
const MISSING_HEADER_SOURCE = join(__dirname, 'fixtures', 'missing-session-header.jsonl')
const MISSING_HEADER_ZSTD = join(__dirname, 'fixtures', 'missing-session-header.jsonl.zstd')
const MISSING_ID_SOURCE = join(__dirname, 'fixtures', 'missing-session-id.jsonl')
const MISSING_ID_ZSTD = join(__dirname, 'fixtures', 'missing-session-id.jsonl.zstd')
const EXPECTED = JSON.parse(readFileSync(join(ROOT, 'expected.json'), 'utf8')) as FixtureExpected

function totals(records: UsageRecord[]): FixtureTotals {
  return records.reduce<FixtureTotals>((sum, record) => ({
    records: sum.records + 1,
    inputTokens: sum.inputTokens + record.inputTokens,
    cacheReadTokens: sum.cacheReadTokens + record.cacheReadTokens,
    cacheWriteTokens: sum.cacheWriteTokens + record.cacheWriteTokens,
    outputTokens: sum.outputTokens + record.outputTokens,
    reasoningTokens: sum.reasoningTokens + record.reasoningTokens,
  }), {
    records: 0,
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
  })
}

function add(left: FixtureTotals, right: FixtureTotals): FixtureTotals {
  return {
    records: left.records + right.records,
    inputTokens: left.inputTokens + right.inputTokens,
    cacheReadTokens: left.cacheReadTokens + right.cacheReadTokens,
    cacheWriteTokens: left.cacheWriteTokens + right.cacheWriteTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    reasoningTokens: left.reasoningTokens + right.reasoningTokens,
  }
}

function jsonl(file: string): Array<Record<string, unknown>> {
  return readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>)
}

function filesUnder(root: string): string[] {
  const files: string[] = []
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) visit(path)
      else files.push(relative(root, path))
    }
  }
  visit(root)
  return files.sort()
}

function walk(
  value: unknown,
  visit: (key: string, entry: unknown, path: string) => void,
  path = '$',
): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      const child = `${path}[${index}]`
      visit('[]', entry, child)
      walk(entry, visit, child)
    })
    return
  }
  if (value === null || typeof value !== 'object') return
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const child = `${path}.${key}`
    visit(key, entry, child)
    walk(entry, visit, child)
  }
}

describe('public usage-accounting fixture', () => {
  it('folds attempt replacement, retry, compaction and fork seed to hand-computed totals', () => {
    const parent = parseSessionLog(readFileSync(PARENT, 'utf8'), 'session-fixture-parent', '/fixture')
    const child = parseSessionLog(readFileSync(CHILD, 'utf8'), 'session-fixture-child', '/fixture')
    const parentTotals = totals(parent.records)
    const childTotals = totals(child.records)

    expect(parentTotals).toEqual(EXPECTED.fold['session-fixture-parent'])
    expect(childTotals).toEqual(EXPECTED.fold['session-fixture-child'])
    expect(add(parentTotals, childTotals)).toEqual(EXPECTED.fold.aggregate)

    // Each non-zero failed attempt remains billable alongside its retry.
    expect(parent.records.filter((record) => record.turn === 2)).toHaveLength(2)
    // A merge-extended kind is not a boundary under the current AgentLoop
    // contract, so its assistant message replaces the preceding chunk sample.
    expect(parent.records.filter((record) => record.turn === 3)).toHaveLength(1)
    // Compaction is an independent call outside the loop turn vocabulary.
    expect(parent.records.filter((record) => record.turn === -1)).toHaveLength(1)
    // The failure-without-usage event does not create a phantom zero record.
    expect(parent.records.some((record) => record.turn === 5)).toBe(false)
    // The child reports only its own post-seed request.
    expect(child.records).toHaveLength(1)
    expect(child.records[0]!.turn).toBe(4)
  })

  it('keeps public expected values fully synthetic', () => {
    expect(EXPECTED.fixtureDataKind).toBe('fully-synthetic')
  })

  it('contains only allowlisted fixture structure and placeholder scalar values', () => {
    const extraFixtures = [
      [OPAQUE_SOURCE, OPAQUE_ZSTD],
      [MISSING_HEADER_SOURCE, MISSING_HEADER_ZSTD],
      [MISSING_ID_SOURCE, MISSING_ID_ZSTD],
    ] as const
    for (const [source, compressed] of extraFixtures) {
      const sourceText = readFileSync(source, 'utf8')
      const decoded = new TextDecoder().decode(decompress(new Uint8Array(readFileSync(compressed))))
      expect(decoded).toBe(sourceText)
    }
    const events = [
      ...jsonl(PARENT),
      ...jsonl(CHILD),
      ...extraFixtures.flatMap(([source]) => jsonl(source)),
    ]
    expect(events).toHaveLength(33)
    const fixtureFiles = filesUnder(ROOT)
    expect(fixtureFiles).toEqual([
      'README.md',
      'expected.json',
      'sessions/--fixture--/session-fixture-child/session.jsonl',
      'sessions/--fixture--/session-fixture-parent/session.jsonl',
    ])

    const allowedEventTypes = new Set([
      'session',
      'request/context',
      'assistant/chunk',
      'assistant/message',
      'llm/retry',
      'llm/retry-started',
      'compaction/summary',
      'session/end-seed',
    ])
    const allowedKeys = new Set([
      'type', 'version', 'id', 'createdAt', 'cwd', 'delegationDepth',
      'parentSession', 'seedLength', 'seq', 'time', 'data', 'provider',
      'model', 'turn', 'step', 'chunk', 'usage', 'inputTokens',
      'outputTokens', 'cacheReadTokens', 'cacheWriteTokens',
      'reasoningTokens', 'reason', 'kind', 'failure', 'message', 'code',
      'sourceEventSeqs', 'retryId', 'mode', 'policyKey', 'retry',
      'maxRetries', 'delayMs', 'compactionId', 'summary', 'shadowedRange',
      'start', 'end', 'shadowedSeqs', 'shadowedTokenCount',
      '[]',
    ])
    const allowedStrings = new Set([
      ...allowedEventTypes,
      'session-fixture-parent', 'session-fixture-child', '/fixture',
      'opaque-fixture-id', 'deepseek-official', 'deepseek-v4-flash',
      'provider-fixture', 'model-fixture', 'usage', 'finish', 'stop', 'error',
      'fixture-provider-failure', 'fixture-failure',
      'fixture-failure-without-usage', 'FIXTURE_FAILURE',
      'retry-fixture-001', 'normal', 'fixture-policy',
      'compaction-fixture-001',
    ])
    const sensitivePatterns = [
      /https?:\/\//i,
      /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
      /\/(?:Users|home)\//,
      /\b(?:sk|key)-[A-Za-z0-9_-]{8,}\b/,
    ]

    for (const file of fixtureFiles) {
      const text = readFileSync(join(ROOT, file), 'utf8')
      for (const pattern of sensitivePatterns) {
        expect(pattern.test(text), `sensitive text in fixture file ${file}`).toBe(false)
      }
    }

    for (const event of events) {
      expect(allowedEventTypes.has(String(event.type))).toBe(true)
      walk(event, (key, entry, path) => {
        expect(allowedKeys.has(key), `unexpected fixture key at ${path}`).toBe(true)
        if (typeof entry !== 'string') return
        expect(allowedStrings.has(entry), `unexpected fixture string at ${path}`).toBe(true)
        for (const pattern of sensitivePatterns) {
          expect(pattern.test(entry), `sensitive fixture string at ${path}`).toBe(false)
        }
      })
      if (event.type === 'compaction/summary') {
        expect((event.data as { summary?: unknown }).summary).toEqual([])
      }
      if (event.type === 'assistant/message') {
        expect(Array.isArray(event.sourceEventSeqs)).toBe(true)
        expect((event.data as Record<string, unknown>).sourceEventSeqs).toBeUndefined()
      }
    }

    const allowedExpectedKeys = new Set([
      'schemaVersion', 'fixtureDataKind', 'fold',
      'session-fixture-parent', 'session-fixture-child', 'aggregate', 'records',
      'inputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens',
      'reasoningTokens', '[]',
    ])
    const allowedExpectedStrings = new Set([
      'fully-synthetic',
    ])
    walk(EXPECTED, (key, entry, path) => {
      expect(allowedExpectedKeys.has(key), `unexpected expected.json key at ${path}`).toBe(true)
      if (typeof entry === 'string') {
        expect(allowedExpectedStrings.has(entry), `unexpected expected.json string at ${path}`).toBe(true)
        for (const pattern of sensitivePatterns) {
          expect(pattern.test(entry), `sensitive expected.json string at ${path}`).toBe(false)
        }
      }
      if (typeof entry === 'number') {
        expect(Number.isFinite(entry), `non-finite expected.json number at ${path}`).toBe(true)
        expect(entry, `negative expected.json number at ${path}`).toBeGreaterThanOrEqual(0)
      }
    })

    expect(events[0]!.id).toBe('session-fixture-parent')
    expect(events.find((event) => event.id === 'session-fixture-child')?.cwd).toBe('/fixture')
  })
})
