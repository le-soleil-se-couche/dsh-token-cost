/** Inspect the native updater's completed ZIP without installing or executing it. */
import { createReadStream, createWriteStream } from 'node:fs'
import { lstat, mkdtemp, readFile, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'
import { AsarArchive } from './asar.ts'
import { captureUpgradeContract, compareUpgradeContracts } from './contracts.ts'

const exec = promisify(execFile)

/** A verdict contains public version/interface facts, never archive URLs or user data. */
export interface UpgradeVerdict {
  allowed: boolean
  version?: string
  reason: 'compatible' | 'changed-interface' | 'unrecognized-package' | 'check-failed'
  changed?: string[]
}

async function regular(path: string, max: number) {
  const stat = await lstat(path)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0 || stat.size > max) throw new Error('UPDATE_FILE')
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha512')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('base64')
}

async function unpackAsar(zip: string, destination: string): Promise<void> {
  const { stdout } = await exec('/usr/bin/unzip', ['-Z1', zip, '*.app/Contents/Resources/app.asar'], {
    timeout: 4_000, maxBuffer: 16_384,
  })
  const entries = stdout.trim().split('\n')
  const member = entries[0] ?? ''
  if (entries.length !== 1 || !/^[^/\\]+\.app\/Contents\/Resources\/app\.asar$/.test(member)) throw new Error('UPDATE_ARCHIVE')
  const child = spawn('/usr/bin/unzip', ['-p', zip, member], { stdio: ['ignore', 'pipe', 'ignore'] })
  let bytes = 0
  const completion = new Promise<void>((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', code => code === 0 ? resolve() : reject(new Error('UPDATE_EXTRACT')))
  })
  // Attach a rejection handler immediately; pipeline and process completion settle independently.
  void completion.catch(() => {})
  const timer = setTimeout(() => child.kill(), 6_000)
  try {
    await pipeline(child.stdout, new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.length
        callback(bytes > 512 * 1024 * 1024 ? new Error('UPDATE_ASAR_SIZE') : null, chunk)
      },
    }), createWriteStream(destination, { flags: 'wx', mode: 0o600 }))
    await completion
  } finally {
    clearTimeout(timer)
    if (child.exitCode === null) child.kill()
  }
}

/** Bind cached approval to both archive bytes and the current installed ASAR identity. */
export function pendingUpdateInspector(currentAsar: string, cacheDirectory: string): () => Promise<UpgradeVerdict> {
  let cached: { key: string; verdict: UpgradeVerdict } | undefined
  let pending: Promise<UpgradeVerdict> | undefined
  return () => pending ??= (async () => {
    const infoPath = join(cacheDirectory, 'pending', 'update-info.json')
    await regular(infoPath, 16_384)
    const infoBytes = await readFile(infoPath)
    const info = JSON.parse(infoBytes.toString('utf8')) as { fileName?: string; sha512?: string }
    if (typeof info.fileName !== 'string' || basename(info.fileName) !== info.fileName
      || !/^[\w][\w.+-]*\.zip$/.test(info.fileName) || typeof info.sha512 !== 'string'
      || !/^[A-Za-z0-9+/]{86}==$/.test(info.sha512)) throw new Error('UPDATE_METADATA')
    const archive = join(cacheDirectory, 'pending', info.fileName)
    const before = await regular(archive, 4 * 1024 * 1024 * 1024)
    const currentIdentity = await regular(currentAsar, 512 * 1024 * 1024)
    const hash = await hashFile(archive)
    if (hash !== info.sha512) throw new Error('UPDATE_CHECKSUM')
    const key = `${currentIdentity}:${hash}`
    let verdict = cached?.key === key ? cached.verdict : undefined
    if (verdict === undefined) {
      const scratch = await mkdtemp(join(tmpdir(), 'dsh-fee-upgrade-'))
      let current: AsarArchive | undefined
      let candidate: AsarArchive | undefined
      try {
        const extracted = join(scratch, 'candidate.asar')
        await unpackAsar(archive, extracted)
        current = await AsarArchive.open(currentAsar)
        candidate = await AsarArchive.open(extracted)
        const [baseline, target] = await Promise.all([captureUpgradeContract(current), captureUpgradeContract(candidate)])
        const changed = compareUpgradeContracts(baseline, target)
        verdict = { allowed: changed.length === 0, version: target.version,
          reason: changed.length === 0 ? 'compatible' : 'changed-interface', changed }
      } catch {
        verdict = { allowed: false, reason: 'unrecognized-package' }
      } finally {
        await Promise.all([current?.close(), candidate?.close()])
        await rm(scratch, { recursive: true, force: true })
      }
    }
    if (before !== await regular(archive, 4 * 1024 * 1024 * 1024)
      || currentIdentity !== await regular(currentAsar, 512 * 1024 * 1024)
      || !infoBytes.equals(await readFile(infoPath))) throw new Error('UPDATE_CHANGED')
    cached = { key, verdict }
    return verdict
  })().catch((): UpgradeVerdict => ({ allowed: false, reason: 'check-failed' })).finally(() => { pending = undefined })
}
