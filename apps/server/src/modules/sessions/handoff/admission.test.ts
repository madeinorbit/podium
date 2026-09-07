/**
 * THE ADMISSION PHASE, TESTED WITHOUT A TRANSFER — POD-1399.
 *
 * The single-flight property (obligation 3) was previously reachable only by
 * dispatching two real handoffs at a two-machine registry and inspecting what
 * the daemons were asked to do. Here the thing being coalesced is a thunk, so
 * "the second dispatch did not start a second transfer" is an assertion about a
 * call count rather than about the absence of a duplicate spawn.
 *
 * THE PROPERTY THAT MATTERS MOST IS THE ONE THAT IS EASY TO LOSE: a caller that
 * JOINS an in-flight transfer is authorized with its OWN gate. A join that
 * skipped the gate would answer "your move succeeded" to someone who was never
 * allowed to ask, and every other test here would still pass.
 */

import { asMachineId, asSessionId, FIRST_ADMIN_USER_ID } from '@podium/model'
import { describe, expect, it, vi } from 'vitest'
import { userCommandPrincipal } from '../../../command-principal'
import { Session } from '../session'
import { HandoffAdmission } from './admission'
import type { HandoffCaller, HandoffResult } from './ports'

const SOURCE = asMachineId('m-source')
const TARGET = asMachineId('m-target')
const OTHER = asMachineId('m-other')
const SESSION = asSessionId('s1')

const caller = (): HandoffCaller => {
  const principal = userCommandPrincipal(FIRST_ADMIN_USER_ID, 'admin')
  return { capability: principal.capability, principal }
}

function makeSession(over: { agentKind?: string; resume?: boolean } = {}): Session {
  return new Session({
    sessionId: SESSION,
    durableLabel: 'podium-s1',
    // `opencode` declares handoff: false in its harness manifest; `claude-code`
    // declares true. The capability table is the source, not this file.
    agentKind: (over.agentKind ?? 'claude-code') as 'claude-code',
    cwd: '/repo/wt/feature',
    title: 'feature',
    origin: { kind: 'spawn' },
    createdAt: '2026-08-02T00:00:00.000Z',
    geometry: { cols: 80, rows: 24 },
    machineId: SOURCE,
    ...(over.resume === false ? {} : { resume: { kind: 'claude-session', value: 'conv-1' } }),
    toDaemon: vi.fn(),
  })
}

const admissionFor = (session: Session | undefined) =>
  new HandoffAdmission({ getSession: () => session })

const ok = (newCwd = '/target/wt'): HandoffResult => ({ ok: true, newCwd })

/** A gate that records what it was asked, and can be told to deny. */
function gate(denyFor?: string) {
  const seen: string[] = []
  const assert = (machineId: string) => {
    seen.push(machineId)
    if (machineId === denyFor) throw new Error(`denied: ${machineId}`)
  }
  return { assert, seen }
}

describe('handoff admission: the gate, before anything is coalesced', () => {
  it('fails closed on a missing principal — there is no ambient operator', async () => {
    const start = vi.fn(async () => ok())
    await expect(
      admissionFor(makeSession()).admit(
        { sessionId: SESSION, machineId: TARGET },
        undefined as unknown as HandoffCaller,
        gate().assert,
        start,
      ),
    ).rejects.toThrow('handoff requires an authenticated caller')
    expect(start).not.toHaveBeenCalled()
  })

  it('refuses an absent session with the command`s pinned throw', async () => {
    const start = vi.fn(async () => ok())
    await expect(
      admissionFor(undefined).admit(
        { sessionId: SESSION, machineId: TARGET },
        caller(),
        gate().assert,
        start,
      ),
    ).rejects.toThrow('unknown session')
    expect(start).not.toHaveBeenCalled()
  })

  it('asks the capability table whether the harness can be handed off, not the name', async () => {
    const start = vi.fn(async () => ok())
    await expect(
      admissionFor(makeSession({ agentKind: 'opencode' })).admit(
        { sessionId: SESSION, machineId: TARGET },
        caller(),
        gate().assert,
        start,
      ),
    ).rejects.toThrow('session harness does not support handoff')
    expect(start).not.toHaveBeenCalled()
  })

  it('refuses a session with no resume reference', async () => {
    const start = vi.fn(async () => ok())
    await expect(
      admissionFor(makeSession({ resume: false })).admit(
        { sessionId: SESSION, machineId: TARGET },
        caller(),
        gate().assert,
        start,
      ),
    ).rejects.toThrow('session has no resume reference')
    expect(start).not.toHaveBeenCalled()
  })

  it('`use` is checked on BOTH machines — source first, then target', async () => {
    const g = gate()
    await admissionFor(makeSession()).admit(
      { sessionId: SESSION, machineId: TARGET },
      caller(),
      g.assert,
      async () => ok(),
    )
    expect(g.seen).toEqual([SOURCE, TARGET])
  })

  it('a denied TARGET stops the dispatch before it starts', async () => {
    const start = vi.fn(async () => ok())
    await expect(
      admissionFor(makeSession()).admit(
        { sessionId: SESSION, machineId: TARGET },
        caller(),
        gate(TARGET).assert,
        start,
      ),
    ).rejects.toThrow(`denied: ${TARGET}`)
    expect(start).not.toHaveBeenCalled()
  })
})

