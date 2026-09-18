import { asSessionId } from '@podium/model'
import { describe, expect, it, vi } from 'vitest'
import type { DaemonContext } from './context'
import { dispatchNativeInputBytes } from './native-terminal-input'

const sessionId = asSessionId('native-input')
const bytes = Buffer.from('echo hello\r')
function world(contracted: boolean, bridged: boolean) {
  const bridge = { writeBytes: vi.fn() }
  const input = vi.fn(() => true)
  const recordInputOrigin = vi.fn()
  const onInputByte = vi.fn()
  const ctx = {
    agentRuntime: { has: () => contracted },
    bridges: new Map(bridged ? [[sessionId, bridge]] : []),
    nativeClientRequests: new Set([sessionId]),
    clientTerminals: { input },
    observers: { recordInputOrigin },
    composerEngine: { onInputByte },
  } as unknown as DaemonContext
  return { ctx, bridge, input, recordInputOrigin, onInputByte }
}

describe('native host byte boundary', () => {
  it.each([true, false])('accepts human bytes with contract=%s and no native client', (contracted) => {
    const w = world(contracted, true)
    if (!contracted) delete w.ctx.agentRuntime
    dispatchNativeInputBytes(w.ctx, { sessionId, inputOrigin: 'human' }, bytes)
    expect(w.bridge.writeBytes).toHaveBeenCalledWith(bytes)
    expect(w.input).not.toHaveBeenCalled()
    expect(w.recordInputOrigin).toHaveBeenCalledWith(sessionId, 'human')
    expect(w.onInputByte).toHaveBeenCalledWith(sessionId)
  })

  it.each(['controller', 'steward', 'mail', 'auto_continue', 'system', 'provider', 'unknown', undefined] as const)(
    'refuses programmatic or unspecified origin %s on both contract surfaces', (inputOrigin) => {
      for (const bridged of [true, false]) {
        const w = world(true, bridged)
        dispatchNativeInputBytes(w.ctx, { sessionId, inputOrigin }, bytes)
        expect(w.bridge.writeBytes).not.toHaveBeenCalled()
        expect(w.input).not.toHaveBeenCalled()
        expect(w.recordInputOrigin).not.toHaveBeenCalled()
        expect(w.onInputByte).not.toHaveBeenCalled()
      }
    },
  )

  it('requires both a native request and an accepting generation', () => {
    const w = world(true, false)
    w.ctx.nativeClientRequests?.clear()
    dispatchNativeInputBytes(w.ctx, { sessionId, inputOrigin: 'human' }, bytes)
    expect(w.input).not.toHaveBeenCalled()
    w.ctx.nativeClientRequests?.add(sessionId)
    w.input.mockReturnValue(false)
    dispatchNativeInputBytes(w.ctx, { sessionId, inputOrigin: 'human' }, bytes)
    expect(w.recordInputOrigin).not.toHaveBeenCalled()
    expect(w.onInputByte).not.toHaveBeenCalled()
    w.input.mockReturnValue(true)
    dispatchNativeInputBytes(w.ctx, { sessionId, inputOrigin: 'human' }, bytes)
    expect(w.input).toHaveBeenLastCalledWith(sessionId, bytes)
    expect(w.onInputByte).toHaveBeenCalledTimes(1)
  })
})
