/**
 * THE WORKFLOWS SOURCE (POD-647) — one hook that owns fetching, dispatching and
 * failure, so the components own none of it.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A HOOK AND NOT A `SliceDefinition`
 * ---------------------------------------------------------------------------
 *
 * Every published slice in `@podium/client-core/viewmodels` derives from the
 * replica snapshot. Workflows are not replicated — they arrive over RPC — and
 * whether they SHOULD be replicated is POD-1127's open decision, which this
 * issue must not settle. So the derivations live in the platform-neutral
 * `slices/workflows.ts` where any source can drive them, and this hook is the
 * source they have TODAY. When POD-1127 lands, the derivations do not move; only
 * what feeds them does.
 *
 * ---------------------------------------------------------------------------
 * A DENIED WRITE ROLLS BACK AND IS SURFACED. IT IS NOT RETRIED.
 * ---------------------------------------------------------------------------
 *
 * ADR 3 D8 re-authorizes every write at apply, so a denial is ROUTINE now rather
 * than exceptional: rights can change between render and apply, and an outbox
 * replay can arrive after they changed. `dispatch` therefore treats a refusal as
 * a terminal outcome — it surfaces the message and refetches so the surface
 * shows what the authority actually holds — and never re-sends. A retry loop
 * against a denial is an unbounded loop by construction, and it is also how a
 * UI turns one refusal into a rate-limit incident.
 *
 * The refetch is what performs the rollback: nothing on this surface writes an
 * optimistic overlay of its own, so re-reading the authority IS restoring truth.
 * The success sentence is shown only AFTER the apply resolves, never
 * optimistically, so a denial never has a success message to take back.
 *
 * ---------------------------------------------------------------------------
 * EVICTION LEAVES QUIETLY, AND NEVER HEALS
 * ---------------------------------------------------------------------------
 *
 * Under POD-1077 the open workflow can lose visibility with no revision moving.
 * The refresh notices only that the open id is no longer among the rows it can
 * see, and CLEARS the selection: no tombstone, no toast, no deletion affordance.
 * Crucially it does not re-request the vanished id, which is the heal loop the
 * old code would have entered — its detail effect fetched whatever `selectedId`
 * held and surfaced the failure as an error banner, forever.
 */
import type {
  ExecutionProfileWire,
  WorkflowBindingWire,
  WorkflowDetailWire,
  WorkflowRunWire,
  WorkflowWire,
} from '@podium/protocol'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useStoreSelector } from '@/app/store'
import type { WorkflowCommand } from './workflow-commands'

export interface WorkflowsSource {
  readonly workflows: WorkflowWire[]
  readonly bindings: WorkflowBindingWire[]
  readonly profiles: ExecutionProfileWire[]
  readonly runs: WorkflowRunWire[]
  readonly detail: WorkflowDetailWire | null
  readonly selectedId: string | null
  readonly loading: boolean
  readonly refreshing: boolean
  readonly error: string | null
  readonly notice: string | null
  readonly showHistory: boolean
  select(id: string | null): void
  setShowHistory(next: boolean): void
  refresh(includeTerminal?: boolean): Promise<void>
  /** Dispatch one command contract. Resolves `true` when the authority applied
   *  it, `false` when it refused — never throws, and never retries. */
  dispatch<TInput>(command: WorkflowCommand<TInput>, input: TInput): Promise<boolean>
}

/** The tRPC arm that serves the workflow contracts, indexed by the same bare
 *  name `registry.ts` joins each contract to its handler under. Typed loosely
 *  HERE and only here: the contract's own schema is the validator, and a
 *  per-name union would restate it in a second place. */
type WorkflowProcs = Record<string, { mutate(input: unknown): Promise<unknown> }>

