/** Gate the native Desktop install handshake while leaving the signed application intact. */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import type { UpgradeProtection } from '../protocol.ts'
import { pendingUpdateInspector, type UpgradeVerdict } from './candidate.ts'
import { sourceTokens } from './contracts.ts'

type Listener = (...args: unknown[]) => void

/** The Node parent IPC operations used by the official Desktop Host. */
export interface DesktopIpc {
  listeners(event: 'message'): Function[]
  removeListener(event: 'message', listener: Listener): unknown
  prependListener(event: 'message', listener: Listener): unknown
  send?(message: object): unknown
}

/** Lifetime and current public status of the installed gate. */
export interface DesktopUpgradeGuard {
  status(): UpgradeProtection
  dispose(): void
}

/** Recognize only the inspected native update/quit control listener. */
export function isDesktopControlListener(listener: Function): boolean {
  const text = sourceTokens(Function.prototype.toString.call(listener)).join(' ')
  return text.includes('message . type !== string:"update-tasks"')
    && text.includes('control . updateTasks ( message . action )')
    && text.includes('string:"quit-inspection"')
}

/** Interpose one known listener; every unrelated message is delegated unchanged. */
export function guardDesktopIpc(ipc: DesktopIpc, inspect: () => Promise<UpgradeVerdict>): DesktopUpgradeGuard {
  const candidates = ipc.listeners('message').filter(isDesktopControlListener)
  let state: UpgradeProtection = { state: 'unavailable' }
  if (candidates.length !== 1 || ipc.send === undefined) return { status: () => ({ ...state }), dispose() {} }
  const original = candidates[0] as Listener
  let alive = true
  state = { state: 'armed' }
  const refuse = (requestId: number, reason: string) => {
    try {
      ipc.send?.({ type: 'update-tasks', requestId, active: true,
        error: `费用插件升级保护：${reason}。本次安装已拦截，当前版本可继续使用。` })
    } catch { /* A disconnected shell cannot install through this request. */ }
  }
  const listener: Listener = (...args) => {
    const message = args[0] as { type?: string; requestId?: number; action?: string } | null
    if (message === null || typeof message !== 'object' || message.type !== 'update-tasks'
      || !Number.isSafeInteger(message.requestId) || !['inspect', 'lock'].includes(message.action ?? '')) {
      original.apply(ipc, args)
      return
    }
    const requestId = message.requestId!
    state = { state: 'checking' }
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      state = { state: 'blocked', reason: 'check-timeout' }
      refuse(requestId, '兼容检查尚未完成，请稍后重试安装')
    }, 8_000)
    void Promise.resolve().then(inspect).then(verdict => {
      if (timedOut) return
      state = { state: verdict.allowed ? 'armed' : 'blocked', version: verdict.version, reason: verdict.reason }
      if (alive && verdict.allowed) original.apply(ipc, args)
      else refuse(requestId, verdict.reason === 'changed-interface' ? '候选版本改变了尚未验证的费用接口' : '候选版本未通过兼容检查')
    }).catch(() => {
      if (!timedOut) {
        state = { state: 'blocked', reason: 'check-failed' }
        refuse(requestId, '无法完成候选版本检查')
      }
    }).finally(() => clearTimeout(timer))
  }
  ipc.removeListener('message', original)
  ipc.prependListener('message', listener)
  return {
    status: () => ({ ...state }),
    dispose() {
      if (!alive) return
      alive = false
      ipc.removeListener('message', listener)
      ipc.prependListener('message', original)
    },
  }
}

/** Auto-enable for the registered macOS Desktop layout; ordinary Web hosts stay unchanged. */
export function installDesktopUpgradeGuard(): DesktopUpgradeGuard {
  const none = (state: UpgradeProtection['state']): DesktopUpgradeGuard => ({ status: () => ({ state }), dispose() {} })
  if (process.platform !== 'darwin' || process.send === undefined || !process.connected) return none('not-applicable')
  const runtime = process.argv[2]
  if (typeof runtime !== 'string' || !runtime.endsWith('/Contents/Resources/app.asar/dsh')) return none('unavailable')
  const asar = dirname(runtime)
  try {
    const config = readFileSync(join(dirname(asar), 'app-update.yml'), 'utf8')
    const cacheName = /^updaterCacheDirName:\s*['"]?([@\w.-]+)['"]?\s*$/m.exec(config)?.[1]
    if (cacheName === undefined) return none('unavailable')
    return guardDesktopIpc(process, pendingUpdateInspector(asar, join(homedir(), 'Library', 'Caches', cacheName)))
  } catch {
    return none('unavailable')
  }
}
