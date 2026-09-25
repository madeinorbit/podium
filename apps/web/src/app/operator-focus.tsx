import { asIssueId, type IssueId } from '@podium/model/browser'
import { shallowEqual } from '@podium/client-core/store'
import { missionIssueIds, resolvedMissionRootFor } from '@podium/client-core/viewmodels'
import {
  createContext,
  type ReactElement,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useReplicaIssues, useStoreSelector } from './store'

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
  focusedIssueId: IssueId | null
  focusLoading: boolean
  setFocusedIssueId: (id: string | null, options?: { transientIfAbsent?: boolean }) => void
}

const OperatorFocusContext = createContext<OperatorFocusValue>({
  focusedIssueId: null,
  focusLoading: false,
  setFocusedIssueId: () => undefined,
})

export function OperatorFocusProvider({
  missionId,
  children,
}: {
  missionId: string | null
  children: ReactNode
}): ReactElement {
  const { workspaces, workspaceKey, updateWorkspaceDeck, sessions } = useStoreSelector((store) => ({
    workspaces: store.workspaces,
    workspaceKey: store.workspaceKey,
    updateWorkspaceDeck: store.updateWorkspaceDeck,
    sessions: store.sessions,
  }), shallowEqual)
  const issues = useReplicaIssues()
  // AppShell supplies the selected issue, which may be a child after a session
  // rehome. Membership and fallback still belong to its resolved mission root.
  const missionRootId = missionId
    ? resolvedMissionRootFor(issues, asIssueId(missionId))?.id ?? missionId
    : null
  const key = workspaceKey()
  const [localFocus, setLocalFocus] = useState<Record<string, IssueId | null>>({})
  const unknownSince = useRef(new Map<string, { id: string; at: number }>())
  const stored = workspaces[key]?.deck?.focusedIssueId
  const focusedIssueId = Object.hasOwn(localFocus, key) ? localFocus[key] ?? null :
    stored === undefined ? (missionId === null ? null : asIssueId(missionId)) : stored === null ? null : asIssueId(stored)
  const members = missionRootId ? missionIssueIds(issues, missionRootId, sessions) : new Set<string>()
  const focusedRecord = focusedIssueId ? issues.find((issue) => issue.id === focusedIssueId) : undefined
  const knownInvalidFocus = Boolean(focusedRecord?.archived || focusedRecord?.deletedAt)
  const displayFocusedIssueId = knownInvalidFocus && missionRootId ? asIssueId(missionRootId) : focusedIssueId
  const unresolvedFocus = focusedIssueId !== null && !knownInvalidFocus && !members.has(focusedIssueId) &&
    !resolvedMissionRootFor(issues, focusedIssueId)
  const record = unknownSince.current.get(key)
  const focusLoading = Boolean(missionRootId && unresolvedFocus &&
    (record?.id !== focusedIssueId || Date.now() - record.at < 20_000))
  useEffect(() => {
    if (stored !== undefined) setLocalFocus((current) => ({ ...current, [key]: stored === null ? null : asIssueId(stored) }))
  }, [key, stored])
  useEffect(() => {
    if (!missionRootId || !focusedIssueId || !knownInvalidFocus && (members.has(focusedIssueId) || unresolvedFocus)) return
    setLocalFocus((current) => ({ ...current, [key]: asIssueId(missionRootId) }))
    if (stored === focusedIssueId) updateWorkspaceDeck({ focusedIssueId: missionRootId }, { passive: true })
  }, [missionRootId, focusedIssueId, knownInvalidFocus, members, unresolvedFocus, key, stored, updateWorkspaceDeck])
  useEffect(() => {
    if (!missionRootId || !focusedIssueId || !unresolvedFocus) {
      unknownSince.current.delete(key)
      return
    }
    const previous = unknownSince.current.get(key)
    const at = previous?.id === focusedIssueId ? previous.at : Date.now()
    unknownSince.current.set(key, { id: focusedIssueId, at })
    const timer = window.setTimeout(() => {
      const current = unknownSince.current.get(key)
      if (current?.id !== focusedIssueId || current.at !== at) return
      unknownSince.current.delete(key)
      setLocalFocus((values) => ({ ...values, [key]: asIssueId(missionRootId) }))
      if (stored === focusedIssueId) updateWorkspaceDeck({ focusedIssueId: missionRootId }, { passive: true })
    }, Math.max(0, 20_000 - (Date.now() - at)))
    return () => window.clearTimeout(timer)
  }, [missionRootId, key, focusedIssueId, unresolvedFocus, stored, updateWorkspaceDeck])
  const value = useMemo(
    () => ({
      focusedIssueId: displayFocusedIssueId,
      focusLoading,
      setFocusedIssueId: (id: string | null, options?: { transientIfAbsent?: boolean }) => {
        const liveKey = workspaceKey()
        setLocalFocus((current) => ({ ...current, [liveKey]: id === null ? null : asIssueId(id) }))
        updateWorkspaceDeck({ focusedIssueId: id }, options)
      },
    }),
    [displayFocusedIssueId, focusLoading, workspaceKey, updateWorkspaceDeck],
  )
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
  focusedIssueId: IssueId | null,
  memberIds: ReadonlySet<string>,
  rootId: string | null | undefined,
  preserveUnknown = false,
): string | null {
  if (focusedIssueId && memberIds.has(focusedIssueId)) return focusedIssueId
  if (focusedIssueId && preserveUnknown) return focusedIssueId
  return rootId ?? null
}
