import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { extractBrowserCore } from '../src/upgrade/browser-core.ts'
import { probeSdk } from '../src/upgrade/probe.ts'

const namespace = [
  'SlotCore', 'SlotOwnershipError', 'StaleAuthorizationError', 'resolveSlotLabel', 'standardHookPropName',
].join(', ')
const bootTable = (binding = 'slotNamespace') =>
  'function boot() { return { "@deepseek-ai/dsh-client-ui-slots": ' + binding + ' } }'

const frontend = [
  'import { unrelated } from "./unused.js";',
  'const [prefix, dynamicKey] = ["actual", "display"];',
  'const omitted = (() => { throw new Error("should not run") })(), suffix = "reference";',
  'function compose(input) { return prefix + " " + input; }',
  'class Renamed {',
  '  render(unrelated = "shadowed") {',
  '    const result = { unrelated, [dynamicKey]: compose(suffix) };',
  '    { const prefix = "local"; result.local = prefix; }',
  '    return result;',
  '  }',
  '}',
  'class SlotOwnershipError extends Error {}',
  'class StaleAuthorizationError extends Error {}',
  'const resolveSlotLabel = value => value;',
  'const standardHookPropName = value => "use" + value;',
  'const slotNamespace = Object.freeze({ ' + namespace.replace('SlotCore', 'SlotCore: Renamed') + ' });',
  bootTable(),
].join('\n')

describe('browser platform SDK extraction', () => {
  it('resolves transitive top-level dependencies without importing or running unrelated web code', () => {
    const source = extractBrowserCore(frontend)
    expect(source).not.toContain('should not run')
    expect(source).not.toContain('unused.js')
    const { SlotCore } = runInNewContext(source)
    expect(new SlotCore().render()).toEqual({
      unrelated: 'shadowed', display: 'actual reference', local: 'local',
    })
  })

  it('rejects a namespace that resolves to an import or a different local binding', () => {
    expect(() => extractBrowserCore(frontend.replace('compose(suffix)', 'unrelated(suffix)').replace(
      'render(unrelated = "shadowed")', 'render()',
    ))).toThrow('BROWSER_CORE_SOURCE')
    expect(() => extractBrowserCore(frontend.replace(bootTable(),
      'function boot(slotNamespace) { return { "@deepseek-ai/dsh-client-ui-slots": slotNamespace } }',
    ))).toThrow('BROWSER_CORE_SOURCE')
  })

  it('rejects an external prototype replacement and accepts a separately scoped binding with the same name', () => {
    expect(() => extractBrowserCore(frontend + '\nRenamed.prototype.render = () => null;')).toThrow('BROWSER_CORE_SOURCE')
    expect(() => extractBrowserCore(frontend + '\nconst Alias = Renamed; Alias.prototype.render = () => null;'))
      .toThrow('BROWSER_CORE_SOURCE')
    expect(() => extractBrowserCore(frontend + '\nfunction patch() { const Alias = Renamed.prototype; Alias.render = () => null; } patch();'))
      .toThrow('BROWSER_CORE_SOURCE')
    expect(() => extractBrowserCore(frontend + '\nfunction other(Renamed) { Renamed.prototype.render = () => null; }'))
      .not.toThrow()
  })
})

