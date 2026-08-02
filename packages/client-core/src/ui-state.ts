/**
 * The client UI-state boundary: URL routing and every persisted view-state key
 * meet here. Device-local values use the principal-scoped Replica ui-state
 * cache; per-user values use the replicated layout port supplied by Actions.
 * No key has an implicit home.
 */

import {
  asArtifactId,
  asIssueId,
  asSessionId,
  DEVICE_LOCAL_UI_KEYS,
  isLayoutKey,
  layoutKeyFromLegacy,
  type IssueId,
  type SessionId,
  THEME_UI_KEYS,
} from '@podium/model'
import type { UiState } from './replica/contract'
import type { DockTab, RecentFileEntry } from './viewmodels'
import { readStoredDockTab } from './viewmodels'

export type UiStateHome = 'device-local' | 'per-user-replicated' | 'pre-auth-theme'

export const UI_STATE_KEYS = {
  view: 'podium.view',
  selectedWorktree: 'podium.selectedWorktree',
  selectedIssueId: 'podium.selectedIssueId',
  dockTab: 'podium.dockTab',
  paneA: 'podium.paneA',
  paneB: 'podium.paneB',
  split: 'podium.split',
  superOpen: 'podium.superOpen.v2',
  panelMode: 'podium.panelMode',
  dockShells: 'podium.dockShells',
  recentFiles: 'podium.recentFiles',
} as const

export const VIEW_KEY = UI_STATE_KEYS.view
export const WT_KEY = UI_STATE_KEYS.selectedWorktree
export const ISSUE_SEL_KEY = UI_STATE_KEYS.selectedIssueId
export const DOCK_TAB_KEY = UI_STATE_KEYS.dockTab
export const PANE_A_KEY = UI_STATE_KEYS.paneA
export const PANE_B_KEY = UI_STATE_KEYS.paneB
export const SPLIT_KEY = UI_STATE_KEYS.split
export const SUPER_OPEN_KEY = UI_STATE_KEYS.superOpen
export const PANEL_MODE_KEY = UI_STATE_KEYS.panelMode
export const DOCK_SHELLS_KEY = UI_STATE_KEYS.dockShells
export const RECENT_FILES_KEY = UI_STATE_KEYS.recentFiles

export type WorkspaceUiStateKey = (typeof UI_STATE_KEYS)[keyof typeof UI_STATE_KEYS]

export interface UiStateRoute {
  readonly home: UiStateHome
  readonly reason: string
}

/**
 * Total routing table for the workspace state owned by this module.
 *
 * Current selection and screen geometry are device-local. Superagent openness
 * and the per-session tab presentation are personal layout, so they travel with
 * the user. Dock-shell attachment stays local: it is a live attachment to a
 * machine/session that another device may not be able to use.
 */
export const UI_STATE_ROUTES = {
  [UI_STATE_KEYS.view]: {
    home: 'device-local',
    reason: 'Navigation is represented by this device history and URL.',
  },
  [UI_STATE_KEYS.selectedWorktree]: {
    home: 'device-local',
    reason: 'Current selection is device-local and mirrored into the URL.',
  },
  [UI_STATE_KEYS.selectedIssueId]: {
    home: 'device-local',
    reason: 'Current selection is device-local and mirrored into the URL.',
  },
  [UI_STATE_KEYS.dockTab]: {
    home: 'per-user-replicated',
    reason: 'Dock-tab selection is personal tab layout in the shared layout family.',
  },
  [UI_STATE_KEYS.paneA]: {
    home: 'device-local',
    reason: 'Pane selection is current navigation and is mirrored into the URL.',
  },
  [UI_STATE_KEYS.paneB]: {
    home: 'device-local',
    reason: 'The secondary pane is geometry for this screen.',
  },
  [UI_STATE_KEYS.split]: {
    home: 'device-local',
    reason: 'Split geometry is a property of this screen.',
  },
  [UI_STATE_KEYS.superOpen]: {
    home: 'per-user-replicated',
    reason: 'The personal superagent column is part of the user shell layout.',
  },
  [UI_STATE_KEYS.panelMode]: {
    home: 'per-user-replicated',
    reason: 'Per-session tab presentation is personal tab layout.',
  },
  [UI_STATE_KEYS.dockShells]: {
    home: 'device-local',
    reason: 'A dock shell is a live device attachment, not portable layout.',
  },
  [UI_STATE_KEYS.recentFiles]: {
    home: 'device-local',
    reason: 'Recent paths are device/machine reachability hints.',
  },
} as const satisfies Record<WorkspaceUiStateKey, UiStateRoute>

