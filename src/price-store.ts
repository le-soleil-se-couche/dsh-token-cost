/**
 * Durable custom-price catalog. Kept next to the usage ledger so adding a
 * model does not depend on the settings-scope write path (which swallows
 * mutate failures and can stay non-writable).
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { parseCustomPrices, serializeCustomPrices } from './pricing.ts'
import type { ModelPrice } from './protocol.ts'

/** File-backed custom model prices. */
export class CustomPriceStore {
  private data: Record<string, ModelPrice> = {}
  private readonly ready: Promise<void>

  constructor(private readonly filePath: string) {
    this.ready = this.load()
  }

  /** Wait until the on-disk catalog has been read. */
  async whenReady(): Promise<void> {
    await this.ready
  }

  /** Current catalog (empty before the first successful load). */
  get(): Record<string, ModelPrice> {
    return this.data
  }

  /** Replace the catalog and persist it atomically. */
  async replace(prices: Record<string, ModelPrice>): Promise<void> {
    this.data = prices
    const text = serializeCustomPrices(prices)
    const dir = dirname(this.filePath)
    await mkdir(dir, { recursive: true })
    const tmp = `${this.filePath}.${process.pid}.tmp`
    await writeFile(tmp, text === '' ? '{}\n' : `${text}\n`, 'utf8')
    await rename(tmp, this.filePath)
  }

  private async load(): Promise<void> {
    try {
      const text = await readFile(this.filePath, 'utf8')
      this.data = parseCustomPrices(text === '' || text.trim() === '{}' ? '' : text)
    } catch {
      this.data = {}
    }
  }
}
