/**
 * WORKSPACE LAYOUT — the editor-style tab model (POD-710).
 *
 * A workspace is what ONE task in the left sidebar has open: its tabs, which one
 * is active, which one is the (single) temporary preview, and how the panes are
 * split. Every operation here is a pure function from a layout to a layout, with
 * no React, no store and no persistence — the engine owns where a layout lives
 * and when it is written; this module owns what a layout IS.
 *
 * Three properties are load-bearing and every reducer preserves them:
 *
 *  1. AT MOST ONE PREVIEW TAB per workspace, and it is always a member of a
 *     pane. The preview is the tab you get by selecting a session in the flight
 *     deck; selecting another session reuses it, so the operator cycles through
 *     ONE temporary tab instead of accumulating a strip of them.
 *  2. A TAB ID LIVES IN EXACTLY ONE PANE. Panes are views onto disjoint sets of
 *     tabs, so "which pane is this tab in" always has one answer.
 *  3. THE LAYOUT IS NEVER EMPTY. `root` always contains at least one leaf,
 *     `focusedPaneId` always names an existing leaf, and closing the last tab of
 *     the last pane leaves an empty pane rather than a layout with none.
 *
 * Reducers are TOTAL: an id that does not exist, a pane that is not a leaf, an
 * index that is out of range — none of them throw, they return the layout they
 * were given (by identity, so the caller can cheaply detect a no-op).
 */

/** Identity of a tab. Today: a sessionId, or a `file:<scope>:<path>` id. */
export type TabId = string

/** Which workspace we are in — the task selected in the left sidebar. */
export type WorkspaceKey = string

export type PaneId = string

/**
 * `row` = panes side by side (a VERTICAL split line — "Split Right").
 * `column` = panes stacked (a HORIZONTAL split line — "Split Down").
 * Name these in the UI the way editors do, never by axis.
 */
export type SplitAxis = 'row' | 'column'

export interface Pane {
  id: PaneId
  /** Strip order within this pane. */
  tabs: TabId[]
  activeTabId: TabId | null
}

/** Split tree. Only ever deeper than a single leaf when `tab-splitting` is on. */
export type SplitNode =
  | { kind: 'leaf'; paneId: PaneId }
  | { kind: 'split'; axis: SplitAxis; children: SplitNode[]; sizes: number[] }

export interface WorkspaceLayout {
  key: WorkspaceKey
  panes: Record<PaneId, Pane>
  root: SplitNode
  focusedPaneId: PaneId
  /** The ONE temporary tab in this workspace. Italic in the strip. */
  previewTabId: TabId | null
}

/** Every workspace this device remembers, keyed by {@link workspaceKeyFor}. */
export type WorkspaceMap = Record<WorkspaceKey, WorkspaceLayout>

/** A route from `root` down through `children` indices to a split node. */
export type SplitPath = readonly number[]

// ---------------------------------------------------------------------------
// The workspace key
// ---------------------------------------------------------------------------

/**
 * The workspace a selection belongs to. Mission root wins over the issue,
 * because every task in a mission shares ONE tab strip; a bare issue and a bare
 * worktree each key themselves; nothing selected is still a workspace ('none'),
 * so the model never has to represent "no workspace".
 *
 * Moved here from `Workspace.tsx` so the engine and every view compute the key
 * the same way — two spellings of this function is two different workspaces for
 * the same task.
 */
export function workspaceKeyFor(sel: {
  missionRootId?: string | null
  issueId?: string | null
  worktreePath?: string | null
}): WorkspaceKey {
  if (sel.missionRootId) return `mission:${sel.missionRootId}`
  if (sel.issueId) return `issue:${sel.issueId}`
  if (sel.worktreePath) return `wt:${sel.worktreePath}`
  return 'none'
}

// ---------------------------------------------------------------------------
// Reading a layout
// ---------------------------------------------------------------------------

/** Leaf pane ids in strip order (left→right, top→bottom). Never empty. */
export function leafPaneIds(node: SplitNode): PaneId[] {
  return node.kind === 'leaf' ? [node.paneId] : node.children.flatMap(leafPaneIds)
}

