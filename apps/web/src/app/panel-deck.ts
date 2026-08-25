import type {
  PaneId,
  SplitAxis,
  SplitNode,
  TabId,
  WorkspaceLayout,
} from '@podium/client-core/viewmodels'
import { paneOfTab } from '@podium/client-core/viewmodels'
import type { SessionMeta } from '@podium/model/browser'
import type { CSSProperties } from 'react'
import type { FileTab } from './store'

// The rendered panel deck [POD-782] [spec:SP-0b2e]: issues are the MAIN way to
// own sessions, so the primary navigation gesture is the ISSUE switch. To make
// that switch instant, the deck of mounted AgentPanels spans issue/worktree
// switches — it is the union of the CURRENT workspace's tabs and the
// most-recently-viewed sessions from PREVIOUSLY-viewed issues (kept warm within
// the measured heavy-panel residency budget). The tab STRIP still shows only the current workspace's tabs;
// foreign warm panels render hidden + inert in the deck and never as tabs.

/** A tab in the current workspace's strip — an agent/shell session or an open file. */
export type DeckTab =
  | { id: string; kind: 'session'; session: SessionMeta }
  | { id: string; kind: 'file'; file: FileTab }

export interface DeckItem {
  id: string
  kind: 'session' | 'file'
  /** Present only for file items (drives the FilePanel props). */
  file?: FileTab
  /** The VISIBLE pane this panel fills — it is that pane's active tab. `null`
   *  means the panel is mounted but not on screen: a background tab, a tab in a
   *  pane that is not rendered, or a foreign warm panel. */
  paneId: PaneId | null
  /** Keep this panel mounted while hidden. Foreign warm panels are always true;
   *  a local hidden session tab is true only while inside the warm cap; file
   *  tabs are cheap and always kept. */
  warm: boolean
  /** A session kept warm from a PREVIOUSLY-viewed issue/worktree — never a tab in
   *  the current strip, always hidden and fully inert (active=false). */
  foreign: boolean
}

/**
 * Compose the rendered panel deck: the current workspace's tabs (sessions +
 * files, in strip order) followed by the foreign warm sessions — previously
 * viewed sessions from other issues/worktrees that the warm set still holds.
 *
 * Foreign entries are filtered to sessions that are still live (`knownSessionIds`
 * — non-archived, non-dock) so a killed/archived session drops from the deck the
 * moment it leaves that set, and de-duped against the current tabs so a session
 * that IS a current tab is never rendered twice.
 *
 * The result is ONE flat list rendered by a single keyed `.map`, which is
 * load-bearing: a session that moves between the local (tab) group and the
 * foreign group keeps the SAME key in the SAME array, so React preserves its
 * component identity (no unmount → the xterm/WebGL context and the POD-725
 * transcript window survive) across the issue switch.
 */
export function composeDeck(opts: {
  tabs: DeckTab[]
  /** Session ids to keep mounted — the budgeted warm LRU, spanning issue switches. */
  warm: Set<string>
  /** Currently-live (non-archived, non-dock) session ids — the eviction gate for
   *  foreign panels. */
  knownSessionIds: Set<string>
  /** The panes ON SCREEN, in leaf order. A pane that is not listed is simply
   *  absent, which is what keeps its tabs mounted-but-hidden instead of
   *  unmounted — a pane coming back must not cost a remount. */
  panes: readonly { id: PaneId; activeTabId: TabId | null }[]
}): DeckItem[] {
  const { tabs, warm, knownSessionIds, panes } = opts
  const paneOfActive = new Map<TabId, PaneId>()
  for (const pane of panes)
    if (pane.activeTabId !== null) paneOfActive.set(pane.activeTabId, pane.id)
  const currentSessionIds = new Set(tabs.filter((t) => t.kind === 'session').map((t) => t.id))
  const local: DeckItem[] = tabs.map((t) => ({
    id: t.id,
    kind: t.kind,
    file: t.kind === 'file' ? t.file : undefined,
    paneId: paneOfActive.get(t.id) ?? null,
    warm: warm.has(t.id),
    foreign: false,
  }))
  const foreign: DeckItem[] = [...warm]
    .filter((id) => !currentSessionIds.has(id) && knownSessionIds.has(id))
    .map((id) => ({
      id,
      kind: 'session' as const,
      paneId: null,
      warm: true,
      foreign: true,
    }))
  return [...local, ...foreign]
}

