import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CustomPriceStore } from '../src/price-store.ts'

describe('CustomPriceStore', () => {
  it('round-trips a catalog through the on-disk file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-token-cost-'))
    const file = join(dir, 'custom-prices.json')
    const store = new CustomPriceStore(file)
    await store.whenReady()
    expect(store.get()).toEqual({})
    await store.replace({
      'gpt-4o': {
        cny: { miss: 18, hit: 9, output: 72 },
        usd: { miss: 2.5, hit: 1.25, output: 10 },
        flat: true,
      },
    })
    const text = await readFile(file, 'utf8')
    expect(text).toContain('gpt-4o')
    const reloaded = new CustomPriceStore(file)
    await reloaded.whenReady()
    expect(reloaded.get()['gpt-4o']?.usd.output).toBe(10)
  })

  it('retains an explicit flat:false after a disk reload', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-token-cost-flat-'))
    const file = join(dir, 'custom-prices.json')
    const store = new CustomPriceStore(file)
    await store.whenReady()
    await store.replace({
      'gpt-4o': {
        cny: { miss: 18, hit: 9, output: 72 },
        usd: { miss: 2.5, hit: 1.25, output: 10 },
        flat: false,
      },
    })

    const reloaded = new CustomPriceStore(file)
    await reloaded.whenReady()
    expect(reloaded.get()['gpt-4o']?.flat).toBe(false)
  })
})
