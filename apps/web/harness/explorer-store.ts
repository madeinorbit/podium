/**
 * THE EXPLORER HARNESS'S STORE (POD-1277).
 *
 * The filed defect is about WHICH PANEL RENDERS, and that is a question about a
 * whole dock column: the trail in the 44px head, the panel body under it, and
 * the width they both live in. jsdom can prove the branch is taken; it cannot
 * show that what arrives is a task the operator can read, because the dock's
 * geometry and every one of its ink tiers come from `styles.css`.
 *
 * So the real `IssueExplorer` is mounted in a browser with this module standing
 * in for `app/store` — the same shape `issue-page-store.ts` uses, so the two
 * harnesses agree about what the shell reads. The fixture is the filed case: an
 * ARCHIVED task the explorer is pointed at.
 */
import type { SessionMeta } from '@podium/model'

const noop = async (): Promise<undefined> => undefined

export const state = {
  issues: [] as unknown[],
  sessions: [] as unknown[],
  /** The fleet a harness entry wants the shell to see. Empty by default, which
   *  is what POD-1277's entry has always rendered against; POD-1457's entry
   *  fills it so the launch box's agent menu has real availability to grey. */
  repos: [] as unknown[],
  machines: [] as unknown[],
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
    update: { mutate: noop },
    close: { mutate: noop },
    start: { mutate: noop },
    action: { mutate: noop },
    clearNeedsHuman: { mutate: noop },
    panelApply: { mutate: noop },
  },
  sessions: { sendText: { mutate: noop } },
} as unknown

const store = (): Record<string, unknown> => ({
  trpc,
  hub: { onIssues: () => () => {} },
  httpOrigin: '',
  sessions: state.sessions,
  issues: state.issues,
  repos: state.repos,
  machines: state.machines,
  worktrees: [],
  selectedIssueId: null,
  paneA: null,
  paneB: null,
  split: false,
  drafts: {},
  coarseNow: Date.parse('2026-08-18T10:00:00.000Z'),
  uiState,
  openFileInWorktree: () => {},
  openArtifact: () => {},
  setSelectedWorktree: () => {},
  setSelectedIssueId: () => {},
  openSessionTab: () => {},
  setPanelMode: () => {},
  setPane: () => {},
  setView: () => {},
  setOpenIssueId: () => {},
  navigateToSession: () => {},
  markIssueRead: noop,
  markIssueUnread: noop,
  // REAL, unlike its neighbours (POD-1618): the rename shot has to photograph
  // the head wearing the new name, and a no-op store would show the old one.
  // Patches the replica in place and wakes the subscribers, which is the whole
  // of what the shipping store does that this frame depends on.
  updateIssue: async (id: string, patch: Record<string, unknown>): Promise<undefined> => {
    state.issues = state.issues.map((issue) =>
      (issue as { id?: string }).id === id ? { ...(issue as object), ...patch } : issue,
    )
    for (const listener of state.listeners) listener()
    return undefined
  },
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
  archiveSession: noop,
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