// ---------------------------------------------------------------------------
// Split geometry (POD-710 wave 2)
// ---------------------------------------------------------------------------

/**
 * WHY GEOMETRY AND NOT NESTED CONTAINERS.
 *
 * The deck's one flat keyed list is load-bearing (see above): a panel that moves
 * between groups must keep its component identity, or the xterm/WebGL context
 * and the POD-725 transcript window go with the remount. Rendering the split
 * tree as nested flex containers would put a panel under a different parent the
 * moment it is dragged into another pane — a remount by construction.
 *
 * So the tree is FLATTENED into rectangles instead. Every pane gets a box in
 * fractions of the deck, every internal split gets a seam, and the panels stay
 * exactly where they were in the list, absolutely positioned into their pane's
 * box. Splitting, dragging a tab across panes and dropping a pane are then pure
 * layout changes — no panel is ever reparented.
 */
export interface PaneRect {
  paneId: PaneId
  /** Fractions of the deck box, 0..1. */
  left: number
  top: number
  width: number
  height: number
}

/** A draggable boundary between two children of one split node. */
export interface SplitSeam {
  /** Stable React key / DOM id. */
  id: string
  /** Route from `root` to the split node this seam belongs to. */
  path: number[]
  axis: SplitAxis
  /** The child on the LEADING side of the seam. */
  index: number
  /** The split node's current sizes — what a drag rewrites. */
  sizes: number[]
  /** Where the boundary sits along the split's axis, as a deck fraction. */
  at: number
  /** The split node's own box, so the seam spans exactly its cross-axis extent. */
  left: number
  top: number
  width: number
  height: number
}

export interface DeckGeometry {
  panes: PaneRect[]
  seams: SplitSeam[]
}

function evenSizes(count: number): number[] {
  return Array.from({ length: count }, () => 1 / count)
}

/** Sizes as fractions summing to 1. Mirrors the reducer's own normalization so a
 *  hand-edited or half-written layout still lays out. */
function fractions(sizes: readonly number[], count: number): number[] {
  if (sizes.length !== count) return evenSizes(count)
  const clean = sizes.map((size) => (Number.isFinite(size) && size > 0 ? size : 0))
  const total = clean.reduce((sum, size) => sum + size, 0)
  if (total <= 0) return evenSizes(count)
  return clean.map((size) => size / total)
}

/** Flatten a split tree into pane boxes and seams, in fractions of the deck. */
export function deckGeometry(root: SplitNode): DeckGeometry {
  const out: DeckGeometry = { panes: [], seams: [] }
  const walk = (node: SplitNode, box: Omit<PaneRect, 'paneId'>, path: number[]): void => {
    if (node.kind === 'leaf') {
      out.panes.push({ paneId: node.paneId, ...box })
      return
    }
    const sizes = fractions(node.sizes, node.children.length)
    const row = node.axis === 'row'
    let offset = 0
    node.children.forEach((child, index) => {
      const share = sizes[index] as number
      walk(
        child,
        row
          ? {
              left: box.left + offset * box.width,
              top: box.top,
              width: box.width * share,
              height: box.height,
            }
          : {
              left: box.left,
              top: box.top + offset * box.height,
              width: box.width,
              height: box.height * share,
            },
        [...path, index],
      )
      offset += share
      if (index < node.children.length - 1) {
        out.seams.push({
          id: `${path.join('.')}|${index}`,
          path,
          axis: node.axis,
          index,
          sizes,
          at: row ? box.left + offset * box.width : box.top + offset * box.height,
          ...box,
        })
      }
    })
  }
  walk(root, { left: 0, top: 0, width: 1, height: 1 }, [])
  return out
}

/**
 * Move ONE boundary. Only the two children it separates change: their sum is
 * held constant, so dragging a seam never disturbs the panes beyond it, and
 * neither side can be squeezed below `min` (a pane too small to read is a pane
 * the operator cannot get back).
 *
 * `position` is where the boundary should land, as a fraction of the split
 * node's own extent. Returns the input array when the pair has no room to move.
 */
