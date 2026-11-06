/** Bounded physical ASAR access. SDK probes execute separately under OS restrictions. */
import * as fs from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

/** Electron virtualizes .asar paths as directories. Inspect physical archive bytes locally. */
export function rawArchiveFs(
  electron = process.versions.electron,
  load: (name: string) => { promises: typeof fs } = createRequire(import.meta.url),
): typeof fs {
  return electron ? load('original-fs').promises : fs
}

const archiveFs = rawArchiveFs()

interface Entry {
  files?: Record<string, Entry>
  offset?: string
  size?: number
  link?: string
  unpacked?: boolean
}

/** An owned archive handle; callers close it in finally. */
export class AsarArchive {
  private constructor(
    private readonly file: FileHandle,
    private readonly tree: Entry,
    private readonly dataOffset: number,
    private readonly size: number,
  ) {}

  /** Open a regular bounded archive and validate its index before reading members. */
  static async open(path: string): Promise<AsarArchive> {
    const file = await archiveFs.open(path, 'r')
    try {
      const stat = await file.stat()
      if (!stat.isFile() || stat.size > 512 * 1024 * 1024) throw new Error('ASAR_SIZE')
      const header = Buffer.alloc(16)
      if ((await file.read(header, 0, 16, 0)).bytesRead !== 16) throw new Error('ASAR_HEADER')
      const headerSize = header.readUInt32LE(4)
      const jsonSize = header.readUInt32LE(12)
      if (header.readUInt32LE(0) !== 4 || header.readUInt32LE(8) !== headerSize - 4
        || headerSize > 32 * 1024 * 1024 || jsonSize === 0 || jsonSize > headerSize - 8
        || 8 + headerSize > stat.size) throw new Error('ASAR_HEADER')
      const data = Buffer.alloc(jsonSize)
      if ((await file.read(data, 0, jsonSize, 16)).bytesRead !== jsonSize) throw new Error('ASAR_HEADER')
      const tree = JSON.parse(data.toString('utf8')) as Entry
      if (tree?.files === undefined || typeof tree.files !== 'object') throw new Error('ASAR_INDEX')
      return new AsarArchive(file, tree, 8 + headerSize, stat.size)
    } catch (error) {
      await file.close()
      throw error
    }
  }

  /** Read one packed file, rejecting linked entries and paths outside the archive. */
  async text(name: string, limit = 8 * 1024 * 1024): Promise<string> {
    const parts = name.split('/')
    if (parts.some(part => part === '' || part === '.' || part === '..') || name.includes('\\')) {
      throw new Error('ASAR_MEMBER_PATH')
    }
    let entry = this.tree
    for (const part of parts) {
      const next = entry.files?.[part]
      if (next === undefined || !Object.hasOwn(entry.files!, part)) throw new Error('ASAR_MEMBER_MISSING')
      entry = next
    }
    if (entry.files !== undefined || entry.link !== undefined || entry.unpacked
      || !Number.isSafeInteger(entry.size) || entry.size! < 0 || entry.size! > limit
      || typeof entry.offset !== 'string' || !/^\d+$/.test(entry.offset)) throw new Error('ASAR_MEMBER')
    const offset = Number(entry.offset) + this.dataOffset
    if (!Number.isSafeInteger(offset) || offset + entry.size! > this.size) throw new Error('ASAR_MEMBER_BOUNDS')
    const data = Buffer.alloc(entry.size!)
    if ((await this.file.read(data, 0, data.length, offset)).bytesRead !== data.length) throw new Error('ASAR_MEMBER_SHORT')
    return data.toString('utf8')
  }

  /** Release the archive descriptor. */
  close(): Promise<void> { return this.file.close() }

  /** Extract only packed JavaScript/JSON SDK files into a new, private probe directory. */
  async extractSdk(destination: string): Promise<void> {
    const root = this.tree.files?.dsh?.files?.node_modules
    if (!root?.files) throw new Error('SDK_LAYOUT')
    // Follow declared runtime dependencies of the seven exercised SDK packages.
    // Unrelated editor/inspector assets are not part of a fee compatibility test.
    const pending = ['@deepseek-ai/cordis', '@deepseek-ai/schemastery', '@deepseek-ai/cordis-plugin-loader',
      '@deepseek-ai/dsh-client-connection', '@deepseek-ai/dsh-settings',
      '@deepseek-ai/dsh-client-ui-renderer', '@deepseek-ai/dsh-client-ui-settings',
      '@deepseek-ai/dsh-client-modules', '@deepseek-ai/dsh-client-locale', '@deepseek-ai/dsh-app-boot']
    const packages = new Map<string, Entry>()
    const visited = new Set<string>()
    while (pending.length) {
      const name = pending.pop()!
      if (visited.has(name)) continue
      visited.add(name)
      if (!/^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/.test(name) || visited.size > 256) throw new Error('SDK_LAYOUT')
      let entry: Entry | undefined = root
      for (const part of name.split('/')) entry = entry?.files?.[part]
      if (!entry?.files) throw new Error('SDK_LAYOUT')
      // Native sidecars are not copied into the probe. If an exercised API actually needs one,
      // its import/behavior fails closed instead of borrowing an installed host dependency.
      if (entry.files['package.json']?.unpacked || entry.files['package.json']?.link) continue
      const manifest = JSON.parse(await this.text(`dsh/node_modules/${name}/package.json`))
      packages.set(name, entry)
      pending.push(...Object.keys(manifest.dependencies ?? {}))
      // Peers supplied by the host are real runtime imports too. Browser platform seeds have
      // no Node package and are exercised through their extracted browser factories instead.
      for (const peer of Object.keys(manifest.peerDependencies ?? {})) {
        let available: Entry | undefined = root
        for (const part of peer.split('/')) available = available?.files?.[part]
        if (available?.files) pending.push(peer)
      }
    }
    let count = 0, bytes = 0
    const visit = async (entry: Entry, relative: string): Promise<void> => {
      for (const [name, child] of Object.entries(entry.files ?? {})) {
        if (!name || name === '.' || name === '..' || /[\\/\0]/.test(name)) throw new Error('ASAR_MEMBER_PATH')
        const path = relative ? `${relative}/${name}` : name
        if (child.files) { await visit(child, path); continue }
        // Native and linked entries are never executed by the probe. A required missing module fails it.
        if (child.link !== undefined || child.unpacked || !/\.(?:[cm]?js|json)$/.test(name)) continue
        if (++count > 25_000 || !Number.isSafeInteger(child.size) || child.size! < 0
          || (bytes += child.size!) > 256 * 1024 * 1024) throw new Error('SDK_LIMIT')
        const source = await this.text(`dsh/node_modules/${path}`)
        const target = join(destination, 'node_modules', path)
        await fs.mkdir(dirname(target), { recursive: true, mode: 0o700 })
        await fs.writeFile(target, source, { flag: 'wx', mode: 0o600 })
      }
    }
    for (const [name, entry] of packages) await visit(entry, name)
    if (count === 0) throw new Error('SDK_LAYOUT')
  }
}
