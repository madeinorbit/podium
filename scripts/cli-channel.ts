import { getUpdateChannel, setUpdateChannel } from '../packages/core/src/setup'

/** `podium channel` -> show; `podium channel stable|edge` -> set. Returns the resulting channel. */
export function applyChannel(arg?: string): { channel: 'stable' | 'edge' } {
  if (arg === undefined) return { channel: getUpdateChannel() }
  if (arg !== 'stable' && arg !== 'edge')
    throw new Error(`unknown channel "${arg}" (use: stable | edge)`)
  return { channel: setUpdateChannel(arg) }
}
