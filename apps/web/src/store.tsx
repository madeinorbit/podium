import { type Sidebar as SidebarSettings, shouldPromptAutoContinue } from '@podium/core'
import type {
  GitDiscoveryDiagnosticWire,
  GitRepositoryWire,
  HostMetricsWire,
  IssueWire,
  SessionMeta,
  WorkState,
} from '@podium/protocol'
import { SocketHub } from '@podium/terminal-client'
import type { JSX } from 'react'
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { formatAppError } from './AppErrorPage'
import { dedupeSessionsByResume, EMPTY_PINS, reposToViews } from './derive'
import { makeTrpc, type ServerOrigin, type Trpc } from './trpc'
import type { PinKind, PinState } from './types'

export interface Store {
  hub: SocketHub
  trpc: Trpc
  repos: GitRepositoryWire[]
  reposLoading: boolean
  /** True once the first repo refresh has resolved — lets the UI distinguish
   *  "still loading" from "registry is genuinely empty" (first-run onboarding). */
  reposLoaded: boolean
  repoDiagnostics: GitDiscoveryDiagnosticWire[]
  sessions: SessionMeta[]
  /** Issues (work items) broadcast by the server — full list, refreshed on every mutation. */
  issues: IssueWire[]
  /** Latest health sample per daemon host; empty until a daemon reports (or after it drops). */
  hostMetrics: HostMetricsWire[]
  pins: PinState
  setPinned: (kind: PinKind, id: string, pinned: boolean) => Promise<void>
  /** Manual tab order per worktree path (drag-to-reorder). Absent key = no manual order. */
  tabOrders: Record<string, string[]>
  setTabOrder: (worktree: string, sessionIds: string[]) => Promise<void>
  /** Main-area surface: attention board, worktree workspace, superagent, or settings. */
  view: MainView
  setView: (view: MainView) => void
  /** Deep-link target for the Settings view — a tab key (e.g. from global search).
   *  Consumed and cleared by SettingsView on mount. */
  settingsTab: string | null
  setSettingsTab: (tab: string | null) => void
  /** Active superagent thread: the 'global' orchestrator or a 'btw_<sessionId>' thread. */
  superThreadId: string
  setSuperThreadId: (id: string) => void
  /** Whether the superagent panel is open — a collapsible right dock on desktop,
   *  a minimizable overlay on mobile (no longer a full-screen view). */
  superOpen: boolean
  setSuperOpen: (open: boolean) => void
  /** Bumped when a btw thread finishes seeding, so the superagent view refetches. */
  superRefreshKey: number
  /** Open (or re-open) a btw superagent thread seeded from a chat session's transcript. */
  startBtw: (sessionId: string) => Promise<void>
  /** Open the session's btw thread and ask the superagent for a concise tl;dr of
   *  the agent's last answer (passed in for context). */
  tldrSession: (sessionId: string, answerText: string) => Promise<void>
  selectedWorktree: string | null
  setSelectedWorktree: (path: string | null) => void
  paneA: string | null // sessionId in pane A
  paneB: string | null // sessionId in pane B (null = no split)
  setPane: (pane: 'A' | 'B', sessionId: string | null) => void
  /** Which split pane currently holds input focus — drives the `focused` field of
   *  the view-state the client reports so the server prioritizes that session's PTY
   *  relay. Only meaningful when `split` is on; clamps to 'A' otherwise. */
  focusedPane: 'A' | 'B'
  setFocusedPane: (pane: 'A' | 'B') => void
  /** Per-session chat-vs-native panel mode, persisted across reloads so a session
   *  returns to the view the user last left it in. A missing entry falls back to the
   *  per-device default; the hibernated/exited-forces-chat rule still wins over it. */
  panelMode: Record<string, 'chat' | 'native'>
  setPanelMode: (sessionId: string, mode: 'chat' | 'native') => void
  /** The EFFECTIVE rendered mode per session (native terminal vs chat) as each
   *  AgentPanel computes it — distinct from the saved `panelMode` override. Reported
   *  up the viewState channel so the server has the signal; not persisted. */
  setPanelRenderMode: (sessionId: string, mode: 'chat' | 'native') => void
  fileTabs: FileTab[]
  openFile: (sessionId: string, path: string) => void
  closeFileTab: (id: string) => void
  readFile: (
    sessionId: string,
    path: string,
  ) => Promise<Awaited<ReturnType<Trpc['files']['read']['query']>>>
  writeFile: (args: {
    sessionId: string
    path: string
    content: string
    baseHash?: string
  }) => Promise<Awaited<ReturnType<Trpc['files']['write']['mutate']>>>
  split: boolean
  toggleSplit: () => void
  /** Enrich the registered repos with branch/worktree metadata (fast — no
   *  filesystem walk). Discovery scanning happens explicitly via the scan flow. */
  refreshRepos: () => Promise<void>
  killSession: (sessionId: string) => Promise<void>
  /** Nudge an errored agent to retry ("continue⏎" into its PTY). */
  continueSession: (sessionId: string) => Promise<void>
  /** Session whose first manual Continue should raise the auto-continue popup,
   *  or null when the popup is closed. */
  autoContinuePromptSessionId: string | null
  closeAutoContinuePrompt: () => void
  renameSession: (sessionId: string, name: string) => Promise<void>
  hibernateSession: (sessionId: string) => Promise<void>
  resurrectSession: (sessionId: string) => Promise<void>
  /** Send a chat message to a parked (hibernated/exited) session, waking it
   *  first and delivering the text once it's ready. Falls back to a plain send
   *  when the session is already live. */
  resumeAndSend: (sessionId: string, text: string) => Promise<void>
  archiveSession: (sessionId: string, archived: boolean) => Promise<void>
  setWorkState: (sessionId: string, workState: WorkState | null) => Promise<void>
  /** Snooze a session out of the attention surface. `until` = null → until next
   *  message; ISO string → timed. Orthogonal to agent state. */
  setSnooze: (sessionId: string, until: string | null) => Promise<void>
  /** Un-snooze a session (return it to the normal attention flow). */
  clearSnooze: (sessionId: string) => Promise<void>
  /** Per-session chat composer draft, shared across every view of that session
   *  (chat panes, split view) and preserved across chat/native mode switches.
   *  The native PTY input line is opaque bytes we can't read back, so this is the
   *  one input state we *can* synchronize. */
  drafts: Record<string, string>
  setSessionDraft: (sessionId: string, text: string) => void
  /** Sidebar layout preferences (repo sort mode + custom order). */
  sidebarSettings: SidebarSettings
  /** Persist a new sidebar sort/order — optimistic update + server round-trip. */
  setSidebarSettings: (next: Partial<SidebarSettings>) => Promise<void>
  /** Server HTTP origin — used to build asset URLs (e.g. markdown images). */
  httpOrigin: string
}

