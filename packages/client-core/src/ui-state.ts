/**
 * The client UI-state boundary: URL routing and every persisted view-state key
 * meet here. Device-local values use the principal-scoped Replica ui-state
 * cache; per-user values use the replicated layout port supplied by Actions.
 * No key has an implicit home.
 */

import {
  asArtifactId,
  asIssueId,
  asMachineId,
  asSessionId,
  DEVICE_LOCAL_UI_KEYS,
  type IssueId,
  isLayoutKey,
  layoutKeyFromLegacy,
  type SessionId,
  THEME_UI_KEYS,
} from '@podium/model'
import type { UiState } from './replica/contract'
import type { DockTab, FileScope, FileTab, RecentFileEntry, WorkspaceMap } from './viewmodels'
import { deserializeWorkspaces, readStoredDockTab, serializeWorkspaces } from './viewmodels'

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
  /** Editor-style tab workspaces, one entry per task (POD-710). */
  workspaces: 'podium.workspaces',
  /** The open file tabs the layouts above hold ids for (POD-1247). */
  fileTabs: 'podium.fileTabs',
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
  /** JSON file tab presentation map (tabId → mode). */
  jsonmode: 'podium.jsonmode',
  /** Issues list layout/ordering preferences. */
  issuesDisplay: 'podium.issues.display',
  /** Guided VPS onboarding lane; replicated so it survives the server-origin transfer. */
  onboardingVps: 'podium.onboarding.vps',
  /** The mobile-handoff promo card, dismissed for good (POD-1320). */
  mobilePromoDismissed: 'podium.mobile.promoDismissed',
} as const

export const VIEW_KEY = UI_STATE_KEYS.view
export const WT_KEY = UI_STATE_KEYS.selectedWorktree
export const ISSUE_SEL_KEY = UI_STATE_KEYS.selectedIssueId
export const DOCK_TAB_KEY = UI_STATE_KEYS.dockTab
export const PANE_A_KEY = UI_STATE_KEYS.paneA
export const PANE_B_KEY = UI_STATE_KEYS.paneB
export const SPLIT_KEY = UI_STATE_KEYS.split
export const WORKSPACES_KEY = UI_STATE_KEYS.workspaces
export const FILE_TABS_KEY = UI_STATE_KEYS.fileTabs
export const SUPER_OPEN_KEY = UI_STATE_KEYS.superOpen
export const PANEL_MODE_KEY = UI_STATE_KEYS.panelMode
export const PANEL_MODE_DEFAULT_KEY = UI_STATE_KEYS.panelModeDefault
export const DOCK_SHELLS_KEY = UI_STATE_KEYS.dockShells
export const RECENT_FILES_KEY = UI_STATE_KEYS.recentFiles
export const RIGHT_PANEL_KEY = UI_STATE_KEYS.rightPanel
export const HTML_MODE_MAP_KEY = UI_STATE_KEYS.htmlmode
export const MD_MODE_MAP_KEY = UI_STATE_KEYS.mdmode
export const JSON_MODE_MAP_KEY = UI_STATE_KEYS.jsonmode
export const ISSUES_DISPLAY_KEY = UI_STATE_KEYS.issuesDisplay
export const ONBOARDING_VPS_KEY = UI_STATE_KEYS.onboardingVps
export const MOBILE_PROMO_DISMISSED_KEY = UI_STATE_KEYS.mobilePromoDismissed
export const ONBOARDING_VPS_SERVER_DRAFT_KEY = 'podium.onboarding.vpsServerDraft'

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
  [UI_STATE_KEYS.workspaces]: {
    home: 'device-local',
    // Same reason as paneA/paneB/split, which are now derived FROM this: which
    // tabs are open in which pane is screen geometry, and a phone has no
    // business inheriting a desktop's split. The whole layout travels with the
    // scalars it replaced (POD-710).
    reason: 'Workspace tab layout is geometry for this screen, like the panes it supersedes.',
  },
  [UI_STATE_KEYS.fileTabs]: {
    home: 'device-local',
    // Travels with the layout that names it (POD-1247): a workspace holds tab
    // IDS, and this is what those ids resolve to. Splitting the two homes would
    // let a phone restore a strip full of file tabs whose buffers it never had.
    // The paths are also this device's reachability, exactly like recent files.
    reason: 'Open file buffers are the other half of this screen\u2019s tab layout.',
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
    reason: 'Per-session chat/native presentation is personal tab layout (POD-1076 layout family).',
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
  [UI_STATE_KEYS.jsonmode]: {
    home: 'per-user-replicated',
    reason: 'JSON file presentation modes are personal file-tab layout.',
  },
  [UI_STATE_KEYS.issuesDisplay]: {
    home: 'per-user-replicated',
    reason: 'Issues list display options are a personal preference.',
  },
  [UI_STATE_KEYS.onboardingVps]: {
    home: 'per-user-replicated',
    reason: 'First-run VPS progress must survive restart and the server-origin transfer.',
  },
  [UI_STATE_KEYS.mobilePromoDismissed]: {
    home: 'per-user-replicated',
    // "No thanks" is an answer about the PERSON, not about this browser: asking
    // again on the laptop after it was turned down on the desktop is the same
    // pitch a second time, which is what "dismissible forever" rules out.
    reason: 'Declining the phone pitch is a personal decision that must follow the user.',
  },
} as const satisfies Record<WorkspaceUiStateKey, UiStateRoute>

