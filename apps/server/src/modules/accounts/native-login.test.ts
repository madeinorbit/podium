import { asMachineId, asSessionId, asUserId, type MachineId, type UserId } from '@podium/model'
import { describe, expect, it, vi } from 'vitest'
import {
  currentReadScope,
  inExplicitReadScope,
  readScopeSlot,
} from '../../store/executor/read-scope'
import { EventBus } from '../bus'
import { NativeLoginService } from './native-login'

const SESSION = asSessionId('login-session')
const MACHINE = asMachineId('machine-a')
const MACHINE_B = asMachineId('machine-b')
const OWNER = asUserId('user:operator')
const OTHER = asUserId('user:second-admin')

const MACHINE_NAMES: Readonly<Record<string, string>> = {
  'machine-a': 'Alpha',
  'machine-b': 'Bravo',
}

/** The string `relay.ts` really refuses an ungranted machine with, so a test
 *  asserting on it is asserting on the wording the product ships. */
const NO_MACHINE_USE = 'you do not have access to start login on this machine'

/**
 * The per-owner shape `relay.ts` composes: one human, the machines they hold
 * `use` on, and the same refusal for everything else.
 *
 * The grant table is the SUBJECT of the PDM-281 tests rather than scenery, so it
 * is spelled per owner. A fixture that authorized everybody would decide those
 * tests by the short circuit rather than by the policy under test.
 */
const grantsByOwner =
  (grants: Readonly<Record<string, readonly MachineId[]>>) =>
  (ownerUserId: UserId) =>
  (machineId: MachineId): string | undefined =>
    grants[ownerUserId]?.includes(machineId) ? undefined : NO_MACHINE_USE

function fixture(opts?: {
  authorizerFor?: (ownerUserId: UserId) => (machineId: MachineId) => string | undefined
  machineIds?: readonly MachineId[]
}) {
  const bus = new EventBus()
  let login: 'in' | 'out' = 'out'
  const machines = () =>
    (opts?.machineIds ?? [MACHINE]).map((id) => ({
      id,
      name: MACHINE_NAMES[id],
      online: true,
      inventory: {
        os: 'linux',
        arch: 'x64',
        tools: [],
        agents: [
          { kind: 'codex', installed: true, login: { state: login } },
          { kind: 'claude-code', installed: true, login: { state: login } },
        ],
      },
    }))
  const toMachine = vi.fn()
  // A DISTINCT SESSION PER MINT (PDM-281). Two humans may now hold two attempts
  // at once and `bySession` is keyed by session id, so one shared id would make
  // the second attempt overwrite the first's lifecycle wiring and the test would
  // pass for the wrong reason. The first mint keeps `SESSION`, so every
  // single-attempt test below reads exactly as it did.
  let minted = 0
  const createSession = vi.fn(async (input: { machineId: MachineId }) => {
    minted += 1
    return {
      sessionId: minted === 1 ? SESSION : asSessionId(`login-session-${minted}`),
      agentId: SESSION,
      harness: 'shell',
      model: null,
      effort: null,
      machine: MACHINE_NAMES[input.machineId],
      machineId: input.machineId,
      accountId: null,
    }
  })
  const service = new NativeLoginService({
    bus,
    machines: { listMachines: async () => machines(), toMachine } as never,
    sessions: { createSession } as never,
    // SETUP ONLY (POD-3257 / spec rule 18): `authorize` became `authorizerFor`,
    // which resolves the owner once and returns the per-machine check.
    authorizerFor: opts?.authorizerFor ?? (() => () => undefined),
    cwdForMachine: () => '/repo',
  })
  return {
    bus,
    service,
    createSession,
    toMachine,
    setLogin: (state: 'in' | 'out') => (login = state),
  }
}