export type MainView = 'home' | 'workspace' | 'settings' | 'usage' | 'issues'

const Ctx = createContext<Store | null>(null)

// Persist the "where am I" state so a reload (the PWA cold-starts often on
// mobile) lands back on the same surface. localStorage access is guarded — it
// throws in private-mode/SSR.
const VIEW_KEY = 'podium.view'
const WT_KEY = 'podium.selectedWorktree'
/** An open inline file-editor tab. `id` (`file:<sessionId>:<path>`) is what paneA/paneB
 *  hold when an editor tab is active; `worktreePath` (the session cwd) scopes it to a
 *  worktree's tab strip. */
export interface FileTab {
  id: string
  sessionId: string
  path: string
  worktreePath: string
}

const PANE_A_KEY = 'podium.paneA'
const PANE_B_KEY = 'podium.paneB'
const SPLIT_KEY = 'podium.split'
const SUPER_OPEN_KEY = 'podium.superOpen'
const PANEL_MODE_KEY = 'podium.panelMode'
function lsGet(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}
function lsSet(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, value)
  } catch {
    // storage unavailable — persistence is best-effort
  }
}
function readStoredView(): MainView {
  const v = lsGet(VIEW_KEY)
  // 'superagent' is no longer a full view (it's a dock now) — a returning user who
  // left on it lands on home instead of a dead surface.
  return v === 'home' || v === 'workspace' || v === 'settings' || v === 'usage' || v === 'issues'
    ? v
    : 'home'
}
/** The persisted per-session panel-mode map. A corrupt/missing blob reads as empty. */
function readStoredPanelModes(): Record<string, 'chat' | 'native'> {
  const raw = lsGet(PANEL_MODE_KEY)
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object') return {}
    const out: Record<string, 'chat' | 'native'> = {}
    for (const [id, m] of Object.entries(parsed as Record<string, unknown>)) {
      if (m === 'chat' || m === 'native') out[id] = m
    }
    return out
  } catch {
    return {}
  }
}

