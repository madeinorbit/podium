import { asSessionId } from '@podium/model'
import { describe, expect, it, vi } from 'vitest'
import type { DaemonContext } from './context'
import { dispatchInputBytes } from './legacy-terminal-input'

const sessionId = asSessionId('legacy-input')
const bytes = Buffer.from('prompt\r')

function world(contracted: boolean, bridged: boolean) {
  const writeBytes = vi.fn()
  const input = vi.fn(() => true)
  const onInputByte = vi.fn()
  const recordInputOrigin = vi.fn()
  const ctx = {
    agentRuntime: { has: () => contracted },
    bridges: new Map(bridged ? [[sessionId, { writeBytes }]] : []),
    nativeClientRequests: new Set([sessionId]),
    clientTerminals: { input },
    composerEngine: { onInputByte },
    observers: { recordInputOrigin },
  } as unknown as DaemonContext
  return { ctx, writeBytes, input, recordInputOrigin, onInputByte }
}

describe('contracted automation refusal', () => {
  // POD-4279 deleted server agent typing, interrupts, answers and sends: a
  // contracted session's automation arrives as runtime verbs, never as input
  // frames. Accepting a frame here would type over the driver's own injection.
  // Flip the sessionIsBehindContract check off and contracted automation is
  // typed into the agent's PTY behind the driver's back. The check asks every
  // registry (not one family), so this holds for terminal and server families
  // alike.
  it('refuses automation for a contracted session even with a bridge', () => {
    const w = world(true, true)
    dispatchInputBytes(w.ctx, { sessionId, inputOrigin: 'controller' }, bytes)
    expect(w.writeBytes).not.toHaveBeenCalled()
    expect(w.input).not.toHaveBeenCalled()
    expect(w.recordInputOrigin).not.toHaveBeenCalled()
    expect(w.onInputByte).not.toHaveBeenCalled()
  })

  // Driverless hosts (POD-4278: shells, logins, profile-less and older unbound
  // peers) have no runtime verbs; the bridge is their only transport. Flip the
  // bridge write off and shell input stops working.
  it('keeps bridge transport for driverless hosts', () => {
    const w = world(false, true)
    dispatchInputBytes(w.ctx, { sessionId, inputOrigin: 'controller' }, bytes)
    expect(w.writeBytes).toHaveBeenCalledTimes(1)
    expect(w.onInputByte).toHaveBeenCalledTimes(1)
    expect(w.recordInputOrigin).toHaveBeenCalledTimes(1)
  })

  it('writes nowhere without a bridge, contracted or not', () => {
    for (const contracted of [true, false]) {
      const w = world(contracted, false)
      dispatchInputBytes(w.ctx, { sessionId, inputOrigin: 'controller' }, bytes)
      expect(w.writeBytes).not.toHaveBeenCalled()
      expect(w.input).not.toHaveBeenCalled()
      expect(w.onInputByte).not.toHaveBeenCalled()
    }
  })
})
