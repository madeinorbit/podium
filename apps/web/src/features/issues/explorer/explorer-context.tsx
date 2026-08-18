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

  // A retarget is silent: no transition, because nothing on this surface was
  // touched to cause it, and a panel that slides every time you click a session
  // in another column is a panel that is always moving.
  useEffect(() => {
    if (target === lastTarget.current) return
    lastTarget.current = target
    setStack((prev) => resetTo(prev, target))
    setMotion(null)
    setSeq((n) => n + 1)
  }, [target])

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

  const value = useMemo<IssueExplorerNav>(
    () => ({
      stack,
      current: stack.length ? (stack[stack.length - 1] ?? null) : null,
      motion,
      seq,
      push,
      popTo,
      back,
      retarget,
      tab,
      setTab,
      query,
      setQuery,
      listScrollTop,
      rememberListScrollTop,
    }),
    [
      stack,
      motion,
      seq,
      push,
      popTo,
      back,
      retarget,
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