/** The panes of a layout, in leaf order. */
export function orderedPanes(ws: WorkspaceLayout): Pane[] {
  return leafPaneIds(ws.root).flatMap((id) => {
    const pane = ws.panes[id]
    return pane ? [pane] : []
  })
}

/** The pane holding `tabId`, or undefined when the tab is not open here. */
export function paneOfTab(ws: WorkspaceLayout, tabId: TabId): Pane | undefined {
  return orderedPanes(ws).find((pane) => pane.tabs.includes(tabId))
}

/** The pane the operator is typing into. Always defined (invariant 3). */
export function focusedPane(ws: WorkspaceLayout): Pane {
  const pane = ws.panes[ws.focusedPaneId]
  if (pane) return pane
  // Defensive: a layout that lost its focus target still has a first leaf.
  return orderedPanes(ws)[0] as Pane
}

/** Every tab id open in this workspace, in pane order. */
export function allTabIds(ws: WorkspaceLayout): TabId[] {
  return orderedPanes(ws).flatMap((pane) => pane.tabs)
}

/** True when `tabId` is this workspace's temporary tab (rendered italic). */
export function isPreviewTab(ws: WorkspaceLayout, tabId: TabId): boolean {
  return ws.previewTabId !== null && ws.previewTabId === tabId
}

// ---------------------------------------------------------------------------
// Tree helpers (internal)
// ---------------------------------------------------------------------------

const leaf = (paneId: PaneId): SplitNode => ({ kind: 'leaf', paneId })

function equalSizes(count: number): number[] {
  return Array.from({ length: count }, () => 1 / count)
}

/** Normalize to sum 1 so a resize never changes the total width of a split. */
function normalizeSizes(sizes: readonly number[], count: number): number[] {
  if (sizes.length !== count) return equalSizes(count)
  const clean = sizes.map((size) => (Number.isFinite(size) && size > 0 ? size : 0))
  const total = clean.reduce((sum, size) => sum + size, 0)
  if (total <= 0) return equalSizes(count)
  return clean.map((size) => size / total)
}

function replaceLeaf(node: SplitNode, paneId: PaneId, replacement: SplitNode): SplitNode {
  if (node.kind === 'leaf') return node.paneId === paneId ? replacement : node
  return {
    ...node,
    children: node.children.map((child) => replaceLeaf(child, paneId, replacement)),
  }
}

/** Drop a leaf from the tree, collapsing a split left with a single child.
 *  Returns null when the whole subtree disappears. */
function removeLeaf(node: SplitNode, paneId: PaneId): SplitNode | null {
  if (node.kind === 'leaf') return node.paneId === paneId ? null : node
  const kept: SplitNode[] = []
  const sizes: number[] = []
  node.children.forEach((child, index) => {
    const next = removeLeaf(child, paneId)
    if (next === null) return
    kept.push(next)
    sizes.push(node.sizes[index] ?? 1 / node.children.length)
  })
  if (kept.length === 0) return null
  if (kept.length === 1) return kept[0] as SplitNode
  return { ...node, children: kept, sizes: normalizeSizes(sizes, kept.length) }
}

function nodeAtPath(root: SplitNode, path: SplitPath): SplitNode | undefined {
  let node: SplitNode | undefined = root
  for (const index of path) {
    if (node?.kind !== 'split') return undefined
    node = node.children[index]
  }
  return node
}

function withSizesAtPath(node: SplitNode, path: SplitPath, sizes: number[]): SplitNode {
  if (path.length === 0) {
    if (node.kind !== 'split') return node
    return { ...node, sizes }
  }
  if (node.kind !== 'split') return node
  const [index, ...rest] = path as number[]
  const child = node.children[index as number]
  if (!child) return node
  const children = [...node.children]
  children[index as number] = withSizesAtPath(child, rest, sizes)
  return { ...node, children }
}

/** Deterministic next pane id — pure, so a reducer never reaches for a clock or
 *  a random source and two clients replaying the same actions agree. */
function nextPaneId(panes: Record<PaneId, Pane>): PaneId {
  let max = 0
  for (const id of Object.keys(panes)) {
    const match = /^p(\d+)$/.exec(id)
    if (match) max = Math.max(max, Number(match[1]))
  }
  return `p${max + 1}`
}

/** Pick the tab that takes over when `removed` (at `index`) leaves a pane:
 *  neighbour-right first, then neighbour-left — the editor rule. */
