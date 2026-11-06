import { spawn } from 'node:child_process'
import { mkdir, realpath, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { probeSdk } from './probe.ts'
import { probeNative, type NativeProbeSource } from './native-probe.ts'

const FAILURE_IDS = new Set(['sdk-framework', 'sdk-connection', 'sdk-settings', 'sdk-slot-registry',
  'sdk-slot-factory', 'sdk-client-settings', 'sdk-client-loader', 'sdk-client-locale', 'sdk-plugin-admission',
  'sdk-probe', 'native-update-protocol'])

/** macOS restrictions apply only to the disposable child, never the DSH host. */
export const PROBE_SANDBOX = `(version 1)
(allow default)
(deny network*)
(deny file-write*)
(deny process-fork)
(deny file-read-data
  (subpath "/Users") (subpath "/Volumes") (subpath "/Library")
  (subpath "/private/tmp") (subpath "/private/var/tmp") (subpath "/private/var/folders"))
(allow file-read-data
  (literal (param "EXECUTABLE"))
  (subpath (param "PROBE_ROOT"))
  (subpath (param "APP_BUNDLE")))`

/** Only bounded, validated result IDs leave a probe; candidate messages/output never reach the UI. */
export function decodeProbeResult(output: string): string[] {
  const value = JSON.parse(output)
  if (value?.protocol !== 'fee-capabilities-v1' || !Array.isArray(value.failed) || value.failed.length > FAILURE_IDS.size
    || value.failed.some((id: unknown) => typeof id !== 'string' || !FAILURE_IDS.has(id))) throw new Error('PROBE_RESULT')
  return [...new Set(value.failed)] as string[]
}

/** Exercise the actual candidate SDK in a killable, no-network/no-write/no-child-process fixture. */
export async function runCapabilityProbe(scratch: string, browserCore: string, native: NativeProbeSource,
  slots: Record<string, { kind: string; scope: string }>, version: string): Promise<string[]> {
  if (process.platform !== 'darwin') throw new Error('PROBE_PLATFORM')
  const root = await realpath(scratch)
  const executable = await realpath(process.execPath)
  const appSuffix = '/Contents/MacOS/'
  const split = executable.indexOf(appSuffix)
  // Standalone Node tests need only their executable. Electron needs its signed framework libraries.
  const bundle = split < 0 ? dirname(executable) : executable.slice(0, split)
  const script = join(root, 'probe.cjs')
  const policy = join(root, 'probe.sb')
  const manifest = createRequire(import.meta.url)('@deepseek-ai/dsh-token-cost/package.json')
  await writeFile(join(root, 'fee-plugin.json'), JSON.stringify(manifest), { flag: 'wx', mode: 0o600 })
  const fixture = join(root, 'node_modules', '@fee', 'compat-probe')
  await mkdir(join(fixture, 'lib'), { recursive: true, mode: 0o700 })
  const files = {
    'package.json': JSON.stringify({ name: '@fee/compat-probe', version: '1.0.0', type: 'module',
      engines: manifest.engines,
      exports: { '.': './lib/index.js', './client': { default: './lib/client.js' }, './package.json': './package.json' },
      dsh: { client: { platform: 'web', inject: ['@deepseek-ai/dsh-client-ui-renderer'] } } }),
    'lib/index.js': 'export function apply() {}',
    'lib/client.js': "window.__ModuleLoader__.load({id:'@fee/compat-probe',factory:()=>({fixture:'fee-capability-probe-v1'})});",
  }
  for (const [name, source] of Object.entries(files)) await writeFile(join(fixture, name), source, { flag: 'wx', mode: 0o600 })
  const code = `(async () => {
    const sdk = await (${probeSdk.toString()})(${JSON.stringify(root)}, ${JSON.stringify(browserCore)}, ${JSON.stringify(slots)}, ${JSON.stringify(version)});
    const native = await (${probeNative.toString()})(${JSON.stringify(native)});
    process.stdout.write(JSON.stringify({protocol:'fee-capabilities-v1',failed:[...sdk,...native]}));
  })().catch(() => { process.stdout.write(JSON.stringify({protocol:'fee-capabilities-v1',failed:['sdk-probe']})); process.exitCode=1; });`
  await writeFile(script, code, { flag: 'wx', mode: 0o600 })
  await writeFile(policy, PROBE_SANDBOX, { flag: 'wx', mode: 0o600 })
  // Retain only the host's existing Electron run-as-Node flag, not credentials, hooks or DSH_HOME.
  const inherited: NodeJS.ProcessEnv = {}
  if (process.env.ELECTRON_RUN_AS_NODE !== undefined) inherited.ELECTRON_RUN_AS_NODE = process.env.ELECTRON_RUN_AS_NODE
  return await new Promise<string[]>((resolve, reject) => {
    const child = spawn('/usr/bin/sandbox-exec', ['-D', `EXECUTABLE=${executable}`, '-D', `PROBE_ROOT=${root}`,
      '-D', `APP_BUNDLE=${bundle}`, '-f', policy, executable, '--max-old-space-size=192', script], {
      cwd: root, env: inherited, stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = '', bytes = 0, exceeded = false
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('PROBE_TIMEOUT')) }, 4_500)
    child.stdout.on('data', chunk => {
      bytes += chunk.length
      if (bytes > 16_384) { exceeded = true; child.kill('SIGKILL') }
      else output += chunk.toString()
    })
    child.stderr.on('data', chunk => { bytes += chunk.length; if (bytes > 16_384) { exceeded = true; child.kill('SIGKILL') } })
    child.once('error', () => { clearTimeout(timer); reject(new Error('PROBE_UNAVAILABLE')) })
    child.once('close', code => {
      clearTimeout(timer)
      if (exceeded) return reject(new Error('PROBE_OUTPUT_LIMIT'))
      try {
        const failed = decodeProbeResult(output)
        if (code !== 0 && failed.length === 0) throw new Error('PROBE_EXIT')
        resolve(failed)
      } catch { reject(new Error('PROBE_UNAVAILABLE')) }
    })
  })
}