describe('NativeLoginService', () => {
  it('holds one grant snapshot for a login pass and re-reads on the next pass', async () => {
    let granted = true
    const grantSnapshot = readScopeSlot(() => granted)
    const f = fixture({
      authorizerFor: () => () => {
        const allowed = inExplicitReadScope() ? currentReadScope().slot(grantSnapshot) : granted
        granted = false
        return allowed ? undefined : 'fresh grant snapshot taken mid-pass'
      },
    })

    await expect(
      f.service.start({
        harness: 'codex',
        ownerUserId: OWNER,
      }),
    ).resolves.toMatchObject({ sessionId: SESSION, status: 'running' })
    await expect(
      f.service.start({
        harness: 'claude-code',
        machineId: MACHINE,
        ownerUserId: OWNER,
      }),
    ).rejects.toThrow('fresh grant snapshot taken mid-pass')
    expect(f.createSession).toHaveBeenCalledTimes(1)
  })

  it('starts one purpose-labelled shell PTY from the harness manifest lane', async () => {
    const f = fixture()
    const attempt = await f.service.start({
      harness: 'codex',
      machineId: MACHINE,
      ownerUserId: OWNER,
    })

    expect(attempt).toMatchObject({ sessionId: SESSION, machineName: 'Alpha', status: 'running' })
    expect(f.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        agentKind: 'shell',
        loginHarness: 'codex',
        cwd: '/repo',
        title: 'codex login',
        machineId: 'machine-a',
      }),
    )
  })

  it('refreshes inventory on exit and reports the observed login result', async () => {
    const f = fixture()
    await f.service.start({ harness: 'codex', ownerUserId: OWNER })

    f.bus.emit('session.exited', { sessionId: SESSION, code: 0 })
    expect(f.toMachine).toHaveBeenCalledWith('machine-a', { type: 'inventoryRequest' })
    expect(f.service.attempt('codex', OWNER)?.status).toBe('refreshing')

    f.bus.emit('machine.metadataChanged', { machineId: asMachineId('machine-a') })
    expect(f.service.attempt('codex', OWNER)?.status).toBe('refreshing')

    f.setLogin('in')
    f.bus.emit('machine.metadataChanged', { machineId: asMachineId('machine-a'), inventory: true })
    await Promise.resolve()
    expect(f.service.attempt('codex', OWNER)?.status).toBe('succeeded')
  })

  // PDM-271. An attempt names a session id and the host it is running on, so it
  // is a report of where one person is authenticating right now.
  it('reports an in-flight attempt to its owner and not to another human', async () => {
    const f = fixture()
    const started = await f.service.start({ harness: 'codex', ownerUserId: OWNER })

    // The positive half is what makes the negative half mean anything: the same
    // call, the same harness, the same live attempt — only the viewer differs.
    expect(f.service.attempt('codex', OWNER)).toEqual(started)
    expect(f.service.attempt('codex', OTHER)).toBeUndefined()

    // ...and it stays scoped as the attempt progresses, because `track` carries
    // the owner through rather than re-deriving it from a lifecycle event.
    f.bus.emit('session.exited', { sessionId: SESSION, code: 1 })
    expect(f.service.attempt('codex', OWNER)?.status).toBe('failed')
    expect(f.service.attempt('codex', OTHER)).toBeUndefined()
  })
})

/**
 * PDM-271 scoped the READ and left the WRITE (PDM-281).
 *
 * `start()` reused an in-flight attempt keyed by HARNESS ALONE, so a second
 * human asking for the same harness was handed the first human's attempt --
 * its session id and the host they are authenticating on -- and was handed it
 * BEFORE `authorize(machine.id)`, the machine-use recheck the fresh path
 * performs. Two separate defects wore one early return: a disclosure, and a
 * gate that a reused attempt skipped and a fresh one passes.
 *
 * THE RULE THAT REPLACES IT is stated in `accounts.login`'s `conflictRule`: one
 * active attempt per harness PER HUMAN is reused until it settles, and a second
 * human is refused on a host that already has one in flight. The unit of
 * conflict is the HOST, not the harness -- `required` in the service under test
 * is already keyed `${machineId}:${harness}` for the same reason -- because what
 * two concurrent logins actually contend for is one harness's credential store
 * on one machine.
 */
