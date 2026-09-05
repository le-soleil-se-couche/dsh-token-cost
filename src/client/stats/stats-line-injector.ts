/**
 * Stats-line cost injector: inserts the current session's total cost into
 * the official conversation stats line, right between the speed group
 * ("首 token 平均 Xs · Y tok/s") and the cache-hit group ("缓存命中 Z%").
 *
 * The injected span carries no own styling: it inherits the stats line's
 * fonts and colors exactly (same as every other group span). A Mutation
 * observer re-applies the injection after every React re-render of the
 * line, and the operation is idempotent (a data marker identifies our
 * nodes).
 */

import { formatMoney } from '../format.ts'

/** Marker identifying injected nodes (removed before re-inject). */
export const COST_NODE_MARKER = 'data-dsh-token-cost-price'

/** The current cost text the bridge computed (empty while unknown). */
export interface CostBridgeState {
  /** Formatted cost for the active currency, e.g. '¥0.12'; empty when unknown. */
  costText: string
  /** True while the plugin is disabled by settings. */
  disabled: boolean
  /** Owning session id (for the click-through detail modal). */
  sessionId?: string
  /** Display currency (for the click-through detail modal). */
  currency?: 'cny' | 'usd'
}

let current: CostBridgeState = { costText: '', disabled: false }

/** Click handler the bridge registers to open the session detail modal. */
let openDetail: ((sessionId: string) => void) | null = null

/** Register the modal opener (the bridge component owns the modal). */
export function registerDetailOpener(opener: (sessionId: string) => void): void {
  openDetail = opener
}

/** Publish a new bridge state (called by the dock bridge component). */
export function publishCostState(state: CostBridgeState): void {
  current = state
  // Data arrived without a DOM mutation: apply immediately (idempotent).
  scheduleApply()
}

/** The latest published state. */
export function costBridgeState(): CostBridgeState {
  return current
}

/** Locale evidence inside the line: which language is the line speaking? */
function lineIsChinese(line: string): boolean {
  return line.includes('缓存命中')
}

/**
 * The official stats line sits inside the composer card (the dock footer of
 * the input bar). Anchor on the composer textarea and walk UP its ancestor
 * chain: the first ancestor that also contains the cache-hit copy is the
 * card, and inside it the cache-hit span is unambiguous (message bodies are
 * siblings, never ancestors, of the textarea).
 */
function locateLine(): { root: HTMLElement; anchor: HTMLElement } | null {
  const textarea = document.querySelector('textarea')
  if (textarea === null) return null
  let container: HTMLElement | null = textarea.parentElement
  while (container !== null && container !== document.body) {
    const text = container.textContent ?? ''
    if (
      (text.includes('缓存命中') || text.includes('Cache hit'))
      && text.includes('tok/s')
    ) {
      const found = findCacheAnchor(container)
      if (found !== null) return found
    }
    container = container.parentElement
  }
  return null
}

/** Find the cache-hit span inside a container and verify the stats-line shape. */
function findCacheAnchor(container: HTMLElement): { root: HTMLElement; anchor: HTMLElement } | null {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT)
  let cursor: Node | null = walker.nextNode()
  while (cursor !== null) {
    const text = cursor.textContent ?? ''
    if (text.includes('缓存命中') || text.includes('Cache hit')) {
      const anchor = cursor.parentElement
      if (anchor !== null) {
        const root = anchor.parentElement
        const rootText = root?.textContent ?? ''
        // The official stats line is a short row of plain group spans
        // separated by "|" spans (children are ALL spans).
        const children = root === null ? [] : [...root.children]
        if (
          root !== null
          && children.length >= 3
          && children.every((child) => child.tagName === 'SPAN')
          && rootText.length < 200
        ) {
          return { root, anchor }
        }
      }
    }
    cursor = walker.nextNode()
  }
  return null
}

