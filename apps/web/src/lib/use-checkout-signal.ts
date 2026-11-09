import { useStoreHandle } from '@podium/client-core/react'
import { checkoutRefresh, replicaAnswerMachines } from '@podium/client-graph/answer-refresh'
import type { MachineId } from '@podium/model'
import { useMemo } from 'react'

/** The view model owns the subscription; React supplies only its address. */
export function useCheckoutSignal(machineId: MachineId | undefined, path: string) {
  const { hub, replica } = useStoreHandle()
  return useMemo(
    () => checkoutRefresh(hub, replicaAnswerMachines(replica), machineId, path),
    [hub, replica, machineId, path],
  )
}
