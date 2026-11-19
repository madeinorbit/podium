import type { MachineId } from '@podium/model'

export { UPDATE_EFFECT_KIND } from '../operations/instance-effect-kinds'

/** An update's record targets the server's own machine. */
export const updateEffectTarget = (hostMachineId: MachineId) =>
  ({ kind: 'machine', id: hostMachineId }) as const
