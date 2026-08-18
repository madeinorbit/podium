/**
 * A STUBBED STORE FOR THE REAL WORK SIDEBAR (POD-1253).
 *
 * Aliased over `@/app/store` by `vite.sidebar.config.ts`, so `SidebarUnified`,
 * its rows, its bands and its folds are exactly what ships and only the data
 * underneath is invented.
 *
 * WHY A HARNESS AND NOT THE LIVE COLUMN. This exists to measure the FOLD's
 * motion, and the live instance on this host is fed by a running fleet: an idle
 * second of its sidebar delivers 2 frames and two 1.2s long tasks with nothing
 * clicked at all. Against that baseline a butter-smooth fold and a jump cut
 * measure the same. Here the column is still until something is pressed, so the
 * frames the fold delivers are the fold's.
 *
 * The fixtures are ported from `SidebarUnified.pinned.test.tsx`'s `vi.hoisted`
 * block rather than invented, so the harness and the unit suite agree about what
 * the component reads — including the fields the viewmodels actually key on
 * (`agentState.phase`, `sessionSummary`, `closedAt`/`readAt`).
 */
type Selector<T> = (store: unknown) => T

const ROWS = Number(new URLSearchParams(location.search).get('rows') ?? 24)

const rows = new Map<string, string>()
const listeners = new Set<() => void>()
const uiState = {
  get: (key: string): string | null => rows.get(key) ?? null,
  set: (key: string, value: string | null): void => {
    if (value === null) rows.delete(key)
    else rows.set(key, value)
    for (const listener of listeners) listener()
  },
  subscribe: (callback: () => void): (() => void) => {
    listeners.add(callback)
    return () => {
      listeners.delete(callback)
    }
  },
}

const TITLES = [
  'QR server pairing on mobile',
  'First-run onboarding overhaul',
  'Shipping sidebar panel',
  'Durable ship orders',
  'Ship stack',
  'Stranded done worktrees',
  'Centered command palette',
  'Native view keyboard shortcuts',
  'Bug: dest web rebuild exit',
  'Vacated origin experience',
  'Bug: sort overlay snap-back',
  'Permission asks answerable inline',
  'Node usage in Podium',
  'Shipping command feature flag',
  'Tab selection and deck sort',
  'Flight deck filters leak closed',
  'Duplicate signpost over live row',
  'Question misreported as prompt',
  'Braille wave loading mark',
  'Phone hibernation banner',
  'Safari tab favicon staleness',
  'Agent preset inventory',
  'Sidebar item height parity',
  'ADE competitive landscape',
]

/** A working session, so the row draws the spinner and the counting clock. */
function session(id: string, issueId: string, working: boolean) {
  return {
    sessionId: id,
    agentKind: 'claude-code',
    cwd: '/repo',
    title: id,
    status: 'live',
    controllerId: null,
    geometry: { cols: 80, rows: 24 },
    epoch: 0,
    clientCount: 0,
    createdAt: '2026-07-06T12:00:00.000Z',
    lastActiveAt: '2026-07-06T12:00:00.000Z',
    origin: { kind: 'spawn' },
    archived: false,
    issueId,
    busy: working,
    readAt: '2026-07-06T12:00:00.000Z',
    unread: false,
    // `since` is an ISO STRING on the wire, not epoch ms — a number here reads
    // back as `NaN:NaN` on the row's clock.
    agentState: working
      ? { phase: 'working', since: new Date(Date.now() - 293_000).toISOString() }
      : { phase: 'idle', idle: { kind: 'done' } },
  }
}

function issue(id: string, seq: number, title: string, over: Record<string, unknown> = {}) {
  return {
    id,
    repoPath: '/repo',
    seq,
    title,
    description: '',
    stage: 'in_progress',
    worktreePath: null,
    branch: null,
    parentBranch: 'main',
    defaultAgent: 'claude-code',
    blockedByNotes: [],
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-20T00:00:00.000Z',
    archived: false,
    needsHuman: false,
    sessions: [],
    sessionSummary: { total: 0, byPhase: {} },
    origin: 'human',
    audience: 'human',
    draft: false,
    childCount: 0,
    childDoneCount: 0,
    priority: 2,
    type: 'task',
    pinned: false,
    labels: [],
    deps: [],
    dependents: [],
    comments: [],
    ready: true,
    blocked: false,
    deferred: false,
    readAt: '2026-06-20T00:00:00.000Z',
    unread: false,
    ...over,
  }
}