/** Client-only exact keys outside the model's shared local/replicated vocabulary.
 * Each is deliberately local: transient chrome, device capability/preferences,
 * screen geometry, or a cursor describing what this screen displayed. */
export const CLIENT_DEVICE_LOCAL_UI_KEYS = [
  'podium.chat.stickyPrompts',
  /** How much of a transcript the chat feed renders (POD-376) — a reading
   *  preference belonging to the screen you read on, not to the session. */
  'podium.chat.verbosity',
  /** Whether the diff sheet wraps long lines — the same species as chat
   *  verbosity: how wide the screen you are reading on is, not a property of
   *  the diff. A phone has no business inheriting a monitor's answer. */
  'podium:diff-sheet:wrap',
  'podium.sounds.enabled',
  'podium.sounds.ownerWindow',
  'podium.terminal.appearance',
  /** Desktop shell spacing — a preference for this screen/device. */
  'podium.shell.density',
  /* `podium:tray:open`, `podium:tray:height` and `podium:superagent:chat` lived
     here until POD-516. They were the web Tray's section state and the
     tray/chat split; the Superagent pane is one surface now, with no sections
     to collapse and no split to remember. Stale rows on old devices are inert —
     nothing reads these keys. */
  'podium:superagent:width',
  'podium:rightdock:width',
  /**
   * THE PHONE LAUNCH SHEET'S LAST PICKS (POD-1354) — model, effort, machine and
   * project.
   *
   * Remembering them is what stops the sheet resetting to Auto on every app
   * start, which made the operator who always runs one model re-choose it every
   * single launch. DEVICE-LOCAL rather than replicated, deliberately: this is
   * the default the NEXT tap on this device should take, and what you reach for
   * in thirty seconds on a phone is routinely not what you reach for at the
   * desk. It changes nothing about any issue or session — a launch still sends
   * whatever the sheet shows at the moment Start is pressed.
   */
  'podium.newWork.model',
  'podium.newWork.effort',
  'podium.newWork.machine',
  'podium.newWork.repo',
  /** Flight Deck view (`full` | `active` | `needs-you`) and the set of folded
   *  branches. The artifact's ledger classes both as DISPLAY PREFERENCE for this
   *  screen: they change what column 2 shows and never touch issue stage or
   *  agent state, and a phone has no business inheriting a desktop's folds. */
  'podium.flightDeck.mode',
  'podium.flightDeck.folds',
  /** Editor-style tab workspaces (POD-710). Declared here rather than in the
   *  model's shared vocabulary because it is a client-only key; the routing
   *  table above states its home and this list is what `uiStateRoute` reads. */
  'podium.workspaces',
  /** The open file buffers those workspaces name (POD-1247). Client-only, and
   *  device-local for the same reason the layout holding its ids is. */
  'podium.fileTabs',
  /**
   * This device's unsent composer drafts (POD-2045).
   *
   * DEVICE-LOCAL is the load-bearing choice, not a default. The draft's shared
   * copy already travels — the server holds a versioned document per session and
   * fans it out to your other devices. What this key stores is the half the
   * server cannot vouch for: text typed while it was unreachable, which exists
   * NOWHERE else until the socket comes back. Replicating it would mean sending
   * the very thing that could not be sent, and reading someone's phone's
   * half-written sentence over their laptop's would reintroduce, from storage,
   * the clobber the ledger exists to prevent.
   */
  'podium.drafts.v1',
  /** Dev diagnostics: remote-typing echo HUD. */
  'podium.echoHud',
  /** Dev diagnostics: switch-latency console trace. */
  'podium.switchTrace',
  /** In-progress GitHub repository search and clone destination for first-run recovery. */
  'podium.githubProjectIntake.draft',
  /** In-progress local repository discovery during first-run activation. */
  'podium.localProjectIntake.draft',
  /** Device-topology drafts for connecting this desktop to an existing Podium. */
  'podium.existingPodium.clientDraft',
  'podium.existingPodium.machineDraft',
  /** URL printed by a new VPS while this desktop is connecting to it for the first time. */
  'podium.onboarding.vpsServerDraft',
  /** Project, agent, model, effort, and prompt for first-task activation. */
  'podium.firstTaskActivation.draft',
  /**
   * Set while first-run setup is underway, cleared when it is finished.
   *
   * DEVICE-LOCAL for the same reason the intake drafts above are: this is the
   * progress of a wizard being driven on THIS screen, and a phone has no
   * business being dragged back into setup because a laptop is halfway through
   * it. The one piece of first-run state that must survive moving between
   * origins — the VPS lane — is replicated instead (`podium.onboarding.vps`).
   */
  'podium.onboarding.active',
] as const

