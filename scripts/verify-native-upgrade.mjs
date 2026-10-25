/** Verify the installed native control code with inert IPC/updater substitutes. Never installs an update. */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { parse } from 'acorn'
import { AsarArchive } from '../src/upgrade/asar.ts'
import { captureUpgradeContract } from '../src/upgrade/contracts.ts'
import { guardDesktopIpc } from '../src/upgrade/desktop.ts'
import { pendingUpdateInspector } from '../src/upgrade/candidate.ts'

const args = process.argv.slice(2)
const option = name => args[args.indexOf(name) + 1]
assert(args.includes('--app') && args.includes('--cache'), 'Provide --app and --cache explicitly')
const asarPath = `${option('--app')}/Contents/Resources/app.asar`
const archive = await AsarArchive.open(asarPath)
let main, host
try {
  await captureUpgradeContract(archive)
  main = await archive.text('lib/main.js')
  host = await archive.text('dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js')
} finally { await archive.close() }

function nodes(value, predicate, output = []) {
  if (!value || typeof value !== 'object') return output
  if (predicate(value)) output.push(value)
  for (const child of Object.values(value)) {
    if (Array.isArray(child)) for (const item of child) nodes(item, predicate, output)
    else if (child && typeof child === 'object') nodes(child, predicate, output)
  }
  return output
}
const parseOptions = { ecmaVersion: 'latest', sourceType: 'module' }
const classes = nodes(parse(main, parseOptions), node => node.type === 'VariableDeclarator'
  && node.id.name === 'DesktopUpdateCoordinator')
assert.equal(classes.length, 1)
const nativeClass = main.slice(classes[0].init.start, classes[0].init.end)
const listeners = nodes(parse(host, parseOptions), node => node.type === 'CallExpression'
  && node.callee.type === 'MemberExpression' && node.callee.object.name === 'process'
  && node.callee.property.name === 'on' && node.arguments[0]?.value === 'message')
assert.equal(listeners.length, 1)
const nativeListener = host.slice(listeners[0].arguments[1].start, listeners[0].arguments[1].end)

for (const mode of ['compatible', 'incompatible', 'check-error']) {
  const replies = new Map()
  const ipc = new EventEmitter()
  ipc.send = response => {
    const complete = replies.get(response.requestId)
    if (complete) { replies.delete(response.requestId); complete(response) }
    return true
  }
  const send = response => { ipc.send(response); return Promise.resolve() }
  const control = { updateTasks: async () => false, quitInspection: async () => ({ activeTasks: false, scheduledTasks: false }) }
  // Only code extracted from the currently installed application is evaluated.
  const original = new Function('control', 'send', 'stop', 'stopping', `return (${nativeListener})`)(control, send, () => {}, undefined)
  ipc.on('message', original)
  const guard = guardDesktopIpc(ipc, async () => {
    if (mode === 'check-error') throw new Error('synthetic failure')
    return { allowed: mode === 'compatible', version: '0.3.0', reason: mode === 'compatible' ? 'compatible' : 'changed-interface' }
  })
  assert.equal(guard.status().state, 'armed')
  let sequence = 0
  const request = action => new Promise((resolve, reject) => {
    const requestId = ++sequence
    replies.set(requestId, result => result.error ? reject(new Error(result.error)) : resolve(result.active))
    ipc.emit('message', { type: 'update-tasks', requestId, action })
  })
  const updater = new EventEmitter()
  updater.checkForUpdates = async () => ({ isUpdateAvailable: true, updateInfo: { version: '0.3.0' } })
  updater.downloadUpdate = async () => { updater.emit('update-downloaded', { version: '0.3.0' }) }
  let stopped = 0, installed = 0
  updater.quitAndInstall = () => { installed++ }
  const Coordinator = new Function('autoUpdater', 'DesktopUpdatePreparationError', 'valid', 'gt', `return (${nativeClass})`)(
    {}, class extends Error {}, value => value, () => true,
  )
  const coordinator = new Coordinator(() => {}, async () => {
    await request('inspect')
    await request('lock')
    stopped++
    return true
  }, updater, () => true, () => '0.2.1-rc.3')
  await coordinator.check()
  await coordinator.download('0.3.0')
  const result = await coordinator.install('0.3.0')
  assert.equal(installed, mode === 'compatible' ? 1 : 0)
  assert.equal(stopped, mode === 'compatible' ? 1 : 0)
  assert.equal(result.phase, mode === 'compatible' ? 'installing' : 'error')
  guard.dispose()
  coordinator.dispose()
  console.log(JSON.stringify({ case: mode, nativeCodeAdmission: 'passed', simulatedInstallerCalls: installed }))
}

const began = performance.now()
const verdict = await pendingUpdateInspector(asarPath, option('--cache'))()
assert.equal(verdict.allowed, true, 'The locally cached official package must match the current verified interfaces')
console.log(JSON.stringify({ cachedOfficialPackage: verdict, elapsedMs: Math.round(performance.now() - began), realInstallPerformed: false }))