export function useWorkflows(): WorkflowsSource {
  const trpc = useStoreSelector((state) => state.trpc)
  const [workflows, setWorkflows] = useState<WorkflowWire[]>([])
  const [bindings, setBindings] = useState<WorkflowBindingWire[]>([])
  const [profiles, setProfiles] = useState<ExecutionProfileWire[]>([])
  const [runs, setRuns] = useState<WorkflowRunWire[]>([])
  const [detail, setDetail] = useState<WorkflowDetailWire | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [showHistory, setShowHistory] = useState(false)
  const refreshLock = useRef(false)
  // Bumped by every completed refresh so the open workflow's DETAIL re-reads
  // too. The old code re-fetched detail inline at the end of each action, which
  // meant a refresh triggered from anywhere else left the editor showing the
  // revision list from before the write.
  const [detailNonce, setDetailNonce] = useState(0)
  // The id the detail read is allowed to answer for. Read at RESOLVE time so a
  // selection that changed (or was evicted) mid-flight discards the late reply
  // instead of painting a row the principal no longer has.
  const wanted = useRef<string | null>(null)

  // biome-ignore lint/correctness/useExhaustiveDependencies: trpc is a stable store singleton.
  const refresh = useCallback(
    async (includeTerminal = showHistory): Promise<void> => {
      if (refreshLock.current) return
      refreshLock.current = true
      setRefreshing(true)
      setError(null)
      try {
        const [workflowRows, bindingRows, profileRows, runRows] = await Promise.all([
          trpc.workflows.list.query({}),
          trpc.workflows.bindings.query({}),
          trpc.workflows.profiles.query({}),
          trpc.workflows.runs.query({ includeTerminal }),
        ])
        setWorkflows(workflowRows)
        setBindings(bindingRows)
        setProfiles(profileRows)
        setRuns(runRows)

        // The open row, re-decided against what is visible NOW. An id that is no
        // longer in the list has been EVICTED as far as this client can tell,
        // and eviction is not a deletion: the selection simply moves on, with no
        // announcement and no re-request of the id.
        const visible = new Set(workflowRows.map((row) => row.id))
        setSelectedId((current) => {
          if (current !== null && visible.has(current)) return current
          const next = workflowRows[0]?.id ?? null
          if (current !== null && current !== next) setDetail(null)
          return next
        })
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        refreshLock.current = false
        setRefreshing(false)
        setLoading(false)
        setDetailNonce((n) => n + 1)
      }
    },
    [showHistory],
  )

  useEffect(() => {
    void refresh()
  }, [refresh])

  // biome-ignore lint/correctness/useExhaustiveDependencies: refetch on selection only; trpc is a stable store singleton.
  useEffect(() => {
    wanted.current = selectedId
    if (!selectedId) {
      setDetail(null)
      return
    }
    let cancelled = false
    void trpc.workflows.get
      .query({ id: selectedId })
      .then((next) => {
        if (!cancelled && wanted.current === selectedId) setDetail(next)
      })
      .catch((cause) => {
        if (cancelled || wanted.current !== selectedId) return
        // A detail read that fails for an id we still want is a real error and
        // is surfaced ONCE. It is never re-issued: an id that is gone from our
        // world would otherwise be requested forever.
        setDetail(null)
        setError(cause instanceof Error ? cause.message : String(cause))
      })
    return () => {
      cancelled = true
    }
  }, [selectedId, detailNonce])

  const dispatch = useCallback(
    async <TInput,>(command: WorkflowCommand<TInput>, input: TInput): Promise<boolean> => {
      setError(null)
      setNotice(null)
      const procs = trpc.workflows as unknown as WorkflowProcs
      try {
        const proc = procs[command.contract]
        // A contract name with no proc behind it is a BUILD-TIME mistake, not a
        // runtime condition — but it must not reach the transport as
        // `undefined.mutate`, whose failure would read like a denial.
        if (!proc) throw new Error(`no transport for workflow contract ${command.contract}`)
        await proc.mutate(command.build(input))
      } catch (cause) {
        // TERMINAL. The authority refused (or the transport failed) and this
        // path does not decide which — both are surfaced identically, and
        // neither is retried. The refresh restores what the authority actually
        // holds; that IS the rollback.
        //
        // ORDER MATTERS, and it cost a test to find: `refresh` clears the error
        // region on entry (a fresh read is a fresh verdict), so setting the
        // refusal BEFORE refreshing would wipe it and leave a denial silent.
        // The message is therefore held and written after the re-read settles.
        const message = cause instanceof Error ? cause.message : String(cause)
        await refresh()
        setError(message)
        return false
      }
      setNotice(command.success)
      await refresh()
      return true
    },
    [refresh, trpc],
  )

  const select = useCallback((id: string | null): void => {
    setSelectedId(id)
  }, [])

  return {
    workflows,
    bindings,
    profiles,
    runs,
    detail,
    selectedId,
    loading,
    refreshing,
    error,
    notice,
    showHistory,
    select,
    setShowHistory,
    refresh,
    dispatch,
  }
}
