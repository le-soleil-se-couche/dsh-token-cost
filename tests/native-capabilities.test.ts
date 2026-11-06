import { describe, expect, it } from 'vitest'
import { probeNative, type NativeProbeSource } from '../src/upgrade/native-probe.ts'
import { decodeProbeResult } from '../src/upgrade/probe-runner.ts'

const fixture = (): NativeProbeSource => ({
  prepare: `async () => { await backend.host.updateTasks('inspect'); await backend.host.updateTasks('lock'); await backend.stop(); return true; }`,
  request: 'async updateTasks(action) { return (await this.control({ type: "update-tasks", action })).active; }',
  listener: `message => {
    control.updateTasks(message.action).then(active => send({ requestId: message.requestId, active }),
      error => send({ requestId: message.requestId, active: true, error: 'refused' }));
  }`,
  coordinator: `class {
    constructor(notify, prepare, updater) { this.prepare = prepare; this.updater = updater; }
    async check() { return this.updater.checkForUpdates(); }
    async download(version) { await this.updater.downloadUpdate(); }
    async install(version) {
      try { if (!await this.prepare()) return { phase: 'error' };
        this.updater.quitAndInstall(); return { phase: 'installing' };
      } catch { return { phase: 'error' }; }
    }
    dispose() {}
  }`,
})

describe('native update behavior, independent of source spelling', () => {
  it('accepts equivalent syntax and local names', async () => {
    const source = fixture()
    expect(await probeNative(source)).toEqual([])
    source.listener = source.listener.replaceAll('message', 'incoming')
    source.coordinator = source.coordinator.replaceAll('version', 'targetVersion')
    expect(await probeNative(source)).toEqual([])
  })

  it('rejects installation that ignores preparation refusal', async () => {
    const source = fixture()
    source.coordinator = source.coordinator.replace("if (!await this.prepare()) return { phase: 'error' };", '')
    expect(await probeNative(source)).toEqual(['native-update-protocol'])
  })

  it('rejects a listener that suppresses active tasks or preparation errors', async () => {
    const active = fixture()
    active.listener = active.listener.replace('requestId: message.requestId, active }', 'requestId: message.requestId, active: false }')
    expect(await probeNative(active)).toEqual(['native-update-protocol'])
    const error = fixture()
    error.listener = error.listener.replace("active: true, error: 'refused'", 'active: false')
    expect(await probeNative(error)).toEqual(['native-update-protocol'])
  })

  it('rejects native wiring that omits either admission phase', async () => {
    for (const action of ['inspect', 'lock']) {
      const source = fixture()
      source.prepare = source.prepare.replace(`await backend.host.updateTasks('${action}');`, '')
      expect(await probeNative(source)).toEqual(['native-update-protocol'])
    }
  })

  it('rejects changed return semantics instead of discarding significant newlines', async () => {
    const source = fixture()
    source.request = source.request.replace('return (', 'return\n(')
    expect(await probeNative(source)).toEqual(['native-update-protocol'])
  })
})

describe('restricted probe result channel', () => {
  it('accepts only the fixed contract and known failure identifiers', () => {
    expect(decodeProbeResult('{"protocol":"fee-capabilities-v1","failed":[]}')).toEqual([])
    expect(() => decodeProbeResult('{"protocol":"other","failed":[]}')).toThrow()
    expect(() => decodeProbeResult('{"protocol":"fee-capabilities-v1","failed":["/private/user-path"]}')).toThrow()
    expect(() => decodeProbeResult('process output\n{"protocol":"fee-capabilities-v1","failed":[]}')).toThrow()
    expect(() => decodeProbeResult('{"protocol":"fee-capabilities-v1","failed":[{}]}')).toThrow()
  })
})
