import {
  createContext,
  type ReactElement,
  type ReactNode,
  useContext,
  useMemo,
  useState,
} from 'react'

/**
 * Which task the operator is INSPECTING, as distinct from which mission they
 * are supervising.
 *
 * `selectedIssueId` in the store is the mission root: it scopes the Flight
 * Deck, the tab strip's session universe and the sidebar's selection. Focus is
 * the finer pointer that moves inside that scope — clicking a task strip, a
 * session row or a center tab retargets the Task inspector WITHOUT collapsing
 * the mission down to that one child.
 *
 * Focus is deliberately NOT reset here when the mission changes. Selecting a
 * child of a different mission sets the mission and the focus in the same
 * interaction, and a reset effect would land after both and overwrite the
 * child with the root — you would click a task and get its epic. Consumers
 * instead RESOLVE focus against the mission they render (`resolveFocus`), so a
 * pointer that no longer belongs simply falls back.
 */
type OperatorFocusValue = {
  focusedIssueId: string | null
  setFocusedIssueId: (id: string | null) => void
}

const OperatorFocusContext = createContext<OperatorFocusValue>({
  focusedIssueId: null,
  setFocusedIssueId: () => undefined,
})

export function OperatorFocusProvider({
  missionId,
  children,
}: {
  missionId: string | null
  children: ReactNode
}): ReactElement {
  const [focusedIssueId, setFocusedIssueId] = useState<string | null>(missionId)
  const value = useMemo(() => ({ focusedIssueId, setFocusedIssueId }), [focusedIssueId])
  return <OperatorFocusContext.Provider value={value}>{children}</OperatorFocusContext.Provider>
}

export function useOperatorFocus(): OperatorFocusValue {
  return useContext(OperatorFocusContext)
}

/**
 * The focused issue as seen from one mission: the pointer when it belongs to
 * that mission, else the mission root. A focus left over from the mission you
 * just navigated away from resolves to the new root rather than to nothing.
 */
export function resolveFocus(
  focusedIssueId: string | null,
  memberIds: ReadonlySet<string>,
  rootId: string | null | undefined,
): string | null {
  if (focusedIssueId && memberIds.has(focusedIssueId)) return focusedIssueId
  return rootId ?? null
}
