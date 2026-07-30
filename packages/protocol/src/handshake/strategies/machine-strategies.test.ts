/**
 * The three `machine` rows of ADR 5 D5 — local secret, pair code, machine token.
 * One file, three describes: they share a fixture set on purpose, because the
 * point being tested is that the three CREDENTIALS differ while the resolved
 * principal does not.
 */

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
import { createMachineLocalSecretStrategy } from './machine-local-secret'
import { createMachinePairCodeStrategy } from './machine-pair-code'
import { createMachineTokenStrategy } from './machine-token'
import { machineUseAllowed } from './types'

const localMachine = machineRecord('local', { owner: 'usr-ada', name: 'ada-mbp' })
const remoteMachine = machineRecord('mach-vps', { owner: 'usr-ada', name: 'vps' })

describe('machine (local) — shared host secret', () => {
  const seed = { secrets: { 'secret-ok': localMachine } }

  it('resolves a machine principal that carries owner and grants', () => {
    const mint = createRecordingMinter()
    const strategy = createMachineLocalSecretStrategy({ machines: fakeMachines(seed), mint })
    const outcome = strategy.authenticate({
      credential: { kind: 'daemonSecret', secret: 'secret-ok' },
      hello: helloFor({ kind: 'daemonSecret', secret: 'secret-ok' }),
      transport: transportFacts({ endpoint: '/daemon', connectionId: 'conn-7' }),
    })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.principal).toMatchObject({
      kind: 'machine',
      machine: 'local',
      // The DEVICE half is the connection, so a reconnect is the same machine on
      // a new binding rather than a new machine.
      device: 'conn-7',
    })
    // A machine is not a person: no user, and nothing minted for one.
    expect(outcome.principal).not.toHaveProperty('user')
    expect(mint.minted).toEqual([{ kind: 'machine', subject: 'local' }])
  })

  it('is payload-inert: claiming another machineId does not change the principal', () => {
    const strategy = createMachineLocalSecretStrategy({
      machines: fakeMachines(seed),
      mint: createRecordingMinter(),
    })
    const outcome = strategy.authenticate({
      credential: { kind: 'daemonSecret', secret: 'secret-ok' },
      hello: helloFor({ kind: 'daemonSecret', secret: 'secret-ok' }, {
        claims: { ...HOSTILE_CLAIMS, machineId: 'mach-someone-elses' },
      }),
      transport: transportFacts(),
    })
    expect(outcome.ok && outcome.principal).toMatchObject({ machine: 'local' })
  })

  it('fails closed on a wrong secret — and being on the local socket is not proof', () => {
    const strategy = createMachineLocalSecretStrategy({
      machines: fakeMachines(seed),
      mint: createRecordingMinter(),
    })
    const outcome = strategy.authenticate({
      credential: { kind: 'daemonSecret', secret: 'secret-wrong' },
      hello: helloFor({ kind: 'daemonSecret', secret: 'secret-wrong' }),
      // Loopback, in-process, same host — none of it authenticates anything.
      transport: transportFacts({ endpoint: '/daemon', inProcess: true }),
    })
    expect(outcome).toMatchObject({ ok: false, reason: 'auth-failed' })
  })

  it('fails closed when the secret file is gone (availability blip, not a bypass)', () => {
    // ADR 5 D5's operational note: deleting the secret under a running split
    // daemon rejects auth until restart. Fail closed is the correct behaviour.
    const strategy = createMachineLocalSecretStrategy({
      machines: fakeMachines({ secrets: {} }),
      mint: createRecordingMinter(),
    })
    const outcome = strategy.authenticate({
      credential: { kind: 'daemonSecret', secret: 'secret-ok' },
      hello: helloFor({ kind: 'daemonSecret', secret: 'secret-ok' }),
      transport: transportFacts(),
    })
    expect(outcome.ok).toBe(false)
  })
})

describe('machine (remote) — one-shot pair code', () => {
  const paired = pairedMachineRecord('mach-vps', 'tok-minted', { owner: 'usr-ada', name: 'vps' })

  it('redeems the code, mints a token exactly once, and names the resolved machine', () => {
    const machines = fakeMachines({ codes: { 'code-1': paired } })
    const strategy = createMachinePairCodeStrategy({ machines, mint: createRecordingMinter() })
    const first = strategy.authenticate({
      credential: { kind: 'pairCode', code: 'code-1' },
      hello: helloFor({ kind: 'pairCode', code: 'code-1' }),
      transport: transportFacts(),
    })
    expect(first).toMatchObject({ ok: true, issuedToken: 'tok-minted', assignedId: 'mach-vps' })

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
