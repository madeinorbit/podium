import {
  parseServedDescriptors,
  resolveDescriptors,
} from '@podium/harness/browser'
import type { HarnessDescriptorWire } from '@podium/protocol'
import type { MachineId } from '@podium/model/browser'
import { useEffect, useState } from 'react'
import { useStoreSelector } from '@/app/store'

/**
 * Resolved harness descriptors for components (POD-4475): the served
 * reports of every machine in scope, unioned over the bundled fallback, so
 * an older client renders a newer harness inside the schema it already has.
 *
 * Menus and setup flows span machines (the multi-machine "+" menu, the
 * first-task activation across eligible hosts), so this takes a SET: one
 * `machines.descriptors` query per defined id, failures and undefined ids
 * falling back to bundled. Mount-scoped (no shared cache): menus and setup
 * screens mount per gesture, and the client-core `useHarnessDescriptors`
 * hook owns the long-lived per-machine subscription.
 */
export function useResolvedDescriptors(
  machineIds: readonly (MachineId | undefined)[],
): HarnessDescriptorWire[] {
  const trpc = useStoreSelector((store) => store.trpc)
  const [served, setServed] = useState<HarnessDescriptorWire[][]>([])
  const key = machineIds.join(',')

  useEffect(() => {
    let live = true
    const ids = [...new Set(machineIds.filter((id): id is MachineId => id !== undefined))]
    if (ids.length === 0) {
      setServed([])
      return
    }
    void (async () => {
      const query = (trpc as unknown as
        | { machines?: { descriptors?: { query: (input: { machineId: MachineId }) => Promise<HarnessDescriptorWire[]> } } }
        | undefined)?.machines?.descriptors?.query
      if (!query) {
        if (live) setServed([])
        return
      }
      const settled = await Promise.all(
        ids.map((id) => query({ machineId: id }).catch(() => [] as HarnessDescriptorWire[])),
      )
      if (live) setServed(settled)
    })()
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trpc, key])

  return resolveDescriptors(parseServedDescriptors(served.flat()))
}