function neighbourAfterRemoval(tabs: readonly TabId[], index: number): TabId | null {
  return tabs[index] ?? tabs[index - 1] ?? null
}

function withPane(ws: WorkspaceLayout, pane: Pane): WorkspaceLayout {
  return { ...ws, panes: { ...ws.panes, [pane.id]: pane } }
}

// ---------------------------------------------------------------------------
// Reducers
// ---------------------------------------------------------------------------

/** A workspace with one empty pane — the shape every key starts from. */
export function emptyWorkspace(key: WorkspaceKey): WorkspaceLayout {
  const paneId = 'p1'
  return {
    key,
    panes: { [paneId]: { id: paneId, tabs: [], activeTabId: null } },
    root: leaf(paneId),
    focusedPaneId: paneId,
    previewTabId: null,
  }
}

/**
 * THE function the flight deck calls.
 *
 * `permanent: false` — the preview open. If the target pane already holds the
 * preview tab, the new tab REPLACES it in the same strip position (that is what
 * makes cycling through sessions feel like one tab); otherwise it is appended.
 * Opening the tab that is already the preview is just an activate, and opening a
 * tab that is already open as a PERMANENT tab activates it and leaves the
 * preview alone — a session you deliberately kept is not silently recycled.
 *
 * `permanent: true` — promotes in place when the tab IS the preview (no move, so
 * the strip does not jump under the cursor), appends when it is not open, and
 * activates either way.
 */
export function openTab(
  ws: WorkspaceLayout,
  tabId: TabId,
  opts: { permanent: boolean; paneId?: PaneId },
): WorkspaceLayout {
  if (!tabId) return ws
  if (opts.paneId !== undefined && !ws.panes[opts.paneId]) return ws
  const existing = paneOfTab(ws, tabId)
  if (existing) {
    const activated = activateTab(ws, tabId)
    // Already open: a permanent open promotes it, a preview open leaves the
    // preview flag exactly as it was.
    if (opts.permanent && activated.previewTabId === tabId) {
      return { ...activated, previewTabId: null }
    }
    return activated
  }
  const targetId = opts.paneId ?? ws.focusedPaneId
  const target = ws.panes[targetId]
  if (!target) return ws
  const previewIndex =
    !opts.permanent && ws.previewTabId !== null ? target.tabs.indexOf(ws.previewTabId) : -1
  const tabs =
    previewIndex >= 0
      ? target.tabs.map((id, index) => (index === previewIndex ? tabId : id))
      : [...target.tabs, tabId]
  const next = withPane(ws, { ...target, tabs, activeTabId: tabId })
  return {
    ...next,
    focusedPaneId: targetId,
    // ≤1 preview per workspace: a preview living in ANOTHER pane is not moved or
    // closed, it simply stops being temporary.
    previewTabId: opts.permanent ? ws.previewTabId : tabId,
  }
}

/** Preview → permanent, with no reorder. The operator typed into it, or
 *  double-clicked it; either way the tab stays exactly where it is. */
export function promoteTab(ws: WorkspaceLayout, tabId: TabId): WorkspaceLayout {
  if (ws.previewTabId === null || ws.previewTabId !== tabId) return ws
  return { ...ws, previewTabId: null }
}

/** Make `tabId` the active tab of its pane, and focus that pane. */
export function activateTab(ws: WorkspaceLayout, tabId: TabId): WorkspaceLayout {
  const pane = paneOfTab(ws, tabId)
  if (!pane) return ws
  if (pane.activeTabId === tabId && ws.focusedPaneId === pane.id) return ws
  return { ...withPane(ws, { ...pane, activeTabId: tabId }), focusedPaneId: pane.id }
}

/**
 * Close a VIEW. Never a session — the session lives in the flight deck and is
 * untouched by this.
 *
 * The neighbour to the right takes over, else the one to the left. A pane
 * emptied this way collapses unless it is the last one, which stays as an empty
 * workspace rather than leaving the layout with no panes at all.
 */