describe('a login attempt belongs to the human who started it (PDM-281)', () => {
  it('refuses a second human who may not use the host the first is on', async () => {
    const f = fixture({ authorizerFor: grantsByOwner({ [OWNER]: [MACHINE] }) })
    const started = await f.service.start({
      harness: 'codex',
      machineId: MACHINE,
      ownerUserId: OWNER,
    })

    // OTHER holds no `use` grant anywhere. The fresh path refuses them at
    // `authorize(machine.id)`; the reuse path returned before ever reaching it,
    // which is why this asserts a REFUSAL and not merely a withheld attempt.
    await expect(
      f.service.start({ harness: 'codex', machineId: MACHINE, ownerUserId: OTHER }),
    ).rejects.toThrow(NO_MACHINE_USE)
    expect(f.createSession).toHaveBeenCalledTimes(1)
    // ...and the refusal left the first human's attempt exactly as it was.
    expect(f.service.attempt('codex', OWNER)).toEqual(started)
  })

  it('refuses a second human on a contended host without naming the first', async () => {
    const f = fixture({
      authorizerFor: grantsByOwner({ [OWNER]: [MACHINE], [OTHER]: [MACHINE] }),
    })
    await f.service.start({ harness: 'codex', machineId: MACHINE, ownerUserId: OWNER })

    // OTHER may use this host, so the machine gate passes and the HOST conflict
    // is what refuses them: one harness credential store, one login at a time.
    const refusal = await f.service
      .start({ harness: 'codex', machineId: MACHINE, ownerUserId: OTHER })
      .then(
        (attempt) => {
          throw new Error(`expected a refusal, got the attempt on ${attempt.machineName}`)
        },
        (error: Error) => error.message,
      )
    expect(refusal).toContain('codex login is already running')
    // The refusal names the host -- which OTHER already holds `use` on and can
    // therefore already see -- and nothing about WHO or WHICH SESSION.
    expect(refusal).not.toContain(OWNER)
    expect(refusal).not.toContain(SESSION)
    // No second PTY was spawned on the contended host either.
    expect(f.createSession).toHaveBeenCalledTimes(1)
  })

  it('lets two humans authenticate one harness on their own hosts at once', async () => {
    const f = fixture({
      machineIds: [MACHINE, MACHINE_B],
      authorizerFor: grantsByOwner({ [OWNER]: [MACHINE], [OTHER]: [MACHINE_B] }),
    })
    const mine = await f.service.start({ harness: 'codex', ownerUserId: OWNER })
    const theirs = await f.service.start({ harness: 'codex', ownerUserId: OTHER })

    // Two humans who share no machine cannot collide in reality, and the map
    // keyed by harness alone said they did.
    expect(mine.machineName).toBe('Alpha')
    expect(theirs.machineName).toBe('Bravo')
    expect(theirs.sessionId).not.toBe(mine.sessionId)
    expect(f.createSession).toHaveBeenCalledTimes(2)
    // Each reads their own, and neither reads the other's.
    expect(f.service.attempt('codex', OWNER)).toEqual(mine)
    expect(f.service.attempt('codex', OTHER)).toEqual(theirs)
  })

  it('auto-selects a free host instead of refusing on a contended one', async () => {
    const f = fixture({
      machineIds: [MACHINE, MACHINE_B],
      authorizerFor: grantsByOwner({ [OWNER]: [MACHINE], [OTHER]: [MACHINE, MACHINE_B] }),
    })
    await f.service.start({ harness: 'codex', machineId: MACHINE, ownerUserId: OWNER })

    // OTHER may use BOTH hosts. Auto-select skips the one carrying somebody
    // else's in-flight attempt exactly as it skips one they may not use, so the
    // refusal above only ever meets a caller who named the contended host.
    const theirs = await f.service.start({ harness: 'codex', ownerUserId: OTHER })
    expect(theirs.machineName).toBe('Bravo')
  })

  // THE HALF THIS FIX IS NOT ABOUT, and the half most at risk from it: narrowing
  // reuse to the owner must not stop reuse. Nothing witnessed the documented
  // idempotency before this test -- deleting the early return outright reddened
  // no test in the repository.
  it('still returns one human their own in-flight attempt when they ask again', async () => {
    const f = fixture()
    const first = await f.service.start({
      harness: 'codex',
      machineId: MACHINE,
      ownerUserId: OWNER,
    })
    const again = await f.service.start({
      harness: 'codex',
      machineId: MACHINE,
      ownerUserId: OWNER,
    })

    expect(again).toEqual(first)
    expect(f.createSession).toHaveBeenCalledTimes(1)
  })
})
