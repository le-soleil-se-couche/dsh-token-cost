import { parse } from 'acorn'
import { isDesktopControlSource } from './ipc-contract.ts'

export interface NativeProbeSource { listener: string; coordinator: string; request: string; prepare: string }

/** Select protocol entrypoints, not their byte identity; execute them only in the restricted child. */
export function nativeProbeSource(main: string, host: string): NativeProbeSource {
  const select = (source: string, predicate: (node: any) => boolean): any[] => {
    const found: any[] = []
    const visit = (value: any): void => {
      if (!value || typeof value !== 'object') return
      if (predicate(value)) found.push(value)
      for (const child of Object.values(value)) {
        if (Array.isArray(child)) child.forEach(visit)
        else visit(child)
      }
    }
    visit(parse(source, { ecmaVersion: 'latest', sourceType: 'module' }))
    return found
  }
  const coordinator = select(main, n => n.type === 'VariableDeclarator' && n.id.name === 'DesktopUpdateCoordinator')
  const prepare = select(main, n => n.type === 'NewExpression' && n.callee.name === 'DesktopUpdateCoordinator'
    && ['ArrowFunctionExpression', 'FunctionExpression'].includes(n.arguments[1]?.type))
  const request = select(main, n => n.type === 'MethodDefinition' && n.key.name === 'updateTasks')
  const listener = select(host, n => n.type === 'CallExpression' && n.callee.type === 'MemberExpression'
    && n.callee.object.name === 'process' && n.callee.property.name === 'on' && n.arguments[0]?.value === 'message'
    && host.slice(n.arguments[1]?.start, n.arguments[1]?.end).includes('update-tasks'))
  if (coordinator.length !== 1 || request.length !== 1 || listener.length !== 1 || prepare.length !== 1) throw new Error('NATIVE_PROTOCOL')
  if (!isDesktopControlSource(host.slice(listener[0].arguments[1].start, listener[0].arguments[1].end))) throw new Error('NATIVE_PROTOCOL')
  return {
    coordinator: main.slice(coordinator[0].init.start, coordinator[0].init.end),
    request: main.slice(request[0].start, request[0].end),
    prepare: main.slice(prepare[0].arguments[1].start, prepare[0].arguments[1].end),
    listener: host.slice(listener[0].arguments[1].start, listener[0].arguments[1].end),
  }
}

/** Self-contained: serialized into a short-lived, OS-restricted process with synthetic IPC only. */
export async function probeNative(source: NativeProbeSource): Promise<string[]> {
  const assert: typeof import('node:assert/strict') = (await import('node:assert/strict')).default
  const { EventEmitter } = await import('node:events')
  const deadline = async <T>(promise: Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined
    try { return await Promise.race([promise, new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error('timeout')), 500)
    })]) } finally { clearTimeout(timer) }
  }
  try {
    const requestMethod = new Function(`return ({${source.request}}).updateTasks`)()
    for (const active of [false, true]) {
      const value = await requestMethod.call({ async control(message: any) {
        assert.equal(message.type, 'update-tasks'); assert.equal(message.action, 'inspect')
        return { type: 'update-tasks', active }
      } }, 'inspect')
      assert.equal(value, active)
    }
    await assert.rejects(() => requestMethod.call({ control: async () => { throw new Error('refused') } }, 'lock'))
    const original = new Function('control', 'send', 'stop', 'stopping', `return (${source.listener})`)
    for (const active of [false, true]) {
      const response = await deadline<any>(new Promise(resolve => {
        const listener = original({ updateTasks: async () => active }, async (reply: any) => resolve(reply), () => {}, undefined)
        listener({ type: 'update-tasks', requestId: 1, action: 'inspect' })
      }))
      assert.equal(response.active, active)
      assert.equal(response.error, undefined)
    }
    const Coordinator = new Function('autoUpdater', 'DesktopUpdatePreparationError', 'valid', 'gt', `return (${source.coordinator})`)(
      {}, class extends Error {}, (v: string) => v, () => true,
    )
    for (const mode of ['compatible', 'refused', 'check-error', 'lock-refused']) {
      const replies = new Map<number, (response: any) => void>()
      let sequence = 0, stopped = 0, installed = 0
      const actions: string[] = []
      const control = { updateTasks: async (action: string) => {
        actions.push(action)
        if (mode === 'refused' || mode === 'check-error' || (mode === 'lock-refused' && action === 'lock')) {
          throw new Error('synthetic refusal')
        }
        return false
      } }
      const listener = original(control, async (reply: any) => replies.get(reply.requestId)?.(reply), () => {}, undefined)
      const request = (action: string): Promise<boolean> => deadline(new Promise((resolve, reject) => {
        const requestId = ++sequence
        replies.set(requestId, response => response.error ? reject(new Error('refused')) : resolve(response.active))
        listener({ type: 'update-tasks', requestId, action })
      }))
      const updater = Object.assign(new EventEmitter(), {
        checkForUpdates: async () => ({ isUpdateAvailable: true, updateInfo: { version: '0.3.0' } }),
        downloadUpdate: async () => { updater.emit('update-downloaded', { version: '0.3.0' }) },
        quitAndInstall: () => { actions.push('install'); installed++ },
      })
      const scope = {
        commandManager: { idle: async () => {} }, workspaceRecovery: Promise.resolve(), startup: undefined,
        backend: { host: { updateTasks: request }, stop: async () => { actions.push('stop'); stopped++ } },
        DesktopUpdatePreparationError: class extends Error {}, locale: { messages: {} },
        currentDialogWindow: () => ({}), prepareDesktopUpdateWindow: async () => true,
        desktopUpdateReadyConfirmation: () => ({ message: 'fixture', detail: 'fixture' }),
        updates: { state: { version: '0.3.0' } }, isMandatory: () => false, mandatoryUI: undefined,
        updateDialog: { show: async () => ({ response: 0 }) }, track: async () => {},
        platformView: { closeAndWait: async () => {} }, disposeFileDrag: async () => {},
        requireCleanStop: false, updateStopFailure: undefined, updateStoppedHost: false,
        stopOperationReports: async () => {}, operationJournal: undefined, updateJournal: undefined,
        shellInstallerOwnsQuit: false, operationReportsStopping: false, operationReportStop: undefined, shuttingDown: false,
      }
      const prepare = new Function('scope', `with(scope) { return (${source.prepare}); }`)(scope)
      const coordinator = new Coordinator(() => {}, prepare, updater, () => true, () => '0.2.1-rc.5')
      try {
        await deadline(coordinator.check())
        await deadline(coordinator.download('0.3.0'))
        const result = await deadline<any>(coordinator.install('0.3.0'))
        assert.equal(installed, mode === 'compatible' ? 1 : 0)
        assert.equal(stopped, mode === 'compatible' ? 1 : 0)
        assert.equal(result.phase, mode === 'compatible' ? 'installing' : 'error')
        if (mode === 'compatible') assert.deepEqual(actions, ['inspect', 'lock', 'stop', 'install'])
      } finally { coordinator.dispose() }
    }
    return []
  } catch { return ['native-update-protocol'] }
}
