import { shallowEqual } from '@podium/client-core/store'
import { missionIssueIds, missionRootFor } from '@podium/client-core/viewmodels'
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
  /** Null until the operator picks one — the list resolves the default from the
   *  counts it already has, so the shell never pays for that pass. */
  tab: ExplorerTab | null
  setTab: (tab: ExplorerTab) => void
  query: string
  setQuery: (query: string) => void
}

const noop = (): void => undefined
const IssueExplorerContext = createContext<IssueExplorerNav>({
  stack: [],
  current: null,
  motion: null,
  seq: 0,
  push: noop,
  popTo: noop,
  back: noop,
  tab: null,
  setTab: noop,
  query: '',
  setQuery: noop,
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
    const root = missionRootFor(issues, selectedIssueId)
    return resolveFocus(
      focusedIssueId,
      root ? missionIssueIds(issues, root.id, sessions) : new Set<string>(),
      root?.id ?? selectedIssueId,
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

  const value = useMemo<IssueExplorerNav>(
    () => ({
      stack,
      current: stack.length ? (stack[stack.length - 1] ?? null) : null,
      motion,
      seq,
      push,
      popTo,
      back,
      tab,
      setTab,
      query,
      setQuery,
    }),
    [stack, motion, seq, push, popTo, back, tab, query],
  )
  return <IssueExplorerContext.Provider value={value}>{children}</IssueExplorerContext.Provider>
}

export function useIssueExplorer(): IssueExplorerNav {
  return useContext(IssueExplorerContext)
}

export { EXPLORER_TABS }
