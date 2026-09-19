/**
 * THE GENERIC PROCEDURE COMPOSITIONS (POD-4303).
 *
 * `driver.ts` promises that absent a declared override, the generic composition
 * in `./procedures.ts` IS the implementation. These are the properties that
 * promise rests on, run against the in-memory reference driver: the terminal
 * event belongs to the sent turn (never a stale epoch), refusals throw typed
 * (never masquerade as outcomes), failures return-or-throw in the documented
 * direction, timeouts interrupt rather than orphan, one-shots die on every
 * path, and overrides win over generics.
 */

import { unsupported } from '@podium/harness'
import type { SessionId, TranscriptItem } from '@podium/model'
import { describe, expect, it } from 'vitest'
import type { AgentSessionHandle, RuntimeDriver } from './driver.js'
import { isDriverRefusal } from './errors.js'
import {
  genericAskAndAwait,
  genericOneShot,
  isTerminalTurnEvent,
  resolveProcedures,
} from './procedures.js'
import type { SessionSpec } from './session-spec.js'
import { createFakeDriver, resetFakeRuntime, type FakeDriver } from './testing/fake-driver.js'

const SPEC: SessionSpec = {
  harness: 'fake-harness',
  selection: { auth: 'unknown', platform: 'linux', available: ['fake'] },
  workdir: '/repo',
  model: {},
  instructions: unsupported('procedures test needs no instructions'),
  mcpServers: unsupported('procedures test needs no MCP servers'),
}

function item(id: string, text: string): TranscriptItem {
  return { id, role: 'assistant', text, ts: '2026-09-19T00:00:00.000Z' }
}

async function createSession(driver: FakeDriver): Promise<{ handle: AgentSessionHandle; sessionId: SessionId }> {
  const handle = await driver.create(SPEC)
  return { handle, sessionId: handle.binding.sessionId }
}

describe('genericAskAndAwait', () => {
  it('resolves the completed event for the sent turn, ignoring earlier epochs', async () => {
    resetFakeRuntime()
    const driver = createFakeDriver()
    const { handle, sessionId } = await createSession(driver)
    // An earlier turn, fully fenced before the procedure runs: its terminal
    // event sits in the bootstrap snapshot and must not satisfy the wait.
    await handle.send({ text: 'earlier' }, { origin: 'agent', delivery: 'when-ready' })
    driver.control.completeTurn(sessionId)

    const waited = genericAskAndAwait(handle, { text: 'hello' })
    // Let the send resolve before the provider confirms, as production does.
    await new Promise((resolve) => setTimeout(resolve, 10))
    driver.control.completeTurn(sessionId)
    const terminal = await waited
    expect(terminal.ev).toBe('completed')
    if (terminal.ev === 'completed') expect(terminal.verdict).toBe('done')
    expect(terminal.turnEpoch).toBe(2)
  })

  it('throws a typed refusal when the send is refused', async () => {
    resetFakeRuntime()
    const driver = createFakeDriver()
    const { handle, sessionId } = await createSession(driver)
    driver.control.askInteraction(sessionId, 'question')
    await expect(genericAskAndAwait(handle, { text: 'blocked' })).rejects.toSatisfy(
      (error: unknown) => isDriverRefusal(error),
    )
  })

  it('returns the failed event rather than throwing it', async () => {
    resetFakeRuntime()
    const driver = createFakeDriver()
    const { handle, sessionId } = await createSession(driver)
    const waited = genericAskAndAwait(handle, { text: 'doomed' })
    await new Promise((resolve) => setTimeout(resolve, 10))
    driver.control.failTurn(sessionId, 'provider-error')
    const terminal = await waited
    expect(terminal.ev).toBe('failed')
    if (terminal.ev === 'failed') expect(terminal.reason).toBe('provider-error')
  })

  it('waits for the next epoch when the receipt is queued', async () => {
    resetFakeRuntime()
    const driver = createFakeDriver()
    const { handle, sessionId } = await createSession(driver)
    // Hold a turn open so the procedure's send parks behind it.
    await handle.send({ text: 'first' }, { origin: 'agent', delivery: 'when-ready' })
    const waited = genericAskAndAwait(handle, { text: 'second' })
    await new Promise((resolve) => setTimeout(resolve, 10))
    // Closing the first turn drains the queue into epoch 2; closing that one
    // is the terminal event the procedure must return.
    driver.control.completeTurn(sessionId)
    driver.control.completeTurn(sessionId)
    const terminal = await waited
    expect(terminal.ev).toBe('completed')
    expect(terminal.turnEpoch).toBe(2)
  })

  it('interrupts and throws on timeout', async () => {
    // The turn never fences, so the timeout path is the only way out — and
    // the wrapped interrupt is the observable proof it interrupts rather
    // than orphans.
    resetFakeRuntime()
    const driver = createFakeDriver()
    const { handle } = await createSession(driver)
    let interrupted = false
    const wrapping: AgentSessionHandle = {
      ...handle,
      interrupt: async () => {
        interrupted = true
        return handle.interrupt()
      },
    }
    await expect(
      genericAskAndAwait(wrapping, { text: 'hangs' }, { timeoutMs: 20 }),
    ).rejects.toThrow(/timed out after 20ms/)
    expect(interrupted).toBe(true)
    // Settle the abandoned wait: the fence the interrupt requested arrives and
    // the session stays usable for the next turn.
    const sessionId = handle.binding.sessionId
    driver.control.completeTurn(sessionId)
    await expect(
      handle.send({ text: 'after' }, { origin: 'agent', delivery: 'when-ready' }),
    ).resolves.toMatchObject({ outcome: 'accepted' })
  })

  it('aborts on an already-aborted signal without sending', async () => {
    resetFakeRuntime()
    const driver = createFakeDriver()
    const { handle } = await createSession(driver)
    const controller = new AbortController()
    controller.abort()
    await expect(
      genericAskAndAwait(handle, { text: 'never' }, { signal: controller.signal }),
    ).rejects.toThrow(/aborted/)
    expect(driver.control.textDeliveries(handle.binding.sessionId)).toBe(0)
  })
})

