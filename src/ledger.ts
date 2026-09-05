/**
 * Incremental session usage ledger: parses each session log exactly once per
 * change and keeps the folded records in memory plus a compact on-disk copy
 * under `$DSH_HOME/storages/dsh-token-cost/ledger.json` so a host restart
 * skips re-parsing unchanged logs.
 *
 * Sync diffs by (mtimeMs, size) per session log file; the active session is
 * the only file that normally changes between queries.
 */

import { decompress } from 'fzstd'
import type { Dirent } from 'node:fs'
import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { SessionMeta, UsageRecord } from './protocol.ts'
import { parseSessionLog } from './parser.ts'

/** Parser semantics version; a bump forces authoritative session-log refolding. */
const LEDGER_VERSION = 3

/** One cached ledger entry. */
interface LedgerEntry {
  file: string
  mtimeMs: number
  size: number
  meta: SessionMeta
  records: UsageRecord[]
}

export interface LedgerStats {
  sessionCount: number
  recordCount: number
  syncedAt: number
}

interface LedgerFile {
  version: typeof LEDGER_VERSION
  sessions: Record<string, LedgerEntry>
}

/** Locate every session log under a sessions root: absolute file paths. */
async function findSessionLogs(root: string): Promise<string[]> {
  const files: string[] = []
  let slugs: Dirent[]
  try {
    slugs = await readdir(root, { withFileTypes: true })
  } catch {
    return files
  }
  for (const slug of slugs) {
    if (!slug.isDirectory()) continue
    const slugDir = join(root, slug.name)
    let sessions: Dirent[]
    try {
      sessions = await readdir(slugDir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const session of sessions) {
      if (!session.isDirectory()) continue
      const file = join(slugDir, session.name, 'session.jsonl.zstd')
      files.push(file)
    }
  }
  return files.sort()
}

/** Decompress a zstd frame and decode UTF-8. */
async function readSessionText(file: string): Promise<string> {
  const bytes = await readFile(file)
  const decoded = decompress(new Uint8Array(bytes))
  return new TextDecoder().decode(decoded)
}

/** Mirror the official injective UTF-16 path-segment encoding for validation. */
function encodeSessionSegment(raw: string): string {
  if (raw.length === 0) throw new Error('cannot encode an empty session id')
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let encoded = ''
  for (let index = 0; index < raw.length; index += 1) {
    const code = raw.charCodeAt(index)
    const char = String.fromCharCode(code)
    encoded += char !== '~' && /^[A-Za-z0-9._-]$/.test(char)
      ? char
      : `~${code.toString(16).toUpperCase().padStart(4, '0')}`
  }
  return encoded
}

/** Decode one canonical DSH session directory segment back to its header id. */
function decodeSessionSegment(encoded: string): string {
  if (encoded.length === 0) throw new Error('session directory name is empty')
  let raw = ''
  for (let index = 0; index < encoded.length; index += 1) {
    const char = encoded[index]!
    if (char !== '~') {
      if (!/^[A-Za-z0-9._-]$/.test(char)) {
        throw new Error(`session directory contains an unsafe character at offset ${index}`)
      }
      raw += char
      continue
    }
    const escape = encoded.slice(index + 1, index + 5)
    if (!/^[0-9A-F]{4}$/.test(escape)) {
      throw new Error(`session directory contains an invalid escape at offset ${index}`)
    }
    raw += String.fromCharCode(Number.parseInt(escape, 16))
    index += 4
  }
  if (encodeSessionSegment(raw) !== encoded) {
    throw new Error('session directory name is not canonically encoded')
  }
  return raw
}

/** Session id decoded from the immediate parent directory of a session log. */
export function sessionIdFromPath(file: string): string {
  return decodeSessionSegment(basename(dirname(file)))
}

/**
 * The in-memory + on-disk ledger. All methods are async but only sync()
 * touches the filesystem; route handlers share one instance and one
 * single-flight sync.
 */
export class SessionLedger {
  private readonly entries = new Map<string, LedgerEntry>()
  private readonly ledgerPath: string
  private syncedAt = 0
  private syncing: Promise<LedgerStats> | null = null

  constructor(
    private readonly sessionsRoot: string,
    ledgerPath: string,
  ) {
    this.ledgerPath = ledgerPath
  }

  /** Load the on-disk ledger once. */
  private async load(): Promise<void> {
    if (this.entries.size > 0) return
    try {
      const text = await readFile(this.ledgerPath, 'utf8')
      const file = JSON.parse(text) as LedgerFile
      if (file?.version === LEDGER_VERSION && typeof file.sessions === 'object') {
        for (const [id, entry] of Object.entries(file.sessions)) {
          this.entries.set(id, entry)
        }
      }
    } catch {
      // First run or corrupt ledger: start empty.
    }
  }

  /** Diff session logs against the cache and re-parse what changed. */
  async sync(force = false): Promise<LedgerStats> {
    if (this.syncing === null) {
      this.syncing = this.syncInner(force).finally(() => {
        this.syncing = null
      })
    }
    return this.syncing
  }

  private async syncInner(force: boolean): Promise<LedgerStats> {
    await this.load()
    const files = await findSessionLogs(this.sessionsRoot)
    const seen = new Set<string>()
    const claimed = new Map<string, string>()
    let changed = false
    for (const file of files) {
      let id: string
      try {
        id = sessionIdFromPath(file)
      } catch (error) {
        console.warn(`[dsh-token-cost] skipped invalid session directory ${file}:`, error)
        continue
      }
      const first = claimed.get(id)
      if (first !== undefined) {
        console.warn(`[dsh-token-cost] skipped duplicate session id "${id}" at ${file}; first seen at ${first}`)
        continue
      }
      let info
      try {
        info = await stat(file)
      } catch {
        continue
      }
      const cached = this.entries.get(id)
      if (
        !force
        && cached !== undefined
        && cached.file === file
        && cached.mtimeMs === info.mtimeMs
        && cached.size === info.size
      ) {
        claimed.set(id, file)
        seen.add(id)
        continue
      }
      let parsed: ReturnType<typeof parseSessionLog>
      try {
        const text = await readSessionText(file)
        parsed = parseSessionLog(text, id, '')
      } catch (error) {
        console.warn(`[dsh-token-cost] skipped invalid session log ${file}:`, error)
        continue
      }
      claimed.set(id, file)
      seen.add(id)
      const records = parsed.records.map((record) => ({
        ...record,
        sessionId: id,
        sessionLabel: parsed.meta.title !== '' ? parsed.meta.title : id,
      }))
      this.entries.set(id, {
        file,
        mtimeMs: info.mtimeMs,
        size: info.size,
        meta: parsed.meta,
        records,
      })
      changed = true
    }
    let removed = false
    for (const id of this.entries.keys()) {
      if (!seen.has(id)) {
        this.entries.delete(id)
        removed = true
      }
    }
    this.syncedAt = Date.now()
    if (changed || removed) await this.persist()
    return this.stats()
  }

  /** Persist the compact ledger; a failure never breaks a query. */
  private async persist(): Promise<void> {
    const sessions: Record<string, LedgerEntry> = {}
    for (const [id, entry] of this.entries) {
      sessions[id] = entry
    }
    const payload: LedgerFile = { version: LEDGER_VERSION, sessions }
    try {
      const text = JSON.stringify(payload)
      const dir = dirname(this.ledgerPath)
      await mkdir(dir, { recursive: true })
      const tmp = `${this.ledgerPath}.${process.pid}.tmp`
      await writeFile(tmp, text, 'utf8')
      await rename(tmp, this.ledgerPath)
    } catch (error) {
      console.warn('[dsh-token-cost] ledger persist failed:', error)
    }
  }

  /** Current stats without touching the filesystem. */
  stats(): LedgerStats {
    let recordCount = 0
    for (const entry of this.entries.values()) recordCount += entry.records.length
    return {
      sessionCount: this.entries.size,
      recordCount,
      syncedAt: this.syncedAt,
    }
  }

  /** All sessions with their meta and records. */
  sessions(): Array<{ meta: SessionMeta; records: UsageRecord[] }> {
    return [...this.entries.values()].map((entry) => ({ meta: entry.meta, records: entry.records }))
  }

  /** One session by id. */
  session(id: string): { meta: SessionMeta; records: UsageRecord[] } | undefined {
    const entry = this.entries.get(id)
    if (entry === undefined) return undefined
    return { meta: entry.meta, records: entry.records }
  }
}
