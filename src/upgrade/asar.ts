/** Bounded read-only ASAR access. Candidate application code is never executed. */
import { open, type FileHandle } from 'node:fs/promises'

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
    const file = await open(path, 'r')
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
}