export function closeTab(ws: WorkspaceLayout, tabId: TabId): WorkspaceLayout {
  const pane = paneOfTab(ws, tabId)
  if (!pane) return ws
  const index = pane.tabs.indexOf(tabId)
  const tabs = pane.tabs.filter((id) => id !== tabId)
  const activeTabId =
    pane.activeTabId === tabId ? neighbourAfterRemoval(tabs, index) : pane.activeTabId
  const previewTabId = ws.previewTabId === tabId ? null : ws.previewTabId
  const next = withPane({ ...ws, previewTabId }, { ...pane, tabs, activeTabId })
  return tabs.length === 0 ? dropPane(next, pane.id) : next
}

/** Remove a leaf pane from the tree and the pane map, re-homing focus. */
function dropPane(ws: WorkspaceLayout, paneId: PaneId): WorkspaceLayout {
  const order = leafPaneIds(ws.root)
  if (order.length <= 1) return ws
  const root = removeLeaf(ws.root, paneId)
  if (root === null) return ws
  const panes = { ...ws.panes }
  delete panes[paneId]
  const remaining = leafPaneIds(root)
  const index = order.indexOf(paneId)
  const focusedPaneId = remaining.includes(ws.focusedPaneId)
    ? ws.focusedPaneId
    : ((order[index - 1] ?? order[index + 1] ?? remaining[0]) as PaneId)
  return { ...ws, panes, root, focusedPaneId }
}

/**
 * Reorder within a pane, or move a tab into another pane (the drag). The moved
 * tab becomes the active tab of the pane it lands in, and an emptied source pane
 * collapses exactly as it does under {@link closeTab} — dragging the last tab
 * out of a pane must not leave an empty pane on screen.
 */
export function moveTab(
  ws: WorkspaceLayout,
  tabId: TabId,
  toPaneId: PaneId,
  toIndex: number,
): WorkspaceLayout {
  const from = paneOfTab(ws, tabId)
  const to = ws.panes[toPaneId]
  if (!from || !to || !leafPaneIds(ws.root).includes(toPaneId)) return ws
  if (!Number.isFinite(toIndex)) return ws
  if (from.id === toPaneId) {
    const rest = from.tabs.filter((id) => id !== tabId)
    const index = Math.max(0, Math.min(Math.trunc(toIndex), rest.length))
    const tabs = [...rest.slice(0, index), tabId, ...rest.slice(index)]
    if (tabs.every((id, i) => id === from.tabs[i])) return activateTab(ws, tabId)
    return activateTab(withPane(ws, { ...from, tabs }), tabId)
  }
  const sourceIndex = from.tabs.indexOf(tabId)
  const sourceTabs = from.tabs.filter((id) => id !== tabId)
  const sourceActive =
    from.activeTabId === tabId ? neighbourAfterRemoval(sourceTabs, sourceIndex) : from.activeTabId
  const index = Math.max(0, Math.min(Math.trunc(toIndex), to.tabs.length))
  const targetTabs = [...to.tabs.slice(0, index), tabId, ...to.tabs.slice(index)]
  let next: WorkspaceLayout = {
    ...ws,
    panes: {
      ...ws.panes,
      [from.id]: { ...from, tabs: sourceTabs, activeTabId: sourceActive },
      [to.id]: { ...to, tabs: targetTabs, activeTabId: tabId },
    },
    focusedPaneId: to.id,
  }
  if (sourceTabs.length === 0) next = dropPane(next, from.id)
  return next
}

/**
 * Split a pane in two. `opts.tabId` (the "Split Right" on a tab) puts that tab
 * in the new pane — moved out of whichever pane holds it, or opened there when
 * it is not open yet. Without it the pane's active tab moves, but only when the
 * pane has more than one: splitting a single-tab pane by moving its only tab
 * would just relabel the pane.
 *
 * The new pane takes focus, which is what every editor does: you split in order
 * to work over there.
 */