/**
 * Apply the injection (idempotent): remove stale nodes, then place the cost
 * group right before the cache-hit span, cloning the official separator so
 * spacing matches the line exactly.
 */
function applyInjection(
  root: HTMLElement,
  anchor: HTMLElement,
  costText: string,
  chinese: boolean,
  state: CostBridgeState,
): void {
  root.querySelectorAll(`[${COST_NODE_MARKER}]`).forEach((el) => el.remove())
  const sep = anchor.previousElementSibling
  const label = chinese ? '费用' : 'Cost'
  const group = document.createElement('span')
  group.setAttribute(COST_NODE_MARKER, 'group')
  updateGroup(group, costText, label, state)
  // The handler resolves the current bridge state at click time. Poll updates
  // can therefore update the existing marker in place without retaining a
  // stale session id in an earlier closure.
  group.addEventListener('click', (event) => {
    if (current.sessionId === undefined || openDetail === null) return
    event.preventDefault()
    event.stopPropagation()
    openDetail(current.sessionId)
  })
  if (sep !== null && sep.textContent === '|' && sep.tagName === 'SPAN') {
    // The official separator before the cache-hit span now separates the
    // cost group; give the cache-hit group a cloned separator of its own.
    const sepClone = sep.cloneNode(true) as HTMLElement
    sepClone.setAttribute(COST_NODE_MARKER, 'sep')
    anchor.before(' ', group, ' ', sepClone)
  } else {
    anchor.before(group)
  }
}

/** Refresh the mutable facts of an already-inserted cost group. */
function updateGroup(
  group: HTMLElement,
  costText: string,
  label: string,
  state: CostBridgeState,
): void {
  const text = `${label} ${costText}`
  if (group.textContent !== text) group.textContent = text
  const clickable = state.sessionId !== undefined && openDetail !== null
  group.style.cursor = clickable ? 'pointer' : ''
  group.style.textDecoration = clickable ? 'underline dotted' : ''
  group.title = clickable ? '查看费用明细' : ''
}

let scheduled = 0

/** Apply the current state once, coalesced to a frame (no-op when nothing to inject). */
function scheduleApply(): void {
  if (scheduled !== 0) return
  scheduled = window.requestAnimationFrame(() => {
    scheduled = 0
    applyNow()
  })
}

/** Apply the current state immediately. */
function applyNow(): void {
  const state = current
  if (state.disabled || state.costText === '') {
    // Stale nodes must not linger when the data went away.
    document.querySelectorAll(`[${COST_NODE_MARKER}]`).forEach((el) => el.remove())
    return
  }
  const located = locateLine()
  if (located === null) return
  const { root, anchor } = located
  const chinese = lineIsChinese(root.textContent ?? '')
  const existing = root.querySelector<HTMLElement>(`[${COST_NODE_MARKER}="group"]`)
  if (existing !== null) {
    // Data can arrive without any host DOM mutation. Update the marker instead
    // of treating its mere presence as proof that the displayed cost is fresh.
    updateGroup(existing, state.costText, chinese ? '费用' : 'Cost', state)
    return
  }
  applyInjection(root, anchor, state.costText, chinese, state)
}

let observer: MutationObserver | null = null

/** Start observing and injecting; safe to call repeatedly. */
export function startStatsLineInjector(): void {
  if (observer !== null) return
  observer = new MutationObserver(() => {
    scheduleApply()
  })
  observer.observe(document.body, { childList: true, subtree: true })
}

/** Stop observing (teardown). */
export function stopStatsLineInjector(): void {
  if (observer !== null) {
    observer.disconnect()
    observer = null
  }
  document.querySelectorAll(`[${COST_NODE_MARKER}]`).forEach((el) => el.remove())
}

/** Format a totals pair into the display cost text. */
export function formatCostText(costCny: number, costUsd: number, currency: 'cny' | 'usd'): string {
  return formatMoney(currency === 'cny' ? costCny : costUsd, currency)
}
