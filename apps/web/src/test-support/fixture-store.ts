import type { Store } from '@podium/client-core/engine'

/** Supply the runtime plumbing old component fixtures omitted. */
export function fixtureStoreSnapshot(input: Store): Store {
  const state = input as Store & { batchGesture?: (fn: () => void) => void }
  return {
    ...state,
    fileTabs: state.fileTabs ?? [],
    batchGesture: state.batchGesture ?? ((fn) => fn()),
    navigateWorkspace: state.navigateWorkspace ?? ((plan) => {
      if (plan.selectedIssueId !== undefined) state.setSelectedIssueId?.(plan.selectedIssueId)
      if (plan.selectedWorktree !== undefined) state.setSelectedWorktree?.(plan.selectedWorktree)
      if (plan.tabId !== undefined) state.setPane?.('A', plan.tabId)
      state.setView?.('workspace')
      return true
    }),
  }
}
