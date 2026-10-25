import { readFileSync } from 'node:fs'
import { evaluatePluginCompatibility } from '@deepseek-ai/dsh-app-boot'
import { describe, expect, it } from 'vitest'

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const { engines: _engines, ...peerOnlyManifest } = manifest

describe('DSH update compatibility', () => {
  it.each(['0.2.1-rc.2', '0.2.1-rc.3', '0.2.1-rc.4', '0.2.1', '0.2.2-rc.1', '0.2.2', '0.2.99'])(
    'keeps the plugin loadable on the supported 0.2.x line: %s',
    (runtimeVersion) => {
      expect(evaluatePluginCompatibility(manifest, {}, runtimeVersion)).toBeUndefined()
      expect(evaluatePluginCompatibility(peerOnlyManifest, {}, runtimeVersion)).toBeUndefined()
    },
  )

  it.each(['0.2.0', '0.2.1-rc.1', '0.3.0-alpha.1', '0.3.0', '1.0.0'])(
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
