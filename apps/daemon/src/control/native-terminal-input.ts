import { createLogger } from '@podium/logger'
import type { ControlMessage } from '@podium/protocol/daemon'
import { driverTiming } from '../runtime/driver-timing'
import type { DaemonContext } from './context'

const log = createLogger('native-terminal-input')
type InputMetadata = Pick<Extract<ControlMessage, { type: 'input' }>, 'sessionId' | 'inputOrigin'>

/**
 * Host attachment transport, not a turn-delivery API. Both negotiated binary
 * input and legacy base64 frames converge here. The server admits the current
 * human controller; a headed client additionally requires a live Native request
 * and an accepting client generation. A stream descriptor alone grants no input.
 *
 * Bound agents accept automation through runtime send/answer/continue verbs.
 * Shell/login terminals use this same human path without any runtime handle.
 * Rollout compatibility belongs to legacy-terminal-input, never this boundary.
 */
export function dispatchNativeInputBytes(
  ctx: DaemonContext,
  metadata: InputMetadata,
  bytes: Uint8Array,
): void {
  if (bytes.byteLength === 0) return
  if (metadata.inputOrigin !== 'human') {
    log.warn('discarding non-human native terminal bytes', {
      sessionId: metadata.sessionId,
      inputOrigin: metadata.inputOrigin,
    })
    return
  }

  const bridge = ctx.sessions.get(metadata.sessionId)?.terminal
  if (bridge) {
    bridge.write(bytes)
  } else if (
    !ctx.nativeClientRequests?.has(metadata.sessionId) ||
    !ctx.clientTerminals?.input(metadata.sessionId, bytes)
  ) {
    // Release revokes the request and the client generation before awaiting
    // disposal. Warm masters are resources, never authority to accept input.
    return
  }

  const submitted = bytes.includes(0x0d) || bytes.includes(0x0a)
  if (submitted) ctx.observers.recordInputOrigin(metadata.sessionId, metadata.inputOrigin)
  if (bridge && metadata.inputOrigin === 'human' && submitted) {
    driverTiming.nativePromptSubmitted(metadata.sessionId)
  }
  // Only accepted bytes make the native replica hot or change attribution.
  ctx.composerEngine.onInputByte(metadata.sessionId)
}
