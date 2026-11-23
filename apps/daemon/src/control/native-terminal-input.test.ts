import { asSessionId } from '@podium/model'
import type { DurableAttachment } from '@podium/process/screen'
import { describe, expect, it, vi } from 'vitest'
import { attachTestTerminal, testSessions } from '../session/testing.js'
import { memoryMarkers, SessionAccessStore } from './access'
import type { DaemonContext } from './context'
import { dispatchNativeInputBytes } from './native-terminal-input'

const sessionId = asSessionId('native-input')
const bytes = Buffer.from('echo hello\r')
function world(contracted: boolean, bridged: boolean) {
  const writeBytes = vi.fn()
  const bridge = {
    pid: 1,
    onFrame: () => () => {},
    onTitle: () => () => {},
    onExit: () => () => {},
    write: () => {},
    writeBytes,
    resize: () => {},
    dispose: () => {},
  } as unknown as DurableAttachment
  const input = vi.fn(() => true)
  const recordInputOrigin = vi.fn()
  const sessions = testSessions()
  sessions.ensure(sessionId).nativeRequested = true
  const ctx = {
    agentRuntime: { has: () => contracted },
    sessions,
    clientTerminals: { input },
    observers: { recordInputOrigin },
    access: new SessionAccessStore({ markers: memoryMarkers() }),
  } as unknown as DaemonContext
  if (bridged) attachTestTerminal(ctx, sessionId, bridge)
  return { ctx, bridge: { writeBytes }, input, recordInputOrigin }
}

describe('native host byte boundary', () => {
  it.each([
    true,
    false,
  ])('accepts human bytes with contract=%s and no native client', (contracted) => {
    const w = world(contracted, true)
    if (!contracted) delete w.ctx.agentRuntime
    dispatchNativeInputBytes(w.ctx, { sessionId, inputOrigin: 'human' }, bytes)
    expect(w.bridge.writeBytes).toHaveBeenCalledWith(bytes)
    expect(w.input).not.toHaveBeenCalled()
    expect(w.recordInputOrigin).toHaveBeenCalledWith(sessionId, 'human')
  })

  it.each([
    'controller',
    'steward',
    'mail',
    'auto_continue',
    'system',
    'provider',
    'unknown',
    undefined,
  ] as const)('refuses programmatic or unspecified origin %s on both contract surfaces', (inputOrigin) => {
    for (const bridged of [true, false]) {
      const w = world(true, bridged)
      dispatchNativeInputBytes(w.ctx, { sessionId, inputOrigin }, bytes)
      expect(w.bridge.writeBytes).not.toHaveBeenCalled()
      expect(w.input).not.toHaveBeenCalled()
      expect(w.recordInputOrigin).not.toHaveBeenCalled()
    }
  })

  it('requires both a native request and an accepting generation', () => {
    const w = world(true, false)
    w.ctx.sessions.get(sessionId)!.nativeRequested = false
    dispatchNativeInputBytes(w.ctx, { sessionId, inputOrigin: 'human' }, bytes)
    expect(w.input).not.toHaveBeenCalled()
    w.ctx.sessions.get(sessionId)!.nativeRequested = true
    w.input.mockReturnValue(false)
    dispatchNativeInputBytes(w.ctx, { sessionId, inputOrigin: 'human' }, bytes)
    expect(w.recordInputOrigin).not.toHaveBeenCalled()
    w.input.mockReturnValue(true)
    dispatchNativeInputBytes(w.ctx, { sessionId, inputOrigin: 'human' }, bytes)
    expect(w.input).toHaveBeenLastCalledWith(sessionId, bytes)
  })
})
