/**
 * THE DECK HARNESS'S STORE (POD-1226).
 *
 * `FlightDeck` is the one surface in the shell whose whole subject is geometry —
 * a rail that has to stay one line from the header to the last row, and four
 * columns that have to stay columns as the operator drags the column between
 * 300px and 620px. jsdom cannot answer either question: it has no layout, so a
 * collision, an overflow and a mis-aligned rail all measure zero there.
 *
 * So the deck is rendered in a real browser against the real `styles.css`, and
 * this module stands in for `app/store` — the same shape `FlightDeck.test.tsx`
 * mocks, so the two agree about what the deck actually reads. The vite harness
 * config redirects every `./store` / `@/app/store` import here.
 *
 * The fixture is settable from the page (`window.deck.setMission`) so one browser
 * session can sweep every width and every row shape.
 */
import type { SessionMeta } from '@podium/model'

type Issue = Record<string, unknown>

export const issue = (id: string, over: Issue = {}): Issue => ({
  id,
  seq: Number(id.replace(/\D/g, '')) || 1,
  displayRef: id.toUpperCase(),
  title: `Task ${id}`,
  stage: 'in_progress',
  archived: false,
  deletedAt: null,
  parentId: null,
  memberSessionIds: [],
  updatedAt: '2026-01-01T00:00:00.000Z',
  readAt: '2026-01-01T00:10:00.000Z',
  unread: false,
  labels: [],
  deps: [],
  ...over,
})

export const session = (id: string, over: Record<string, unknown> = {}): SessionMeta =>
  ({
    sessionId: id,
    agentKind: 'claude-code',
    status: 'live',
    cwd: '/repo',
    name: id,
    title: id,
    displayRef: id.toUpperCase(),
    unread: false,
    archived: false,
    lastActiveAt: '2026-01-01T00:00:00.000Z',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...over,
  }) as unknown as SessionMeta

const noop = async (): Promise<undefined> => undefined

export const state = {
  issues: [] as unknown[],
  sessions: [] as unknown[],
  selectedIssueId: 'root' as string | null,
  paneA: null as string | null,
  ui: new Map<string, string>(),
  listeners: new Set<() => void>(),
  /** Per-session phase samples served to the waterfall's activityHistory
   *  query — the on/off record a fixture declares for segmented bars. */
  activity: {} as Record<string, Array<{ at: string; phase: string }>>,
  /** Bumped by the entry so React re-renders when the fixture is replaced. */
  version: 0,
}

const uiState = {
  get: (key: string): string | null => state.ui.get(key) ?? null,
  set: (key: string, value: string | null): void => {
    if (value === null) state.ui.delete(key)
    else state.ui.set(key, value)
    for (const listener of state.listeners) listener()
  },
  subscribe: (cb: () => void): (() => void) => {
    state.listeners.add(cb)
    return () => {
      state.listeners.delete(cb)
    }
  },
}

const trpc = {
  features: {
    state: {
      query: async () => ({
        devMode: true,
        channel: 'stable' as const,
        flags: [
          {
            id: 'podium-development',
            name: 'Podium development',
            description: 'Show controls for developing Podium itself.',
            visibility: 'stable' as const,
            listed: true,
            enabled: true,
            source: 'user' as const,
            locked: false,
          },
        ],
      }),
    },
  },
  issues: {
    setPlacement: { mutate: noop },
    start: { mutate: noop },
    addSession: { mutate: noop },
  },
  sessions: {
    activityHistory: {
      query: async ({ sessionIds }: { sessionIds: string[] }) => ({
        sampledAt: new Date().toISOString(),
        sessions: Object.fromEntries(
          sessionIds
            .filter((id) => (state.activity[id]?.length ?? 0) > 0)
            .map((id) => [id, state.activity[id]]),
        ),
      }),
    },
  },
} as unknown

const store = (): Record<string, unknown> => ({
  sessions: state.sessions,
  repos: [],
  machines: [],
  selectedIssueId: state.selectedIssueId,
  paneA: state.paneA,
  paneB: null,
  split: false,
  drafts: {},
  coarseNow: Date.parse('2026-01-01T00:30:00.000Z'),
  uiState,
  setSelectedWorktree: () => {},
  setSelectedIssueId: () => {},
  openSessionTab: () => {},
  setPanelMode: () => {},
  setView: () => {},
  markIssueRead: noop,
  markIssueUnread: noop,
  updateIssue: noop,
  deleteIssue: noop,
  closeIssue: noop,
  deferIssue: noop,
  undeferIssue: noop,
  setIssueLabels: noop,
  setIssuePlacement: noop,
  restoreIssue: noop,
  markSessionRead: noop,
  setIssueTucked: noop,
  renameSession: noop,
  trpc,
})

export function useStoreSelector<T>(select: (s: Record<string, unknown>) => T): T {
  return select(store())
}

export function useStore(): Record<string, unknown> {
  return store()
}

export function useReplicaIssues(): unknown[] {
  return state.issues
}

export function useSessionDraft(): string {
  return ''
}

export function useSession(): SessionMeta | undefined {
  return undefined
}

export function useSessionExitKind(): null {
  return null
}

export function useSlice<T>(): T | undefined {
  return undefined
}