export function splitPane(
  ws: WorkspaceLayout,
  paneId: PaneId,
  axis: SplitAxis,
  opts?: { tabId?: TabId },
): WorkspaceLayout {
  const source = ws.panes[paneId]
  if (!source || !leafPaneIds(ws.root).includes(paneId)) return ws
  const moving =
    opts?.tabId !== undefined && opts.tabId
      ? opts.tabId
      : source.tabs.length > 1
        ? source.activeTabId
        : null
  const newPaneId = nextPaneId(ws.panes)
  const panes: Record<PaneId, Pane> = { ...ws.panes }
  const donor = moving === null ? undefined : paneOfTab(ws, moving)
  if (moving !== null && donor) {
    const index = donor.tabs.indexOf(moving)
    const tabs = donor.tabs.filter((id) => id !== moving)
    panes[donor.id] = {
      ...donor,
      tabs,
      activeTabId:
        donor.activeTabId === moving ? neighbourAfterRemoval(tabs, index) : donor.activeTabId,
    }
  }
  panes[newPaneId] = {
    id: newPaneId,
    tabs: moving !== null ? [moving] : [],
    activeTabId: moving,
  }
  const root = replaceLeaf(ws.root, paneId, {
    kind: 'split',
    axis,
    children: [leaf(paneId), leaf(newPaneId)],
    sizes: equalSizes(2),
  })
  return { ...ws, panes, root, focusedPaneId: newPaneId }
}

/** Close a pane; its tabs migrate to the previous leaf (the next one when it was
 *  the first). The last pane cannot be closed — that would be a layout with no
 *  panes, which nothing downstream can render. */
export function closePane(ws: WorkspaceLayout, paneId: PaneId): WorkspaceLayout {
  const order = leafPaneIds(ws.root)
  const pane = ws.panes[paneId]
  if (!pane || !order.includes(paneId) || order.length <= 1) return ws
  const index = order.indexOf(paneId)
  const hostId = (order[index - 1] ?? order[index + 1]) as PaneId
  const host = ws.panes[hostId] as Pane
  const merged: Pane = {
    ...host,
    tabs: [...host.tabs, ...pane.tabs],
    activeTabId: host.activeTabId ?? pane.activeTabId,
  }
  return dropPane(withPane(ws, merged), paneId)
}

/** Move input focus to a pane (a click into it, or a pane-navigation command). */
export function focusPane(ws: WorkspaceLayout, paneId: PaneId): WorkspaceLayout {
  if (!ws.panes[paneId] || !leafPaneIds(ws.root).includes(paneId)) return ws
  if (ws.focusedPaneId === paneId) return ws
  return { ...ws, focusedPaneId: paneId }
}

/** Resize the split node at `path` (root is `[]`). Sizes are normalized to sum
 *  to 1, so a resizer can hand over pixels or fractions. */
export function resizeSplit(
  ws: WorkspaceLayout,
  path: SplitPath,
  sizes: readonly number[],
): WorkspaceLayout {
  const node = nodeAtPath(ws.root, path)
  if (node?.kind !== 'split') return ws
  if (sizes.length !== node.children.length) return ws
  if (!sizes.every((size) => Number.isFinite(size) && size > 0)) return ws
  return { ...ws, root: withSizesAtPath(ws.root, path, normalizeSizes(sizes, sizes.length)) }
}

/**
 * Drop tabs whose underlying session or file is gone.
 *
 * Deliberately NOT structural: panes and splits are the operator's arrangement
 * and survive an empty pane. Only membership is pruned — and `knownTabIds` must
 * be a set the caller is CERTAIN about, because a tab dropped here is gone from
 * a persisted layout. An id that is merely not-yet-synced (an optimistic spawn,
 * a deep-linked pane) is not unknown; it is early.
 */
