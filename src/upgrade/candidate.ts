/** Inspect the native updater's completed ZIP without installing or executing it. */
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'
import { AsarArchive, rawArchiveFs } from './asar.ts'
import { captureUpgradeContract } from './contracts.ts'
import { extractBrowserCore } from './browser-core.ts'
import { runCapabilityProbe } from './probe-runner.ts'

const exec = promisify(execFile)
const archiveFs = rawArchiveFs()

/** A verdict contains public version/interface facts, never archive URLs or user data. */
export interface UpgradeVerdict {
  allowed: boolean
  version?: string
  reason: 'compatible' | 'changed-interface' | 'unrecognized-package' | 'check-failed'
  changed?: string[]
  detail?: string
}

async function regular(path: string, max: number) {
  const stat = await archiveFs.lstat(path)
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
      let candidate: AsarArchive | undefined
      try {
        // A neutral filename prevents Electron from virtualizing the in-progress output.
        const extracted = join(scratch, 'candidate.bin')
        await unpackAsar(archive, extracted)
        candidate = await AsarArchive.open(extracted)
        const target = await captureUpgradeContract(candidate)
        const core = extractBrowserCore(target.frontend)
        await candidate.extractSdk(scratch)
        const changed = await runCapabilityProbe(scratch, core, target.native, target.slots, target.version)
        verdict = { allowed: changed.length === 0, version: target.version,
          reason: changed.length === 0 ? 'compatible' : 'changed-interface', changed }
      } catch (error) {
        verdict = { allowed: false, reason: 'unrecognized-package', detail: checkFailure(error) }
      } finally {
        await candidate?.close()
        await rm(scratch, { recursive: true, force: true })
      }
    }
    if (before !== await regular(archive, 4 * 1024 * 1024 * 1024)
      || currentIdentity !== await regular(currentAsar, 512 * 1024 * 1024)
      || !infoBytes.equals(await readFile(infoPath))) throw new Error('UPDATE_CHANGED')
    cached = { key, verdict }
    return verdict
  })().catch((error): UpgradeVerdict => ({ allowed: false, reason: 'check-failed', detail: checkFailure(error) })).finally(() => { pending = undefined })
}

/** Stable diagnostic codes only: never expose source text, filesystem paths or subprocess stderr. */
function checkFailure(error: unknown): string {
  const code = error instanceof Error ? error.message : ''
  const known = new Set(['UPDATE_FILE', 'UPDATE_METADATA', 'UPDATE_CHECKSUM', 'UPDATE_CHANGED', 'UPDATE_ARCHIVE',
    'UPDATE_ASAR_SIZE', 'UPDATE_EXTRACT', 'ASAR_SIZE', 'ASAR_HEADER', 'ASAR_INDEX', 'ASAR_MEMBER_PATH',
    'ASAR_MEMBER_MISSING', 'ASAR_MEMBER', 'ASAR_MEMBER_BOUNDS', 'ASAR_MEMBER_SHORT', 'SDK_LAYOUT', 'SDK_LIMIT',
    'HOST_SLOT', 'HOST_FAMILY', 'HOST_PROTOCOL', 'FRAMEWORK_FAMILY', 'SESSION_FORMAT', 'CLIENT_LAYOUT', 'NATIVE_PROTOCOL',
    'BROWSER_CORE_SOURCE', 'PROBE_PLATFORM', 'PROBE_TIMEOUT', 'PROBE_UNAVAILABLE', 'PROBE_OUTPUT_LIMIT'])
  return known.has(code) ? code : 'CHECK_FAILED'
}