/** Client-only exact keys outside the model's shared local/replicated vocabulary.
 * Each is deliberately local: transient chrome, device capability/preferences,
 * screen geometry, or a cursor describing what this screen displayed. */
export const CLIENT_DEVICE_LOCAL_UI_KEYS = [
  'podium.chat.stickyPrompts',
  'podium.sounds.enabled',
  'podium.terminal.appearance',
  'podium:tray:open',
  'podium:superagent:chat',
  'podium:tray:height',
  'podium:superfeed:cursor',
  'podium:superagent:width',
  'podium:rightdock:width',
] as const

const DEVICE_LOCAL_SET: ReadonlySet<string> = new Set([
  ...DEVICE_LOCAL_UI_KEYS,
  ...CLIENT_DEVICE_LOCAL_UI_KEYS,
])
const THEME_SET: ReadonlySet<string> = new Set(THEME_UI_KEYS)

/** Default-closed classifier shared by all component and engine reads/writes. */
export function uiStateRoute(key: string): UiStateRoute {
  if (THEME_SET.has(key)) {
    return {
      home: 'pre-auth-theme',
      reason: 'Theme alone is read before a principal exists to prevent first-paint flash.',
    }
  }
  const layoutKey = layoutKeyFromLegacy(key)
  if (layoutKey !== null && isLayoutKey(layoutKey)) {
    return {
      home: 'per-user-replicated',
      reason: 'The shared per-user layout vocabulary classifies this key as replicated.',
    }
  }
  if (DEVICE_LOCAL_SET.has(key)) {
    return {
      home: 'device-local',
      reason: 'The shared/client local vocabulary classifies this key as device-local.',
    }
  }
  throw new Error(`Unclassified UI-state key: ${key}`)
}

export interface ReplicatedUiStatePort {
  get(key: string): unknown
  /** Actions owns command dispatch. This method must update its optimistic row
   * synchronously before returning, then enqueue through the Outbox. */
  set(key: string, value: unknown): void
  clear(key: string): void
  subscribe(cb: () => void): () => void
}

export interface RoutedUiState {
  get(key: string): string | null
  set(key: string, value: string | null): void
  hydrate(): Promise<void>
  subscribe(cb: () => void): () => void
}

function replicatedString(port: ReplicatedUiStatePort, key: string): string | null {
  const value = port.get(key)
  if (value === undefined || value === null) return null
  return typeof value === 'string' ? value : JSON.stringify(value)
}

/**
 * Route reads/writes and finish the one-shot legacy migration. Replica.uiState
 * has already folded raw legacy localStorage into the acting principal's local
 * collection. On the first read of a replicated key, move that value into the
 * optimistic replicated row and delete the local copy. A later principal sees
 * no raw key and therefore cannot consume the first principal's layout.
 */
export function createRoutedUiState(init: {
  local: UiState
  replicated: ReplicatedUiStatePort
}): RoutedUiState {
  const { local, replicated } = init
  const read = (key: string): string | null => {
    const route = uiStateRoute(key)
    if (route.home !== 'per-user-replicated') return local.get(key)
    const layoutKey = layoutKeyFromLegacy(key)
    if (layoutKey === null) throw new Error(`Replicated UI-state key has no layout key: ${key}`)
    const current = replicatedString(replicated, layoutKey)
    if (current !== null) {
      if (local.get(key) !== null) local.set(key, null)
      return current
    }
    const legacy = local.get(key)
    if (legacy === null) return null
    replicated.set(layoutKey, legacy)
    local.set(key, null)
    return legacy
  }
  return {
    get: read,
    set: (key, value) => {
      const route = uiStateRoute(key)
      if (route.home !== 'per-user-replicated') local.set(key, value)
      else {
        const layoutKey = layoutKeyFromLegacy(key)
        if (layoutKey === null) throw new Error(`Replicated UI-state key has no layout key: ${key}`)
        if (value === null) replicated.clear(layoutKey)
        else replicated.set(layoutKey, value)
        if (local.get(key) !== null) local.set(key, null)
      }
    },
    subscribe: (cb) => {
      const offLocal = local.subscribe(cb)
      const offReplicated = replicated.subscribe(cb)
      return () => {
        offLocal()
        offReplicated()
      }
    },
  }
}

