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
import { readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { SessionMeta, UsageRecord } from './protocol.ts'
import { parseSessionLog } from './parser.ts'

/** Parser semantics version; a bump forces authoritative session-log refolding. */
const LEDGER_VERSION = 2

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

/** Session id derived from a log path: the immediate parent directory name. */
export function sessionIdFromPath(file: string): string {
  return basename(dirname(file)) || 'session-unknown'
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
      const id = sessionIdFromPath(file)
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
      const dir = this.ledgerPath.slice(0, Math.max(this.ledgerPath.lastIndexOf('/'), 0))
      const { mkdirSync } = await import('node:fs')
      mkdirSync(dir, { recursive: true })
      const tmp = `${this.ledgerPath}.${process.pid}.tmp`
      await writeFile(tmp, text, 'utf8')
      const { rename } = await import('node:fs/promises')
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
