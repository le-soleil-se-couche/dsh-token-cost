/**
 * Ledger tests: incremental sync over real zstd session-log files.
 */

import { copyFileSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { SessionLedger, sessionIdFromPath } from '../src/ledger.ts'

/** Committed zstd fixtures: session-a bills 100 input tokens, session-b 200. */
const FIXTURE_A = join(__dirname, 'fixtures', 'session-a.jsonl.zstd')
const FIXTURE_B = join(__dirname, 'fixtures', 'session-b.jsonl.zstd')
const FIXTURE_OPAQUE = join(__dirname, 'fixtures', 'opaque-session.jsonl.zstd')
const FIXTURE_MISSING_HEADER = join(__dirname, 'fixtures', 'missing-session-header.jsonl.zstd')
const FIXTURE_MISSING_ID = join(__dirname, 'fixtures', 'missing-session-id.jsonl.zstd')
const FIXTURE_ESCAPED_ID = join(__dirname, 'fixtures', 'escaped-session-id.jsonl.zstd')

function plainSession(version: 0 | 1 | 2, id: string, inputTokens: number): string {
  const header = version === 2
    ? { type: 'session', version, id, createdAt: 1, isSeeded: false, delegationDepth: 0 }
    : { type: 'session', version, id, createdAt: 1, delegationDepth: 0 }
  const events = version === 2
    ? [
        { type: 'request/context', seq: 0, time: 1, data: { provider: 'fixture', model: 'model-v2' } },
        {
          type: 'assistant/message', seq: 1, time: 2, surfaceOp: 'append', data: {
            turn: 1,
            step: 1,
            message: { role: 'assistant', content: [], source: { kind: 'model', provider: 'fixture', model: 'model-v2' }, id: 'm' },
            usage: { inputTokens, outputTokens: 1 },
            stream: [],
          },
        },
      ]
    : [
        { type: 'request/context', seq: 0, time: 1, data: { provider: 'fixture', model: `model-v${version}` } },
        { type: 'assistant/message', seq: 1, time: 2, data: { turn: 1, step: 1, usage: { inputTokens, outputTokens: 1 } } },
      ]
  return [header, ...events].map((event) => JSON.stringify(event)).join('\n') + '\n'
}

describe('SessionLedger', () => {
  it('decodes the official canonical session-id directory encoding', () => {
    expect(sessionIdFromPath('/sessions/--fixture--/session~002Fchild/session.jsonl.zstd'))
      .toBe('session/child')
    expect(sessionIdFromPath('/sessions/--fixture--/~002E/session.jsonl.zstd')).toBe('.')
    expect(sessionIdFromPath('C:\\sessions\\--fixture--\\session~002Fchild\\session.v2.jsonl.zstd'))
      .toBe('session/child')
    expect(() => sessionIdFromPath('/sessions/--fixture--/session~00ff/session.jsonl.zstd'))
      .toThrow('invalid escape')
    expect(() => sessionIdFromPath('/sessions/--fixture--/session~0041/session.jsonl.zstd'))
      .toThrow('not canonically encoded')
  })

  it('parses new sessions, skips unchanged files, and re-parses changed ones', async () => {
    const root = mkdtempSync(join(tmpdir(), 'token-cost-test-'))
    const dir = join(root, '--tmp--')
    const { mkdirSync } = await import('node:fs')
    mkdirSync(join(dir, 'session-abc'), { recursive: true })
    const file = join(dir, 'session-abc', 'session.jsonl.zstd')
    copyFileSync(FIXTURE_A, file)

    const ledger = new SessionLedger(root, join(root, 'ledger.json'))
    const first = await ledger.sync()
    expect(first.sessionCount).toBe(1)
    expect(first.recordCount).toBe(1)
    const session = ledger.session('session-abc')
    expect(session!.records[0]!.inputTokens).toBe(100)

    // Unchanged file: sync must not re-parse (mtime/size identical).
    await ledger.sync()
    expect(ledger.stats().recordCount).toBe(1)

    // Changed file: re-parse picks the new usage up.
    copyFileSync(FIXTURE_B, file)
    await ledger.sync()
    expect(ledger.session('session-abc')!.records[0]!.inputTokens).toBe(200)
  })

  it('persists a ledger when the target filename has no explicit parent', async () => {
    const root = mkdtempSync(join(tmpdir(), 'token-cost-ledger-persist-test-'))
    const dir = join(root, '--tmp--', 'session-abc')
    const previousCwd = process.cwd()
    const { mkdirSync } = await import('node:fs')
    mkdirSync(dir, { recursive: true })
    copyFileSync(FIXTURE_A, join(dir, 'session.jsonl.zstd'))

    process.chdir(root)
    try {
      const ledger = new SessionLedger(root, 'ledger.json')
      expect(await ledger.sync()).toMatchObject({ sessionCount: 1, recordCount: 1 })
      expect(readFileSync(join(root, 'ledger.json'), 'utf8')).toContain('"version":4')
    } finally {
      process.chdir(previousCwd)
    }
  })

  it('discovers opaque session directory names instead of assuming a session- prefix', async () => {
    const root = mkdtempSync(join(tmpdir(), 'token-cost-opaque-session-test-'))
    const dir = join(root, '--tmp--', 'opaque-fixture-id')
    const { mkdirSync } = await import('node:fs')
    mkdirSync(dir, { recursive: true })
    copyFileSync(FIXTURE_OPAQUE, join(dir, 'session.jsonl.zstd'))

    const ledger = new SessionLedger(root, join(root, 'ledger.json'))
    const stats = await ledger.sync()
    expect(stats.sessionCount).toBe(1)
    expect(ledger.session('opaque-fixture-id')!.records[0]!.inputTokens).toBe(100)
  })

  it('loads an encoded session directory under the raw header id', async () => {
    const root = mkdtempSync(join(tmpdir(), 'token-cost-escaped-session-test-'))
    const dir = join(root, '--tmp--', 'session~002Fchild')
    const { mkdirSync } = await import('node:fs')
    mkdirSync(dir, { recursive: true })
    copyFileSync(FIXTURE_ESCAPED_ID, join(dir, 'session.jsonl.zstd'))

    const ledger = new SessionLedger(root, join(root, 'ledger.json'))
    expect(await ledger.sync()).toMatchObject({ sessionCount: 1, recordCount: 1 })
    expect(ledger.session('session/child')!.records[0]!.inputTokens).toBe(123)
  })

  it('skips a copied session artifact when the header id disagrees with its directory', async () => {
    const root = mkdtempSync(join(tmpdir(), 'token-cost-mismatched-session-test-'))
    const dir = join(root, '--tmp--', 'opaque-fixture-id')
    const { mkdirSync } = await import('node:fs')
    mkdirSync(dir, { recursive: true })
    copyFileSync(FIXTURE_A, join(dir, 'session.jsonl.zstd'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    try {
      const ledger = new SessionLedger(root, join(root, 'ledger.json'))
      expect(await ledger.sync()).toMatchObject({ sessionCount: 0, recordCount: 0 })
      expect(warn).toHaveBeenCalledOnce()
    } finally {
      warn.mockRestore()
    }
  })

  it.each([
    ['missing header', FIXTURE_MISSING_HEADER],
    ['missing header id', FIXTURE_MISSING_ID],
  ])('skips a session log with %s', async (_label, fixture) => {
    const root = mkdtempSync(join(tmpdir(), 'token-cost-invalid-header-test-'))
    const dir = join(root, '--tmp--', 'invalid-fixture')
    const { mkdirSync } = await import('node:fs')
    mkdirSync(dir, { recursive: true })
    copyFileSync(fixture, join(dir, 'session.jsonl.zstd'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    try {
      const ledger = new SessionLedger(root, join(root, 'ledger.json'))
      expect(await ledger.sync()).toMatchObject({ sessionCount: 0, recordCount: 0 })
      expect(warn).toHaveBeenCalledOnce()
    } finally {
      warn.mockRestore()
    }
  })

  it('counts a duplicated session id once across storage slugs', async () => {
    const root = mkdtempSync(join(tmpdir(), 'token-cost-duplicate-session-test-'))
    const { mkdirSync } = await import('node:fs')
    for (const slug of ['--a--', '--b--']) {
      const dir = join(root, slug, 'session-abc')
      mkdirSync(dir, { recursive: true })
      copyFileSync(FIXTURE_A, join(dir, 'session.jsonl.zstd'))
    }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    try {
      const ledger = new SessionLedger(root, join(root, 'ledger.json'))
      expect(await ledger.sync()).toMatchObject({ sessionCount: 1, recordCount: 1 })
      expect(warn).toHaveBeenCalledOnce()
    } finally {
      warn.mockRestore()
    }
  })

  it('selects the highest canonical generation once and reads raw v2 JSONL', async () => {
    const root = mkdtempSync(join(tmpdir(), 'token-cost-generation-test-'))
    const dir = join(root, '--tmp--', 'session-generation')
    const { mkdirSync } = await import('node:fs')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'session.jsonl'), plainSession(0, 'session-generation', 100), 'utf8')
    writeFileSync(join(dir, 'session.v1.jsonl'), plainSession(1, 'session-generation', 200), 'utf8')
    writeFileSync(join(dir, 'session.v2.jsonl'), plainSession(2, 'session-generation', 300), 'utf8')

    const ledger = new SessionLedger(root, join(root, 'ledger.json'))
    expect(await ledger.sync()).toMatchObject({ sessionCount: 1, recordCount: 1 })
    expect(ledger.session('session-generation')!.records[0]).toMatchObject({
      model: 'model-v2',
      inputTokens: 300,
    })
  })

  it('keeps released-v1 raw logs readable when no migrated successor exists', async () => {
    const root = mkdtempSync(join(tmpdir(), 'token-cost-v1-test-'))
    const dir = join(root, '--tmp--', 'session-v1')
    const { mkdirSync } = await import('node:fs')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'session.v1.jsonl'), plainSession(1, 'session-v1', 211), 'utf8')

    const ledger = new SessionLedger(root, join(root, 'ledger.json'))
    expect(await ledger.sync()).toMatchObject({ sessionCount: 1, recordCount: 1 })
    expect(ledger.session('session-v1')!.records[0]!.inputTokens).toBe(211)
  })

  it('does not fall back to v2 when a newer unknown generation is authoritative', async () => {
    const root = mkdtempSync(join(tmpdir(), 'token-cost-future-generation-test-'))
    const dir = join(root, '--tmp--', 'session-future')
    const { mkdirSync } = await import('node:fs')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'session.v2.jsonl'), plainSession(2, 'session-future', 300), 'utf8')
    const ledger = new SessionLedger(root, join(root, 'ledger.json'))
    expect(await ledger.sync()).toMatchObject({ sessionCount: 1, recordCount: 1 })

    writeFileSync(join(dir, 'session.v3.jsonl'), JSON.stringify({
      type: 'session', version: 3, id: 'session-future', createdAt: 1,
    }) + '\n', 'utf8')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    try {
      expect(await ledger.sync()).toMatchObject({ sessionCount: 0, recordCount: 0 })
      expect(ledger.session('session-future')).toBeUndefined()
      expect(warn).toHaveBeenCalledOnce()
      expect(String(warn.mock.calls[0]?.[1])).toContain('unsupported session format version v3')
    } finally {
      warn.mockRestore()
    }
  })

  it('drops a cached total when the highest generation becomes ambiguous', async () => {
    const root = mkdtempSync(join(tmpdir(), 'token-cost-ambiguous-generation-test-'))
    const dir = join(root, '--tmp--', 'session-ambiguous')
    const { mkdirSync } = await import('node:fs')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'session.v2.jsonl'), plainSession(2, 'session-ambiguous', 300), 'utf8')
    const ledger = new SessionLedger(root, join(root, 'ledger.json'))
    expect(await ledger.sync()).toMatchObject({ sessionCount: 1, recordCount: 1 })

    // Contents are irrelevant: discovery must reject two physical encodings
    // for the same highest generation before either can remain authoritative.
    copyFileSync(FIXTURE_A, join(dir, 'session.v2.jsonl.zstd'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(await ledger.sync()).toMatchObject({ sessionCount: 0, recordCount: 0 })
      expect(ledger.session('session-ambiguous')).toBeUndefined()
      expect(warn).toHaveBeenCalledOnce()
      expect(String(warn.mock.calls[0]?.[0])).toContain('skipped ambiguous session generation')
    } finally {
      warn.mockRestore()
    }
  })

  it('invalidates a version-3 ledger and persists a version-4 refold', async () => {
    const root = mkdtempSync(join(tmpdir(), 'token-cost-ledger-version-test-'))
    const dir = join(root, '--tmp--', 'session-abc')
    const ledgerPath = join(root, 'ledger.json')
    const { mkdirSync } = await import('node:fs')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'session.jsonl.zstd')
    copyFileSync(FIXTURE_A, file)
    const info = statSync(file)
    writeFileSync(ledgerPath, JSON.stringify({
      version: 3,
      sessions: {
        'session-abc': {
          file,
          mtimeMs: info.mtimeMs,
          size: info.size,
          meta: {
            sessionId: 'session-abc',
            cwd: '/stale',
            title: 'stale',
            createdAt: 1,
            lastActivity: 1,
          },
          records: [{
            time: 1,
            turn: 1,
            step: 1,
            sessionId: 'session-abc',
            sessionLabel: 'stale',
            provider: 'stale',
            model: 'stale',
            inputTokens: 999,
            cacheReadTokens: 999,
            cacheWriteTokens: 999,
            outputTokens: 999,
            reasoningTokens: 999,
          }],
        },
      },
    }), 'utf8')

    const ledger = new SessionLedger(root, ledgerPath)
    await ledger.sync()
    expect(ledger.session('session-abc')!.records[0]!.inputTokens).toBe(100)
    expect(JSON.parse(readFileSync(ledgerPath, 'utf8')).version).toBe(4)
  })
})