export type MainView =
  | 'workspace'
  | 'settings'
  | 'usage'
  | 'issues'
  | 'automations'
  | 'specs'
  | 'workflows'

export interface RouteState {
  view: MainView
  issueId: string | null
  settingsTab: string | null
  worktree: string | null
  pane: string | null
}

export function routeDefaults(view: MainView): RouteState {
  return { view, issueId: null, settingsTab: null, worktree: null, pane: null }
}

const ROUTE_PARAMS = ['wt', 'pane'] as const

function decode(seg: string): string {
  try {
    return decodeURIComponent(seg)
  } catch {
    return seg
  }
}

export function parseRoute(pathname: string, search: string): RouteState | null {
  const params = new URLSearchParams(search)
  const segs = pathname.split('/').filter(Boolean).map(decode)
  const base: Omit<RouteState, 'view'> = {
    issueId: null,
    settingsTab: null,
    worktree: params.get('wt'),
    pane: params.get('pane'),
  }
  if (segs.length === 0) return { view: 'workspace', ...base }
  const [head, second, ...rest] = segs
  if (rest.length > 0) return null
  switch (head) {
    case 'workspace':
      return second === undefined ? { view: 'workspace', ...base } : null
    case 'issues':
      return { view: 'issues', ...base, issueId: second ?? null }
    case 'settings':
      return { view: 'settings', ...base, settingsTab: second ?? null }
    case 'usage':
    case 'automations':
    case 'specs':
    case 'workflows':
      return second === undefined ? { view: head, ...base } : null
    default:
      return null
  }
}

export function routePath(route: RouteState, currentSearch = ''): string {
  let path: string
  switch (route.view) {
    case 'workspace':
      path = '/workspace'
      break
    case 'issues':
      path = route.issueId ? `/issues/${encodeURIComponent(route.issueId)}` : '/issues'
      break
    case 'settings':
      path = route.settingsTab ? `/settings/${encodeURIComponent(route.settingsTab)}` : '/settings'
      break
    default:
      path = `/${route.view}`
  }
  const params = new URLSearchParams(currentSearch)
  for (const p of ROUTE_PARAMS) params.delete(p)
  if (route.view === 'workspace') {
    if (route.worktree) params.set('wt', route.worktree)
    if (route.pane) params.set('pane', route.pane)
  }
  const query = params.toString()
  return query ? `${path}?${query}` : path
}

export interface RouterWindow {
  location: { pathname: string; search: string }
  history: {
    pushState(data: unknown, unused: string, url?: string | null): void
    replaceState(data: unknown, unused: string, url?: string | null): void
  }
  addEventListener(type: 'popstate', cb: () => void): void
  removeEventListener(type: 'popstate', cb: () => void): void
}

export interface Router {
  current(): RouteState
  navigate(next: RouteState): void
  replace(next: RouteState): void
  subscribe(cb: (route: RouteState) => void): () => void
  attach(): void
  dispose(): void
}

