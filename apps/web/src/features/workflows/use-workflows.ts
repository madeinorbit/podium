import { useRequestClient } from '@podium/client-core/react'
/**
 * THE WORKFLOWS SOURCE (POD-647; synced records since POD-6676): the one hook
 * the workflow screen reads, so the components own no fetching, dispatch or
 * failure.
 *
 * ---------------------------------------------------------------------------
 * EVERY RECORD IS THE POOL'S SHARED MODEL
 * ---------------------------------------------------------------------------
 *
 * Agent profiles, workflow definitions, every revision, the bindings and the
 * runs are synced records (ADR 12 D1, design POD-5620 §1.9-1.10): the feed
 * delivers what this principal may read, so a change made on another device, by
 * an agent, or by the server advancing a run shows here without a request, and
 * the saved copy answers offline. This hook only selects and orders them
 * (`workflowRecords`). The one request left is a run's HISTORY, which grows and
 * stays an answer (`useRunHistory`).
 *
 * ---------------------------------------------------------------------------
 * A DENIED WRITE IS SURFACED. IT IS NOT RETRIED.
 * ---------------------------------------------------------------------------
 *
 * ADR 3 D8 re-authorizes every write at apply, so a denial is routine. `dispatch`
 * answers each command now on the sync write entry point and treats a refusal as
 * terminal: it surfaces the message and never re-sends. Nothing here paints
 * optimistically, so there is nothing to roll back: the records move when the
 * authority's change reaches the feed. The success sentence is shown only after
 * the apply resolves, so a denial never has a success message to take back.
 *
 * ---------------------------------------------------------------------------
 * EVICTION LEAVES QUIETLY, AND NEVER HEALS
 * ---------------------------------------------------------------------------
 *
 * Under POD-1077 the open workflow can lose visibility with no revision moving:
 * its record simply leaves the pool. The selection then moves on, with no
 * tombstone, no toast and no re-request of the vanished id.
 */

import { type WorkflowRecords, workflowRecords } from '@podium/client-graph/workflow-views'
import type {
  AgentProfileWire,
  WorkflowBindingWire,
  WorkflowRevisionWire,
  WorkflowRunRecord,
  WorkflowWire,
} from '@podium/model/browser'
import type { WorkflowRunEventWire } from '@podium/protocol'
import { submitNow } from '@podium/protocol'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useWorklistPool, useWorklistPoolProjection } from '@/app/store-worklist-pool'
import type { Trpc } from '@/app/trpc'
import type { WorkflowCommand } from './workflow-commands'

/*
 * What the screen reads of each record: its stored fields and the few derived
 * ones it shows. The pool's shared models (`@podium/client-graph/models`) are
 * these, by structure; a test hands plain rows.
 */
export type WorkflowRow = Readonly<WorkflowWire>
export type WorkflowRevisionRow = Readonly<WorkflowRevisionWire>
/** A binding, with its feed id (`workflowBindingRowId`). */
export type WorkflowBindingRow = Readonly<WorkflowBindingWire> & { readonly id: string }
/** A profile, with the name of its machine when it is known. */
export type AgentProfileRow = Readonly<AgentProfileWire> & { readonly machineName: string | null }
/** A run, with its revision when this principal holds it. */
export type WorkflowRunRow = Readonly<WorkflowRunRecord> & {
  readonly revision?: Pick<WorkflowRevisionWire, 'version'> | undefined
}

/** The open workflow and its revisions, newest first. */
export interface WorkflowDetail {
  readonly workflow: WorkflowRow
  readonly revisions: readonly WorkflowRevisionRow[]
}

export interface WorkflowsSource {
  readonly workflows: readonly WorkflowRow[]
  readonly bindings: readonly WorkflowBindingRow[]
  readonly profiles: readonly AgentProfileRow[]
  /** Live runs, or every run when {@link showHistory} is on; newest first. */
  readonly runs: readonly WorkflowRunRow[]
  readonly detail: WorkflowDetail | null
  readonly selectedId: string | null
  /** The pool is still loading (the first paint). */
  readonly loading: boolean
  readonly error: string | null
  readonly notice: string | null
  /** Show finished and superseded runs too. */
  readonly showHistory: boolean
  select(id: string | null): void
  setShowHistory(next: boolean): void
  /** Dispatch one command. Resolves `true` when the authority applied it,
   *  `false` when it refused — never throws, and never retries. */
  dispatch<TInput>(command: WorkflowCommand<TInput>, input: TInput): Promise<boolean>
}

