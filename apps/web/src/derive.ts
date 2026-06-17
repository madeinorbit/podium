import type { AgentKind, GitRepositoryWire, HostMetricsWire, SessionMeta } from '@podium/protocol'
import { cn } from '@/lib/utils'
import { attentionGroup } from './home'
import type { PinState, RepoView, WorktreeView } from './types'

export type MemorySeverity = 'ok' | 'warn' | 'critical'

export interface HostMemoryView {
  hostname: string
  /** Headline: `used/total GB`, e.g. "12.3/32 GB". RAM only — swap never bleeds in. */
  label: string
  /** Used percentage, 0–100. */
  pct: number
  severity: MemorySeverity
  /** Tooltip: hostname + the full numbers, including swap when the host has any. */
  title: string
}

const GIB = 1024 ** 3
const usedGib = (bytes: number): string => (bytes / GIB).toFixed(1)
// Totals are installed capacity — print "32", not "32.0".
const totalGib = (bytes: number): string => {
  const v = bytes / GIB
  return Number.isInteger(v) ? String(v) : v.toFixed(1)
}

/** Human size for breakdown rows: "12.3 GB" from 1 GiB up, whole "512 MB" below. */
export function formatMemBytes(bytes: number): string {
  if (bytes >= GIB) return `${(bytes / GIB).toFixed(1)} GB`
  return `${Math.round(bytes / 1024 ** 2)} MB`
}

/**
 * Present one host's memory sample. Used = total − available (the kernel's
 * "allocatable without swapping" estimate), the convention of free/htop/Activity
 * Monitor — counting page cache as used would peg every warm box near 100%.
 */
export function hostMemoryView(host: HostMetricsWire): HostMemoryView {
  const m = host.memory
  const usedBytes = Math.max(0, m.totalBytes - m.availableBytes)
  const pct = m.totalBytes > 0 ? Math.round((usedBytes / m.totalBytes) * 100) : 0
  const severity: MemorySeverity = pct >= 90 ? 'critical' : pct >= 75 ? 'warn' : 'ok'
  const label = `${usedGib(usedBytes)}/${totalGib(m.totalBytes)} GB`
  const swap =
    m.swapTotalBytes > 0
      ? ` · swap ${usedGib(Math.max(0, m.swapTotalBytes - m.swapFreeBytes))}/${totalGib(m.swapTotalBytes)} GB`
      : ''
  return {
    hostname: host.hostname,
    label,
    pct,
    severity,
    title: `${host.hostname} — memory ${label} used (${pct}%)${swap}`,
  }
}

export function panelLabel(agentKind: AgentKind): string {
  switch (agentKind) {
    case 'claude-code':
      return 'Claude'
    case 'codex':
      return 'Codex'
    case 'grok':
      return 'Grok'
    case 'shell':
      return 'Shell'
    default: {
      const exhaustive: never = agentKind
      return exhaustive
    }
  }
}

/**
 * Harnesses that produce a structured transcript — so the chat view, the
 * chat↔live switcher, and the BTW button are offered immediately on spawn,
 * before the first transcript frame arrives. The server's observed
 * `transcriptAvailable` flag still wins when present; this is the fallback.
 */
export function defaultChatCapable(agentKind: AgentKind): boolean {
  return agentKind === 'claude-code' || agentKind === 'grok' || agentKind === 'codex'
}

export function reposToViews(repos: GitRepositoryWire[]): RepoView[] {
  // Scanning a path that contains worktrees returns both the parent repo (with its
  // worktrees[]) and each worktree as its own top-level entry. Drop the standalone
  // duplicates so each worktree shows once, nested under its parent.
  const linkedWorktreePaths = new Set(repos.flatMap((r) => r.worktrees.map((w) => w.path)))
  return repos
    .filter((r) => !linkedWorktreePaths.has(r.path))
    .map((r) => {
      const main: WorktreeView = {
        path: r.path,
        ...(r.branch !== undefined ? { branch: r.branch } : {}),
        repoPath: r.path,
        isMain: true,
      }
      const linked: WorktreeView[] = r.worktrees.map((w) => ({
        path: w.path,
        ...(w.branch !== undefined ? { branch: w.branch } : {}),
        repoPath: r.path,
        isMain: false,
      }))
      return { path: r.path, name: r.path.split('/').pop() || r.path, worktrees: [main, ...linked] }
    })
}

