import type { ControlMessage } from '@podium/protocol/daemon'
import { handleFor, sessionIsBehindContract } from '../runtime/handlers'
import type { DaemonContext } from './context'
import { dispatchNativeInputBytes } from './native-terminal-input'

type InputMetadata = Pick<Extract<ControlMessage, { type: 'input' }>, 'sessionId' | 'inputOrigin'>

/**
 * Mixed-peer adapter. POD-4291 still owns terminal-family legacy inbox batches;
 * their existence cannot be inferred from a runtime binding alone. Remove that
 * rollout arm only after those callers migrate. Shell/login and older unbound
 * hosts are a separate population and must retain byte transport.
 *
 * This adapter can write ONLY a bridge. It cannot borrow a Native client lease,
 * and server-family contract automation must use runtime verbs. Human input is
 * delegated to the permanent host boundary regardless of driver availability.
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
  if (
    sessionIsBehindContract(ctx, metadata.sessionId) &&
    handleFor(ctx, metadata.sessionId)?.binding.family !== 'terminal'
  ) return
  const bridge = ctx.bridges.get(metadata.sessionId)
  if (!bridge) return
  if (bytes.includes(0x0d) || bytes.includes(0x0a)) {
    ctx.observers.recordInputOrigin(metadata.sessionId, metadata.inputOrigin)
  }
  bridge.writeBytes(bytes)
  ctx.composerEngine.onInputByte(metadata.sessionId)
}
