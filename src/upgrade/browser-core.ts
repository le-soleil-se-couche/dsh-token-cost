import { parse, type AnyNode, type Expression, type ObjectExpression, type Pattern, type Property } from 'acorn'

const SLOT_MODULE = '@deepseek-ai/dsh-client-ui-slots'
const SLOT_EXPORTS = ['SlotCore', 'SlotOwnershipError', 'StaleAuthorizationError', 'resolveSlotLabel', 'standardHookPropName']
const PURE_GLOBALS = new Set([
  'Array', 'Boolean', 'Error', 'Infinity', 'JSON', 'Map', 'Math', 'NaN', 'Number',
  'Object', 'Promise', 'Reflect', 'RegExp', 'Set', 'String', 'Symbol', 'TypeError',
  'WeakMap', 'WeakSet', 'queueMicrotask', 'undefined',
])

function unsupported(): never { throw new Error('BROWSER_CORE_SOURCE') }

function isNode(value: unknown): value is AnyNode {
  return typeof value === 'object' && value !== null && typeof (value as AnyNode).type === 'string'
}

function* children(node: AnyNode): Iterable<AnyNode> {
  for (const value of Object.values(node)) {
    if (isNode(value)) yield value
    else if (Array.isArray(value)) yield* value.filter(isNode)
  }
}

function* descendants(node: AnyNode): Iterable<AnyNode> {
  yield node
  for (const child of children(node)) yield* descendants(child)
}

function propertyName(node: Pick<Property, 'computed' | 'key'>): string | undefined {
  if (!node.computed && node.key.type === 'Identifier') return node.key.name
  if (node.key.type === 'Literal' && typeof node.key.value === 'string') return node.key.value
}

function namesOf(pattern: Pattern): string[] {
  switch (pattern.type) {
    case 'Identifier': return [pattern.name]
    case 'RestElement': return namesOf(pattern.argument)
    case 'AssignmentPattern': return namesOf(pattern.left)
    case 'ArrayPattern': return pattern.elements.flatMap(element => element === null ? [] : namesOf(element))
    case 'ObjectPattern': return pattern.properties.flatMap(property =>
      namesOf(property.type === 'RestElement' ? property.argument : property.value))
    default: return unsupported()
  }
}

function lexicalNames(nodes: readonly AnyNode[]): string[] {
  return nodes.flatMap(node => {
    if (node.type === 'VariableDeclaration' && node.kind !== 'var') {
      return node.declarations.flatMap(declaration => namesOf(declaration.id))
    }
    if (node.type === 'ClassDeclaration' || node.type === 'FunctionDeclaration') return node.id ? [node.id.name] : []
    return []
  })
}

function* hoistedNames(node: AnyNode): Iterable<string> {
  if (node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression'
    || node.type === 'ClassDeclaration' || node.type === 'ClassExpression' || node.type === 'StaticBlock') return
  if (node.type === 'VariableDeclaration' && node.kind === 'var') {
    for (const declaration of node.declarations) yield* namesOf(declaration.id)
  }
  for (const child of children(node)) yield* hoistedNames(child)
}

/** Walk free references only. Property names, labels, and locally bound variables are not module dependencies. */
type Identifier = Extract<AnyNode, { type: 'Identifier' }>

function references(root: AnyNode, reference: (node: Identifier) => void, strict = true): void {
  const patternValues = (pattern: Pattern, scope: ReadonlySet<string>): void => {
    if (pattern.type === 'AssignmentPattern') {
      patternValues(pattern.left, scope)
      visit(pattern.right, scope)
    } else if (pattern.type === 'RestElement') patternValues(pattern.argument, scope)
    else if (pattern.type === 'ArrayPattern') {
      for (const element of pattern.elements) if (element) patternValues(element, scope)
    } else if (pattern.type === 'ObjectPattern') {
      for (const property of pattern.properties) {
        if (property.type === 'RestElement') patternValues(property.argument, scope)
        else {
          if (property.computed) visit(property.key, scope)
          patternValues(property.value, scope)
        }
      }
    }
  }
  const visit = (node: AnyNode, scope: ReadonlySet<string>): void => {
    switch (node.type) {
      case 'Identifier':
        if (!scope.has(node.name)) reference(node)
        return
      case 'VariableDeclarator':
        patternValues(node.id, scope)
        if (node.init) visit(node.init, scope)
        return
      case 'FunctionDeclaration':
      case 'FunctionExpression':
      case 'ArrowFunctionExpression': {
        const parameters = new Set([...scope, ...node.params.flatMap(namesOf)])
        if (node.id) parameters.add(node.id.name)
        if (node.type !== 'ArrowFunctionExpression') parameters.add('arguments')
        for (const param of node.params) patternValues(param, parameters)
        visit(node.body, new Set([...parameters, ...hoistedNames(node.body)]))
        return
      }
      case 'ClassDeclaration':
      case 'ClassExpression': {
        const local = node.id ? new Set([...scope, node.id.name]) : scope
        if (node.superClass) visit(node.superClass, local)
        visit(node.body, local)
        return
      }
      case 'BlockStatement':
      case 'StaticBlock': {
        const locals = lexicalNames(node.body)
        if (node.type === 'StaticBlock') for (const child of node.body) locals.push(...hoistedNames(child))
        const block = locals.length ? new Set([...scope, ...locals]) : scope
        for (const child of node.body) visit(child, block)
        return
      }
      case 'CatchClause': {
        const block = node.param ? new Set([...scope, ...namesOf(node.param)]) : scope
        if (node.param) patternValues(node.param, block)
        visit(node.body, block)
        return
      }
      case 'ForStatement':
      case 'ForInStatement':
      case 'ForOfStatement': {
        const initializer = node.type === 'ForStatement' ? node.init : node.left
        const locals = initializer ? lexicalNames([initializer]) : []
        const loop = locals.length ? new Set([...scope, ...locals]) : scope
        for (const child of children(node)) visit(child, loop)
        return
      }
      case 'SwitchStatement': {
        visit(node.discriminant, scope)
        const locals = lexicalNames(node.cases.flatMap(branch => branch.consequent))
        const block = locals.length ? new Set([...scope, ...locals]) : scope
        for (const branch of node.cases) visit(branch, block)
        return
      }
      case 'MemberExpression':
        visit(node.object, scope)
        if (node.computed) visit(node.property, scope)
        return
      case 'Property':
      case 'PropertyDefinition':
      case 'MethodDefinition':
        if (node.computed) visit(node.key, scope)
        if (node.value) visit(node.value, scope)
        return
      case 'LabeledStatement':
        visit(node.body, scope)
        return
      case 'BreakStatement':
      case 'ContinueStatement':
        return
      case 'ImportExpression':
      case 'MetaProperty':
      case 'WithStatement':
        if (strict) return unsupported()
        return
      default:
        for (const child of children(node)) visit(child, scope)
    }
  }
  visit(root, new Set())
}