/** `total` sub-issues under `parentId`, of which `done` are closed and one is
 *  underway — the shape that draws a two-segment meter. */
function subtree(parentId: string, total: number, done: number) {
  return Array.from({ length: total }, (_, i) =>
    issue(`${parentId}-c${i}`, 500 + i, `${parentId} task ${i + 1}`, {
      parentId,
      audience: 'agent',
      stage: i < done ? 'done' : i === done ? 'in_progress' : 'backlog',
      ...(i < done
        ? {
            closedReason: 'done',
            closedAt: '2026-06-10T00:00:00.000Z',
            tuckedAt: '2026-06-11T00:00:00.000Z',
          }
        : {}),
    }),
  )
}

const issues = [
  // Five pinned, so the column carries both bands the artboard draws.
  ...TITLES.slice(0, 5).map((t, i) =>
    issue(`pin-${i}`, 844 - i, t, {
      pinned: true,
      ...(i % 2 === 0 ? { color: 'violet' } : {}),
      // A real subtree on every other row, so the taller (metered) box renders.
      ...(i % 2 === 0 ? { childCount: 8, childDoneCount: 5 } : {}),
    }),
  ),
  ...TITLES.slice(5, ROWS).map((t, i) =>
    issue(`work-${i}`, 969 - i, t, {
      ...(i % 3 === 0 ? { childCount: 9, childDoneCount: 4 } : {}),
    }),
  ),
  // A closed tail, so the fold under the group has something to open.
  ...[0, 1, 2, 3, 4, 5].map((i) =>
    issue(`closed-${i}`, 900 - i, `Settled work ${i + 1}`, {
      stage: 'done',
      closedReason: 'done',
      closedAt: '2026-06-10T00:00:00.000Z',
      readAt: '2026-06-11T00:00:00.000Z',
      tuckedAt: '2026-06-11T00:00:00.000Z',
    }),
  ),
  // REAL SUB-ISSUES, because `missionProgress` counts accepted members and
  // nothing else — `childCount` on the parent is a summary the meter does not
  // read. Without these the harness renders only the artboard's SHORT row and
  // the taller (metered) one never appears in a screenshot.
  ...subtree('pin-0', 8, 5),
  ...subtree('work-0', 9, 4),
  ...subtree('work-3', 4, 3),
]

const sessions = issues
  .filter((i) => i.stage !== 'done')
  .map((i, index) => session(`s-${i.id}`, i.id, index % 4 === 0))

const store = {
  repos: [{ path: '/repo', kind: 'repository' as const, branch: 'main', worktrees: [] }],
  sessions,
  machines: [],
  pins: { panels: [], worktrees: [], repos: [] },
  setPinned: () => {},
  issues,
  trpc: {
    settings: {
      get: { query: async () => ({ sessionDefaults: { agent: 'claude-code' } }) },
      updatePersonal: { mutate: async () => ({}) },
    },
    issues: { defer: { mutate: async () => ({}) }, update: { mutate: async () => ({}) } },
    // The rail's footer search is behind `command-palette`; without this the
    // harness would draw a footer the shipping column does not have.
    features: {
      state: {
        query: async () => ({
          devMode: false,
          channel: 'stable' as const,
          flags: [
            {
              id: 'command-palette',
              name: 'Command palette',
              description: '',
              visibility: 'stable' as const,
              listed: true,
              enabled: true,
              source: 'default' as const,
              locked: false,
            },
          ],
        }),
      },
    },
  },
  selectedWorktree: null,
  setSelectedWorktree: () => {},
  selectedIssueId: 'work-2',
  setSelectedIssueId: () => {},
  setOpenIssueId: () => {},
  paneA: null,
  setPane: () => {},
  fileTabs: [],
  view: 'workspace',
  setView: () => {},
  sidebarSettings: { groupByRepo: false },
  setSidebarSettings: () => {},
  uiState,
  spawnDraftAgent: () => ({ sessionId: 's-new', issueId: 'i-new' }),
  markIssueRead: () => {},
  markSessionRead: () => {},
  setPaletteOpen: () => {},
  coarseNow: Date.now(),
}

export const useStore = (): typeof store => store
export const useReplicaIssues = (): typeof issues => issues
export const useStoreSelector = <T>(selector: Selector<T>): T => selector(store)
export const useSlice = <T>(def: { derive: (s: unknown) => T }): T => def.derive(store)