export function StoreProvider({
  config,
  onFatalError,
  children,
}: {
  config: ServerOrigin
  onFatalError: (message: string) => void
  children: ReactNode
}): JSX.Element {
  const hub = useMemo(
    () =>
      new SocketHub({
        url: config.wsClientUrl,
        viewport: { cols: 80, rows: 24, dpr: globalThis.devicePixelRatio ?? 1 },
        onError: (message) => onFatalError(message),
      }),
    [config.wsClientUrl, onFatalError],
  )
  const trpc = useMemo(() => makeTrpc(config.httpOrigin), [config.httpOrigin])

  const [repos, setRepos] = useState<GitRepositoryWire[]>([])
  const [reposLoading, setReposLoading] = useState(false)
  const [reposLoaded, setReposLoaded] = useState(false)
  const [repoDiagnostics, setRepoDiagnostics] = useState<GitDiscoveryDiagnosticWire[]>([])
  const [sessions, setSessions] = useState<SessionMeta[]>([])
  const [issues, setIssues] = useState<IssueWire[]>([])
  const [hostMetrics, setHostMetrics] = useState<HostMetricsWire[]>([])
  const [pins, setPins] = useState<PinState>(EMPTY_PINS)
  const [tabOrders, setTabOrders] = useState<Record<string, string[]>>({})
  const [view, setView] = useState<MainView>(readStoredView)
  const [settingsTab, setSettingsTab] = useState<string | null>(null)
  const [autoContinuePromptSessionId, setAutoContinuePromptSessionId] = useState<string | null>(
    null,
  )
  const [superThreadId, setSuperThreadId] = useState('global')
  const [superOpen, setSuperOpen] = useState(() => lsGet(SUPER_OPEN_KEY) === '1')
  const [superRefreshKey, setSuperRefreshKey] = useState(0)
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [sidebarSettings, setSidebarSettingsState] = useState<SidebarSettings>({
    repoSort: 'lastUsed',
    repoOrder: [],
  })
  const [selectedWorktree, setSelectedWorktree] = useState<string | null>(() => lsGet(WT_KEY))
  const [paneA, setPaneA] = useState<string | null>(() => lsGet(PANE_A_KEY))
  const [paneB, setPaneB] = useState<string | null>(() => lsGet(PANE_B_KEY))
  const [split, setSplit] = useState(() => lsGet(SPLIT_KEY) === '1')
  // Which pane has input focus. Not persisted — it resets to A on reload, which is
  // the right default (A is always the shown pane when split is off).
  const [focusedPane, setFocusedPane] = useState<'A' | 'B'>('A')
  const [panelMode, setPanelMode] =
    useState<Record<string, 'chat' | 'native'>>(readStoredPanelModes)
  // Effective rendered mode per session (what AgentPanel actually shows), reported up
  // the viewState channel. Not persisted — it's re-reported on mount from live state.
  const [panelRenderModes, setPanelRenderModes] = useState<Record<string, 'chat' | 'native'>>({})
  const [fileTabs, setFileTabs] = useState<FileTab[]>([])
  const started = useRef(false)
  // Latest reportViewState closure, so the once-mounted visibilitychange listener
  // always sees current pane/focus state without re-subscribing on every change.
  const reportViewStateRef = useRef<() => void>(() => {})

  const refreshRepos = useMemo(
    () => async () => {
      setReposLoading(true)
      try {
        const r = await trpc.discovery.refreshRepos.mutate()
        setRepos(r.repositories)
        setRepoDiagnostics(r.diagnostics)
      } finally {
        setReposLoading(false)
        setReposLoaded(true)
      }
    },
    [trpc],
  )
  const refreshPins = useMemo(
    () => async () => {
      setPins(await trpc.pins.list.query())
    },
    [trpc],
  )
  const setPinned = useMemo(
    () => async (kind: PinKind, id: string, pinned: boolean) => {
      setPins(await trpc.pins.set.mutate({ kind, id, pinned }))
    },
    [trpc],
  )
  const openFile = useMemo(
    () => (sessionId: string, path: string) => {
      const id = `file:${sessionId}:${path}`
      const worktreePath = sessions.find((s) => s.sessionId === sessionId)?.cwd ?? ''
      setFileTabs((tabs) =>
        tabs.some((t) => t.id === id) ? tabs : [...tabs, { id, sessionId, path, worktreePath }],
      )
      setPaneA(id)
    },
    [sessions],
  )
  const closeFileTab = useMemo(
    () => (id: string) => {
      setFileTabs((tabs) => tabs.filter((t) => t.id !== id))
      setPaneA((p) => (p === id ? null : p))
      setPaneB((p) => (p === id ? null : p))
    },
    [],
  )
  const readFile = useMemo(
    () => (sessionId: string, path: string) => trpc.files.read.query({ sessionId, path }),
    [trpc],
  )
  const writeFile = useMemo(
    () => (args: { sessionId: string; path: string; content: string; baseHash?: string }) =>
      trpc.files.write.mutate(args),
    [trpc],
  )
  const refreshTabOrders = useMemo(
    () => async () => {
      setTabOrders(await trpc.tabs.listOrders.query())
    },
    [trpc],
  )
  // Optimistic: dnd-kit hands back the new order on drop, and waiting on the
  // round-trip would make the tab snap back for a frame. Server result reconciles.
  const setTabOrder = useMemo(
    () => async (worktree: string, sessionIds: string[]) => {
      setTabOrders((orders) => ({ ...orders, [worktree]: sessionIds }))
      setTabOrders(await trpc.tabs.setOrder.mutate({ worktree, sessionIds }))
    },
    [trpc],
  )
  const killSession = useMemo(
    () => async (sessionId: string) => {
      await trpc.sessions.kill.mutate({ sessionId }).catch(() => {})
      setFileTabs((tabs) => tabs.filter((t) => t.sessionId !== sessionId))
      setPaneA((p) => (p === sessionId ? null : p))
      setPaneB((p) => (p === sessionId ? null : p))
      setPins((p) => ({ ...p, panels: p.panels.filter((id) => id !== sessionId) }))
      setTabOrders((orders) =>
        Object.fromEntries(
          Object.entries(orders).map(([wt, ids]) => [wt, ids.filter((id) => id !== sessionId)]),
        ),
      )
    },
    [trpc],
  )
  const continueSession = useMemo(
    () => async (sessionId: string) => {
      await trpc.sessions.continue.mutate({ sessionId }).catch(() => {})
      // After the manual nudge, offer to make it automatic — once, and only when
      // it isn't already on / hasn't already been answered.
      try {
        const settings = await trpc.settings.get.query()
        if (shouldPromptAutoContinue(settings)) setAutoContinuePromptSessionId(sessionId)
      } catch {
        // Non-fatal: the nudge already happened; just skip the offer.
      }
    },
    [trpc],
  )
  const closeAutoContinuePrompt = useMemo(
    () => () => setAutoContinuePromptSessionId(null),
    [],
  )
  const hibernateSession = useMemo(
    () => async (sessionId: string) => {
      await trpc.sessions.hibernate.mutate({ sessionId }).catch(() => {})
    },
    [trpc],
  )
  const resurrectSession = useMemo(
    () => async (sessionId: string) => {
      await trpc.sessions.resurrect.mutate({ sessionId }).catch(() => {})
    },
    [trpc],
  )
  const resumeAndSend = useMemo(
    () => async (sessionId: string, text: string) => {
      await trpc.sessions.resumeAndSend.mutate({ sessionId, text }).catch(() => {})
    },
    [trpc],
  )
  // Curation mutations are optimistic: the server broadcast reconciles, but
  // waiting on it makes renames/drags feel sticky.
  const renameSession = useMemo(
    () => async (sessionId: string, name: string) => {
      setSessions((all) =>
        all.map((s) => (s.sessionId === sessionId ? { ...s, name: name.trim() } : s)),
      )
      await trpc.sessions.rename.mutate({ sessionId, name }).catch(() => {})
    },
    [trpc],
  )
  const archiveSession = useMemo(
    () => async (sessionId: string, archived: boolean) => {
      // Archiving "files the work away": it also lands the session in the board's
      // Done lane. Unarchiving only restores it — it doesn't reopen the work state.
      const workState: WorkState | undefined = archived ? 'done' : undefined
      setSessions((all) =>
        all.map((s) =>
          s.sessionId === sessionId ? { ...s, archived, ...(archived ? { workState } : {}) } : s,
        ),
      )
      // Filing the work away also drops it from pinned panels — a pinned tab for an
      // archived session is dead weight, exactly as closing/killing it removes the
      // pin (mirrors killSession's local pin filter). Unlike kill, archiving doesn't
      // delete the row server-side, so the panel pin would otherwise survive in the
      // DB and resurrect on reload — clear it on the server too to make it stick.
      if (archived) {
        setPins((p) => ({ ...p, panels: p.panels.filter((id) => id !== sessionId) }))
        await trpc.pins.set.mutate({ kind: 'panel', id: sessionId, pinned: false }).catch(() => {})
      }
      await trpc.sessions.setArchived.mutate({ sessionId, archived }).catch(() => {})
      if (archived) {
        await trpc.sessions.setWorkState.mutate({ sessionId, workState: 'done' }).catch(() => {})
      }
    },
    [trpc],
  )
  const startBtw = useMemo(
    () => async (sessionId: string) => {
      // Open the superagent dock on the session's btw thread immediately; the
      // server seeds it (and runs the orientation turn) in the background.
      setSuperThreadId(`btw_${sessionId}`)
      setSuperOpen(true)
      await trpc.superagent.startBtw.mutate({ sessionId }).catch(() => {})
      // Seeding + the orientation turn are done now — nudge the view to refetch.
      setSuperRefreshKey((k) => k + 1)
    },
    [trpc],
  )
  const tldrSession = useMemo(
    () => async (sessionId: string, answerText: string) => {
      const threadId = `btw_${sessionId}`
      setSuperThreadId(threadId)
      setSuperOpen(true)
      // Ensure the thread is seeded with this session's context before we ask.
      await trpc.superagent.startBtw.mutate({ sessionId }).catch(() => {})
      const prompt = answerText.trim()
        ? `Give me a concise tl;dr (2–4 bullet points) of the agent's last answer below.\n\n---\n${answerText.trim().slice(0, 4000)}`
        : "Give me a concise tl;dr (2–4 bullet points) of the agent's last answer."
      await trpc.superagent.send.mutate({ threadId, text: prompt }).catch(() => {})
      setSuperRefreshKey((k) => k + 1)
    },
    [trpc],
  )
  const setSessionDraft = useMemo(
    () => (sessionId: string, text: string) => {
      setDrafts((d) => (d[sessionId] === text ? d : { ...d, [sessionId]: text }))
      hub.sendSessionDraft(sessionId, text)
    },
    [hub],
  )
  const setSidebarSettings = useMemo(
    () => async (next: Partial<SidebarSettings>) => {
      // Optimistic update so the UI reorders instantly.
      setSidebarSettingsState((s) => ({ ...s, ...next }))
      // Persist by loading the full settings blob, patching sidebar, and saving.
      try {
        const current = await trpc.settings.get.query()
        const updated = await trpc.settings.set.mutate({
          ...current,
          sidebar: { ...current.sidebar, ...next },
        })
        setSidebarSettingsState(updated.sidebar)
      } catch {
        // best-effort — the optimistic state already applied
      }
    },
    [trpc],
  )
  const setPanelModeCb = useMemo(
    () => (sessionId: string, mode: 'chat' | 'native') => {
      setPanelMode((m) => (m[sessionId] === mode ? m : { ...m, [sessionId]: mode }))
    },
    [],
  )
  const setPanelRenderModeCb = useMemo(
    () => (sessionId: string, mode: 'chat' | 'native') => {
      setPanelRenderModes((m) => (m[sessionId] === mode ? m : { ...m, [sessionId]: mode }))
    },
    [],
  )
  const setWorkState = useMemo(
    () => async (sessionId: string, workState: WorkState | null) => {
      setSessions((all) =>
        all.map((s) =>
          s.sessionId === sessionId ? { ...s, workState: workState ?? undefined } : s,
        ),
      )
      await trpc.sessions.setWorkState.mutate({ sessionId, workState }).catch(() => {})
    },
    [trpc],
  )
  const setSnooze = useMemo(
    () => async (sessionId: string, until: string | null) => {
      setSessions((all) =>
        all.map((s) => (s.sessionId === sessionId ? { ...s, snoozedUntil: until } : s)),
      )
      await trpc.snoozes.set.mutate({ sessionId, until }).catch(() => {})
    },
    [trpc],
  )
  const clearSnooze = useMemo(
    () => async (sessionId: string) => {
      setSessions((all) =>
        all.map((s) => (s.sessionId === sessionId ? { ...s, snoozedUntil: undefined } : s)),
      )
      await trpc.snoozes.clear.mutate({ sessionId }).catch(() => {})
    },
    [trpc],
  )

  // Report which sessions this client renders (`visible`) and which one has input
  // focus (`focused`) so the server can prioritize PTY relay for them. While the tab
  // is hidden we report nothing — a backgrounded client isn't watching anything.
  // `focusedPane` is clamped to A when split is off (B isn't shown).
  const reportViewState = useMemo(
    () => () => {
      const tabVisible = document.visibilityState === 'visible'
      const effectivePane: 'A' | 'B' = split ? focusedPane : 'A'
      const visible = tabVisible
        ? [paneA, split ? paneB : null].filter((x): x is string => x != null)
        : []
      const focused = tabVisible ? (effectivePane === 'A' ? paneA : paneB) : null
      // Rendered mode (native/chat) for each visible session — default 'native' until
      // its AgentPanel reports its effective mode. Wired through to the server; does
      // not affect output scheduling.
      const modes: Record<string, 'native' | 'chat'> = {}
      for (const sid of visible) modes[sid] = panelRenderModes[sid] ?? 'native'
      hub.setViewState(visible, focused, modes)
    },
    [hub, paneA, paneB, split, focusedPane, panelRenderModes],
  )
  // Re-derive + send on every change to the inputs, and keep the ref current so the
  // visibilitychange listener (registered once at mount) calls the latest closure.
  useEffect(() => {
    reportViewStateRef.current = reportViewState
    reportViewState()
  }, [reportViewState])

  useEffect(() => {
    // Wait for the first repo load — otherwise a persisted (restored) selection
    // would be wiped against the still-empty repo list before discovery resolves.
    if (!reposLoaded) return
    if (!selectedWorktree) {
      const worktrees = reposToViews(repos).flatMap((repo) => repo.worktrees)
      setSelectedWorktree(worktrees[0]?.path ?? null)
      return
    }
    const worktrees = reposToViews(repos).flatMap((repo) => repo.worktrees)
    // Keep an explicit selection alive when it's a registered worktree OR when a
    // session is actually running there — a superagent-/CLI-spawned session can
    // sit in a path the web's repo list doesn't know yet, and reverting it to
    // worktrees[0] made "Open" on that session show an unrelated one.
    const known = worktrees.some((w) => w.path === selectedWorktree)
    const hasSession = sessions.some((s) => s.cwd === selectedWorktree)
    if (known || hasSession) return
    setSelectedWorktree(worktrees[0]?.path ?? null)
  }, [repos, reposLoaded, selectedWorktree, sessions])

  // Persist the "where am I" state for next load.
  useEffect(() => lsSet(VIEW_KEY, view), [view])
  useEffect(() => lsSet(WT_KEY, selectedWorktree), [selectedWorktree])
  useEffect(() => lsSet(PANE_A_KEY, paneA), [paneA])
  useEffect(() => lsSet(PANE_B_KEY, paneB), [paneB])
  useEffect(() => lsSet(SPLIT_KEY, split ? '1' : '0'), [split])
  useEffect(() => lsSet(SUPER_OPEN_KEY, superOpen ? '1' : '0'), [superOpen])
  useEffect(() => lsSet(PANEL_MODE_KEY, JSON.stringify(panelMode)), [panelMode])

  useEffect(() => {
    // Collapse duplicate rows for the same underlying conversation (e.g. a Codex
    // thread surfaced twice on resume) before they reach any view.
    const offSessions = hub.onSessions((s) => setSessions(dedupeSessionsByResume(s)))
    const offIssues = hub.onIssues(setIssues)
    const offIssueUpd = hub.onIssueUpdated((u) =>
      setIssues((xs) => xs.map((i) => (i.id === u.id ? u : i))),
    )
    const offHostMetrics = hub.onHostMetrics(setHostMetrics)
    const offDraft = hub.onSessionDraft((sessionId, text) =>
      setDrafts((d) => (d[sessionId] === text ? d : { ...d, [sessionId]: text })),
    )
    // Attention → web notification, but only while this page can't be seen —
    // a visible Podium window IS the notification.
    const offAttention = hub.onAttention((e) => {
      if (document.visibilityState === 'visible') return
      if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return
      try {
        new Notification(e.title, { body: e.body, tag: e.sessionId })
      } catch {
        // some webviews throw on construction — never break the app over a toast
      }
    })
    // Presence feeds the server's smart router (skip mobile push while visible).
    // Re-report view-state too so hiding the tab clears it (and showing re-asserts).
    const reportVisibility = () => {
      hub.setVisible(document.visibilityState === 'visible')
      reportViewStateRef.current()
    }
    document.addEventListener('visibilitychange', reportVisibility)
    reportVisibility()
    const connectTimer = setTimeout(() => {
      try {
        hub.connect()
      } catch (e) {
        onFatalError(formatAppError(e, 'WebSocket connection failed'))
      }
    }, 0)
    if (!started.current) {
      started.current = true
      // Sidebar prefs load out of band so boot fans out only repos + pins + tab
      // orders (never gated on settings or a conversation scan).
      void trpc.settings.get
        .query()
        .then((s) => setSidebarSettingsState(s.sidebar))
        .catch(() => {})
      void Promise.all([refreshRepos(), refreshPins(), refreshTabOrders()]).catch((e) => {
        onFatalError(formatAppError(e, 'Could not load Podium data'))
      })
    }
    return () => {
      clearTimeout(connectTimer)
      offSessions()
      offIssues()
      offIssueUpd()
      offHostMetrics()
      offDraft()
      offAttention()
      document.removeEventListener('visibilitychange', reportVisibility)
      hub.dispose()
    }
  }, [hub, onFatalError, refreshPins, refreshRepos, refreshTabOrders])

  const value: Store = {
    hub,
    trpc,
    repos,
    reposLoading,
    reposLoaded,
    repoDiagnostics,
    sessions,
    issues,
    hostMetrics,
    pins,
    setPinned,
    tabOrders,
    setTabOrder,
    view,
    setView,
    settingsTab,
    setSettingsTab,
    superThreadId,
    setSuperThreadId,
    superOpen,
    setSuperOpen,
    superRefreshKey,
    startBtw,
    tldrSession,
    selectedWorktree,
    setSelectedWorktree,
    paneA,
    paneB,
    // Selecting a pane also focuses it — clicking/opening a pane is a reasonable
    // proxy for input focus, and the terminal components don't expose a focus seam.
    setPane: (pane, id) => {
      if (pane === 'A') setPaneA(id)
      else setPaneB(id)
      setFocusedPane(pane)
    },
    focusedPane,
    setFocusedPane,
    panelMode,
    setPanelMode: setPanelModeCb,
    setPanelRenderMode: setPanelRenderModeCb,
    split,
    toggleSplit: () => setSplit((s) => !s),
    refreshRepos,
    killSession,
    continueSession,
    autoContinuePromptSessionId,
    closeAutoContinuePrompt,
    hibernateSession,
    resurrectSession,
    resumeAndSend,
    renameSession,
    archiveSession,
    setWorkState,
    setSnooze,
    clearSnooze,
    drafts,
    setSessionDraft,
    sidebarSettings,
    setSidebarSettings,
    httpOrigin: config.httpOrigin,
    fileTabs,
    openFile,
    closeFileTab,
    readFile,
    writeFile,
  }
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useStore(): Store {
  const s = useContext(Ctx)
  if (!s) throw new Error('useStore outside StoreProvider')
  return s
}