export function createRouter(init: { win?: RouterWindow; fallbackView?: MainView } = {}): Router {
  const win = init.win ?? (window as unknown as RouterWindow)
  const listeners = new Set<(route: RouteState) => void>()
  const parsed = parseRoute(win.location.pathname, win.location.search)
  let route: RouteState
  if (parsed === null) {
    route = routeDefaults(init.fallbackView ?? 'workspace')
    win.history.replaceState(null, '', routePath(route, win.location.search))
  } else if (
    init.fallbackView &&
    init.fallbackView !== 'workspace' &&
    win.location.pathname.replace(/\/+$/, '') === ''
  ) {
    route = routeDefaults(init.fallbackView)
    win.history.replaceState(null, '', routePath(route, win.location.search))
  } else route = parsed

  const notify = (): void => {
    for (const cb of [...listeners]) cb(route)
  }
  const onPopState = (): void => {
    route = parseRoute(win.location.pathname, win.location.search) ?? routeDefaults('workspace')
    if (parseRoute(win.location.pathname, win.location.search) === null) {
      win.history.replaceState(null, '', routePath(route, win.location.search))
    }
    notify()
  }
  let attached = false
  const attach = (): void => {
    if (attached) return
    attached = true
    win.addEventListener('popstate', onPopState)
  }
  attach()
  const apply = (next: RouteState, mode: 'push' | 'replace'): void => {
    const nextUrl = routePath(next, win.location.search)
    if (nextUrl === `${win.location.pathname}${win.location.search}`) {
      route = next
      return
    }
    win.history[mode === 'push' ? 'pushState' : 'replaceState'](null, '', nextUrl)
    route = next
    notify()
  }
  return {
    current: () => route,
    navigate: (next) => apply(next, 'push'),
    replace: (next) => apply(next, 'replace'),
    subscribe: (cb) => {
      listeners.add(cb)
      return () => void listeners.delete(cb)
    },
    attach,
    dispose: () => {
      attached = false
      win.removeEventListener('popstate', onPopState)
      listeners.clear()
    },
  }
}

export function createMemoryRouterWindow(initialUrl = '/'): RouterWindow {
  const split = (url: string): { pathname: string; search: string } => {
    const q = url.indexOf('?')
    return q === -1
      ? { pathname: url, search: '' }
      : { pathname: url.slice(0, q), search: url.slice(q) }
  }
  let current = split(initialUrl)
  const set = (url?: string | null): void => {
    if (typeof url === 'string') current = split(url)
  }
  return {
    location: {
      get pathname() {
        return current.pathname
      },
      get search() {
        return current.search
      },
    },
    history: {
      pushState: (_data, _unused, url) => set(url),
      replaceState: (_data, _unused, url) => set(url),
    },
    addEventListener: () => {},
    removeEventListener: () => {},
  }
}

export interface WorkspaceUiSnapshot {
  view: MainView
  selectedWorktree: string | null
  selectedIssueId: IssueId | null
  dockTab: DockTab
  paneA: SessionId | null
  paneB: SessionId | null
  split: boolean
  superOpen: boolean
  panelMode: Record<string, 'chat' | 'native'>
  dockShells: Record<string, SessionId>
  recentFiles: RecentFileEntry[]
}

function parseRecord<T>(
  raw: string | null,
  accept: (value: unknown) => value is T,
): Record<string, T> {
  if (!raw) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return {}
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, T] => accept(entry[1])),
    )
  } catch {
    return {}
  }
}

export function readStoredView(ui: Pick<RoutedUiState, 'get'>): MainView {
  const value = ui.get(UI_STATE_KEYS.view)
  return value === 'workspace' ||
    value === 'settings' ||
    value === 'usage' ||
    value === 'issues' ||
    value === 'automations' ||
    value === 'specs' ||
    value === 'workflows'
    ? value
    : 'workspace'
}

export function readStoredDockShells(ui: Pick<RoutedUiState, 'get'>): Record<string, SessionId> {
  const rows = parseRecord(
    ui.get(UI_STATE_KEYS.dockShells),
    (v): v is string => typeof v === 'string' && v.length > 0,
  )
  return Object.fromEntries(
    Object.entries(rows).map(([worktree, id]) => [worktree, asSessionId(id)]),
  )
}

export function readStoredPanelModes(
  ui: Pick<RoutedUiState, 'get'>,
): Record<string, 'chat' | 'native'> {
  return parseRecord(
    ui.get(UI_STATE_KEYS.panelMode),
    (v): v is 'chat' | 'native' => v === 'chat' || v === 'native',
  )
}

export function readStoredRecentFiles(ui: Pick<RoutedUiState, 'get'>): RecentFileEntry[] {
  const raw = ui.get(UI_STATE_KEYS.recentFiles)
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.flatMap((value): RecentFileEntry[] => {
      if (!value || typeof value !== 'object') return []
      const row = value as Record<string, unknown>
      if (
        typeof row.path !== 'string' ||
        !row.path ||
        typeof row.worktreePath !== 'string' ||
        typeof row.openedAt !== 'number'
      )
        return []
      const artifact = row.artifact as Record<string, unknown> | undefined
      return [
        {
          path: row.path,
          worktreePath: row.worktreePath,
          openedAt: row.openedAt,
          ...(typeof row.machineId === 'string' ? { machineId: row.machineId } : {}),
          ...(artifact &&
          typeof artifact.issueId === 'string' &&
          typeof artifact.artifactId === 'string'
            ? {
                artifact: {
                  issueId: asIssueId(artifact.issueId),
                  artifactId: asArtifactId(artifact.artifactId),
                },
              }
            : {}),
        },
      ]
    })
  } catch {
    return []
  }
}

