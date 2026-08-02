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
  type IssueId,
  isLayoutKey,
  layoutKeyFromLegacy,
  type SessionId,
  THEME_UI_KEYS,
} from '@podium/model'
import type { UiState } from './replica/contract'
import type { DockTab, RecentFileEntry } from './viewmodels'
import { readStoredDockTab } from './viewmodels'

export type { UiState }

export type UiStateHome =
  | 'device-local'
  | 'per-user-replicated'
  /**
   * Per-user state that follows the person but is NOT a `user_layout` key/value
   * row: it has its own family, its own table and its own command, because its
   * arbitration rule is not last-writer-wins (POD-1380's read cursor is
   * monotonic). The distinction is load-bearing rather than cosmetic —
   * `per-user-replicated` means "goes through the layout port", and routing a
   * monotonic cursor through an LWW port is how a cursor moves backward.
   *
   * A key with this home is NOT stored in the ui-state collection at all, and
   * {@link createRoutedUiState} REFUSES it rather than falling back to local:
   * silently writing it to this device is the exact bug the routing table exists
   * to prevent.
   */
  | 'per-user-command'
  | 'pre-auth-theme'
  | 'known-unrouted'

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
  panelModeDefault: 'podium.panelModeDefault',
  dockShells: 'podium.dockShells',
  recentFiles: 'podium.recentFiles',
  /** Right-dock tab when the dock is a separate surface (`issue` | `git` | …). */
  rightPanel: 'podium.rightPanel',
  /** HTML file tab presentation map (tabId → mode). */
  htmlmode: 'podium.htmlmode',
  /** Markdown file tab presentation map (tabId → mode). */
  mdmode: 'podium.mdmode',
  /** Issues list layout/ordering preferences. */
  issuesDisplay: 'podium.issues.display',
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
export const PANEL_MODE_DEFAULT_KEY = UI_STATE_KEYS.panelModeDefault
export const DOCK_SHELLS_KEY = UI_STATE_KEYS.dockShells
export const RECENT_FILES_KEY = UI_STATE_KEYS.recentFiles
export const RIGHT_PANEL_KEY = UI_STATE_KEYS.rightPanel
export const HTML_MODE_MAP_KEY = UI_STATE_KEYS.htmlmode
export const MD_MODE_MAP_KEY = UI_STATE_KEYS.mdmode
export const ISSUES_DISPLAY_KEY = UI_STATE_KEYS.issuesDisplay

/** Prefix for per-dock-section open state (`podium.dock.section.<name>`). */
export const DOCK_SECTION_KEY_PREFIX = 'podium.dock.section.'

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
    // Decision coordinated with POD-1076 / layout-state: sidebar and tab LAYOUT
    // are per-user (doc §3.1.1). Per-session chat-vs-native presentation is that
    // family, not screen geometry — it should follow the person across devices.
    reason:
      'Per-session chat/native presentation is personal tab layout (POD-1076 layout family).',
  },
  [UI_STATE_KEYS.panelModeDefault]: {
    home: 'per-user-replicated',
    reason: 'The default tab presentation is a personal preference (POD-1076).',
  },
  [UI_STATE_KEYS.dockShells]: {
    home: 'device-local',
    reason: 'A dock shell is a live device attachment, not portable layout.',
  },
  [UI_STATE_KEYS.recentFiles]: {
    home: 'device-local',
    reason: 'Recent paths are device/machine reachability hints.',
  },
  [UI_STATE_KEYS.rightPanel]: {
    home: 'per-user-replicated',
    reason: 'Right-panel tab selection is personal dock layout.',
  },
  [UI_STATE_KEYS.htmlmode]: {
    home: 'per-user-replicated',
    reason: 'HTML file presentation modes are personal file-tab layout.',
  },
  [UI_STATE_KEYS.mdmode]: {
    home: 'per-user-replicated',
    reason: 'Markdown file presentation modes are personal file-tab layout.',
  },
  [UI_STATE_KEYS.issuesDisplay]: {
    home: 'per-user-replicated',
    reason: 'Issues list display options are a personal preference.',
  },
} as const satisfies Record<WorkspaceUiStateKey, UiStateRoute>

/** Client-only exact keys outside the model's shared local/replicated vocabulary.
 * Each is deliberately local: transient chrome, device capability/preferences,
 * screen geometry, or a cursor describing what this screen displayed. */
export const CLIENT_DEVICE_LOCAL_UI_KEYS = [
  'podium.chat.stickyPrompts',
  'podium.sounds.enabled',
  'podium.sounds.ownerWindow',
  'podium.terminal.appearance',
  'podium:tray:open',
  'podium:superagent:chat',
  'podium:tray:height',
  'podium:superagent:width',
  'podium:rightdock:width',
  /** Dev diagnostics: remote-typing echo HUD. */
  'podium.echoHud',
  /** Dev diagnostics: switch-latency console trace. */
  'podium.switchTrace',
] as const

