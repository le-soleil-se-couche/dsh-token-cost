/**
 * Behavioral check for the candidate SDK. This function is serialized into
 * the restricted helper process, so all its runtime dependencies are local
 * imports. Its result contains only fixed check identifiers.
 */
export async function probeSdk(
  root: string,
  browserCoreSource: string,
  slotDefinitions: Record<string, { kind: string; scope: string }>,
  runtimeVersion: string,
): Promise<string[]> {
  type Disposer = () => unknown
  type Fiber = { await(): Promise<unknown>; dispose(): unknown }
  type Route = { path: string; methods: string[]; requestBody: string; fetch(): Promise<Response> }
  type Peer = { dispose(): unknown }
  type Settings = { enabled: boolean; currency: string }
  type LiveConfig = { [K in keyof Settings]: { get(): Settings[K] } }
  type Entry = { fiber: Fiber; options: { id: string; config?: Partial<Settings> } }
  type FormView = {
    ns: string; value: Settings; revision: number; applies: string; schema: unknown
  }
  type Mutation = { op: 'set'; path: string[]; value: string | boolean }
  type SlotComponent = () => null
  type SlotOptions = {
    name: string; id?: string; scope?: string; order?: number; locale?: string;
    label?: () => string; inject?: () => object; children?: Record<string, { kind: string; scope: string }>
  }
  type SlotEntry = { options: SlotOptions; component: unknown }
  type Slots = {
    inject(name: string, register: () => Disposer): Disposer
    register(options: SlotOptions, component: SlotComponent): Disposer
    registerFactory(options: SlotOptions, component: SlotComponent): Disposer
    entries(name: string): readonly SlotEntry[]
    hostFace(): { factoryOf(name: string): { component: unknown; scope: string } | undefined }
  }
  type Context = {
    fiber: Fiber
    provide(name: string, value: unknown): void
    get(name: string): unknown
    plugin(plugin: unknown, config?: object): Fiber
    effect(install: () => Disposer | void, label: string): Disposer
    events: { on(name: string, listener: (paths: string[][]) => void): void }
    connection: {
      browserPeer: Peer
      createPeer(options: { principal: { kind: string } }): Peer
      requestRejection(request: unknown): number
      createSharedFetchHandler(channel: string): { fetch(request: Request, peer: Peer): Promise<Response> }
      fetch: { register(route: Route): Disposer }
    }
    loader: {
      builtins: Record<string, unknown>
      create(options: { id: string; name: string; config: Partial<Settings> }): Promise<unknown>
      await(): Promise<unknown>
      resolve(id: string): Entry
      update(id: string, options: { config: Partial<Settings> }): Promise<unknown>
    }
    settings: {
      describe(): FormView[]
      mutate(id: string, ops: Mutation[], revision: number): Promise<unknown>
    }
    clientModules: {
      resolveMeta(id: string, base: string): { packageName: string; meta: { clientPath: string } } | null
      graph(): { entries: ReadonlyArray<{ id: string; url: string; inject?: readonly string[] }> }
      fetchBundle(request: Request): Promise<Response>
    }
    slots: Slots
    locale: {
      register(id: string, dicts: Record<string, Record<string, string>>): Disposer
      bind(id: string): (key: string, values?: Record<string, string>) => string
    }
    configForms: {
      get(id: string): {
        getSnapshot(): { value?: Settings; writable: boolean }
        subscribe(listener: () => void): Disposer
        set(key: keyof Settings, value: string | boolean): Promise<boolean>
      }
    }
  }
  type Factory = (requireModule: (specifier: string) => unknown) => unknown

  function requireCheck(condition: unknown): asserts condition {
    if (!condition) throw new Error('SDK_CONTRACT')
  }
  let check: string = 'sdk-framework'
  try {
    // Nonliteral imports keep the serialized function independent of any
    // bundler's module-scope import helpers.
    const loadNode = async <T>(name: string): Promise<T> => await import('node:' + name) as T
    const [{ readFile }, { join }, { pathToFileURL }, vm] = await Promise.all([
      loadNode<typeof import('node:fs/promises')>('fs/promises'),
      loadNode<typeof import('node:path')>('path'),
      loadNode<typeof import('node:url')>('url'),
      loadNode<typeof import('node:vm')>('vm'),
    ])
    const sdkPath = (name: string, file: string) => join(root, 'node_modules', '@deepseek-ai', name, file)
    const sdkImport = async <T>(name: string, file = 'lib/index.js'): Promise<T> =>
      await import(pathToFileURL(sdkPath(name, file)).href) as T
    const cordis = await sdkImport<{ Context: new () => Context }>('cordis')
    const { default: schema } = await sdkImport<typeof import('@deepseek-ai/schemastery')>('schemastery', 'lib/index.mjs')
    const { Loader } = await sdkImport<{ Loader: unknown }>('cordis-plugin-loader')
    check = 'sdk-plugin-admission'
    const boot = JSON.parse(await readFile(sdkPath('dsh-app-boot', 'package.json'), 'utf8'))
    const manifest = JSON.parse(await readFile(join(root, 'fee-plugin.json'), 'utf8'))
    const { evaluatePluginCompatibility } = await sdkImport<{
      evaluatePluginCompatibility(manifest: unknown, exemptions: object, version: string):
        { exempted: boolean; requirements: Record<string, unknown> } | undefined
    }>('dsh-app-boot')
    requireCheck(boot.version === runtimeVersion && typeof manifest.engines?.dsh === 'string')
    requireCheck(evaluatePluginCompatibility(manifest, {}, runtimeVersion) === undefined)
    for (const version of ['0.2.1-rc.1', '1.0.0']) {
      const rejected = evaluatePluginCompatibility(manifest, {}, version)
      requireCheck(rejected?.exempted === false && rejected.requirements['engines.dsh'] === manifest.engines.dsh)
    }
    check = 'sdk-framework'
    const host = new cordis.Context()
    const id = 'token-cost'
    let browserView: FormView
    try {
      check = 'sdk-connection'
      const connection = await sdkImport<unknown>('dsh-client-connection')
      host.provide('credentials', {
        async modifyRecord(_key: unknown, update: (value: undefined) => Promise<unknown>) {
          return update(undefined)
        },
      })
      await host.plugin(connection).await()
      const path = '/api/dsh-token-cost/status'
      const handler = host.connection.createSharedFetchHandler('/api')
      const access = (peer = host.connection.browserPeer, method = 'GET') =>
        handler.fetch(new Request('http://localhost' + path, { method }), peer)
      requireCheck(host.get('webServer') === undefined && (await access()).status === 404)
      requireCheck(host.connection.requestRejection({ method: 'GET', headers: { host: 'localhost' }, socket: {} }) === 401)

      check = 'sdk-framework'
      const baseUrl = pathToFileURL(join(root, 'probe.cjs')).href
      await host.plugin(Loader, { baseUrl }).await()
      const loader = host.loader
      const Config = schema.object({
        enabled: schema.boolean().default(true).volatile(),
        currency: schema.union([schema.const('cny'), schema.const('usd')]).default('cny').volatile(),
      })
      const events: string[][][] = []
      let starts = 0
      let live: LiveConfig | undefined
      loader.builtins[id] = {
        name: id,
        Config,
        inject: ['connection'],
        apply(ctx: Context, config: LiveConfig) {
          starts += 1
          live = config
          let dispose: Disposer | undefined
          const rebuild = (): void => {
            dispose?.()
            dispose = undefined
            if (!config.enabled.get()) return
            dispose = ctx.effect(() => ctx.connection.fetch.register({
              path,
              methods: ['GET'],
              requestBody: 'buffered',
              fetch: async () => Response.json({ currency: config.currency.get() }),
            }), 'token-cost SDK probe')
          }
          ctx.events.on('loader/volatile-update', paths => {
            events.push(paths)
            if (paths.some(([key]) => key === 'enabled')) rebuild()
          })
          rebuild()
        },
      }
      await loader.create({ id, name: 'cordis:' + id, config: {} })
      await loader.await()
      const config = live as LiveConfig | undefined
      requireCheck(starts === 1 && config?.enabled.get() === true && config.currency.get() === 'cny')
      const { enabled, currency } = config

      check = 'sdk-connection'
      const ownerResponse = await access()
      requireCheck(ownerResponse.status === 200 && (await ownerResponse.json()).currency === 'cny')
      requireCheck((await access(undefined, 'POST')).status === 404)
      const visitor = host.connection.createPeer({ principal: { kind: 'token-cost-probe-visitor' } })
      requireCheck((await access(visitor)).status === 403)
      await visitor.dispose()

      check = 'sdk-settings'
      const entry = loader.resolve(id)
      const { SettingsForms } = await sdkImport<{ SettingsForms: unknown }>('dsh-settings')
      host.provide('configEditor', {
        configuration: () => [{ entry, inherited: {}, override: entry.options.config ?? {} }],
        entries: () => [entry],
        edit: (target: Entry, mutate: (raw: Partial<Settings>, inherited: Partial<Settings>) => Partial<Settings>) =>
          loader.update(target.options.id, { config: mutate(target.options.config ?? {}, {}) }),
      })
      host.provide('profileContext', { name: 'token-cost-probe', home: join(root, 'nonexistent-fixture-profile') })
      await host.plugin(SettingsForms).await()
      const readSettings = (): FormView => {
        const descriptor = host.settings.describe().find(item => item.ns === id)
        requireCheck(descriptor)
        return descriptor
      }
      const mutate = (key: keyof Settings, value: string | boolean, revision: number) =>
        host.settings.mutate(id, [{ op: 'set', path: [key], value }], revision)
      browserView = readSettings()
      requireCheck(browserView.value.currency === 'cny' && browserView.applies === 'live')
      await mutate('currency', 'usd', browserView.revision)
      const updated = readSettings()
      requireCheck(updated.revision > browserView.revision && updated.value.currency === 'usd'
        && live?.currency === currency && currency.get() === 'usd')
      requireCheck((await (await access()).json()).currency === 'usd')
      await mutate('enabled', false, updated.revision)
      requireCheck(live?.enabled === enabled && enabled.get() === false && (await access()).status === 404)
      await mutate('enabled', true, readSettings().revision)
      requireCheck(enabled.get() === true && (await access()).status === 200 && starts === 1)
      requireCheck(JSON.stringify(events) === '[[["currency"]],[["enabled"]],[["enabled"]]]')
      check = 'sdk-connection'
      await entry.fiber.dispose()
      requireCheck((await access()).status === 404)

      check = 'sdk-client-loader'
      const packageName = '@fee/compat-probe'
      const packageDir = 'node_modules/' + packageName + '/'
      const externalManifest = JSON.parse(await readFile(join(root, packageDir, 'package.json'), 'utf8'))
      const declaredInject = externalManifest.dsh?.client?.inject
      requireCheck(Array.isArray(declaredInject) && declaredInject.length > 0)
      // A file row uses Loader's real ESM path without its fallback resolver
      // creating a helper on disk. Bare package metadata is also resolved.
      await loader.create({ id: 'compat-probe', name: './' + packageDir + 'lib/index.js', config: {} })
      await loader.await()
      const { ClientModuleRegistry } = await sdkImport<{ ClientModuleRegistry: unknown }>('dsh-client-modules')
      await host.plugin(ClientModuleRegistry).await()
      const registry = host.clientModules
      const metadata = registry.resolveMeta(packageName, baseUrl)
      requireCheck(metadata?.packageName === packageName && metadata.meta.clientPath === join(root, packageDir, 'lib/client.js'))
      const row = registry.graph().entries.find(item => item.id === packageName)
      requireCheck(row && JSON.stringify(row.inject) === JSON.stringify(declaredInject))
      const bundleUrl = new URL(row.url, 'http://localhost')
      requireCheck(bundleUrl.origin === 'http://localhost' && bundleUrl.pathname.startsWith('/plugins/'))
      const bundle = await registry.fetchBundle(new Request(bundleUrl))
      requireCheck(bundle.status === 200 && /\b(?:java|ecma)script\b/i.test(bundle.headers.get('content-type') ?? ''))
      let servedFactory: Factory | undefined
      const bundleSandbox = vm.createContext({ window: { __ModuleLoader__: {
        load(registration: { id: string; factory: Factory }) {
          requireCheck(registration.id === packageName && typeof registration.factory === 'function' && !servedFactory)
          servedFactory = registration.factory
        },
      } } })
      vm.runInContext(await bundle.text(), bundleSandbox, { timeout: 1000 })
      requireCheck(servedFactory)
      bundleSandbox.readFixture = servedFactory
      const served = vm.runInContext('readFixture().fixture', bundleSandbox, { timeout: 1000 })
      requireCheck(served === 'fee-capability-probe-v1')
    } finally {
      await host.fiber.dispose()
    }

    check = 'sdk-slot-registry'
    const scheduled: Array<() => void> = []
    const drain = (): void => {
      let limit = 1000
      while (scheduled.length > 0 && --limit > 0) scheduled.shift()!()
      requireCheck(scheduled.length === 0)
    }
    const sandbox = vm.createContext({
      queueMicrotask: (callback: () => void) => { scheduled.push(callback) },
      navigator: { languages: ['en'], language: 'en' },
      structuredClone,
    })
    const evaluate = (source: string): unknown => vm.runInContext(source, sandbox, { timeout: 1000 })
    const browserCore = evaluate(browserCoreSource)
    const react = { createContext: () => ({}), Component: class {} }
    const platform = new Map<string, unknown>([
      ['@deepseek-ai/cordis', cordis],
      ['@deepseek-ai/dsh-client-ui-slots', browserCore],
      ['react', react],
      ['react-dom', {}],
      ['react-dom/client', {}],
      ['react/jsx-runtime', {}],
    ])
    const loadClient = async <T>(name: string): Promise<T> => {
      let registered: Factory | undefined
      const expected = '@deepseek-ai/' + name
      sandbox.window = { __ModuleLoader__: { load(value: { id: string; factory: Factory }) {
        requireCheck(value.id === expected && typeof value.factory === 'function' && registered === undefined)
        registered = value.factory
      } } }
      evaluate(await readFile(sdkPath(name, 'lib/client.js'), 'utf8'))
      requireCheck(registered)
      sandbox.factory = registered
      sandbox.requireModule = (specifier: string) => {
        requireCheck(platform.has(specifier))
        return platform.get(specifier)
      }
      return evaluate('factory(requireModule)') as T
    }
    const { SlotRegistry } = await loadClient<{ SlotRegistry: new (ctx: Context) => Slots }>('dsh-client-ui-renderer')
    const client = new cordis.Context()
    try {
      new SlotRegistry(client)
      const composer = 'conversation.composer.dock'
      const settings = 'settings.plugins.tab'
      requireCheck(slotDefinitions[composer]?.kind === 'list' && slotDefinitions[composer].scope === 'session'
        && slotDefinitions[settings]?.kind === 'list' && slotDefinitions[settings].scope === 'root')
      const entry = (slot: string) => client.slots.entries(slot).find(item => item.options.id === id)
      const component: SlotComponent = () => null
      const plugin = client.plugin({
        name: id,
        inject: ['slots'],
        apply(ctx: Context) {
          const cost = ctx.slots.inject(composer, () => ctx.slots.register({
            name: composer, id, order: 110, locale: id, inject: () => ({ settings: {} }),
          }, component))
          const tab = ctx.slots.inject(settings, () => ctx.slots.register({
            name: settings, id, label: () => 'Fixture settings', locale: id, inject: () => ({ settings: {} }),
          }, component))
          requireCheck(typeof cost === 'function' && typeof tab === 'function')
        },
      })
      await plugin.await()
      requireCheck(entry(composer) === undefined && entry(settings) === undefined)
      const declare = () => client.slots.register({
        name: 'root',
        children: slotDefinitions,
      }, component)
      const first = declare()
      drain()
      requireCheck(entry(composer)?.component === component && entry(settings)?.options.label?.() === 'Fixture settings')
      first()
      drain()
      requireCheck(entry(composer) === undefined && entry(settings) === undefined)
      const second = declare()
      drain()
      requireCheck(entry(composer)?.component === component && entry(settings)?.component === component)
      await plugin.dispose()
      drain()
      requireCheck(entry(composer) === undefined && entry(settings) === undefined)
      second()

      check = 'sdk-slot-factory'
      const name = 'token-cost-probe-factory'
      const factory = () => client.slots.hostFace().factoryOf(name)
      const register = (ctx: Context) => ctx.slots.registerFactory({ name, scope: 'root' }, component)
      const dispose = register(client)
      drain()
      requireCheck(factory()?.component === component && factory()?.scope === 'root')
      dispose()
      drain()
      requireCheck(factory() === undefined)
      const factoryOwner = client.plugin({
        name: 'token-cost-factory-probe',
        inject: ['slots'],
        apply: (ctx: Context) => { register(ctx) },
      })
      await factoryOwner.await()
      requireCheck(factory()?.component === component)
      await factoryOwner.dispose()
      drain()
      requireCheck(factory() === undefined)

      check = 'sdk-client-settings'
      // Real ConfigForms controller over an in-memory store and RPC carrier.
      // No React hooks or browser DOM are executed by this check.
      platform.set('@deepseek-ai/dsh-client-store', {
        defineStore: (spec: unknown) => ({ spec }),
        createSnapshotStore<T extends object>(initial: T) {
          let value = initial
          const listeners = new Set<() => void>()
          const set = (next: T): void => {
            value = next
            for (const listener of listeners) listener()
          }
          return {
            getSnapshot: () => value,
            subscribe(listener: () => void) {
              listeners.add(listener)
              return () => listeners.delete(listener)
            },
            set,
            update(change: (draft: T) => void) {
              const draft = { ...value }
              change(draft)
              set(draft)
            },
          }
        },
      })
      const remoteSettings = {
        async describe() { return { ok: true, value: { writable: true, namespaces: [browserView] } } },
        async mutate(namespace: string, ops: Mutation[], revision: number) {
          requireCheck(namespace === id && revision === browserView.revision && ops.length === 1)
          const [{ op, path, value }] = ops
          requireCheck(op === 'set' && path.length === 1 && path[0] === 'currency' && value === 'usd')
          browserView = { ...browserView, value: { ...browserView.value, currency: value }, revision: revision + 1 }
          return { ok: true, value: browserView }
        },
      }
      client.provide('remote', { settings: remoteSettings, $on: () => () => {} })
      client.provide('remote.settings', remoteSettings)
      await client.plugin(await loadClient<unknown>('dsh-client-ui-settings')).await()
      const form = client.configForms.get(id)
      for (let turn = 0; turn < 20 && !form.getSnapshot().value; turn += 1) await Promise.resolve()
      requireCheck(form.getSnapshot().writable && form.getSnapshot().value?.currency === 'cny')
      let notifications = 0
      const unsubscribe = form.subscribe(() => { notifications += 1 })
      requireCheck(await form.set('currency', 'usd') && form.getSnapshot().value?.currency === 'usd' && notifications > 0)
      unsubscribe()

      check = 'sdk-client-locale'
      platform.set('@deepseek-ai/dsh-client-ui-primitives', {})
      await client.plugin(await loadClient<unknown>('dsh-client-locale')).await()
      const disposeDictionary = client.effect(() => client.locale.register(id, {
        en: { fee: 'Fee {amount}' }, zh: { fee: '费用 {amount}' },
      }), 'token-cost SDK dictionary')
      const t = client.locale.bind(id)
      requireCheck(t('fee', { amount: '42' }) === 'Fee 42')
      disposeDictionary()
      requireCheck(t('fee', { amount: '42' }) === 'fee')
    } finally {
      await client.fiber.dispose()
    }
    return []
  } catch {
    return [check]
  }
}
