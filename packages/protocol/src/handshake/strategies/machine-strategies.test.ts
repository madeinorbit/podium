/** Pair-code and bearer credentials resolve the same machine principal. */

import { describe, expect, it } from 'vitest'
import { asUserId } from '../../planes/principal'
import {
  createRecordingMinter,
  fakeMachines,
  helloFor,
  HOSTILE_CLAIMS,
  machineRecord,
  pairedMachineRecord,
  transportFacts,
} from '../test-support'
import { createMachinePairCodeStrategy } from './machine-pair-code'
import { createMachineTokenStrategy } from './machine-token'
import { machineUseAllowed } from './types'

const localMachine = machineRecord('local', { owner: 'usr-ada', name: 'ada-mbp' })
const remoteMachine = machineRecord('mach-vps', { owner: 'usr-ada', name: 'vps' })

describe('machine (remote) — one-shot pair code', () => {
  const paired = pairedMachineRecord('mach-vps', 'tok-minted', { owner: 'usr-ada', name: 'vps', updatePubkey: 'server-key-1' })

  it('redeems the code, mints a token exactly once, and names the resolved machine', () => {
    const machines = fakeMachines({ codes: { 'code-1': paired } })
    const strategy = createMachinePairCodeStrategy({ machines, mint: createRecordingMinter() })
    const first = strategy.authenticate({
      credential: { kind: 'pairCode', code: 'code-1' },
      hello: helloFor({ kind: 'pairCode', code: 'code-1' }),
      transport: transportFacts(),
    })
    expect(first).toMatchObject({ ok: true, issuedToken: 'tok-minted', assignedId: 'mach-vps', updatePubkey: 'server-key-1' })

    // Single-use: the same code again authenticates nothing (PairingManager).
    const second = strategy.authenticate({
      credential: { kind: 'pairCode', code: 'code-1' },
      hello: helloFor({ kind: 'pairCode', code: 'code-1' }),
      transport: transportFacts(),
    })
    expect(second).toMatchObject({ ok: false, reason: 'auth-failed' })
  })

  it('passes the peer self-description as a REQUEST, never as identity', () => {
    const machines = fakeMachines({ codes: { 'code-1': paired } })
    const strategy = createMachinePairCodeStrategy({ machines, mint: createRecordingMinter() })
    const outcome = strategy.authenticate({
      credential: { kind: 'pairCode', code: 'code-1' },
      hello: helloFor({ kind: 'pairCode', code: 'code-1' }, {
        claims: { machineId: 'mach-hijack', name: 'Totally Ada', hostname: 'evil.local' },
      }),
      transport: transportFacts(),
    })
    // The directory was TOLD the request …
    expect(machines.pairRequests).toEqual([
      { machineId: 'mach-hijack', name: 'Totally Ada', hostname: 'evil.local' },
    ])
    // … and the principal is whatever the directory decided, not what was asked.
    expect(outcome.ok && outcome.principal).toMatchObject({ machine: 'mach-vps' })
  })

  it('fails closed on an unknown or expired code, with pairing-UX text only', () => {
    const strategy = createMachinePairCodeStrategy({
      machines: fakeMachines({ codes: {} }),
      mint: createRecordingMinter(),
    })
    const outcome = strategy.authenticate({
      credential: { kind: 'pairCode', code: 'nope' },
      hello: helloFor({ kind: 'pairCode', code: 'nope' }),
      transport: transportFacts(),
    })
    expect(outcome).toMatchObject({
      ok: false,
      reason: 'auth-failed',
      // Discloses nothing about any identity — it is the ceremony's own UX.
      peerMessage: 'invalid or expired code',
    })
  })
})

describe('machine (remote) — long-lived token', () => {
  const seed = { tokens: { 'tok-vps': remoteMachine } }

  it('resolves the machine the token verified against, not the hint', () => {
    const machines = fakeMachines(seed)
    const strategy = createMachineTokenStrategy({ machines, mint: createRecordingMinter() })
    const outcome = strategy.authenticate({
      credential: { kind: 'machineToken', token: 'tok-vps', machineHint: 'mach-someone-elses' },
      hello: helloFor(
        { kind: 'machineToken', token: 'tok-vps', machineHint: 'mach-someone-elses' },
        { claims: { ...HOSTILE_CLAIMS, machineId: 'mach-someone-elses' } },
      ),
      transport: transportFacts(),
    })
    // The hint reached the directory as a lookup narrowing …
    expect(machines.tokenHints).toEqual(['mach-someone-elses'])
    // … and did NOT become the identity.
    expect(outcome.ok && outcome.principal).toMatchObject({ machine: 'mach-vps' })
  })

  it('fails closed on an unknown or rotated token, with no peer-visible detail', () => {
    const strategy = createMachineTokenStrategy({
      machines: fakeMachines(seed),
      mint: createRecordingMinter(),
    })
    const outcome = strategy.authenticate({
      credential: { kind: 'machineToken', token: 'tok-rotated' },
      hello: helloFor({ kind: 'machineToken', token: 'tok-rotated' }),
      transport: transportFacts(),
    })
    expect(outcome).toMatchObject({ ok: false, reason: 'auth-failed' })
    // A failed token must not tell an unauthenticated peer whether the machine exists.
    expect(outcome.ok ? null : outcome.peerMessage).toBeUndefined()
  })
})

describe('the all-in-one guard (readiness M4 / ADR 3 Am.1 D18.6)', () => {
  it('authenticating to the server does not confer `use` on the host machine', () => {
    // A different authenticated human — an admin, even — is not the owner and
    // holds no grant, so `use` (a code-execution boundary) is refused.
    expect(machineUseAllowed(localMachine, asUserId('usr-bob'))).toBe(false)
    // The owner may.
    expect(machineUseAllowed(localMachine, asUserId('usr-ada'))).toBe(true)
    // An explicit grant may.
    const shared = machineRecord('local', {
      owner: 'usr-ada',
      grants: [{ subject: asUserId('usr-bob'), verb: 'use' }],
    })
    expect(machineUseAllowed(shared, asUserId('usr-bob'))).toBe(true)
    // A `see` grant is NOT a `use` grant — one bit for both is the rejected model.
    const seeOnly = machineRecord('local', {
      owner: 'usr-ada',
      grants: [{ subject: asUserId('usr-bob'), verb: 'see' }],
    })
    expect(machineUseAllowed(seeOnly, asUserId('usr-bob'))).toBe(false)
  })

  it('an owner-less machine grants `use` to nobody', () => {
    const legacy = machineRecord('mach-legacy', { owner: null })
    expect(machineUseAllowed(legacy, asUserId('usr-ada'))).toBe(false)
    expect(machineUseAllowed(legacy, null)).toBe(false)
  })
})
