import { shallowEqual } from '@podium/client-core/store'
import { missionIssueIds, selectedMissionRoot } from '@podium/client-core/viewmodels'
import {
  createContext,
  type ReactElement,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { resolveFocus, useOperatorFocus } from '@/app/operator-focus'
import { useReplicaIssues, useStoreSelector } from '@/app/store'
import { EXPLORER_TABS, type ExplorerTab } from './explorer-list'
import { type ExplorerStack, popToDepth, pushLevel, resetTo } from './explorer-nav'

/**
 * The issue explorer's state, held ABOVE the dock.
 *
 * It lives here and not in the panel because the panel unmounts when the dock
 * closes, and the explorer's whole contract is that closing it is a distinct
 * act that costs you nothing: reopen and you are back where you were, on the
 * same task, with the same trail, tab and query.
 *
 * It also keeps tracking while closed. A Flight Deck click retargets the stack
 * whether or not anyone is looking, so opening the tool shows the task you last
 * touched rather than the one you last looked at — the panel is a window onto a
 * pointer the shell maintains, not a thing that starts existing when opened.
 */
export interface IssueExplorerNav {
  /** Deepest last. Empty is level 0 — the task list. */
  stack: ExplorerStack
  /** The issue whose detail is showing, or null on the list. */
  current: string | null
  /** How the last move went, for the transition. Null on a silent retarget. */
  motion: 'push' | 'pop' | null
  /** Bumped on every move, so the rendered level can be keyed on it. */
  seq: number
  push: (id: string) => void
  popTo: (depth: number) => void
  back: () => void
  /**
   * Point the explorer at a task WITHOUT moving the shell (POD-1265).
   *
   * The other way to arrive here is to move the selection and let the effect
   * below follow it — which is right for a deck or sidebar click, and wrong for
   * a ref card in chat: the reader asked to look at a task, not to switch the
   * tab area and the sidebar over to it. Same reset semantics as an external
   * retarget, because a card in another surface is not a step in this trail.
   */
  retarget: (id: string) => void
  /**
   * Collapse to level 0 — the task list.
   *
   * Silent, and not a pop: the level did not step back, it stopped existing
   * (the task was deleted, or the replica no longer carries it). Sliding a
   * level out implies somewhere to slide back to, and there is nowhere.
   */
  toIndex: () => void
  /** Null until the operator picks one — the list resolves the default from the
   *  counts it already has, so the shell never pays for that pass. */
  tab: ExplorerTab | null
  setTab: (tab: ExplorerTab) => void
  query: string
  setQuery: (query: string) => void
  listScrollTop: (scope: string) => number
  rememberListScrollTop: (scope: string, top: number) => void
}

export const EXPLORER_SCROLL_CACHE_LIMIT = 8

const noop = (): void => undefined
const IssueExplorerContext = createContext<IssueExplorerNav>({
  stack: [],
  current: null,
  motion: null,
  seq: 0,
  push: noop,
  popTo: noop,
  back: noop,
  retarget: noop,
  toIndex: noop,
  tab: null,
  setTab: noop,
  query: '',
  setQuery: noop,
  listScrollTop: () => 0,
  rememberListScrollTop: noop,
})

export function IssueExplorerProvider({ children }: { children: ReactNode }): ReactElement {
  const { selectedIssueId, sessions } = useStoreSelector(
    (s) => ({ selectedIssueId: s.selectedIssueId, sessions: s.sessions }),
    shallowEqual,
  )
  const issues = useReplicaIssues()
  const { focusedIssueId } = useOperatorFocus()

  // WHAT THE SHELL IS POINTING AT — the same resolution the dock used to do for
  // itself: the operator's focus inside the selected mission, falling back to
  // the mission root when the focus belongs to a mission they navigated away
  // from. Sync runs INWARD only: the explorer reads this, and nothing the
  // explorer does writes back to it. Walking a relation into another team's
  // task must not move the deck out from under the work in progress.
  const target = useMemo(() => {
    const root = selectedMissionRoot(issues, sessions, selectedIssueId)
    return resolveFocus(
      focusedIssueId,
      root ? missionIssueIds(issues, root.id, sessions) : new Set<string>(),
      // NO FALLBACK TO THE RAW SELECTION (POD-1112). With no mission resolved
      // there is nothing for the explorer to point at, and it opens where a
      // tool with no subject should: level 0, the task list. The selection this
      // used to fall back to is exactly the case that resolved to nothing — an
      // empty draft vessel, or an id no longer in the replica — so the fallback
      // could only ever open the panel on a task the operator did not choose.
      root?.id ?? null,
    )
  }, [focusedIssueId, issues, selectedIssueId, sessions])

  const [stack, setStack] = useState<ExplorerStack>(() => (target ? [target] : []))
  const [motion, setMotion] = useState<'push' | 'pop' | null>(null)
  const [seq, setSeq] = useState(0)
  const lastTarget = useRef(target)

  // AN EMPTY REPLICA IS NOT EVIDENCE OF ABSENCE (POD-1277). A reconnect
  // mid-flight empties `issues` for a frame, which resolves every pointer to
  // null and marks every level's subject gone. Riding one out costs nothing;
  // acting on it would throw the operator back to level 0 every time the socket
  // blinks. Both rules below therefore only run once the replica has content.
  const grounded = issues.length > 0

  // A retarget is silent: no transition, because nothing on this surface was
  // touched to cause it, and a panel that slides every time you click a session
  // in another column is a panel that is always moving.
  useEffect(() => {
    if (!grounded) return
    if (target === lastTarget.current) return
    lastTarget.current = target
    setStack((prev) => resetTo(prev, target))
    setMotion(null)
    setSeq((n) => n + 1)
  }, [target, grounded])

  const [tab, setTab] = useState<ExplorerTab | null>(null)
  const [query, setQuery] = useState('')
  const listScrollPositions = useRef(new Map<string, number>())
  const listScrollTop = useCallback(
    (scope: string): number => {
      const positions = listScrollPositions.current
      const top = positions.get(scope) ?? 0
      if (positions.has(scope)) {
        positions.delete(scope)
        positions.set(scope, top)
      }
      return top
    },
    [],
  )
  const rememberListScrollTop = useCallback((scope: string, top: number): void => {
    const positions = listScrollPositions.current
    positions.delete(scope)
    positions.set(scope, top)
    while (positions.size > EXPLORER_SCROLL_CACHE_LIMIT) {
      const oldest = positions.keys().next().value as string | undefined
      if (oldest === undefined) break
      positions.delete(oldest)
    }
  }, [])

  const push = useCallback((id: string): void => {
    setStack((prev) => pushLevel(prev, id))
    setMotion('push')
    setSeq((n) => n + 1)
  }, [])
  const popTo = useCallback((depth: number): void => {
    setStack((prev) => popToDepth(prev, depth))
    setMotion('pop')
    setSeq((n) => n + 1)
  }, [])
  const back = useCallback((): void => {
    setStack((prev) => popToDepth(prev, prev.length - 1))
    setMotion('pop')
    setSeq((n) => n + 1)
  }, [])
  // Silent, like the shell-driven retarget above: the operator touched another
  // surface, and a panel that slides whenever something elsewhere is clicked is
  // a panel that is always moving. `lastTarget` is deliberately NOT written —
  // the shell still points where it did, so if the selection later lands on this
  // same task the effect above may still collapse a trail walked from here.
  const retarget = useCallback((id: string): void => {
    setStack((prev) => resetTo(prev, id))
    setMotion(null)
    setSeq((n) => n + 1)
  }, [])

  const toIndex = useCallback((): void => {
    setStack((prev) => (prev.length === 0 ? prev : []))
    setMotion(null)
    setSeq((n) => n + 1)
  }, [])

  const current = stack.length ? (stack[stack.length - 1] ?? null) : null

  // A LEVEL WHOSE TASK IS GONE GOES HOME. Deletion is the one way a level can
  // outlive its subject — archived tasks still open, and the trail labels them.
  //
  // This lives in the PROVIDER, not in the panel that renders the trail, because
  // the pointer outlives the panel by design: the dock unmounts the explorer
  // whenever it closes or another tab is picked, and a rule that only runs while
  // someone is looking is not a rule about the pointer, it is a rule about the
  // view. Deleting a task from the Flight Deck with the dock shut used to leave
  // the dead id in the stack until the panel was next mounted, so reopening the
  // dock landed on a task that no longer existed (POD-1471).
  //
  // HOME IS THE SUBJECT IF THERE STILL IS ONE, and the list otherwise. A
  // tombstone drops the task out of the mission index, so deleting the task the
  // explorer is ON re-aims the subject at the live root in the very commit that
  // strands the level: the two rules fire together, and a flat "go to the list"
  // would race the re-aim and park the panel on level 0 while real work is still
  // selected. Resolving the destination here instead of ordering the effects
  // makes the outcome the same whichever of them lands first.
  const { missing, reseed } = useMemo(() => {
    const alive = (id: string): boolean => issues.some((i) => i.id === id && !i.deletedAt)
    if (!grounded || current === null || alive(current)) return { missing: false, reseed: null }
    return { missing: true, reseed: target !== null && alive(target) ? target : null }
  }, [grounded, current, target, issues])

  useEffect(() => {
    if (!missing) return
    if (reseed === null) {
      toIndex()
      return
    }
    setStack([reseed])
    setMotion(null)
    setSeq((n) => n + 1)
  }, [missing, reseed, toIndex])

  const value = useMemo<IssueExplorerNav>(
    () => ({
      stack,
      current,
      motion,
      seq,
      push,
      popTo,
      back,
      retarget,
      toIndex,
      tab,
      setTab,
      query,
      setQuery,
      listScrollTop,
      rememberListScrollTop,
    }),
    [
      stack,
      current,
      motion,
      seq,
      push,
      popTo,
      back,
      retarget,
      toIndex,
      tab,
      query,
      listScrollTop,
      rememberListScrollTop,
    ],
  )
  return <IssueExplorerContext.Provider value={value}>{children}</IssueExplorerContext.Provider>
}

export function useIssueExplorer(): IssueExplorerNav {
  return useContext(IssueExplorerContext)
}

export { EXPLORER_TABS }