export function pruneWorkspace(
  ws: WorkspaceLayout,
  knownTabIds: ReadonlySet<TabId>,
): WorkspaceLayout {
  const stale = allTabIds(ws).filter((id) => !knownTabIds.has(id))
  if (stale.length === 0) return ws
  const panes: Record<PaneId, Pane> = {}
  for (const [id, pane] of Object.entries(ws.panes)) {
    const index = pane.activeTabId === null ? -1 : pane.tabs.indexOf(pane.activeTabId)
    const tabs = pane.tabs.filter((tab) => knownTabIds.has(tab))
    const activeTabId =
      pane.activeTabId !== null && knownTabIds.has(pane.activeTabId)
        ? pane.activeTabId
        : neighbourAfterRemoval(tabs, Math.max(0, index))
    panes[id] = { ...pane, tabs, activeTabId }
  }
  const previewTabId =
    ws.previewTabId !== null && knownTabIds.has(ws.previewTabId) ? ws.previewTabId : null
  return { ...ws, panes, previewTabId }
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

/** Bump when the persisted shape changes. An older/newer blob deserializes to
 *  `{}` rather than half-parsing into a layout nothing can render. */
export const WORKSPACES_BLOB_VERSION = 1

export function serializeWorkspaces(all: WorkspaceMap): string {
  return JSON.stringify({ v: WORKSPACES_BLOB_VERSION, workspaces: all })
}

/**
 * TOTAL by contract: malformed, truncated, older-shaped or hand-edited JSON
 * returns `{}`, and a single unusable workspace inside an otherwise good blob is
 * dropped rather than taking its siblings with it. Persisted layout is device
 * state — it must never be able to break the workspace it describes.
 */
export function deserializeWorkspaces(raw: string | null): WorkspaceMap {
  if (!raw) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {}
  }
  if (!isRecord(parsed) || parsed.v !== WORKSPACES_BLOB_VERSION) return {}
  const workspaces = parsed.workspaces
  if (!isRecord(workspaces)) return {}
  const out: WorkspaceMap = {}
  for (const [key, value] of Object.entries(workspaces)) {
    const layout = normalizeWorkspace(value, key)
    if (layout) out[key] = layout
  }
  return out
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Repair an untrusted layout into one that satisfies every invariant, or
 *  reject it. Exported for the same reason `deserializeWorkspaces` is total. */
export function normalizeWorkspace(value: unknown, key: WorkspaceKey): WorkspaceLayout | null {
  if (!isRecord(value)) return null
  const rawPanes = isRecord(value.panes) ? value.panes : null
  if (!rawPanes) return null
  const root = normalizeNode(value.root, (paneId) => isRecord(rawPanes[paneId]))
  if (!root) return null
  const seen = new Set<TabId>()
  const panes: Record<PaneId, Pane> = {}
  for (const paneId of leafPaneIds(root)) {
    const rawPane = rawPanes[paneId]
    const source = isRecord(rawPane) ? rawPane : {}
    const tabs: TabId[] = []
    for (const tab of Array.isArray(source.tabs) ? source.tabs : []) {
      // A tab id repeated across panes would break "one pane per tab": the
      // first spelling wins and the rest are dropped.
      if (typeof tab !== 'string' || !tab || seen.has(tab)) continue
      seen.add(tab)
      tabs.push(tab)
    }
    const rawActive = source.activeTabId
    const activeTabId =
      typeof rawActive === 'string' && tabs.includes(rawActive) ? rawActive : (tabs[0] ?? null)
    panes[paneId] = { id: paneId, tabs, activeTabId }
  }
  const leaves = leafPaneIds(root)
  const focusedRaw = value.focusedPaneId
  const focusedPaneId =
    typeof focusedRaw === 'string' && leaves.includes(focusedRaw)
      ? focusedRaw
      : (leaves[0] as PaneId)
  const previewRaw = value.previewTabId
  const previewTabId = typeof previewRaw === 'string' && seen.has(previewRaw) ? previewRaw : null
  return { key, panes, root, focusedPaneId, previewTabId }
}

function normalizeNode(value: unknown, hasPane: (paneId: PaneId) => boolean): SplitNode | null {
  if (!isRecord(value)) return null
  if (value.kind === 'leaf') {
    return typeof value.paneId === 'string' && value.paneId && hasPane(value.paneId)
      ? leaf(value.paneId)
      : null
  }
  if (value.kind !== 'split') return null
  if (value.axis !== 'row' && value.axis !== 'column') return null
  if (!Array.isArray(value.children)) return null
  const rawSizes = Array.isArray(value.sizes) ? value.sizes : []
  const children: SplitNode[] = []
  const sizes: number[] = []
  value.children.forEach((child, index) => {
    const node = normalizeNode(child, hasPane)
    if (!node) return
    children.push(node)
    const size = rawSizes[index]
    sizes.push(typeof size === 'number' && Number.isFinite(size) && size > 0 ? size : 1)
  })
  if (children.length === 0) return null
  if (children.length === 1) return children[0] as SplitNode
  return {
    kind: 'split',
    axis: value.axis,
    children,
    sizes: normalizeSizes(sizes, children.length),
  }
}