const EMPTY: readonly never[] = Object.freeze([])
const NO_RECORDS: WorkflowRecords = {
  profiles: EMPTY,
  workflows: EMPTY,
  revisionsOf: () => EMPTY,
  bindings: EMPTY,
  runs: EMPTY,
}

export function useWorkflows(): WorkflowsSource {
  // A service handle for the writes: the records themselves come from the pool.
  const trpc = useRequestClient<Trpc>()
  const pool = useWorklistPool()
  const records = useWorklistPoolProjection(workflowRecords, NO_RECORDS)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [showHistory, setShowHistory] = useState(false)

  // The open row, re-decided against what is visible NOW. An id that left the
  // pool has been evicted as far as this client can tell: the selection moves
  // on, with no announcement and no re-request of the id.
  const open =
    selectedId !== null && records.workflows.some((workflow) => workflow.id === selectedId)
      ? selectedId
      : (records.workflows[0]?.id ?? null)
  useEffect(() => {
    if (open !== selectedId) setSelectedId(open)
  }, [open, selectedId])

  const detail = useMemo((): WorkflowDetail | null => {
    const workflow = records.workflows.find((row) => row.id === open)
    return workflow ? { workflow, revisions: records.revisionsOf(workflow.id) } : null
  }, [records, open])

  const runs = useMemo(
    (): readonly WorkflowRunRow[] =>
      showHistory ? records.runs : records.runs.filter((run) => run.live),
    [records.runs, showHistory],
  )

  const dispatch = useCallback(
    async <TInput>(command: WorkflowCommand<TInput>, input: TInput): Promise<boolean> => {
      setError(null)
      setNotice(null)
      try {
        // On the sync write entry point (ADR 12 D2), answered now.
        await submitNow(trpc, command.wire, command.build(input))
      } catch (cause) {
        // TERMINAL. The authority refused (or the transport failed) and this
        // path does not decide which: both are surfaced, neither is retried.
        setError(cause instanceof Error ? cause.message : String(cause))
        return false
      }
      setNotice(command.success)
      return true
    },
    [trpc],
  )

  const select = useCallback((id: string | null): void => {
    setSelectedId(id)
  }, [])

  return {
    workflows: records.workflows,
    bindings: records.bindings,
    profiles: records.profiles,
    runs,
    detail,
    selectedId: open,
    loading: pool === null,
    error,
    notice,
    showHistory,
    select,
    setShowHistory,
    dispatch,
  }
}

/** One run's recorded acts, as the server answers them. */
export interface RunHistory {
  readonly events: readonly WorkflowRunEventWire[] | null
  readonly loading: boolean
  readonly error: string | null
}

/**
 * A RUN'S HISTORY, ASKED FOR WHEN SHOWN (design §1.10): its acts grow without
 * bound, so they are not on the synced run; the view that shows them asks the
 * server (`workflows.status`) and drops the answer when it closes. It asks again
 * when the run moves, so a new act shows.
 */
export function useRunHistory(runId: string, open: boolean, revision: unknown): RunHistory {
  const trpc = useRequestClient<Trpc>()
  const [state, setState] = useState<RunHistory>({ events: null, loading: false, error: null })
  // biome-ignore lint/correctness/useExhaustiveDependencies: `revision` re-asks when the run moves; trpc is a stable store singleton.
  useEffect(() => {
    if (!open) return
    let cancelled = false
    setState((prior) => ({ ...prior, loading: true, error: null }))
    trpc.workflows.status
      .query({ runId })
      .then((run) => {
        if (!cancelled) setState({ events: run.history, loading: false, error: null })
      })
      .catch((cause: unknown) => {
        if (cancelled) return
        setState({
          events: null,
          loading: false,
          error: cause instanceof Error ? cause.message : String(cause),
        })
      })
    return () => {
      cancelled = true
    }
  }, [runId, open, revision])
  return state
}