export const STICKY_PROMPTS_KEY = 'podium.chat.stickyPrompts'
export const SOUNDS_ENABLED_KEY = 'podium.sounds.enabled'
export const SOUND_OWNER_KEY = 'podium.sounds.ownerWindow'
export const TERMINAL_APPEARANCE_KEY = 'podium.terminal.appearance'
export const ECHO_HUD_KEY = 'podium.echoHud'
export const SWITCH_TRACE_KEY = 'podium.switchTrace'
/** Superagent column mode (open | folded) — replicated via layout-state. */
export const SUPERAGENT_MODE_KEY = 'podium:superagent:mode'
export const SIDEBAR_COLLAPSED_KEY = 'podium:sidebar:collapsed'

/**
 * Keys that are not UI view-state but must still appear in the routing table so
 * an unclassified persistence home cannot default silently to local.
 * Homes are explicit; none are written by feature code outside the named owner.
 */
/** sessionStorage-only PWA wire-version reload guard (not ui-state collection). */
export const WIRE_RELOAD_COUNTER_KEY = 'podium.vreload'
/** Legacy pre-replica outbox blob key — replica migrates it once. */
export const LEGACY_OUTBOX_LS_KEY = 'podium.outbox.v1'

/**
 * The issue-event feed's read position. POD-403 recorded it `known-unrouted`
 * against POD-1380; POD-1380 gave it a home, and it is NOT this module's.
 *
 * It is per-user state (`docs/multi-user-readiness.md` §3.3 — read state follows
 * the person), stored in `user_read_position` and written by `readPosition.advance`.
 * It stays in this table because the table is a TOTALITY over every key this
 * module has ever persisted: deleting the row would make a key that once lived
 * here indistinguishable from one that never did.
 */
export const READ_POSITION_UI_KEY = 'podium:superfeed:cursor'

export const KNOWN_NON_UI_ROUTES = {
  [READ_POSITION_UI_KEY]: {
    home: 'per-user-command' as const,
    reason:
      'The issue-event read position is per-user state with its own family and command ' +
      '(readPosition.advance, POD-1380). Monotonic, so it cannot ride the last-writer-wins layout ' +
      'port; not device-local, because read state follows the person (readiness §3.3).',
  },
  /** sessionStorage-only PWA wire-version reload guard; deliberately pre-store. */
  [WIRE_RELOAD_COUNTER_KEY]: {
    home: 'known-unrouted' as const,
    reason:
      'sessionStorage loop guard for wire-version hard-reload; must work before the store exists.',
  },
  /** Legacy pre-replica outbox blob key — replica migrates it once. */
  [LEGACY_OUTBOX_LS_KEY]: {
    home: 'known-unrouted' as const,
    reason: 'Replica outbox adapter owns this legacy key and the versioned collection.',
  },
} as const

const DEVICE_LOCAL_SET: ReadonlySet<string> = new Set([
  ...DEVICE_LOCAL_UI_KEYS,
  ...CLIENT_DEVICE_LOCAL_UI_KEYS,
])
const THEME_SET: ReadonlySet<string> = new Set(THEME_UI_KEYS)

export type PreAuthThemeKey = (typeof THEME_UI_KEYS)[number]

/** Raw, unnamespaced storage is permitted only for these two named theme keys.
 * ThemeProvider runs before a principal-bound replica exists. */
export function readPreAuthTheme(key: PreAuthThemeKey): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null
  } catch {
    return null
  }
}

export function writePreAuthTheme(key: PreAuthThemeKey, value: string): void {
  try {
    globalThis.localStorage?.setItem(key, value)
  } catch {
    // Best effort: private browsing may reject storage.
  }
}