export interface RouterUiState {
  readonly router: Router
  readonly ui: RoutedUiState
  hydrate(): WorkspaceUiSnapshot
  flush(state: WorkspaceUiSnapshot, changed?: ReadonlySet<string>): void
  mirrorWorkspaceRoute(state: Pick<WorkspaceUiSnapshot, 'selectedWorktree' | 'paneA'>): void
}

const ALL_SNAPSHOT_KEYS = new Set<keyof WorkspaceUiSnapshot>([
  'view',
  'selectedWorktree',
  'selectedIssueId',
  'dockTab',
  'paneA',
  'paneB',
  'split',
  'superOpen',
  'panelMode',
  'dockShells',
  'recentFiles',
])

export function createRouterUiState(init: {
  local: UiState
  replicated: ReplicatedUiStatePort
  win?: RouterWindow
}): RouterUiState {
  const ui = createRoutedUiState(init)
  const router = createRouter({ fallbackView: readStoredView(ui), win: init.win })
  return {
    router,
    ui,
    hydrate: () => {
      const route = router.current()
      return {
        view: route.view,
        selectedWorktree: route.worktree ?? ui.get(UI_STATE_KEYS.selectedWorktree),
        selectedIssueId: ui.get(UI_STATE_KEYS.selectedIssueId)
          ? asIssueId(ui.get(UI_STATE_KEYS.selectedIssueId) as string)
          : null,
        dockTab: readStoredDockTab(ui.get(UI_STATE_KEYS.dockTab)),
        paneA: route.pane
          ? asSessionId(route.pane)
          : ui.get(UI_STATE_KEYS.paneA)
            ? asSessionId(ui.get(UI_STATE_KEYS.paneA) as string)
            : null,
        paneB: ui.get(UI_STATE_KEYS.paneB)
          ? asSessionId(ui.get(UI_STATE_KEYS.paneB) as string)
          : null,
        split: ui.get(UI_STATE_KEYS.split) === '1',
        superOpen: ui.get(UI_STATE_KEYS.superOpen) !== '0',
        panelMode: readStoredPanelModes(ui),
        dockShells: readStoredDockShells(ui),
        recentFiles: readStoredRecentFiles(ui),
      }
    },
    flush: (state, changed = ALL_SNAPSHOT_KEYS) => {
      const write = (
        field: keyof WorkspaceUiSnapshot,
        key: WorkspaceUiStateKey,
        value: string | null,
      ): void => {
        if (changed.has(field)) ui.set(key, value)
      }
      write('view', UI_STATE_KEYS.view, state.view)
      write('selectedWorktree', UI_STATE_KEYS.selectedWorktree, state.selectedWorktree)
      write('selectedIssueId', UI_STATE_KEYS.selectedIssueId, state.selectedIssueId)
      write('dockTab', UI_STATE_KEYS.dockTab, state.dockTab)
      write('paneA', UI_STATE_KEYS.paneA, state.paneA)
      write('paneB', UI_STATE_KEYS.paneB, state.paneB)
      write('split', UI_STATE_KEYS.split, state.split ? '1' : '0')
      write('superOpen', UI_STATE_KEYS.superOpen, state.superOpen ? '1' : '0')
      write('panelMode', UI_STATE_KEYS.panelMode, JSON.stringify(state.panelMode))
      write('dockShells', UI_STATE_KEYS.dockShells, JSON.stringify(state.dockShells))
      write('recentFiles', UI_STATE_KEYS.recentFiles, JSON.stringify(state.recentFiles))
    },
    mirrorWorkspaceRoute: (state) => {
      const route = router.current()
      if (route.view !== 'workspace') return
      if (route.worktree === state.selectedWorktree && route.pane === state.paneA) return
      router.replace({ ...route, worktree: state.selectedWorktree, pane: state.paneA })
    },
  }
}