export function resizedSizes(
  sizes: readonly number[],
  index: number,
  position: number,
  min: number,
): number[] {
  const lead = sizes[index]
  const trail = sizes[index + 1]
  if (lead === undefined || trail === undefined || !Number.isFinite(position)) return [...sizes]
  const pair = lead + trail
  if (pair < min * 2) return [...sizes]
  const before = sizes.slice(0, index).reduce((sum, size) => sum + size, 0)
  const next = [...sizes]
  const clamped = Math.min(pair - min, Math.max(min, position - before))
  next[index] = clamped
  next[index + 1] = pair - clamped
  return next
}

// ---------------------------------------------------------------------------
// Where a dragged tab lands
// ---------------------------------------------------------------------------

/** Droppable id grammar for the cross-pane drag. Pane ids are `p<N>` and tab ids
 *  are session ids or `file:…`, so a prefixed spelling is unambiguous. */
export const stripDropId = (paneId: PaneId): string => `strip:${paneId}`
export const paneDropId = (paneId: PaneId): string => `pane:${paneId}`
export const splitDropId = (axis: SplitAxis, paneId: PaneId): string => `split:${axis}:${paneId}`

export type TabDrop =
  | { kind: 'move'; tabId: TabId; paneId: PaneId; index: number }
  | { kind: 'split'; tabId: TabId; paneId: PaneId; axis: SplitAxis }
  | { kind: 'activate'; tabId: TabId }

/**
 * Resolve a drop onto one of the four target kinds, or to nothing.
 *
 * Pure, because "where does this tab go" is the whole of the cross-pane drag and
 * the drag itself is the untestable part. Order matters: a split zone sits INSIDE
 * a pane body, and a tab sits inside a strip, so the more specific spelling is
 * matched first.
 */
export function resolveTabDrop(
  layout: WorkspaceLayout,
  tabId: TabId,
  overId: string,
): TabDrop | null {
  if (!tabId || overId === tabId) return null
  const zone = /^split:(row|column):(.+)$/.exec(overId)
  if (zone) {
    const paneId = zone[2] as PaneId
    return layout.panes[paneId]
      ? { kind: 'split', tabId, paneId, axis: zone[1] as SplitAxis }
      : null
  }
  const paneTarget = /^(?:strip|pane):(.+)$/.exec(overId)
  if (paneTarget) {
    const target = layout.panes[paneTarget[1] as PaneId]
    if (!target) return null
    // Dropping a tab back into the pane it already lives in is a selection, not
    // a move — sending it to the end would reorder the strip under the operator.
    return target.tabs.includes(tabId)
      ? { kind: 'activate', tabId }
      : { kind: 'move', tabId, paneId: target.id, index: target.tabs.length }
  }
  const host = paneOfTab(layout, overId)
  if (!host) return null
  return { kind: 'move', tabId, paneId: host.id, index: host.tabs.indexOf(overId) }
}

const pct = (value: number): string => `${value * 100}%`

/** A pane's CHROME box — the whole pane, tab strip included. */
export function paneBoxStyle(rect: PaneRect): CSSProperties {
  return {
    left: pct(rect.left),
    top: pct(rect.top),
    width: pct(rect.width),
    height: pct(rect.height),
  }
}

/** How much of a pane its own chrome takes: the `--section-bar-h` strip plus the
 *  1px hairline it closes with. The panel starts BELOW that line, not under it. */
const PANE_HEADER = 'calc(var(--section-bar-h) + 1px)'

/** A pane's PANEL box — the chrome box less its tab strip, so an absolutely
 *  positioned panel lands under the strip of the pane it belongs to. */
export function panelBoxStyle(rect: PaneRect): CSSProperties {
  return {
    left: pct(rect.left),
    top: `calc(${pct(rect.top)} + ${PANE_HEADER})`,
    width: pct(rect.width),
    height: `calc(${pct(rect.height)} - ${PANE_HEADER})`,
  }
}

/** A seam's box: a thin grab strip centred on the boundary, spanning the split
 *  node's cross-axis extent. */
export function seamBoxStyle(seam: SplitSeam): CSSProperties {
  return seam.axis === 'row'
    ? { left: pct(seam.at), top: pct(seam.top), height: pct(seam.height) }
    : { top: pct(seam.at), left: pct(seam.left), width: pct(seam.width) }
}