describe('candidate SDK behavior probe', () => {
  const require = createRequire(import.meta.url)
  const fromBoot = createRequire(require.resolve('@deepseek-ai/dsh-app-boot/package.json'))
  let directory: string
  let rendererFile: string
  let rendererSource: string
  let core: string
  let externalClient: string
  const external = '@fee/compat-probe'
  const externalSource = 'window.__ModuleLoader__.load({id:"@fee/compat-probe",factory:()=>({fixture:"fee-capability-probe-v1"})});'
  const definitions = {
    'conversation.composer.dock': { kind: 'list', scope: 'session' },
    'settings.plugins.tab': { kind: 'list', scope: 'root' },
  }
  const run = () => probeSdk(directory, core, definitions, '0.2.1-rc.3')

  beforeAll(async () => {
    directory = await realpath(await mkdtemp(join(tmpdir(), 'dsh-capability-probe-')))
    const scoped = join(directory, 'node_modules', '@deepseek-ai')
    await mkdir(scoped, { recursive: true })
    const packages = ['cordis', 'schemastery', 'dsh-client-connection', 'cordis-plugin-loader', 'dsh-settings',
      'dsh-client-ui-settings', 'dsh-client-locale', 'dsh-app-boot']
    for (const name of packages) {
      const loader = name === 'cordis-plugin-loader' ? fromBoot : require
      const manifest = loader.resolve('@deepseek-ai/' + name + '/package.json')
      await symlink(dirname(manifest), join(scoped, name), 'dir')
    }
    rendererFile = join(scoped, 'dsh-client-ui-renderer', 'lib', 'client.js')
    await mkdir(dirname(rendererFile), { recursive: true })
    rendererSource = await readFile(require.resolve('@deepseek-ai/dsh-client-ui-renderer/client'), 'utf8')
    const slots = await readFile(require.resolve('@deepseek-ai/dsh-client-ui-slots'), 'utf8')
    const coreSource = slots.replace(/^export \{[^\n]+\};$/m, '')
    core = extractBrowserCore(coreSource + '\nconst slotNamespace = { ' + namespace + ' };' + bootTable())
    await writeFile(join(directory, 'fee-plugin.json'), await readFile(new URL('../package.json', import.meta.url)))

    const externalRoot = join(directory, 'node_modules', external)
    await mkdir(join(externalRoot, 'lib'), { recursive: true })
    await writeFile(join(externalRoot, 'package.json'), JSON.stringify({
      name: external, type: 'module',
      exports: { '.': './lib/index.js', './client': { default: './lib/client.js' }, './package.json': './package.json' },
      dsh: { client: { platform: 'web', inject: ['@deepseek-ai/dsh-client-ui-renderer'] } },
    }))
    await writeFile(join(externalRoot, 'lib', 'index.js'), 'export function apply() {}')
    externalClient = join(externalRoot, 'lib', 'client.js')
    await writeFile(externalClient, externalSource)
    // The repository's pinned development SDK has no ClientModuleRegistry
    // package. The released candidate exercises the real registry separately.
    // This fixture lets unit tests mutate the served closure and run slot
    // probes with the pinned renderer without adding a package dependency.
    const registryRoot = join(scoped, 'dsh-client-modules')
    await mkdir(join(registryRoot, 'lib'), { recursive: true })
    await writeFile(join(registryRoot, 'package.json'), JSON.stringify({ type: 'module' }))
    await writeFile(join(registryRoot, 'lib', 'index.js'), [
      'import { Service } from "@deepseek-ai/cordis";',
      'import { readFile } from "node:fs/promises";',
      'import { createRequire } from "node:module";',
      'import { dirname, join } from "node:path";',
      'const fixture = ' + JSON.stringify(external) + ';',
      'const client = ' + JSON.stringify(externalClient) + ';',
      'export class ClientModuleRegistry extends Service {',
      '  constructor(ctx) { super(ctx, "clientModules"); }',
      '  resolveMeta(id, base) {',
      '    const path = createRequire(base).resolve(id + "/package.json");',
      '    return { packageName: id, meta: { clientPath: join(dirname(path), "lib", "client.js") } };',
      '  }',
      '  graph() {',
      '    const loaded = [...this.ctx.loader.entries()].some(entry => entry.options.name.endsWith(fixture + "/lib/index.js"));',
      '    return { entries: loaded ? [{ id: fixture, url: "/plugins/probe", inject: ["@deepseek-ai/dsh-client-ui-renderer"] }] : [] };',
      '  }',
      '  async fetchBundle() { return new Response(await readFile(client, "utf8"), { headers: { "content-type": "text/javascript" } }); }',
      '}',
    ].join('\n'))
  })

  afterAll(async () => {
    if (directory) await rm(directory, { recursive: true, force: true })
  })

  it('allows the current SDK with harmless source changes', async () => {
    await writeFile(rendererFile, rendererSource + '\n// unrelated metadata')
    await expect(run()).resolves.toEqual([])
  })

  it('blocks a candidate with incompatible published slot declarations', async () => {
    await expect(probeSdk(directory, core, {
      ...definitions,
      'conversation.composer.dock': { kind: 'list', scope: 'root' },
    }, '0.2.1-rc.3')).resolves.toEqual(['sdk-slot-registry'])
  })

  it('blocks an external module carrier that serves the wrong registration', async () => {
    await writeFile(rendererFile, rendererSource)
    await writeFile(externalClient, externalSource.replace(external, '@fee/wrong-probe'))
    try {
      await expect(run()).resolves.toEqual(['sdk-client-loader'])
    } finally {
      await writeFile(externalClient, externalSource)
    }
  })

  it.each([
    ['_register', 'return () => {};', 'sdk-slot-registry'],
    ['_registerFactory', 'throw new Error("fixture error");', 'sdk-slot-factory'],
    ['_registerFactory', 'return\n() => {};', 'sdk-slot-factory'],
  ])('blocks %s behavior changes through a live slot registration', async (method, injected, expected) => {
    const anchor = method + '(options, component) {'
    expect(rendererSource).toContain(anchor)
    await writeFile(rendererFile, rendererSource.replace(anchor, anchor + '\n' + injected))
    await expect(run()).resolves.toEqual([expected])
  })
})
