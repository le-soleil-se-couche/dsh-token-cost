/** Verify the actual bundle in the invoking runtime, without installing an update. */
import assert from 'node:assert/strict'
import { readFile, writeFile, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
const args = process.argv.slice(2)
const option = name => args[args.indexOf(name) + 1]
assert(args.includes('--app') && args.includes('--cache'), 'Provide --app and --cache')
if (args.includes('--require-electron')) assert(process.versions.electron, 'Run through the official Desktop CLI')
const before = process.noAsar
const moduleUrl = new URL(`../lib/.upgrade-check-${randomUUID()}.mjs`, import.meta.url)
try {
  const bundle = await readFile(new URL('../lib/index.js', import.meta.url), 'utf8')
  await writeFile(moduleUrl, bundle + '\nexport { pendingUpdateInspector };\n', { flag: 'wx' })
  const { pendingUpdateInspector } = await import(moduleUrl.href)
  const inspect = pendingUpdateInspector(`${option('--app')}/Contents/Resources/app.asar`, option('--cache'))
  const verdict = await inspect()
  assert.equal(verdict.allowed, true, JSON.stringify(verdict))
  assert.deepEqual(await inspect(), verdict, 'Cached recheck must retain the verdict')
  assert.equal(process.noAsar, before, 'Global ASAR handling must remain unchanged')
  console.log(JSON.stringify({ electron: process.versions.electron ?? null, noAsar: process.noAsar ?? null,
    verdict, cachedRecheck: 'passed', realInstallPerformed: false }))
} finally { await unlink(moduleUrl).catch(() => {}) }
