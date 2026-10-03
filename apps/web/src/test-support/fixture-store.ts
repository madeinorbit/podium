import type { Store } from '@podium/client-core/engine'
import { asSessionId } from '@podium/model/browser'

/** Supply the runtime plumbing old component fixtures omitted. */
export function fixtureStoreSnapshot(
  input: Store,
  onMutation?: () => void,
): Store & { batchGesture: (fn: () => void) => void } {
  const state = input as Store & { batchGesture?: (fn: () => void) => void }
  return {
    ...state,
    fileTabs: state.fileTabs ?? [],
    batchGesture: (fn) => {
      if (state.batchGesture) state.batchGesture(fn)
      else fn()
      onMutation?.()
    },
    navigateWorkspace:
      state.navigateWorkspace ??
      ((plan) => {
        if (plan.selectedIssueId !== undefined) state.setSelectedIssueId?.(plan.selectedIssueId)
        if (plan.selectedWorktree !== undefined) state.setSelectedWorktree?.(plan.selectedWorktree)
        if (plan.tabId !== undefined)
          state.setPane?.('A', plan.tabId === null ? null : asSessionId(plan.tabId))
        state.setView?.('workspace')
        return true
      }),
  }
}
