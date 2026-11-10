import type { MachineVersionState } from './service'

export function deriveVersionState(
  reported: string | null,
  target: string | undefined,
): MachineVersionState {
  if (!reported || !target) return 'unreported'
  return reported === target ? 'current' : 'behind'
}