describe('handoff admission: one live transfer per session', () => {
  /** A transfer that does not settle until the test says so. */
  function pending() {
    let settle: (result: HandoffResult) => void = () => {}
    let fail: (error: Error) => void = () => {}
    const promise = new Promise<HandoffResult>((resolve, reject) => {
      settle = resolve
      fail = reject
    })
    return { start: vi.fn(() => promise), settle, fail }
  }

  it('a duplicate dispatch to the SAME target joins the running transfer', async () => {
    const admission = admissionFor(makeSession())
    const t = pending()
    const first = admission.admit(
      { sessionId: SESSION, machineId: TARGET },
      caller(),
      gate().assert,
      t.start,
    )
    const second = admission.admit(
      { sessionId: SESSION, machineId: TARGET },
      caller(),
      gate().assert,
      t.start,
    )
    expect(t.start).toHaveBeenCalledTimes(1)
    t.settle(ok('/target/wt'))
    await expect(first).resolves.toEqual({ ok: true, newCwd: '/target/wt' })
    await expect(second).resolves.toEqual({ ok: true, newCwd: '/target/wt' })
  })

  it('THE JOINING CALLER IS AUTHORIZED WITH ITS OWN GATE, not the initiator`s', async () => {
    const admission = admissionFor(makeSession())
    const t = pending()
    const first = admission.admit(
      { sessionId: SESSION, machineId: TARGET },
      caller(),
      gate().assert,
      t.start,
    )
    // The second caller may not use the target. It must be refused even though a
    // transfer to that same target is already running and would have succeeded.
    await expect(
      admission.admit(
        { sessionId: SESSION, machineId: TARGET },
        caller(),
        gate(TARGET).assert,
        t.start,
      ),
    ).rejects.toThrow(`denied: ${TARGET}`)
    t.settle(ok())
    await first
  })

  it('a concurrent dispatch to a DIFFERENT target is refused, never raced', async () => {
    const admission = admissionFor(makeSession())
    const t = pending()
    const first = admission.admit(
      { sessionId: SESSION, machineId: TARGET },
      caller(),
      gate().assert,
      t.start,
    )
    await expect(
      admission.admit({ sessionId: SESSION, machineId: OTHER }, caller(), gate().assert, t.start),
    ).rejects.toThrow('session handoff already in progress')
    expect(t.start).toHaveBeenCalledTimes(1)
    t.settle(ok())
    await first
  })

  it('the registry reports the transfer while it runs and forgets it once it settles', async () => {
    const admission = admissionFor(makeSession())
    const t = pending()
    expect(admission.isTransferring(SESSION)).toBe(false)
    const first = admission.admit(
      { sessionId: SESSION, machineId: TARGET },
      caller(),
      gate().assert,
      t.start,
    )
    expect(admission.isTransferring(SESSION)).toBe(true)
    t.settle(ok())
    await first
    expect(admission.isTransferring(SESSION)).toBe(false)
  })

  it('a FAILED transfer releases the session too — the guard is not a latch', async () => {
    const admission = admissionFor(makeSession())
    const t = pending()
    const first = admission.admit(
      { sessionId: SESSION, machineId: TARGET },
      caller(),
      gate().assert,
      t.start,
    )
    t.fail(new Error('export failed'))
    await expect(first).rejects.toThrow('export failed')
    expect(admission.isTransferring(SESSION)).toBe(false)
    // And a retry is admitted rather than refused as a duplicate.
    const retry = pending()
    const second = admission.admit(
      { sessionId: SESSION, machineId: TARGET },
      caller(),
      gate().assert,
      retry.start,
    )
    expect(retry.start).toHaveBeenCalledTimes(1)
    retry.settle(ok())
    await expect(second).resolves.toEqual({ ok: true, newCwd: '/target/wt' })
  })
})
