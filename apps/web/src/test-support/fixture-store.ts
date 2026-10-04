import type { ReferenceState as Store } from '@podium/client-graph/diagnostics/reference-state'
import { asSessionId } from '@podium/model/browser'

/** Supply the runtime plumbing old component fixtures omitted. */
export function fixtureStoreSnapshot(
  input: import("@/app/store").Store,
  onMutation?: () => void,
): Store & { batchGesture: (fn: () => void) => void } {
  const state = input as Store & { batchGesture?: (fn: () => void) => void }
  // Preserve tripwire getters without evaluating unrelated reader inputs while
  // borrowing the action owner. The pool fixtures read those inputs explicitly.
  const plumbing: Pick<Store, 'fileTabs' | 'navigateWorkspace'> & {
    batchGesture: (fn: () => void) => void
  } = {
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
  return Object.create(Object.getPrototypeOf(state), {
    ...Object.getOwnPropertyDescriptors(state),
    ...Object.getOwnPropertyDescriptors(plumbing),
  })
}
