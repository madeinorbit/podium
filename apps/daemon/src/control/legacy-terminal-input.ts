import type { ControlMessage } from '@podium/protocol/daemon'
import { sessionIsBehindContract } from '../runtime/handlers'
import type { DaemonContext } from './context'
import { dispatchNativeInputBytes } from './native-terminal-input'

type InputMetadata = Pick<Extract<ControlMessage, { type: 'input' }>, 'sessionId' | 'inputOrigin'>

/**
 * Mixed-peer adapter. The server sends automation bytes only for driverless
 * hosts now (POD-4279 deleted agent typing, interrupts, answers and sends):
 * a contracted session's turns, stops and answers arrive as runtime verbs,
 * never as input frames. Automation for a contracted session is therefore
 * refused here — accepting it would type over the driver's own injection.
 * Shell/login and older unbound hosts are a separate population (POD-4278)
 * and retain byte transport while they have a bridge.
 *
 * This adapter can write ONLY a bridge. It cannot borrow a Native client lease.
 * Human input is delegated to the permanent host boundary regardless of driver
 * availability.
 */
export function dispatchInputBytes(
  ctx: DaemonContext,
  metadata: InputMetadata,
  bytes: Uint8Array,
): void {
  if (metadata.inputOrigin === 'human') {
    dispatchNativeInputBytes(ctx, metadata, bytes)
    return
  }
  if (bytes.byteLength === 0) return
  // A contracted session speaks runtime verbs; an automation input frame for
  // one is either a stale peer or a bypass, and the bridge must not take it.
  if (sessionIsBehindContract(ctx, metadata.sessionId)) return
  const terminal = ctx.sessions.get(metadata.sessionId)?.terminal
  const bridge = terminal?.kind === 'headed' ? terminal : undefined
  if (!bridge) return
  if (bytes.includes(0x0d) || bytes.includes(0x0a)) {
    ctx.observers.recordInputOrigin(metadata.sessionId, metadata.inputOrigin)
  }
  bridge.write(bytes)
  ctx.composerEngine.onInputByte(metadata.sessionId)
}
