/**
 * THE ISSUE PAGE HARNESS'S STORE (POD-1266).
 *
 * The page's mutation runner reports a REFUSED WRITE, and where that report
 * lands is the whole question — a strip pinned under the page reads as
 * furniture, a toast over the page reads as an answer. jsdom can prove which
 * component receives the message; it cannot show what the operator sees, because
 * it has no layout and sonner's toast is positioned, sized and themed entirely
 * by CSS the test environment never applies.
 *
 * So the page is rendered in a real browser against the real `styles.css`, with
 * this module standing in for `app/store` — the same shape
 * `IssuePage.agent-start.test.tsx` mocks, so the harness and the test agree
 * about what the page reads. The vite harness config redirects every `./store` /
 * `@/app/store` import here.
 *
 * `issues.start` REJECTS, with the message the operator filed: `git worktree
 * add` refusing a branch that already exists. That is the fixture — the failure
 * IS the subject.
 */
import type { SessionMeta } from '@podium/model'

const noop = async (): Promise<undefined> => undefined

/** The filed failure, verbatim (POD-1266). Three lines of git, one long path. */
export const START_FAILURE = [
  'worktree add failed: Command failed: git -C /home/podium/podium worktree add -b issue/1262-main-red-on-typecheck-blocks-redeploy -- /home/podium/podium/.worktrees/issue-1262-main-red-on-typecheck-blocks-redeploy main',
  "Preparing worktree (new branch 'issue/1262-main-red-on-typecheck-blocks-redeploy')",
  "fatal: a branch named 'issue/1262-main-red-on-typecheck-blocks-redeploy' already exists",
].join('\n')

export const state = {
  issues: [] as unknown[],
  sessions: [] as unknown[],
  ui: new Map<string, string>(),
  listeners: new Set<() => void>(),
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
  features: { state: { query: async () => null } },
  settings: { get: { query: async () => ({ gitWorkflow: { mergeStyle: 'ff-only' } }) } },
  issues: {
    events: { query: async () => [] },
    comments: { query: async () => [] },
    mail: { query: async () => [] },
    setPlacement: { mutate: noop },
    addSession: { mutate: noop },
    addShell: { mutate: noop },
    update: { mutate: noop },
    action: { mutate: noop },
    // The subject.
    start: {
      mutate: async (): Promise<never> => {
        throw new Error(START_FAILURE)
      },
    },
  },
} as unknown

const store = (): Record<string, unknown> => ({
  trpc,
  hub: { onIssues: () => () => {} },
  sessions: state.sessions,
  issues: state.issues,
  repos: [],
  machines: [],
  worktrees: [],
  selectedIssueId: null,
  paneA: null,
  paneB: null,
  split: false,
  drafts: {},
  coarseNow: Date.parse('2026-01-01T00:30:00.000Z'),
  uiState,
  setSelectedWorktree: () => {},
  setSelectedIssueId: () => {},
  openSessionTab: () => {},
  setPanelMode: () => {},
  setPane: () => {},
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
