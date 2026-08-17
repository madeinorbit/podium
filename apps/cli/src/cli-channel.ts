import type { FleetUpdateChannel } from '@podium/runtime/config'
import { getUpdateChannel, setUpdateChannel } from '@podium/runtime/setup'

/**
 * THE CHANNELS THIS PRODUCT HAS, in one list (POD-2196).
 *
 * `dev` was missing here and nowhere else: the config schema accepts it,
 * `FleetUpdateChannel` names it, and it is the only channel a source checkout's
 * own `dev+<sha>` target is ever published on. So a machine running from source
 * could not be pinned to the one channel that applies to it — it sat on
 * `stable`, where its target never appears, and the only way to reach `dev` was
 * the `PODIUM_UPDATE_CHANNEL` environment variable.
 */
const CHANNELS: readonly FleetUpdateChannel[] = ['stable', 'edge', 'dev']

/** `podium channel` -> show; `podium channel stable|edge|dev` -> set. Returns the resulting channel. */
export function applyChannel(arg?: string): { channel: FleetUpdateChannel } {
  if (arg === undefined) return { channel: getUpdateChannel() }
  if (!CHANNELS.includes(arg as FleetUpdateChannel))
    throw new Error(`unknown channel "${arg}" (use: ${CHANNELS.join(' | ')})`)
  return { channel: setUpdateChannel(arg as FleetUpdateChannel) }
}
