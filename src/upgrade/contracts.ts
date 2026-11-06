/** Declarative prerequisites; behavioral SDK probes decide compatibility independently of source identity. */
import { parse } from 'acorn'
import { nativeProbeSource, type NativeProbeSource } from './native-probe.ts'

export interface PackageReader { text(path: string): Promise<string> }
export interface UpgradeContract {
  version: string
  native: NativeProbeSource
  frontend: string
  slots: Record<string, { kind: string; scope: string }>
}
const PREFIX = 'dsh/node_modules/@deepseek-ai/'

/** Read declarations from the candidate host's actual registration, not from the test fixture. */
export function requiredSlot(source: string, name: string, scope: string): { kind: string; scope: string } {
  const tree = parse(source, { ecmaVersion: 'latest', sourceType: 'module' })
  const property = (node: any, key: string): any => node?.type === 'ObjectExpression'
    ? node.properties.find((p: any) => p.type === 'Property' && !p.computed && (p.key.name ?? p.key.value) === key)?.value
    : undefined
  const declarations: any[] = []
  const aliases = new Set<string>()
  let consumer = false
  const collect = (node: any): void => {
    if (!node || typeof node !== 'object') return
    if (node.type === 'VariableDeclarator') {
      if (node.id.type === 'ObjectPattern') for (const p of node.id.properties) {
        if (p.type === 'Property' && (p.key.name ?? p.key.value) === 'slots' && p.value.type === 'Identifier') aliases.add(p.value.name)
      }
      if (node.id.type === 'Identifier' && node.init?.type === 'MemberExpression'
        && node.init.property.name === 'slots') aliases.add(node.id.name)
    }
    for (const child of Object.values(node)) {
      if (Array.isArray(child)) child.forEach(collect)
      else collect(child)
    }
  }
  collect(tree)
  const visit = (node: any): void => {
    if (!node || typeof node !== 'object') return
    if (node.type === 'CallExpression') {
      if (node.arguments[0]?.type === 'Literal' && node.arguments[0].value === name) consumer = true
      if (node.callee.type === 'MemberExpression' && node.callee.property.name === 'register'
        && ((node.callee.object.type === 'MemberExpression' && node.callee.object.property.name === 'slots')
          || (node.callee.object.type === 'Identifier' && aliases.has(node.callee.object.name)))) {
        const declaration = property(property(node.arguments[0], 'children'), name)
        if (declaration) declarations.push(declaration)
      }
    }
    for (const child of Object.values(node)) {
      if (Array.isArray(child)) child.forEach(visit)
      else visit(child)
    }
  }
  visit(tree)
  if (!consumer || declarations.length !== 1 || property(declarations[0], 'kind')?.value !== 'list'
    || property(declarations[0], 'scope')?.value !== scope) throw new Error('HOST_SLOT')
  return { kind: 'list', scope }
}

/** Capture public formats and declared API families, then prepare behavior probes. */
export async function captureUpgradeContract(reader: PackageReader): Promise<UpgradeContract> {
  const manifest = JSON.parse(await reader.text('package.json')) as { name?: string; version?: string }
  if (manifest.name !== '@deepseek-ai/dsh-desktop' || typeof manifest.version !== 'string'
    || !/^0\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.test(manifest.version)) throw new Error('HOST_FAMILY')
  const descriptor = JSON.parse(await reader.text('dsh/desktop-runtime.json'))
  if (descriptor.schemaVersion !== 1 || descriptor.release?.version !== manifest.version
    || descriptor.release.hostProtocolVersion !== 4) throw new Error('HOST_PROTOCOL')
  for (const [name, major] of [['cordis', 4], ['schemastery', 3]] as const) {
    const pkg = JSON.parse(await reader.text(`${PREFIX}${name}/package.json`))
    if (typeof pkg.version !== 'string' || Number(pkg.version.split('.')[0]) !== major) throw new Error('FRAMEWORK_FAMILY')
  }
  // Storage format is an explicit public compatibility boundary, unlike SDK implementation bodies.
  const session = parse(await reader.text(`${PREFIX}dsh-session/lib/index.js`), { ecmaVersion: 'latest', sourceType: 'module' })
  const declarations = session.body.flatMap(statement => statement.type === 'VariableDeclaration' ? statement.declarations : [])
  const format = declarations.find(d => d.id.type === 'Identifier' && d.id.name === 'SESSION_FORMAT_VERSION')
  if (format?.init?.type !== 'Literal' || format.init.value !== 4) throw new Error('SESSION_FORMAT')
  const html = await reader.text(`${PREFIX}dsh-web-frontend/dist/index.html`)
  const scripts = [...html.matchAll(/<script\b[^>]*>/g)].map(match => match[0])
    .filter(tag => /type=["']module["']/.test(tag))
    .map(tag => /src=["'](?:\.\/|\/)?(assets\/[\w.-]+\.js)["']/.exec(tag)?.[1]).filter(Boolean)
  if (scripts.length !== 1) throw new Error('CLIENT_LAYOUT')
  const frontend = await reader.text(`${PREFIX}dsh-web-frontend/dist/${scripts[0]}`)
  const native = nativeProbeSource(await reader.text('lib/main.js'), await reader.text(`${PREFIX}dsh-desktop-host/lib/index.js`))
  const slots = {
    'conversation.composer.dock': requiredSlot(await reader.text(`${PREFIX}dsh-client-ui-conversation/lib/client.js`), 'conversation.composer.dock', 'session'),
    'settings.plugins.tab': requiredSlot(await reader.text(`${PREFIX}dsh-client-ui-settings-plugins/lib/client.js`), 'settings.plugins.tab', 'root'),
  }
  return { version: manifest.version, native, frontend, slots }
}