/** Default-closed classifier shared by all component and engine reads/writes. */
export function uiStateRoute(key: string): UiStateRoute {
  if (THEME_SET.has(key)) {
    return {
      home: 'pre-auth-theme',
      reason: 'Theme alone is read before a principal exists to prevent first-paint flash.',
    }
  }
  const knownNonUi = KNOWN_NON_UI_ROUTES[key as keyof typeof KNOWN_NON_UI_ROUTES]
  if (knownNonUi) return knownNonUi
  // Dynamic dock-section keys (podium.dock.section.<name>).
  if (key.startsWith(DOCK_SECTION_KEY_PREFIX) && key.length > DOCK_SECTION_KEY_PREFIX.length) {
    return {
      home: 'per-user-replicated',
      reason: 'Dock section open state is personal layout under the shared prefix vocabulary.',
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

// ---------------------------------------------------------------------------
// Panel mode — ONE modeled derivation (saved map + defaults → effective mode)
// ---------------------------------------------------------------------------

export type PanelMode = 'native' | 'chat'

/**
 * Derive the effective chat-vs-native mode for a session.
 *
 * This is the sole derivation for panel presentation. The store holds the
 * persisted per-session map; callers materialize the derived value into that
 * map on first open so subsequent reads are pure map lookups.
 *
 * Priority:
 * 1. Non-chat-capable sessions always show native.
 * 2. Persisted per-session override (when present).
 * 3. Personal default pick (panelModeDefault).
 * 4. The `startScreen` setting (`native` | `chat` | `auto`→mobile heuristic).
 */
export function effectivePanelMode(input: {
  startScreen: 'native' | 'chat' | 'auto'
  chatCapable: boolean
  isMobile: boolean
  /** Persisted per-session mode when known. */
  saved?: PanelMode | null
  /** Personal default (PANEL_MODE_DEFAULT_KEY). */
  deviceDefault?: string | null
}): PanelMode {
  if (!input.chatCapable) return 'native'
  if (input.saved === 'native' || input.saved === 'chat') return input.saved
  if (input.deviceDefault === 'native' || input.deviceDefault === 'chat') return input.deviceDefault
  if (input.startScreen === 'auto') return input.isMobile ? 'chat' : 'native'
  if (input.startScreen === 'chat') return 'chat'
  return 'native'
}

/** @deprecated Prefer {@link effectivePanelMode} — same function, old name. */
export const initialPanelMode = effectivePanelMode

// ---------------------------------------------------------------------------
// File panel modes (HTML / Markdown Preview|Source|Split) — one map per family
// ---------------------------------------------------------------------------

export type FilePanelMode = 'preview' | 'source' | 'split'

/** Keep the map from growing without bound: oldest-written entries drop first. */
export const FILE_MODE_MAP_CAP = 200

function readFileModeMap(ui: Pick<UiState, 'get'>, mapKey: string): Record<string, string> {
  const raw = ui.get(mapKey)
  if (!raw) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : {}
  } catch {
    return {}
  }
}

/** The saved mode for one file tab, or null when never picked / corrupt. */
export function readFilePanelMode(
  ui: Pick<UiState, 'get'>,
  mapKey: string,
  id: string,
): FilePanelMode | null {
  const v = readFileModeMap(ui, mapKey)[id]
  return v === 'preview' || v === 'source' || v === 'split' ? v : null
}

/** Persist one file tab's mode into the family map (bounded, insertion-ordered). */
export function writeFilePanelMode(
  ui: Pick<UiState, 'get' | 'set'>,
  mapKey: string,
  id: string,
  mode: FilePanelMode,
): void {
  // Route-check: refuse undeclared map keys (totality).
  uiStateRoute(mapKey)
  const map = readFileModeMap(ui, mapKey)
  if (map[id] === mode) return
  delete map[id]
  map[id] = mode
  const keys = Object.keys(map)
  for (const stale of keys.slice(0, Math.max(0, keys.length - FILE_MODE_MAP_CAP))) {
    delete map[stale]
  }
  ui.set(mapKey, JSON.stringify(map))
}

/** Debug / diagnostics flag stored in the principal-scoped ui-state collection. */
export function debugFlagEnabled(ui: Pick<UiState, 'get'>, key: string): boolean {
  uiStateRoute(key)
  return ui.get(key) === '1'
}

export interface ReplicatedUiStatePort {
  get(key: string): unknown
  /** Actions owns command dispatch. This method must update its optimistic row
   * synchronously before returning, then enqueue through the Outbox. */
  set(key: string, value: unknown): void
  clear(key: string): void
  hydrate(): Promise<void>
  subscribe(cb: () => void): () => void
}

export interface RoutedUiState {
  get(key: string): string | null
  set(key: string, value: string | null): void
  subscribe(cb: () => void): () => void
}

function replicatedString(port: ReplicatedUiStatePort, key: string): string | null {
  const value = port.get(key)
  if (value === undefined || value === null) return null
  return typeof value === 'string' ? value : JSON.stringify(value)
}

/** Fail closed: a replicated route without a canonical family key is a routing-table defect. */
export function requireReplicatedLayoutKey(key: string): string {
  const layoutKey = layoutKeyFromLegacy(key)
  if (layoutKey === null) throw new Error(`Replicated UI-state key has no layout key: ${key}`)
  return layoutKey
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
  const refuseCommandHome = (key: string, route: UiStateRoute): void => {
    if (route.home !== 'per-user-command') return
    throw new Error(
      `'${key}' is per-user state owned by its own command family, not the ui-state store — ` +
        'reading or writing it here would give this device a private copy of a value that ' +
        'follows the user (POD-1380)',
    )
  }
  const read = (key: string): string | null => {
    const route = uiStateRoute(key)
    refuseCommandHome(key, route)
    if (route.home !== 'per-user-replicated') return local.get(key)
    const layoutKey = requireReplicatedLayoutKey(key)
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
      refuseCommandHome(key, route)
      if (route.home !== 'per-user-replicated') local.set(key, value)
      else {
        const layoutKey = requireReplicatedLayoutKey(key)
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

export function createUiStateRouter(local: UiState, win?: RouterWindow): Router {
  return createRouter({ fallbackView: readStoredView(local), win })
}

export function createRouterUiState(init: {
  local: UiState
  replicated: ReplicatedUiStatePort
  win?: RouterWindow
  router?: Router
}): RouterUiState {
  const ui = createRoutedUiState(init)
  const router = init.router ?? createUiStateRouter(init.local, init.win)
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
