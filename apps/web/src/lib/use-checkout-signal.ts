import { useStoreHandle } from '@podium/client-core/react'
import { checkoutRefresh } from '@podium/client-graph/answer-refresh'
import type { MachineId } from '@podium/model'
import { useMemo } from 'react'

/** The view model owns the subscription; React supplies only its address. */
export function useCheckoutSignal(machineId: MachineId | undefined, path: string) {
  const { hub } = useStoreHandle()
  return useMemo(() => checkoutRefresh(hub, machineId, path), [hub, machineId, path])
}
