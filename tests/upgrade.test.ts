import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { captureUpgradeContract, requiredSlot } from '../src/upgrade/contracts.ts'
import { guardDesktopIpc, isDesktopControlListener } from '../src/upgrade/desktop.ts'
import { pendingUpdateInspector } from '../src/upgrade/candidate.ts'
import { AsarArchive, rawArchiveFs } from '../src/upgrade/asar.ts'

const PREFIX = 'dsh/node_modules/@deepseek-ai/'
function fixture(version = '0.2.1-rc.3') {
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ name: '@deepseek-ai/dsh-desktop', version }),
    'dsh/desktop-runtime.json': JSON.stringify({ schemaVersion: 1, release: { version, hostProtocolVersion: 4 } }),
    [`${PREFIX}cordis/package.json`]: '{"version":"4.0.5"}',
    [`${PREFIX}schemastery/package.json`]: '{"version":"3.18.5"}',
    [`${PREFIX}dsh-session/lib/index.js`]: 'const SESSION_FORMAT_VERSION = 4;',
    'lib/main.js': `var DesktopUpdateCoordinator = class {
      async install(version) { if (await this.beforeRestart()) this.updater.quitAndInstall(); }
      async updateTasks(action) { return this.control({ type: "update-tasks", action }); }
    };
    const active = await host.updateTasks("inspect");
    const stillActive = await host.updateTasks("lock");
    this.updater.autoInstallOnAppQuit = false;
    new DesktopUpdateCoordinator(publish, async () => true);`,
    [`${PREFIX}dsh-desktop-host/lib/index.js`]: `process.on("message", message => {
      if (message.type === "quit-inspection") return;
      if (message.type !== "update-tasks") return;
      control.updateTasks(message.action);
    }); process.once("disconnect", stop);`,
    [`${PREFIX}dsh-client-connection/lib/index.js`]: `class Connection {
      get fetch() { return this.routes; }
      registerFetchRoute(owner, route) { return owner.effect(() => route); }
      createSharedFetchHandler(channel) { return { owner: true, channel }; }
    }`,
    [`${PREFIX}dsh-client-ui-renderer/lib/client.js`]: `class SlotRegistry {
      inject(key, callback) { return callback(); }
    } SlotRegistry.prototype.register = function register(rawOptions, component) { return component; };`,
    [`${PREFIX}dsh-client-ui-settings/lib/client.js`]: `var ConfigFormController = class { read() { return this.value; } };
      class ConfigForms { get(entryId) { return this.forms[entryId]; } }`,
    [`${PREFIX}dsh-settings/lib/index.js`]: 'var SettingsForms = class extends Service { update() { return true; } };',
    [`${PREFIX}dsh-client-locale/lib/client.js`]: 'class Locale { register(ns, localeOrDicts, dict) { return dict; } }',
    [`${PREFIX}dsh-client-ui-conversation/lib/client.js`]: 'ctx.slots.register({children: { "conversation.composer.dock": { kind: "list", scope: "session" } }}, Component); renderSlot("conversation.composer.dock", {});',
    [`${PREFIX}dsh-client-ui-settings-plugins/lib/client.js`]: 'ctx.slots.register({children: { "settings.plugins.tab": { kind: "list", scope: "root" } }}, Component); renderSlot("settings.plugins.tab", {});',
    [`${PREFIX}dsh-app-boot/lib/index.js`]: `function satisfies(runtimeVersion, range) { return true; }
      function unmetRequirements(fields, runtimeVersion) { return {}; }
      function evaluatePluginCompatibility(manifest, exemptions = {}, runtimeVersion = getDshRuntimeVersion()) { return undefined; }`,
    [`${PREFIX}dsh-client-modules/lib/index.js`]: 'const clientFactoryProtocol = 1;',
    [`${PREFIX}dsh-web-frontend/dist/index.html`]: '<script type="module" src="/assets/index-abc.js"></script>',
    [`${PREFIX}dsh-web-frontend/dist/assets/index-abc.js`]: 'const frontend = true;',
    'node_modules/electron-updater/out/DownloadedUpdateHelper.js': 'const cacheProtocol = 1;',
    'node_modules/electron-updater/out/AppUpdater.js': 'const downloadProtocol = 1;',
    'node_modules/electron-updater/out/MacUpdater.js': 'const installProtocol = 1;',
  }
  return { files, text: async (path: string) => {
    if (!(path in files)) throw new Error('missing')
    return files[path]!
  } }
}

const temporary: string[] = []
afterEach(async () => {
  vi.useRealTimers()
  for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true })
})