/** Bundler namespace objects are plain records or wrapped in Object.freeze/defineProperty. */
function namespaceObject(node: Expression): ObjectExpression {
  if (node.type === 'ObjectExpression') return node
  if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression'
    && !node.callee.computed && node.callee.object.type === 'Identifier' && node.callee.object.name === 'Object'
    && node.callee.property.type === 'Identifier'
    && ['freeze', 'defineProperty'].includes(node.callee.property.name)
    && node.arguments[0] && node.arguments[0].type !== 'SpreadElement') return namespaceObject(node.arguments[0])
  return unsupported()
}

interface Unit {
  readonly node: AnyNode
  readonly code: string
}

function topLevelUnits(body: readonly AnyNode[], source: string): Map<string, Unit[]> {
  const names = new Map<string, Unit[]>()
  const add = (name: string, unit: Unit): void => {
    const list = names.get(name) ?? []
    list.push(unit)
    names.set(name, list)
  }
  for (const statement of body) {
    const node = statement.type === 'ExportNamedDeclaration' || statement.type === 'ExportDefaultDeclaration'
      ? statement.declaration : statement
    if (node?.type === 'VariableDeclaration') {
      for (const declaration of node.declarations) {
        const unit = { node: declaration, code: node.kind + ' ' + source.slice(declaration.start, declaration.end) + ';' }
        for (const name of namesOf(declaration.id)) add(name, unit)
      }
    } else if ((node?.type === 'FunctionDeclaration' || node?.type === 'ClassDeclaration') && node.id) {
      add(node.id.name, { node, code: source.slice(node.start, node.end) + ';' })
    }
  }
  return names
}

/**
 * Recover the browser platform's SlotCore namespace without running the browser
 * entry or its imports. Unknown bundler shapes and unresolved dependencies fail
 * closed. The returned script is evaluated only in the restricted SDK process.
 */
export function extractBrowserCore(source: string): string {
  try {
    const program = parse(source, { ecmaVersion: 'latest', sourceType: 'module' })
    let registration: Identifier | undefined
    for (const node of descendants(program)) {
      if (node.type === 'Property' && propertyName(node) === SLOT_MODULE) {
        if (registration || node.kind !== 'init' || node.value.type !== 'Identifier') return unsupported()
        registration = node.value
      }
    }
    if (!registration) return unsupported()
    const units = topLevelUnits(program.body, source)
    const namespace = registration.name
    const entry = units.get(namespace)
    const namespaceNode = entry?.[0]?.node
    if (entry?.length !== 1 || namespaceNode?.type !== 'VariableDeclarator' || !namespaceNode.init) return unsupported()
    const names = namespaceObject(namespaceNode.init).properties.map(property => {
      if (property.type !== 'Property' || property.kind !== 'init' || property.method) return unsupported()
      return propertyName(property)
    })
    if (new Set(names).size !== names.length || SLOT_EXPORTS.some(name => !names.includes(name))) return unsupported()

    const selected = new Set<Unit>()
    const include = (name: string): void => {
      const matches = units.get(name)
      if (matches === undefined && PURE_GLOBALS.has(name)) return
      if (matches?.length !== 1) return unsupported()
      const unit = matches[0]
      if (selected.has(unit)) return
      selected.add(unit)
      references(unit.node, node => include(node.name))
    }
    include(namespace)
    const declarations = [...selected].sort((a, b) => a.node.start - b.node.start)
    let topLevelRegistration = false
    references(program, node => {
      if (node === registration) {
        topLevelRegistration = true
        return
      }
      // An external reference can let an alias or arbitrary function mutate
      // the actual SlotCore. Only the known platform-seed handoff is isolated.
      if (!units.get(node.name)?.some(unit => selected.has(unit))) return
      if (!declarations.some(unit => unit.node.start <= node.start && node.end <= unit.node.end)) return unsupported()
    }, false)
    if (!topLevelRegistration) return unsupported()
    const result = ['"use strict";', ...declarations.map(unit => unit.code), namespace + ';'].join('\n')
    if (result.length > 512 * 1024) return unsupported()
    return result
  } catch {
    return unsupported()
  }
}

