/**
 * THE CREDENTIALS A SESSION CONTROL READS: my `credentials.list` (the pool's
 * shared credential models), my default per harness (my synced preferences)
 * and who holds custody of each machine (the machine models).
 *
 * Every composer, menu and session header shares ONE request per pool: the
 * list is read when the first of them opens and again when the page becomes
 * visible after a minute away, never once per session on screen.
 */

import { issueAgentDescriptors } from '@podium/client-core/agent-models'
import { useRequestClient } from '@podium/client-core/react'
import type { MobxPool } from '@podium/client-graph'
import { here } from '@podium/client-graph/lookup'
import { myPreferences } from '@podium/client-graph/per-user-records'
import { RecordRequest } from '@podium/client-graph/requested-records'
import type { AccessRefusal, CredentialView, MachineId, SessionId } from '@podium/model'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useWorklistPool, useWorklistPoolProjection } from '@/app/store-worklist-pool'
import type { Trpc } from '@/app/trpc'
import { useHarnessDescriptors } from '@/lib/use-harness-descriptors'
import type { AcceptLine, CustodianOf } from './session-credential-facts'

const STALE_MS = 60_000

interface SharedList {
  readonly request: RecordRequest<'credential'>
  readAt: number
}
const lists = new WeakMap<MobxPool, SharedList>()

/**
 * The pool's one credential request, made when a control first opens (in an
 * effect, never while rendering). A stand-in pool without the requested-records
 * source (a screen test's) gets none, and the controls show the default.
 */
function sharedList(pool: MobxPool): SharedList | undefined {
  let list = lists.get(pool)
  if (!list) {
    try {
      list = {
        request: new RecordRequest(pool, 'credential', (row) => row.id as string),
        readAt: 0,
      }
    } catch {
      return undefined
    }
    lists.set(pool, list)
  }
  return list
}

export interface SessionCredentials {
  /** Undefined until the list has been read once. */
  readonly views: readonly CredentialView[] | undefined
  readonly defaults: Readonly<Record<string, string | undefined>>
  readonly custodianOf: CustodianOf
  /** Read the list again (after a switch or a renewal elsewhere). */
  readonly reload: () => void
}

const EMPTY_DEFAULTS: Readonly<Record<string, string | undefined>> = {}

function defaultsOf(pool: MobxPool): Readonly<Record<string, string | undefined>> {
  return (
    (myPreferences(pool)?.credentialDefaults as Record<string, string> | undefined) ??
    EMPTY_DEFAULTS
  )
}

export function useSessionCredentials(): SessionCredentials {
  const pool = useWorklistPool()
  const trpc = useRequestClient<Trpc>()
  const [list, setList] = useState<SharedList | undefined>(undefined)
  const reload = useCallback(() => {
    const shared = pool ? sharedList(pool) : undefined
    if (!shared) return
    shared.readAt = Date.now()
    void shared.request.read(() => trpc.credentials.list.query())
  }, [pool, trpc])
  useEffect(() => {
    if (!pool) return
    setList(sharedList(pool))
    const refresh = () => {
      if (document.visibilityState === 'hidden') return
      const shared = sharedList(pool)
      if (shared && Date.now() - shared.readAt >= STALE_MS) reload()
    }
    refresh()
    document.addEventListener('visibilitychange', refresh)
    return () => document.removeEventListener('visibilitychange', refresh)
  }, [pool, reload])
  const viewsOf = useCallback(
    (_pool: MobxPool): readonly CredentialView[] | undefined =>
      list === undefined || list.request.answer === undefined
        ? undefined
        : // A credential model carries the view's fields; its id is the same value.
          (list.request.models as unknown as readonly CredentialView[]),
    [list],
  )
  const views = useWorklistPoolProjection(viewsOf, undefined)
  const defaults = useWorklistPoolProjection(defaultsOf, EMPTY_DEFAULTS)
  const custodianOf = useCallback<CustodianOf>(
    (machineId) => {
      if (!pool) return undefined
      return here(pool.model('machine', machineId))?.custodian as string | null | undefined
    },
    [pool],
  )
  return { views, defaults, custodianOf, reload }
}

const NO_LINES: readonly AcceptLine[] = []

/** What each harness accepts, from the machine's served descriptors (the
 *  bundled ones until they arrive). */
export function useHarnessAccepts(
  machineId: string | undefined,
): (harness: string) => readonly AcceptLine[] {
  const { served } = useHarnessDescriptors(machineId as MachineId | undefined)
  const descriptors = useMemo(() => issueAgentDescriptors(served), [served])
  return useCallback(
    (harness) => descriptors.find((d) => d.kind === harness)?.accepts ?? NO_LINES,
    [descriptors],
  )
}

/** Why this session's start was refused for its credential, from its launch record. */
export function usePaneLaunchRefusal(sessionId: SessionId | undefined): AccessRefusal | undefined {
  const read = useCallback(
    (pool: MobxPool) => (sessionId ? pool.sessionObject(sessionId).launchRefusal : undefined),
    [sessionId],
  )
  return useWorklistPoolProjection(read, undefined)
}
