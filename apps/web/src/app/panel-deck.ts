import type { SessionMeta } from '@podium/protocol'
import type { FileTab } from './store'

// The rendered panel deck [POD-782] [spec:SP-0b2e]: issues are the MAIN way to
// own sessions, so the primary navigation gesture is the ISSUE switch. To make
// that switch instant, the deck of mounted AgentPanels spans issue/worktree
// switches — it is the union of the CURRENT workspace's tabs and the
// most-recently-viewed sessions from PREVIOUSLY-viewed issues (kept warm up to
// the LRU cap). The tab STRIP still shows only the current workspace's tabs;
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
  /** In pane A — the primary visible pane. */
  inA: boolean
  /** In pane B — the split's second visible pane (only when split is on). */
  inB: boolean
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
  /** Session ids to keep mounted — the warm LRU, spanning issue switches. */
  warm: Set<string>
  /** Currently-live (non-archived, non-dock) session ids — the eviction gate for
   *  foreign panels. */
  knownSessionIds: Set<string>
  paneA: string | null
  paneB: string | null
  split: boolean
}): DeckItem[] {
  const { tabs, warm, knownSessionIds, paneA, paneB, split } = opts
  const currentSessionIds = new Set(tabs.filter((t) => t.kind === 'session').map((t) => t.id))
  const local: DeckItem[] = tabs.map((t) => ({
    id: t.id,
    kind: t.kind,
    file: t.kind === 'file' ? t.file : undefined,
    inA: t.id === paneA,
    inB: split && t.id === paneB,
    warm: warm.has(t.id),
    foreign: false,
  }))
  const foreign: DeckItem[] = [...warm]
    .filter((id) => !currentSessionIds.has(id) && knownSessionIds.has(id))
    .map((id) => ({
      id,
      kind: 'session' as const,
      inA: false,
      inB: false,
      warm: true,
      foreign: true,
    }))
  return [...local, ...foreign]
}
