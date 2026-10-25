import { readFileSync } from 'node:fs'
import { evaluatePluginCompatibility } from '@deepseek-ai/dsh-app-boot'
import { describe, expect, it } from 'vitest'

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const { engines: _engines, ...peerOnlyManifest } = manifest

describe('DSH manifest admission (native updates also require interface checks)', () => {
  it.each(['0.2.1-rc.2', '0.2.1-rc.3', '0.2.1-rc.4', '0.2.1', '0.2.2-rc.1', '0.2.2', '0.2.99', '0.3.0-rc.1', '0.3.0', '0.9.9'])(
    'allows the plugin compatibility logic to load on the declared 0.x family: %s',
    (runtimeVersion) => {
      expect(evaluatePluginCompatibility(manifest, {}, runtimeVersion)).toBeUndefined()
      expect(evaluatePluginCompatibility(peerOnlyManifest, {}, runtimeVersion)).toBeUndefined()
    },
  )

  it.each(['0.2.0', '0.2.1-rc.1', '1.0.0-alpha.1', '1.0.0'])(
    'requires a new compatibility review outside the supported line: %s',
    (runtimeVersion) => {
      expect(evaluatePluginCompatibility(manifest, {}, runtimeVersion)).toMatchObject({
        requirements: { 'engines.dsh': manifest.engines.dsh },
        exempted: false,
      })
      expect(evaluatePluginCompatibility(peerOnlyManifest, {}, runtimeVersion)).toMatchObject({
        exempted: false,
      })
    },
  )

  it('reproduces the previous exact-RC rejection on the next desktop update', () => {
    const previous = { ...manifest, engines: { ...manifest.engines, dsh: '0.2.1-rc.2' } }
    expect(evaluatePluginCompatibility(previous, {}, '0.2.1-rc.3')).toMatchObject({
      requirements: { 'engines.dsh': '0.2.1-rc.2' },
      exempted: false,
    })
  })
})
