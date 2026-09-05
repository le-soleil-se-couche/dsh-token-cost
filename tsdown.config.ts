/**
 * Standalone build config for the dsh-token-cost plugin.
 *
 * Uses the repo's client-bundle preset (build/tsdown.client.ts):
 * node-half lib/ (ledger + pricing + routes) plus the browser bundle
 * lib/client.js (closure-factory artifact for the GUI's __ModuleLoader__,
 * CSS Modules inlined). The client entry is auto-detected at
 * src/client/index.ts by the preset.
 */
import { clientBundle } from './build/tsdown.client.ts'

export default clientBundle('@deepseek-ai/dsh-token-cost', ['src/index.ts'], {
  libExternal: [
    '@deepseek-ai/dsh-host-webserver',
    '@deepseek-ai/dsh-settings',
    '@deepseek-ai/schemastery',
  ],
})