describe('declarative prerequisites for behavior probes', () => {
  it('accepts SDK minor updates and native implementation changes for behavioral verification', async () => {
    const next = fixture('0.2.2-rc.1')
    next.files[`${PREFIX}cordis/package.json`] = '{"version":"4.1.0"}'
    next.files[`${PREFIX}schemastery/package.json`] = '{"version":"3.19.0"}'
    next.files['lib/main.js'] += '\nfunction unrelatedNewFeature() { return 42; }'
    const result = await captureUpgradeContract(next)
    expect(result.version).toBe('0.2.2-rc.1')
    expect(result.native.coordinator).toContain('install(version)')
    expect(result.frontend).toBe('const frontend = true;')
    // No source hash grants approval: candidate.ts must still run the SDK/native behavior probes.
    expect(result).not.toHaveProperty('fingerprints')
  })

  it('requires actual host slot registration and a consumer with matching shape', () => {
    const good = 'ctx.slots.register({ children: { "conversation.composer.dock": {kind:"list",scope:"session"} } }, Component); renderSlot("conversation.composer.dock", {});'
    expect(requiredSlot(good, 'conversation.composer.dock', 'session')).toEqual({ kind: 'list', scope: 'session' })
    for (const bad of [good.replaceAll('conversation.composer.dock', 'renamed'), good.replace('kind:"list"', 'kind:"single"'),
      good.replace('scope:"session"', 'scope:"root"'), good.split(';')[0]!, 'const unrelated = {"conversation.composer.dock": {kind:"list",scope:"session"}};']) {
      expect(() => requiredSlot(bad, 'conversation.composer.dock', 'session')).toThrow('HOST_SLOT')
    }
  })

  it.each(['format', 'framework', 'major', 'protocol', 'client-layout', 'native-protocol'])(
    'rejects unsupported prerequisite %s', async kind => {
      const next = fixture(kind === 'major' ? '1.0.0' : '0.2.2-rc.1')
      if (kind === 'format') next.files[`${PREFIX}dsh-session/lib/index.js`] = 'const SESSION_FORMAT_VERSION = 5;'
      if (kind === 'framework') next.files[`${PREFIX}cordis/package.json`] = '{"version":"5.0.0"}'
      if (kind === 'protocol') next.files['dsh/desktop-runtime.json'] = JSON.stringify({ schemaVersion: 1, release: { version: '0.2.2-rc.1', hostProtocolVersion: 5 } })
      if (kind === 'client-layout') next.files[`${PREFIX}dsh-web-frontend/dist/index.html`] = '<script type="module" src="../../outside.js"></script>'
      if (kind === 'native-protocol') next.files['lib/main.js'] = 'const unknown = true;'
      await expect(captureUpgradeContract(next)).rejects.toThrow()
    },
  )
})

function transport() {
  const ipc = Object.assign(new EventEmitter(), { send: vi.fn((_message: object) => {}) })
  const control = { updateTasks: vi.fn(() => false) }
  // Synthetic native protocol, with no application, session, or filesystem effects.
  const original = new Function('control', 'send', `return function(message) {
    if (message.type === "quit-inspection") { send({ quit: true }); return; }
    if (message.type !== "update-tasks") return;
    const active = control.updateTasks(message.action);
    send({ type: "update-tasks", requestId: message.requestId, active });
  }`)(control, ipc.send) as (message: object) => void
  ipc.on('message', original)
  return { ipc, control, original }
}