/** Sessions shown in a worktree's tab strip / sidebar — archived ones stay out. */
export function sessionsForWorktree(sessions: SessionMeta[], worktreePath: string): SessionMeta[] {
  return sessions.filter((s) => s.cwd === worktreePath && !s.archived)
}

/** Resolve a session's cwd to its repo name + branch, for the pinned-panel
 *  badge — pinned panels span repos/worktrees, so "which repo/branch" is what
 *  tells them apart. Null when the cwd isn't a known worktree (e.g. a session
 *  spawned in a path discovery hasn't indexed). */
export function repoBranchForCwd(
  repos: GitRepositoryWire[],
  cwd: string,
): { repo: string; branch?: string } | null {
  for (const repo of reposToViews(repos)) {
    for (const worktree of repo.worktrees) {
      if (worktree.path === cwd) {
        return { repo: repo.name, ...(worktree.branch !== undefined ? { branch: worktree.branch } : {}) }
      }
    }
  }
  return null
}

export interface WorktreeNavView extends WorktreeView {
  repoName: string
  sessions: SessionMeta[]
}

export interface RepoNavView {
  path: string
  name: string
  worktrees: WorktreeNavView[]
}

export interface SidebarSections {
  pinnedPanels: SessionMeta[]
  pinnedWorktrees: WorktreeNavView[]
  pinnedRepos: RepoNavView[]
  repos: RepoNavView[]
}

export const EMPTY_PINS: PinState = { panels: [], worktrees: [], repos: [] }

export function sortSessionsForPins(sessions: SessionMeta[], pins: PinState): SessionMeta[] {
  const panelOrder = orderMap(pins.panels)
  return [...sessions].sort((left, right) =>
    comparePinned(left.sessionId, right.sessionId, panelOrder),
  )
}

/**
 * Sidebar session order: most-recently-active first, with currently-working
 * sessions sunk beneath everything else. You steer the parked and blocked ones;
 * the agents happily running on their own need your eyes the least, so they sit
 * at the bottom of the list.
 */
export function sortSessionsForSidebar(sessions: SessionMeta[]): SessionMeta[] {
  return [...sessions].sort((a, b) => {
    const aWorking = attentionGroup(a) === 'working'
    const bWorking = attentionGroup(b) === 'working'
    if (aWorking !== bWorking) return aWorking ? 1 : -1
    return b.lastActiveAt.localeCompare(a.lastActiveAt)
  })
}

/**
 * Tab-strip order for one worktree. The user's manual (drag) order wins; sessions
 * it doesn't know about — panels opened after the last drag — append at the end
 * in the default pin-aware order.
 */
export function orderTabs(
  sessions: SessionMeta[],
  manualOrder: string[] | undefined,
  pins: PinState,
): SessionMeta[] {
  const base = sortSessionsForPins(sessions, pins)
  if (!manualOrder || manualOrder.length === 0) return base
  const position = orderMap(manualOrder)
  const known = base
    .filter((s) => position.has(s.sessionId))
    .sort((a, b) => (position.get(a.sessionId) ?? 0) - (position.get(b.sessionId) ?? 0))
  const unknown = base.filter((s) => !position.has(s.sessionId))
  return [...known, ...unknown]
}

