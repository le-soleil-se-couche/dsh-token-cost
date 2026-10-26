/** Registered compatibility plan for the native Desktop update handshake and fee APIs. */
import { createHash } from 'node:crypto'
import { parse, tokenizer } from 'acorn'

/** Archive reader shared by real packages and synthetic update fixtures. */
export interface PackageReader { text(path: string): Promise<string> }

/** Evidence compared before the native updater may stop the current host. */
export interface UpgradeContract {
  version: string
  fingerprints: Record<string, string>
}

const PREFIX = 'dsh/node_modules/@deepseek-ai/'

/** Ignore comments and layout while retaining every executable token and string. */
export function sourceTokens(source: string): string[] {
  const tokens: string[] = []
  const scanner = tokenizer(source, { ecmaVersion: 'latest', sourceType: 'module' })
  for (let token = scanner.getToken(); token.type.label !== 'eof'; token = scanner.getToken()) {
    const kind = token.type.label
    // Acorn's Token declaration omits its documented runtime value field.
    const value = 'value' in token ? token.value : undefined
    if (kind === 'string' || kind === 'template' || kind === 'regexp') tokens.push(`${kind}:${JSON.stringify(value)}`)
    else if (kind === 'num') tokens.push(`${typeof value}:${String(value)}`)
    else if (kind === 'privateId') tokens.push(`private:${String(value)}`)
    else tokens.push(String(value ?? kind))
  }
  return tokens
}

/** Extract one unambiguous function/object block from an observed source anchor. */
export function sourceBlock(source: string, anchor: string): string {
  const tokens = sourceTokens(source)
  const needle = sourceTokens(anchor)
  const starts = tokens.flatMap((_token, index) => tokens[index + needle.length] === '{'
    && needle.every((value, offset) => tokens[index + offset] === value) ? [index] : [])
  if (starts.length !== 1) throw new Error('SOURCE_ANCHOR')
  const start = starts[0]!
  const opening = start + needle.length
  if (tokens[opening] !== '{') throw new Error('SOURCE_BLOCK')
  let depth = 0
  for (let i = opening; i < tokens.length; i++) {
    if (tokens[i] === '{' || tokens[i] === '${') depth++
    if (tokens[i] === '}' && --depth === 0) {
      const positions = Array.from(tokenizer(source, { ecmaVersion: 'latest', sourceType: 'module' }))
      const begin = positions[opening]!.start
      const end = positions[i]!.end
      const tree = parseSource(source)
      let selected: unknown
      const visit = (value: unknown): void => {
        if (!value || typeof value !== 'object') return
        const node = value as Record<string, unknown>
        if (node.start === begin && node.end === end) { selected = node; return }
        for (const child of Object.values(node)) {
          if (Array.isArray(child)) child.forEach(visit)
          else visit(child)
        }
      }
      visit(tree)
      if (!selected) throw new Error('SOURCE_SYNTAX_BLOCK')
      return JSON.stringify(tokens.slice(start, i + 1)) + canonicalSyntax(selected)
    }
  }
  throw new Error('SOURCE_BLOCK')
}

// Syntax, unlike lexical tokens, retains automatic semicolon insertion semantics.
function parseSource(source: string) {
  return parse(source, { ecmaVersion: 'latest', sourceType: 'module', allowReturnOutsideFunction: true })
}

function canonicalSyntax(tree: unknown): string {
  return JSON.stringify(tree, (key, value) => {
    if (['start', 'end', 'loc', 'range', 'raw'].includes(key)) return undefined
    return typeof value === 'bigint' ? { bigint: value.toString() } : value
  })
}

function digest(value: string): string { return createHash('sha256').update(value).digest('hex') }

function sequenceIndex(tokens: string[], fragment: string, from = 0): number {
  const needle = sourceTokens(fragment)
  return tokens.findIndex((_token, index) => index >= from && needle.every((value, offset) => tokens[index + offset] === value))
}

/** Source anchors are limited to interfaces actually used by this plugin. */
const BLOCKS: Array<[string, string, string]> = [
  ['native-install', 'lib/main.js', 'async install(version)'],
  ['native-request', 'lib/main.js', 'async updateTasks(action)'],
  ['fetch-registry', `${PREFIX}dsh-client-connection/lib/index.js`, 'get fetch()'],
  ['fetch-register', `${PREFIX}dsh-client-connection/lib/index.js`, 'registerFetchRoute(owner, route)'],
  ['fetch-owner', `${PREFIX}dsh-client-connection/lib/index.js`, 'createSharedFetchHandler(channel)'],
  ['slots-wait', `${PREFIX}dsh-client-ui-renderer/lib/client.js`, 'inject(key, callback)'],
  ['slots-register', `${PREFIX}dsh-client-ui-renderer/lib/client.js`, 'SlotRegistry.prototype.register = function register(rawOptions, component)'],
  ['settings-form', `${PREFIX}dsh-client-ui-settings/lib/client.js`, 'var ConfigFormController = class'],
  ['settings-get', `${PREFIX}dsh-client-ui-settings/lib/client.js`, 'get(entryId)'],
  ['settings-host', `${PREFIX}dsh-settings/lib/index.js`, 'var SettingsForms = class extends Service'],
  ['locale-register', `${PREFIX}dsh-client-locale/lib/client.js`, 'register(ns, localeOrDicts, dict)'],
  ['composer-slot', `${PREFIX}dsh-client-ui-conversation/lib/client.js`, '"conversation.composer.dock":'],
  ['settings-slot', `${PREFIX}dsh-client-ui-settings-plugins/lib/client.js`, '"settings.plugins.tab":'],
  ['loader-range', `${PREFIX}dsh-app-boot/lib/index.js`, 'function satisfies(runtimeVersion, range)'],
  ['loader-requirements', `${PREFIX}dsh-app-boot/lib/index.js`, 'function unmetRequirements(fields, runtimeVersion)'],
  ['loader-admission', `${PREFIX}dsh-app-boot/lib/index.js`, 'function evaluatePluginCompatibility(manifest, exemptions = {}, runtimeVersion = getDshRuntimeVersion())'],
]