describe('genericOneShot', () => {
  it('returns the turn transcript and kills the handle', async () => {
    resetFakeRuntime()
    const driver = createFakeDriver()
    let captured: AgentSessionHandle | undefined
    const capturing: RuntimeDriver = {
      ...driver,
      create: async (spec) => {
        captured = await driver.create(spec)
        return captured
      },
    }
    const shot = genericOneShot(capturing, SPEC, 'summarise')
    await new Promise((resolve) => setTimeout(resolve, 10))
    if (!captured) throw new Error('one-shot never created its session')
    const sessionId = captured.binding.sessionId
    driver.control.emitItem(sessionId, item('one-shot-1', 'done'))
    driver.control.completeTurn(sessionId)
    const items = await shot
    expect(items.map((entry) => entry.text)).toContain('done')
    // Killed in every path: a further send is refused as not running.
    await expect(
      captured.send({ text: 'after' }, { origin: 'agent', delivery: 'when-ready' }),
    ).resolves.toMatchObject({ outcome: 'refused' })
  })

  it('throws on a failed turn', async () => {
    resetFakeRuntime()
    const driver = createFakeDriver()
    let sessionId: SessionId | undefined
    const capturing: RuntimeDriver = {
      ...driver,
      create: async (spec) => {
        const handle = await driver.create(spec)
        sessionId = handle.binding.sessionId
        return handle
      },
    }
    const shot = genericOneShot(capturing, SPEC, 'doomed')
    await new Promise((resolve) => setTimeout(resolve, 10))
    if (!sessionId) throw new Error('one-shot never created its session')
    driver.control.failTurn(sessionId, 'rate-limit')
    await expect(shot).rejects.toThrow(/rate-limit/)
  })
})

describe('resolveProcedures', () => {
  it('prefers the driver override over the generic composition', async () => {
    resetFakeRuntime()
    const driver = createFakeDriver()
    const marker = [item('native-1', 'native one-shot')]
    const overriding: RuntimeDriver = {
      ...driver,
      procedures: { oneShot: async () => marker },
    }
    const resolved = resolveProcedures(overriding)
    await expect(resolved.oneShot(SPEC, 'anything')).resolves.toBe(marker)
  })

  it('falls back to the generics with no override', async () => {
    resetFakeRuntime()
    const driver = createFakeDriver()
    const resolved = resolveProcedures(driver)
    // The resolved askAndAwait is the composition, not a missing override:
    // drive a turn on a fresh handle and await its fence.
    const handle = await driver.create(SPEC)
    const waited = resolved.askAndAwait(handle, { text: 'hello' })
    await new Promise((resolve) => setTimeout(resolve, 10))
    driver.control.completeTurn(handle.binding.sessionId)
    const terminal = await waited
    expect(terminal.ev).toBe('completed')
  })
})

describe('isTerminalTurnEvent', () => {
  it('treats only completed and failed as terminal', () => {
    expect(isTerminalTurnEvent({ ev: 'started', turnEpoch: 1, origin: 'agent' })).toBe(false)
    expect(isTerminalTurnEvent({ ev: 'completed', turnEpoch: 1, verdict: 'done' })).toBe(true)
    expect(
      isTerminalTurnEvent({ ev: 'failed', turnEpoch: 1, reason: 'timeout', disposition: 'retryable' }),
    ).toBe(true)
  })
})