/** The phone launch sheet's remembered picks — see CLIENT_DEVICE_LOCAL_UI_KEYS. */
export const NEW_WORK_MODEL_KEY = 'podium.newWork.model'
export const NEW_WORK_EFFORT_KEY = 'podium.newWork.effort'
export const NEW_WORK_MACHINE_KEY = 'podium.newWork.machine'
export const NEW_WORK_REPO_KEY = 'podium.newWork.repo'
export const FLIGHT_DECK_MODE_KEY = 'podium.flightDeck.mode'
export const FLIGHT_DECK_FOLDS_KEY = 'podium.flightDeck.folds'
export const STICKY_PROMPTS_KEY = 'podium.chat.stickyPrompts'
export const CHAT_VERBOSITY_KEY = 'podium.chat.verbosity'
export const DIFF_SHEET_WRAP_KEY = 'podium:diff-sheet:wrap'
export const SOUNDS_ENABLED_KEY = 'podium.sounds.enabled'
export const SOUND_OWNER_KEY = 'podium.sounds.ownerWindow'
export const TERMINAL_APPEARANCE_KEY = 'podium.terminal.appearance'
export const SHELL_DENSITY_KEY = 'podium.shell.density'
export const ECHO_HUD_KEY = 'podium.echoHud'
export const SWITCH_TRACE_KEY = 'podium.switchTrace'
export const GITHUB_PROJECT_INTAKE_DRAFT_KEY = 'podium.githubProjectIntake.draft'
export const LOCAL_PROJECT_INTAKE_DRAFT_KEY = 'podium.localProjectIntake.draft'
export const EXISTING_PODIUM_CLIENT_DRAFT_KEY = 'podium.existingPodium.clientDraft'
export const EXISTING_PODIUM_MACHINE_DRAFT_KEY = 'podium.existingPodium.machineDraft'
export const FIRST_TASK_ACTIVATION_DRAFT_KEY = 'podium.firstTaskActivation.draft'
/** Truthy while first-run setup is underway on this device (POD-1200). */
export const ONBOARDING_ACTIVE_KEY = 'podium.onboarding.active'

export type ShellDensity = 'balanced' | 'compact'

/** Parse the device-local shell density, defaulting absent/corrupt values to balanced. */
export function readStoredDensity(ui: Pick<UiState, 'get'>): ShellDensity {
  return ui.get(SHELL_DENSITY_KEY) === 'compact' ? 'compact' : 'balanced'
}
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
 * 0. A session with no terminal always shows chat.
 * 1. Non-chat-capable sessions always show native.
 * 2. Persisted per-session override (when present).
 * 3. Personal default pick (panelModeDefault).
 * 4. The `startScreen` setting (`native` | `chat` | `auto`→mobile heuristic).
 *
 * RULE 0 OUTRANKS THE PERSISTED PICK, AND THAT IS THE POINT (POD-2290). Rules
 * 2–4 answer "which of two views did this operator want"; rule 0 says there is
 * only ONE view, so there is no preference to honour. A server- or
 * embedded-driven session has no PTY, and a remembered `native` — a per-device
 * default, or a per-session pick made when the same harness still ran under a
 * terminal — would put the operator back on a pane whose attach can never
 * confirm. The mirror of rule 1, which has always overridden the same saved
 * value for the opposite reason: a shell has no transcript to chat with.
 */