const UPDATE_BINDING_FILES: Array<[string, string]> = [
  ['updater-cache', 'node_modules/electron-updater/out/DownloadedUpdateHelper.js'],
  ['updater-download', 'node_modules/electron-updater/out/AppUpdater.js'],
  ['updater-mac', 'node_modules/electron-updater/out/MacUpdater.js'],
  ['client-module-loader', `${PREFIX}dsh-client-modules/lib/index.js`],
]

/** Capture only a recognized native layout; unknown layouts never produce approval. */
export async function captureUpgradeContract(reader: PackageReader): Promise<UpgradeContract> {
  const cache = new Map<string, Promise<string>>()
  const text = (path: string) => {
    let value = cache.get(path)
    if (value === undefined) { value = reader.text(path); cache.set(path, value) }
    return value
  }
  const manifest = JSON.parse(await text('package.json')) as { name?: string; version?: string }
  if (manifest.name !== '@deepseek-ai/dsh-desktop' || typeof manifest.version !== 'string'
    || !/^0\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.test(manifest.version)) throw new Error('HOST_FAMILY')
  const descriptor = JSON.parse(await text('dsh/desktop-runtime.json')) as { schemaVersion?: number; release?: { version?: string; hostProtocolVersion?: number } }
  if (descriptor.schemaVersion !== 1 || descriptor.release?.version !== manifest.version
    || descriptor.release.hostProtocolVersion !== 4) throw new Error('HOST_PROTOCOL')
  for (const [name, range] of [['cordis', /^4\.0\.\d+$/], ['schemastery', /^3\.18\.\d+$/]] as const) {
    const pkg = JSON.parse(await text(`${PREFIX}${name}/package.json`)) as { version?: string }
    if (!range.test(pkg.version ?? '')) throw new Error('FRAMEWORK_FAMILY')
  }
  if (sequenceIndex(sourceTokens(await text(`${PREFIX}dsh-session/lib/index.js`)), 'const SESSION_FORMAT_VERSION = 4;') < 0) throw new Error('SESSION_FORMAT')
  const shell = sourceTokens(await text('lib/main.js'))
  if (sequenceIndex(shell, 'const active = await host.updateTasks("inspect")') < 0
    || sequenceIndex(shell, 'const stillActive = await host.updateTasks("lock")') < 0
    || sequenceIndex(shell, 'this.updater.autoInstallOnAppQuit = false;') < 0) throw new Error('NATIVE_INSTALL_ADMISSION')
  const host = sourceTokens(await text(`${PREFIX}dsh-desktop-host/lib/index.js`))
  const start = sequenceIndex(host, 'if (message.type !== "update-tasks"')
  const end = sequenceIndex(host, 'process.once("disconnect"', start)
  if (start < 0 || end < start || sequenceIndex(host.slice(start, end), 'control.updateTasks(message.action)') < 0) throw new Error('NATIVE_CONTROL')
  const fingerprints: Record<string, string> = { 'native-control': digest(canonicalSyntax(parseSource(await text(`${PREFIX}dsh-desktop-host/lib/index.js`)))) }
  for (const [name, path, anchor] of BLOCKS) {
    try { fingerprints[name] = digest(sourceBlock(await text(path), anchor)) }
    catch { throw new Error(`SOURCE_INTERFACE:${name}`) }
  }
  // Registration delegates to private methods and helpers. Conservatively bind the
  // whole renderer implementation so changes outside the public wrapper cannot pass.
  fingerprints['slots-implementation'] = digest(canonicalSyntax(parseSource(
    await text(`${PREFIX}dsh-client-ui-renderer/lib/client.js`),
  )))
  // The IPC request has no version field: bind it to the known native cache protocol.
  // A future updater that changes this binding must not use an old cached approval.
  for (const [name, path] of UPDATE_BINDING_FILES) fingerprints[name] = digest(canonicalSyntax(parseSource(await text(path))))
  return { version: manifest.version, fingerprints }
}

/** Accept version/layout-only changes; altered fee or update behavior needs a reviewed plan. */
export function compareUpgradeContracts(current: UpgradeContract, candidate: UpgradeContract): string[] {
  return [...new Set([...Object.keys(current.fingerprints), ...Object.keys(candidate.fingerprints)])]
    .filter(key => current.fingerprints[key] !== candidate.fingerprints[key])
}
