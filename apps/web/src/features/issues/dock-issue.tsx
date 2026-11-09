import { useUiValue } from '@podium/client-core/react'
import type { MobxPool } from '@podium/client-graph'
import { LOADING } from '@podium/client-graph/loading'
import { omitGone } from '@podium/client-graph/lookup'
import type { SliceIssue } from '@podium/client-graph/shared/slice-types'
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
import { useOperatorFocus } from '@/app/operator-focus'
import { type IssueViewModel, useRuntimeSelector } from '@/app/store'
import { useWorklistPoolProjection } from '@/app/store-worklist-pool'
import { poolMissionContains, poolMissionRoot } from '@/features/worklist/use-pool-unified-work'

/**
 * Which ONE task the right dock's task panel shows.
 *
 * By default that is the shell's task — the selected mission, narrowed to the
 * task focused inside it. A ref chip in chat, a Flight Deck pick or a linked row
 * inside the panel may point it at another task (`show`) without moving the
 * left sidebar's selection; the next change of the shell's task takes it back.
 *
 * Held ABOVE the dock, because the panel unmounts when the dock closes and the
 * pointer must keep following the shell while nobody is looking: opening the
 * dock shows the task last touched, not the one last looked at.
 */
export interface DockIssue {
  /** The task the panel shows, or null when there is none. */
  issueId: string | null
  /** The shell's task, which the panel follows unless pointed elsewhere. */
  shellIssueId: string | null
  /** Point the panel at a task without moving the shell. */
  show: (id: string) => void
}

const DockIssueContext = createContext<DockIssue>({
  issueId: null,
  shellIssueId: null,
  show: () => undefined,
})

/** Only the selected/focused path is read, so the pointer never subscribes to
 * every issue model in the replica. */
export function poolDockIssueTarget(
  pool: MobxPool,
  selectedId: string | null,
  focusedId: string | null,
): string | null | typeof LOADING {
  const root = poolMissionRoot(pool, selectedId)
  if (root === LOADING) return LOADING
  if (!root || root.archived || root.deletedAt) return null
  if (root.isDraftVessel && !root.worktreePath && !pool.issueObject(root.id).headlessOccupied) {
    let occupied = false
    for (const id of pool.graph.many('issue', root.id, 'sessions')) {
      const session = omitGone(pool.row('session', id, 'summary'))
      if (session === LOADING) return LOADING
      if (session && (session as { archived?: boolean }).archived !== true) {
        occupied = true
        break
      }
    }
    if (!occupied) return null
  }
  if (!focusedId) return root.id
  const focused = omitGone(pool.row('issue', focusedId, 'summary'))
  if (focused === LOADING) return LOADING
  if (!focused || (focused as SliceIssue).deletedAt) return root.id
  const belongs = poolMissionContains(pool, root.id, focusedId)
  return belongs === LOADING ? LOADING : belongs ? focusedId : root.id
}

function poolPresence(pool: MobxPool, id: string): boolean | typeof LOADING {
  const row = omitGone(pool.row('issue', id, 'summary'))
  return row === LOADING ? LOADING : Boolean(row && !(row as SliceIssue).deletedAt)
}

const UNRESOLVED: { target: string | null | typeof LOADING; grounded: boolean } = {
  target: LOADING,
  grounded: false,
}

export function DockIssueProvider({ children }: { children: ReactNode }): ReactElement {
  const selectedId = useUiValue('selectedIssueId')
  const { focusedIssueId } = useOperatorFocus()
  const readTarget = useCallback(
    (pool: MobxPool): typeof UNRESOLVED => ({
      target: poolDockIssueTarget(pool, selectedId, focusedIssueId),
      grounded: pool.tables.issue.size > 0,
    }),
    [selectedId, focusedIssueId],
  )
  const { target, grounded } = useWorklistPoolProjection(readTarget, UNRESOLVED)
  const [shell, setShell] = useState<string | null>(() => (target === LOADING ? null : target))
  const [override, setOverride] = useState<string | null>(null)

  // AN EMPTY REPLICA IS NOT EVIDENCE OF ABSENCE (POD-1277). A reconnect
  // mid-flight empties `issues` for a frame, which resolves the target to null;
  // acting on it would blank the panel every time the socket blinks, so the
  // shell's task only moves once the replica has content. A move of the shell
  // also ends any detour the panel was on.
  useEffect(() => {
    if (!grounded || target === LOADING) return
    setShell(target)
    setOverride(null)
  }, [target, grounded])

  // A DETOUR WHOSE TASK IS DELETED ENDS, and the panel goes back to the shell's
  // task. Archived tasks still open. This runs here rather than in the panel so
  // it also holds while the dock is shut (POD-1471).
  const readPresence = useCallback(
    (pool: MobxPool) => (override === null ? true : poolPresence(pool, override)),
    [override],
  )
  const present = useWorklistPoolProjection(readPresence, LOADING)
  useEffect(() => {
    if (grounded && present === false) setOverride(null)
  }, [grounded, present])

  // Stable, and reading the shell's task when called rather than when bound:
  // a Flight Deck strip's memo keeps the handler from an older render.
  const shellRef = useRef(shell)
  shellRef.current = shell
  const show = useCallback(
    (id: string): void => setOverride(id === shellRef.current ? null : id),
    [],
  )
  const value = useMemo<DockIssue>(
    () => ({ issueId: override ?? shell, shellIssueId: shell, show }),
    [override, shell, show],
  )
  return <DockIssueContext.Provider value={value}>{children}</DockIssueContext.Provider>
}

export function useDockIssue(): DockIssue {
  return useContext(DockIssueContext)
}

/** Board rows for the given ids, in order, skipping any the replica lacks. */
export function useDockIssueRows(ids: readonly string[]): IssueViewModel[] {
  const key = JSON.stringify(ids)
  const read = useCallback(
    (pool: MobxPool) =>
      (JSON.parse(key) as string[]).flatMap((id) => {
        const row = omitGone(pool.row('issueBoardRow', id))
        return row && typeof row !== 'symbol' ? [row] : []
      }),
    [key],
  )
  return useWorklistPoolProjection(read, [])
}
