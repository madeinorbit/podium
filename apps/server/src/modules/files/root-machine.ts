import type { MachineId } from '@podium/model'
import { TRPCError } from '@trpc/server'

/** A root without a pin must belong to exactly one registered machine. */
export async function resolveFileRootMachine(
  root: string,
  machineId: MachineId | undefined,
  machinesForRoot: (root: string) => Promise<MachineId[]>,
): Promise<MachineId> {
  if (machineId !== undefined) return machineId
  const machines = [...new Set(await machinesForRoot(root))]
  if (machines.length > 1) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'repository root is registered on several machines; specify machineId',
    })
  }
  const machine = machines[0]
  if (machine === undefined) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'root is not a known repository path' })
  }
  return machine
}