export function effectivePanelMode(input: {
  startScreen: 'native' | 'chat' | 'auto'
  chatCapable: boolean
  isMobile: boolean
  /** There is a PTY behind the native view — false for the server and embedded
   *  driver families. Required rather than defaulted so a new caller has to
   *  answer it; `sessionHasTerminal` is the one place "unknown" becomes true. */
  terminalCapable: boolean
  /** Persisted per-session mode when known. */
  saved?: PanelMode | null
  /** Personal default (PANEL_MODE_DEFAULT_KEY). */
  deviceDefault?: string | null
}): PanelMode {
  if (!input.terminalCapable) return 'chat'
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
  issueId: IssueId | null
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
      return { view: 'issues', ...base, issueId: second === undefined ? null : asIssueId(second) }
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
  /** Per-task tab layouts (POD-710) — the truth the three scalars above mirror. */
  workspaces: WorkspaceMap
  /** The file buffers those layouts hold tab ids for (POD-1247). */
  fileTabs: FileTab[]
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

/**
 * THE OPEN FILE BUFFERS, RESTORED (POD-1247).
 *
 * The workspace layouts persist tab IDS; without these records every one of
 * those ids named nothing after a reload, so file tabs silently vanished and
 * the layout entries were swept as ghosts. The two are written from the same
 * flush and read from the same hydrate, which is what keeps them agreeing.
 *
 * TOTAL, like every other reader here: a malformed row is dropped and a
 * malformed blob restores as no tabs at all. A tab whose SCOPE does not parse
 * is dropped rather than defaulted — the scope is how the daemon read is
 * addressed, and a guessed one would read the wrong machine's file.
 */
export function readStoredFileTabs(ui: Pick<RoutedUiState, 'get'>): FileTab[] {
  const raw = ui.get(UI_STATE_KEYS.fileTabs)
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    const seen = new Set<string>()
    return parsed.flatMap((value): FileTab[] => {
      if (!value || typeof value !== 'object') return []
      const row = value as Record<string, unknown>
      const scope = readFileScope(row.scope)
      if (
        !scope ||
        typeof row.id !== 'string' ||
        !row.id ||
        seen.has(row.id) ||
        typeof row.path !== 'string' ||
        typeof row.worktreePath !== 'string'
      )
        return []
      seen.add(row.id)
      return [
        {
          id: row.id,
          scope,
          path: row.path,
          worktreePath: row.worktreePath,
          ...(typeof row.issueId === 'string' && row.issueId
            ? { issueId: asIssueId(row.issueId) }
            : {}),
        },
      ]
    })
  } catch {
    return []
  }
}

/** One arm of the scope union, or null. Closed on purpose: an unknown `kind`
 *  from a newer build is not a scope this build knows how to address. */
function readFileScope(value: unknown): FileScope | null {
  if (!value || typeof value !== 'object') return null
  const row = value as Record<string, unknown>
  if (row.kind === 'session') {
    return typeof row.sessionId === 'string' && row.sessionId
      ? { kind: 'session', sessionId: asSessionId(row.sessionId) }
      : null
  }
  if (row.kind === 'worktree') {
    return typeof row.root === 'string' && row.root
      ? {
          kind: 'worktree',
          root: row.root,
          ...(typeof row.machineId === 'string' ? { machineId: asMachineId(row.machineId) } : {}),
        }
      : null
  }
  if (row.kind === 'artifact') {
    return typeof row.issueId === 'string' &&
      row.issueId &&
      typeof row.artifactId === 'string' &&
      row.artifactId
      ? {
          kind: 'artifact',
          issueId: asIssueId(row.issueId),
          artifactId: asArtifactId(row.artifactId),
        }
      : null
  }
  return null
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
          ...(typeof row.machineId === 'string' ? { machineId: asMachineId(row.machineId) } : {}),
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
  'workspaces',
  'fileTabs',
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
        // Total by contract: a corrupt or older-shaped blob restores {} rather
        // than throwing on the boot path.
        workspaces: deserializeWorkspaces(ui.get(UI_STATE_KEYS.workspaces)),
        fileTabs: readStoredFileTabs(ui),
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
      write('workspaces', UI_STATE_KEYS.workspaces, serializeWorkspaces(state.workspaces))
      write('fileTabs', UI_STATE_KEYS.fileTabs, JSON.stringify(state.fileTabs))
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
