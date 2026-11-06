import { parse } from 'acorn'

/** The live listener and the candidate probe use the same protocol recognizer. */
export function isDesktopControlSource(source: string): boolean {
  try {
    const tree = parse(`(${source})`, { ecmaVersion: 'latest', sourceType: 'module' })
    const literals = new Set<string>()
    let invokesUpdate = false
    const visit = (value: any): void => {
      if (!value || typeof value !== 'object') return
      if (value.type === 'Literal' && typeof value.value === 'string') literals.add(value.value)
      if (value.type === 'CallExpression' && value.callee.type === 'MemberExpression') {
        const property = value.callee.property
        if ((!value.callee.computed && property.name === 'updateTasks') || property.value === 'updateTasks') invokesUpdate = true
      }
      for (const child of Object.values(value)) {
        if (Array.isArray(child)) child.forEach(visit)
        else visit(child)
      }
    }
    visit(tree)
    return invokesUpdate && literals.has('update-tasks') && literals.has('quit-inspection')
  } catch { return false }
}