describe('native installation admission', () => {
  it('blocks incompatible installation before the native task lock and delegates ordinary quit', async () => {
    const { ipc, control, original } = transport()
    expect(isDesktopControlListener(original)).toBe(true)
    const inspect = vi.fn(async () => ({ allowed: false, reason: 'changed-interface' as const, version: '0.3.0' }))
    const guard = guardDesktopIpc(ipc, inspect)
    ipc.emit('message', { type: 'update-tasks', requestId: 1, action: 'inspect' })
    await vi.waitFor(() => expect(ipc.send).toHaveBeenCalled())
    expect(ipc.send).toHaveBeenCalledWith(expect.objectContaining({ requestId: 1, error: expect.stringContaining('安装已拦截') }))
    expect(control.updateTasks).not.toHaveBeenCalled()
    expect(guard.status().state).toBe('blocked')
    ipc.emit('message', { type: 'quit-inspection', requestId: 2 })
    expect(ipc.send).toHaveBeenLastCalledWith({ quit: true })
    guard.dispose()
    expect(ipc.listeners('message')).toEqual([original])
  })

  it('passes a compatible target to the native inspector and rechecks at lock', async () => {
    const { ipc, control } = transport()
    const inspect = vi.fn(async () => ({ allowed: true, reason: 'compatible' as const, version: '0.3.0' }))
    const guard = guardDesktopIpc(ipc, inspect)
    for (const [requestId, action] of [[1, 'inspect'], [2, 'lock']] as const) {
      ipc.emit('message', { type: 'update-tasks', requestId, action })
      await vi.waitFor(() => expect(control.updateTasks).toHaveBeenCalledWith(action))
    }
    expect(inspect).toHaveBeenCalledTimes(2)
    ipc.emit('message', { type: 'update-tasks', requestId: 3, action: 'unlock' })
    expect(control.updateTasks).toHaveBeenLastCalledWith('unlock')
    expect(inspect).toHaveBeenCalledTimes(2)
    guard.dispose()
  })

  it('refuses a timeout and never delivers its late approval to the native installer', async () => {
    vi.useFakeTimers()
    const { ipc, control } = transport()
    let complete!: (value: { allowed: boolean; reason: 'compatible' }) => void
    const guard = guardDesktopIpc(ipc, () => new Promise(resolve => { complete = resolve }))
    ipc.emit('message', { type: 'update-tasks', requestId: 1, action: 'lock' })
    await vi.advanceTimersByTimeAsync(8_000)
    complete({ allowed: true, reason: 'compatible' })
    await vi.advanceTimersByTimeAsync(1)
    expect(control.updateTasks).not.toHaveBeenCalled()
    expect(ipc.send).toHaveBeenCalledTimes(1)
    expect(guard.status().reason).toBe('check-timeout')
    guard.dispose()
  })

  it('refuses lock if the fresh candidate recheck no longer passes', async () => {
    const { ipc, control } = transport()
    const inspect = vi.fn()
      .mockResolvedValueOnce({ allowed: true, reason: 'compatible', version: '0.2.2-rc.1' })
      .mockResolvedValueOnce({ allowed: false, reason: 'check-failed', detail: 'UPDATE_CHANGED' })
    const guard = guardDesktopIpc(ipc, inspect)
    ipc.emit('message', { type: 'update-tasks', requestId: 1, action: 'inspect' })
    await vi.waitFor(() => expect(control.updateTasks).toHaveBeenCalledWith('inspect'))
    ipc.emit('message', { type: 'update-tasks', requestId: 2, action: 'lock' })
    await vi.waitFor(() => expect(guard.status().state).toBe('blocked'))
    expect(control.updateTasks).not.toHaveBeenCalledWith('lock')
    expect(ipc.send).toHaveBeenCalledWith(expect.objectContaining({ requestId: 2, error: expect.stringContaining('UPDATE_CHANGED') }))
    guard.dispose()
  })

  it('recognizes equivalent listener argument names', () => {
    const { original } = transport()
    const renamed = new Function('control', 'send', `return (${original.toString().replaceAll('message', 'packet')})`)({}, () => {})
    expect(isDesktopControlListener(renamed)).toBe(true)
  })

  it('preserves other listeners and reports unavailable for an unknown host', () => {
    const { ipc, original } = transport()
    const other = vi.fn()
    ipc.on('message', other)
    const guard = guardDesktopIpc(ipc, vi.fn())
    guard.dispose()
    expect(ipc.listeners('message')).toEqual([original, other])
    const unknown = new EventEmitter()
    unknown.on('message', other)
    expect(guardDesktopIpc(unknown, vi.fn()).status().state).toBe('unavailable')
    expect(unknown.listeners('message')).toEqual([other])
  })
})

describe('candidate input boundaries', () => {
  it('fails closed on an absent update, traversal metadata, and a checksum mismatch', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fee-upgrade-test-'))
    temporary.push(dir)
    const inspect = pendingUpdateInspector(join(dir, 'current.asar'), dir)
    expect((await inspect()).allowed).toBe(false)
    await mkdir(join(dir, 'pending'))
    const info = join(dir, 'pending/update-info.json')
    await writeFile(info, JSON.stringify({ fileName: '../../outside.zip', sha512: 'x'.repeat(86) + '==' }))
    expect((await inspect()).allowed).toBe(false)
    await writeFile(info, JSON.stringify({ fileName: 'candidate.zip', sha512: 'x'.repeat(86) + '==' }))
    await writeFile(join(dir, 'pending/candidate.zip'), 'not an archive')
    await writeFile(join(dir, 'current.asar'), 'current application')
    expect((await inspect()).allowed).toBe(false)
  })

  it('rejects a malformed ASAR header before parsing or allocating its declared body', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fee-asar-test-'))
    temporary.push(dir)
    const path = join(dir, 'bad.asar')
    await writeFile(path, Buffer.alloc(16, 255))
    await expect(AsarArchive.open(path)).rejects.toThrow('ASAR_HEADER')
  })
})


describe('physical ASAR access in the desktop runtime', () => {
  it('uses original-fs for both identity and byte reads in Electron without global flags', async () => {
    const physical = { lstat: vi.fn(), open: vi.fn() }
    const load = vi.fn(() => ({ promises: physical }))
    const before = (process as unknown as { noAsar?: boolean }).noAsar
    const selected = rawArchiveFs('desktop-electron', load as unknown as Parameters<typeof rawArchiveFs>[1])
    expect(load).toHaveBeenCalledWith('original-fs')
    expect(selected.lstat).toBe(physical.lstat)
    expect(selected.open).toBe(physical.open)
    expect((process as unknown as { noAsar?: boolean }).noAsar).toBe(before)
  })

  it('keeps normal Node filesystem access and fails closed if Electron raw fs is unavailable', () => {
    const load = vi.fn(() => { throw new Error('unavailable') })
    expect(rawArchiveFs('', load).open).toBeTypeOf('function')
    expect(load).not.toHaveBeenCalled()
    expect(() => rawArchiveFs('desktop-electron', load)).toThrow('unavailable')
  })
})