export function sidebarSections(
  repos: GitRepositoryWire[],
  sessions: SessionMeta[],
  pins: PinState,
): SidebarSections {
  const repoViews = reposToViews(repos)
  const pinnedPanelIds = new Set(pins.panels)
  const pinnedWorktreePaths = new Set(pins.worktrees)
  const pinnedRepoPaths = new Set(pins.repos)

  const allWorktrees = repoViews.flatMap((repo) =>
    repo.worktrees.map((worktree) => ({ repo, worktree })),
  )
  const pinnedPanels = pins.panels
    .map((sessionId) => sessions.find((session) => session.sessionId === sessionId))
    .filter((session): session is SessionMeta => session !== undefined)

  const navWorktree = (repo: RepoView, worktree: WorktreeView): WorktreeNavView => ({
    ...worktree,
    repoName: repo.name,
    sessions: sortSessionsForSidebar(
      sessionsForWorktree(sessions, worktree.path).filter(
        (session) => !pinnedPanelIds.has(session.sessionId),
      ),
    ),
  })

  const navRepo = (repo: RepoView): RepoNavView => ({
    path: repo.path,
    name: repo.name,
    worktrees: repo.worktrees
      .filter((worktree) => !pinnedWorktreePaths.has(worktree.path))
      .map((worktree) => navWorktree(repo, worktree)),
  })

  return {
    pinnedPanels,
    pinnedWorktrees: pins.worktrees
      .map((path) => allWorktrees.find(({ worktree }) => worktree.path === path))
      .filter((item): item is { repo: RepoView; worktree: WorktreeView } => item !== undefined)
      .map(({ repo, worktree }) => navWorktree(repo, worktree)),
    pinnedRepos: pins.repos
      .map((path) => repoViews.find((repo) => repo.path === path))
      .filter((repo): repo is RepoView => repo !== undefined)
      .map(navRepo),
    repos: repoViews
      .filter((repo) => !pinnedRepoPaths.has(repo.path))
      .map(navRepo)
      .filter((repo) => repo.worktrees.length > 0),
  }
}

function orderMap(ids: string[]): Map<string, number> {
  return new Map(ids.map((id, index) => [id, index]))
}

function comparePinned(leftId: string, rightId: string, order: Map<string, number>): number {
  const leftOrder = order.get(leftId)
  const rightOrder = order.get(rightId)
  if (leftOrder !== undefined && rightOrder !== undefined) return leftOrder - rightOrder
  if (leftOrder !== undefined) return -1
  if (rightOrder !== undefined) return 1
  return 0
}

export interface AgentBadge {
  label: string
  tone: 'working' | 'idle' | 'attention' | 'error' | 'muted'
  showContinue: boolean
}

/** Map harness-observed runtime state to the little badge on a session row.
 *  Null = nothing to show (uninstrumented agent kinds stay clean). */
export function agentBadge(meta: SessionMeta): AgentBadge | null {
  const s = meta.agentState
  if (!s || s.phase === 'unknown') return null
  switch (s.phase) {
    case 'working':
      return { label: 'working', tone: 'working', showContinue: false }
    case 'compacting':
      return { label: 'compacting', tone: 'working', showContinue: false }
    case 'idle': {
      switch (s.idle?.kind) {
        case 'question':
          return { label: 'needs answer', tone: 'attention', showContinue: false }
        case 'approval':
          return { label: 'plan ready', tone: 'attention', showContinue: false }
        case 'open_todos':
          return { label: 'todos open', tone: 'attention', showContinue: false }
        default:
          return { label: 'idle', tone: 'idle', showContinue: false }
      }
    }
    case 'needs_user':
      return {
        label: s.need?.kind === 'question' ? 'needs answer' : 'needs permission',
        tone: 'attention',
        showContinue: false,
      }
    case 'errored':
      return {
        label: `error: ${s.error?.class ?? 'unknown'}`,
        tone: 'error',
        showContinue: s.error?.retryable ?? false,
      }
    case 'ended':
      return { label: 'ended', tone: 'muted', showContinue: false }
  }
}

export interface ChatActivity {
  label: string
  tone: AgentBadge['tone']
}

/**
 * The activity row shown pinned to the bottom of the chat view, or null for
 * nothing. Reuses `agentBadge` for instrumented agents; falls back to the PTY
 * `busy` signal for uninstrumented kinds; and shows an optimistic "Sending…"
 * immediately after a submit (`justSent`) before the first `working` event lands.
 */
