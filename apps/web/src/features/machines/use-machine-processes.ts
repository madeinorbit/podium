import { useSocketHub, useReplica } from '@podium/client-core/react'
import { replicaAnswerMachines } from '@podium/client-graph/answer-refresh'
import { MachineProcessesView } from '@podium/client-graph/machine-processes-view'
import type { MachineId } from '@podium/model'
import { reaction } from 'mobx'
import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react'
import { useTabVisible } from '@/lib/use-polled-query'

/** The view owns one demand-bound processes value; memory/reclaim readers share
 * the underlying topic key through the hub's reference count. */
export function useMachineProcesses(machineId?: MachineId) {
  const hub = useSocketHub()
  const replica = useReplica()
  const view = useMemo(
    () => new MachineProcessesView(hub, replicaAnswerMachines(replica), machineId),
    [hub, replica, machineId],
  )
  const visible = useTabVisible()
  useEffect(() => {
    if (visible) view.open()
    return () => view.close()
  }, [view, visible])
  const subscribe = useCallback(
    (changed: () => void) => reaction(() => view.snapshot, changed),
    [view],
  )
  const get = useCallback(() => view.snapshot, [view])
  const snapshot = useSyncExternalStore(subscribe, get)
  return {
    data: snapshot.value?.breakdown ?? null,
    inventory: snapshot.value?.reclaim ?? null,
    error: snapshot.error,
    reclaimError: snapshot.value?.reclaimError ?? snapshot.error,
    fetchedAt: snapshot.value ? Date.parse(snapshot.value.breakdown.sampledAt) : null,
    pending: snapshot.pending,
    failed: snapshot.error !== null,
    refresh: useCallback(() => view.refresh(), [view]),
  }
}
