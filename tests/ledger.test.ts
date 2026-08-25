/**
 * Ledger tests: incremental sync over real zstd session-log files.
 */

import { copyFileSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { SessionLedger } from '../src/ledger.ts'

/** Committed zstd fixtures: session-a bills 100 input tokens, session-b 200. */
const FIXTURE_A = join(__dirname, 'fixtures', 'session-a.jsonl.zstd')
const FIXTURE_B = join(__dirname, 'fixtures', 'session-b.jsonl.zstd')
const FIXTURE_OPAQUE = join(__dirname, 'fixtures', 'opaque-session.jsonl.zstd')
const FIXTURE_MISSING_HEADER = join(__dirname, 'fixtures', 'missing-session-header.jsonl.zstd')
const FIXTURE_MISSING_ID = join(__dirname, 'fixtures', 'missing-session-id.jsonl.zstd')

describe('SessionLedger', () => {
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

  it('invalidates a version-1 ledger and persists a version-2 refold', async () => {
    const root = mkdtempSync(join(tmpdir(), 'token-cost-ledger-version-test-'))
    const dir = join(root, '--tmp--', 'session-abc')
    const ledgerPath = join(root, 'ledger.json')
    const { mkdirSync } = await import('node:fs')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'session.jsonl.zstd')
    copyFileSync(FIXTURE_A, file)
    const info = statSync(file)
    writeFileSync(ledgerPath, JSON.stringify({
      version: 1,
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
    expect(JSON.parse(readFileSync(ledgerPath, 'utf8')).version).toBe(2)
  })
})