export function chatActivity(meta: SessionMeta | undefined, justSent: boolean): ChatActivity | null {
  if (!meta) return null
  const badge = agentBadge(meta)
  if (badge?.tone === 'working') {
    return { label: badge.label === 'compacting' ? 'Compacting…' : 'Working…', tone: 'working' }
  }
  if (badge?.tone === 'attention') return { label: badge.label, tone: 'attention' }
  if (!meta.agentState && meta.busy) return { label: 'Working…', tone: 'working' }
  if (justSent) return { label: 'Sending…', tone: 'working' }
  return null
}

// Four semantic status colours, identical across every surface (sidebar, tabs,
// home board, chat) so a colour means the same thing everywhere:
//   working   → green   (agent running / shell command running)
//   attention → yellow  (needs you: question / approval / permission)
//   error     → red
//   ready     → blue    (idle-and-waiting, a fresh agent, or a shell at its prompt)
//   neutral   → grey    (hibernated/exited carry no live colour; the parked
//                        grayed-italic row carries hibernation instead)
export type DotTone = 'working' | 'attention' | 'error' | 'ready' | 'neutral'

/**
 * The status-dot tone for a session row/tab/card — the single source of truth
 * for agent colour, shared by every mode so the semantics never drift.
 *
 * Hibernated sessions get NO status colour (grey): per the colour rules, a parked
 * agent's state is carried by the grayed/italic row (`.dot.parked`), not the dot.
 */
export function sessionDotTone(s: SessionMeta): DotTone {
  // Parked/terminal: no live status colour. Hibernation's state rides on the
  // grayed/italic row instead of the dot.
  if (s.status === 'hibernated' || s.status === 'exited') return 'neutral'
  // Booting / brief reconnect: not working yet → blue.
  if (s.status === 'starting' || s.status === 'reconnecting') return 'ready'
  const badge = agentBadge(s)
  if (badge) {
    switch (badge.tone) {
      case 'working':
        return 'working'
      case 'attention':
        return 'attention'
      case 'error':
        return 'error'
      case 'idle': // finished a turn, nothing pending → ready for your next message
        return 'ready'
      case 'muted': // ended
        return 'neutral'
    }
  }
  // Uninstrumented live session: a shell is "working" (green) only while a command
  // runs; otherwise it — and a fresh agent that hasn't started a turn — is blue.
  if (s.agentKind === 'shell') return s.busy ? 'working' : 'ready'
  return 'ready'
}

// Tone → theme-independent hue. NOT the `bg-primary`/`bg-success` design tokens:
// `bg-primary` is near-black in the light theme, so an explicit blue keeps the
// status colours identical across themes and modes (matching the minimap palette).
const DOT_TONE_CLASS: Record<DotTone, string> = {
  working: 'bg-emerald-500',
  attention: 'bg-amber-500',
  error: 'bg-red-500',
  ready: 'bg-blue-500',
  neutral: 'bg-muted-foreground',
}

/**
 * Full className for a session's status dot: the tone hue plus a `parked` marker
 * for hibernated sessions. The marker drives the grayed/italic row look in CSS
 * (`.dot.parked + .worker-label`), independent of the (neutral) dot colour.
 */
export function sessionDotClass(s: SessionMeta): string {
  return cn(
    'dot inline-block size-2 min-w-2 flex-none rounded-full',
    DOT_TONE_CLASS[sessionDotTone(s)],
    s.status === 'hibernated' && 'parked',
  )
}

// The agent's `/color` identity accent (Claude's named colours) → a vivid,
// theme-independent hex, shown as the tab/sidebar accent line. This is *identity*
// (which agent), distinct from the status dot (what it's doing). Unknown/absent
// → undefined (no accent).
const AGENT_COLOR_HEX: Record<string, string> = {
  red: '#ef4444',
  blue: '#3b82f6',
  green: '#22c55e',
  yellow: '#eab308',
  purple: '#a855f7',
  orange: '#f97316',
  pink: '#ec4899',
  cyan: '#06b6d4',
}
export function agentColorHex(name: string | undefined): string | undefined {
  return name ? AGENT_COLOR_HEX[name.toLowerCase()] : undefined
}
