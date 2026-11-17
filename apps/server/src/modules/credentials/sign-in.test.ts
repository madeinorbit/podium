/**
 * ADDING A SUBSCRIPTION BY SIGNING IN ON A MACHINE (credential management §6
 * way 2; epic plan Task 9, acceptance 1, 2, 3 and 5).
 *
 * The machine is a fake: `homeEnsure`, `homeRemove` and the sign-in terminal
 * are recorded, and the machine's report of a home's login is an inventory
 * the test hands in. Identities are obviously fake.
 */

import {
  asMachineId,
  asSessionId,
  asUserId,
  type CredentialId,
  type Inventory,
  type MachineId,
} from '@podium/model'
import { CAP_HARNESS_HOMES } from '@podium/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import type { SessionStore } from '../../store'
import { memberFacts } from '../../store/fixtures/test-support'
import { openTestStore } from '../../test-support/open-test-store'
import { HomeSignInService, SignInRefused } from './sign-in'

const OWNER = asUserId('user:signin-owner')
const OTHER = asUserId('user:signin-other')
const MINE = asMachineId('machine:signin-mine')
const THEIRS = asMachineId('machine:signin-theirs')
const FP_A = 'fp-FAKE-account-a'
const FP_B = 'fp-FAKE-account-b'
const A = 'a@example.invalid'
const B = 'b@example.invalid'

const services: HomeSignInService[] = []
afterEach(() => {
  for (const s of services.splice(0)) s.dispose()
})

async function setup(opts: { online?: boolean; homes?: boolean; created?: boolean } = {}) {
  const store: SessionStore = await openTestStore(':memory:')
  for (const id of [OWNER, OTHER]) {
    await memberFacts(store).create(
      {
        id,
        displayName: id,
        role: 'member',
        createdAt: new Date().toISOString(),
        disabledAt: null,
      },
      'not-a-real-hash',
    )
  }
  for (const [id, owner] of [
    [MINE, OWNER],
    [THEIRS, OTHER],
  ] as const) {
    await store.machines.upsertMachine({
      id,
      name: id,
      hostname: `${id}.invalid`,
      tokenHash: `hash-${id}`,
      ownerUserId: owner,
    })
  }
  const calls: string[] = []
  let session = 0
  const service = new HomeSignInService({
    store,
    daemon: {
      isOnline: () => opts.online ?? true,
      supports: (_m, cap) => cap === CAP_HARNESS_HOMES && (opts.homes ?? true),
    },
    rpc: {
      homeEnsure: async (credentialId, harness, machineId) => {
        calls.push(`ensure ${credentialId}:${harness} on ${machineId}`)
        return { ok: true, homeId: `${credentialId}:${harness}`, created: opts.created ?? true }
      },
      homeRemove: async (homeId, machineId) => {
        calls.push(`remove ${homeId} on ${machineId}`)
        return { ok: true }
      },
    },
    terminals: {
      open: async (i) => {
        calls.push(`open ${i.harness} sign-in in ${i.homeId} on ${i.machineId}`)
        return asSessionId(`signin-terminal-${++session}`)
      },
      close: async (sessionId) => void calls.push(`close ${sessionId}`),
    },
    requestInventory: (machineId) => void calls.push(`inventory? ${machineId}`),
    ttlMs: 60_000,
    reportWaitMs: 60_000,
  })
  services.push(service)
  return { store, service, calls }
}

/** What the machine reports: one home of `harness` signed in as `fp`. */
function reporting(
  harness: 'claude-code' | 'codex',
  homeId: string,
  identity?: { fingerprint: string; email?: string },
): Inventory {
  return {
    os: 'linux',
    arch: 'x64',
    tools: [],
    agents: [
      {
        kind: harness,
        installed: true,
        login: { state: 'out' },
        logins: [
          { homeId: 'default', state: 'out' },
          identity ? { homeId, state: 'in', identity } : { homeId, state: 'out' },
        ],
      },
    ],
  } as Inventory
}

async function refusalOf(call: Promise<unknown>): Promise<SignInRefused> {
  try {
    await call
  } catch (error) {
    if (error instanceof SignInRefused) return error
    throw error
  }
  throw new Error('expected a refusal')
}

describe('signInStart (acceptance 1)', () => {
  it('on a machine the person holds custody of, ensures a home and opens the vendor sign-in in it', async () => {
    const { service, calls } = await setup()
    const started = await service.start({
      ownerUserId: OWNER,
      type: 'anthropic.claude-login',
      machineId: MINE,
    })
    const home = `${started.credentialId}:claude-code`
    expect(calls).toEqual([
      `ensure ${home} on ${MINE}`,
      `open claude-code sign-in in ${home} on ${MINE}`,
    ])
    expect(service.status(started.credentialId, OWNER)).toEqual({
      state: 'waiting',
      machineId: MINE,
      terminalSessionId: started.terminalSessionId,
    })
    // Codex's home is its own harness's.
    const codex = await service.start({
      ownerUserId: OWNER,
      type: 'openai.chatgpt-login',
      machineId: MINE,
    })
    expect(calls.at(-1)).toBe(`open codex sign-in in ${codex.credentialId}:codex on ${MINE}`)
  })

  it('refuses a machine the credential was not sent to with machine-not-allowed, and makes nothing', async () => {
    const { service, calls } = await setup()
    const refusal = await refusalOf(
      service.start({ ownerUserId: OWNER, type: 'anthropic.claude-login', machineId: THEIRS }),
    )
    expect(refusal.refusal).toBe('machine-not-allowed')
    expect(refusal.message).toBe("This credential's owner has not sent it to this machine.")
    expect(calls).toEqual([])
  })

  it('signs an existing credential in on a machine its owner sent it to', async () => {
    const { store, service, calls } = await setup()
    const existing = await store.credentials.insert({
      ownerUserId: OWNER,
      label: 'Max',
      type: 'anthropic.claude-login',
      identity: { fingerprint: FP_A, email: A },
    })
    await refusalOf(
      service.start({
        ownerUserId: OWNER,
        type: existing.type,
        machineId: THEIRS,
        credentialId: existing.id,
      }),
    )
    await store.credentials.allowMachine(existing.id, THEIRS, OWNER)
    const started = await service.start({
      ownerUserId: OWNER,
      type: existing.type,
      machineId: THEIRS,
      credentialId: existing.id,
    })
    expect(started.credentialId).toBe(existing.id)
    expect(calls[0]).toBe(`ensure ${existing.id}:claude-code on ${THEIRS}`)
  })

  it('refuses a type that is not signed in on a machine, an offline machine and an old daemon', async () => {
    expect(
      (
        await refusalOf(
          (
            await setup()
          ).service.start({ ownerUserId: OWNER, type: 'anthropic.api-key', machineId: MINE }),
        )
      ).message,
    ).toMatch(/not added by signing in/)
    expect(
      (
        await refusalOf(
          (
            await setup({ online: false })
          ).service.start({ ownerUserId: OWNER, type: 'anthropic.claude-login', machineId: MINE }),
        )
      ).refusal,
    ).toBe('machine-offline')
    expect(
      (
        await refusalOf(
          (
            await setup({ homes: false })
          ).service.start({ ownerUserId: OWNER, type: 'anthropic.claude-login', machineId: MINE }),
        )
      ).refusal,
    ).toBe('daemon-too-old')
  })

  it("answers another person's credential as one that does not exist", async () => {
    const { store, service } = await setup()
    const theirs = await store.credentials.insert({
      ownerUserId: OTHER,
      label: 'x',
      type: 'anthropic.claude-login',
    })
    const refusal = await refusalOf(
      service.start({
        ownerUserId: OWNER,
        type: theirs.type,
        machineId: MINE,
        credentialId: theirs.id,
      }),
    )
    expect(refusal.code).toBe('not-found')
  })
})

describe('the home reports a login (acceptance 2)', () => {
  it('binds the credential to the identity that signed in, status ok, a home placement present', async () => {
    const { store, service, calls } = await setup()
    const started = await service.start({
      ownerUserId: OWNER,
      type: 'anthropic.claude-login',
      machineId: MINE,
      label: 'Second Max',
    })
    const home = `${started.credentialId}:claude-code`
    // Nothing exists while the person signs in.
    expect(await store.credentials.get(started.credentialId)).toBeUndefined()
    await service.onInventory(MINE, reporting('claude-code', home))
    expect(service.status(started.credentialId, OWNER).state).toBe('waiting')
    await service.onInventory(MINE, reporting('claude-code', home, { fingerprint: FP_A, email: A }))
    expect(service.status(started.credentialId, OWNER)).toEqual({
      state: 'signed-in',
      credentialId: started.credentialId,
      label: 'Second Max',
      email: A,
      outcome: 'new',
    })
    const record = await store.credentials.get(started.credentialId)
    expect(record).toMatchObject({
      ownerUserId: OWNER,
      type: 'anthropic.claude-login',
      status: 'ok',
      identity: { fingerprint: FP_A, email: A },
    })
    expect(record?.verifiedAt).toEqual(expect.any(String))
    expect(await store.credentials.listPlacements(started.credentialId)).toEqual([
      expect.objectContaining({ machineId: MINE, kind: 'home', homeId: home, state: 'present' }),
    ])
    // The terminal has done its job.
    expect(calls.at(-1)).toBe(`close ${started.terminalSessionId}`)
    // Another person cannot read the attempt.
    expect(service.status(started.credentialId, OTHER).state).toBe('failed')
  })

  it('names the credential after the account when the person gave no name', async () => {
    const { store, service } = await setup()
    const started = await service.start({
      ownerUserId: OWNER,
      type: 'openai.chatgpt-login',
      machineId: MINE,
    })
    await service.onInventory(
      MINE,
      reporting('codex', `${started.credentialId}:codex`, { fingerprint: FP_B, email: B }),
    )
    expect((await store.credentials.get(started.credentialId))?.label).toBe(B)
  })
})

describe('signed in as another account (acceptance 3, review focus 5)', () => {
  it('attaches the home to the credential that account already has, and names it', async () => {
    const { store, service } = await setup()
    const a = await store.credentials.insert({
      ownerUserId: OWNER,
      label: 'Account A',
      type: 'anthropic.claude-login',
      identity: { fingerprint: FP_A, email: A },
    })
    const b = await store.credentials.insert({
      ownerUserId: OWNER,
      label: 'Account B',
      type: 'anthropic.claude-login',
      identity: { fingerprint: FP_B, email: B },
    })
    await service.start({ ownerUserId: OWNER, type: a.type, machineId: MINE, credentialId: a.id })
    await service.onInventory(
      MINE,
      reporting('claude-code', `${a.id}:claude-code`, { fingerprint: FP_B, email: B }),
    )
    expect(service.status(a.id, OWNER)).toEqual({
      state: 'signed-in',
      credentialId: b.id,
      label: 'Account B',
      email: B,
      outcome: 'attached',
    })
    expect(await store.credentials.listPlacements(b.id)).toEqual([
      expect.objectContaining({
        machineId: MINE,
        kind: 'home',
        homeId: `${a.id}:claude-code`,
        state: 'present',
      }),
    ])
    expect((await store.credentials.get(a.id))?.identity).toEqual({ fingerprint: FP_A, email: A })
    expect(await store.credentials.listPlacements(a.id)).toEqual([])
  })

  it('a new sign-in as an account already held attaches to it and creates nothing', async () => {
    const { store, service } = await setup()
    const b = await store.credentials.insert({
      ownerUserId: OWNER,
      label: 'Account B',
      type: 'anthropic.claude-login',
      identity: { fingerprint: FP_B, email: B },
    })
    const started = await service.start({ ownerUserId: OWNER, type: b.type, machineId: MINE })
    await service.onInventory(
      MINE,
      reporting('claude-code', `${started.credentialId}:claude-code`, {
        fingerprint: FP_B,
        email: B,
      }),
    )
    expect(service.status(started.credentialId, OWNER)).toMatchObject({
      credentialId: b.id,
      outcome: 'attached',
    })
    expect(await store.credentials.get(started.credentialId)).toBeUndefined()
    expect(await store.credentials.listVisibleTo(OWNER)).toHaveLength(1)
  })

  it('gives the credential the account that signed in when none holds it, and says what it was', async () => {
    const { store, service } = await setup()
    const a = await store.credentials.insert({
      ownerUserId: OWNER,
      label: 'Account A',
      type: 'anthropic.claude-login',
      identity: { fingerprint: FP_A, email: A },
    })
    await service.start({ ownerUserId: OWNER, type: a.type, machineId: MINE, credentialId: a.id })
    await service.onInventory(
      MINE,
      reporting('claude-code', `${a.id}:claude-code`, { fingerprint: FP_B, email: B }),
    )
    expect(service.status(a.id, OWNER)).toEqual({
      state: 'signed-in',
      credentialId: a.id,
      label: 'Account A',
      email: B,
      outcome: 'identity-changed',
      previousEmail: A,
    })
    expect((await store.credentials.get(a.id))?.identity).toEqual({ fingerprint: FP_B, email: B })
  })

  it('the same account signed in again is the same credential', async () => {
    const { store, service } = await setup()
    const a = await store.credentials.insert({
      ownerUserId: OWNER,
      label: 'Account A',
      type: 'anthropic.claude-login',
      identity: { fingerprint: FP_A, email: A },
    })
    await store.credentials.markAttention(a.id, 'signed out')
    await service.start({ ownerUserId: OWNER, type: a.type, machineId: MINE, credentialId: a.id })
    await service.onInventory(
      MINE,
      reporting('claude-code', `${a.id}:claude-code`, { fingerprint: FP_A, email: A }),
    )
    expect(service.status(a.id, OWNER)).toMatchObject({ outcome: 'same', credentialId: a.id })
    expect((await store.credentials.get(a.id))?.status).toBe('ok')
  })
})

describe('cancelled or abandoned (acceptance 5)', () => {
  async function started() {
    const s = await setup()
    const attempt = await s.service.start({
      ownerUserId: OWNER,
      type: 'anthropic.claude-login',
      machineId: MINE,
    })
    s.calls.length = 0
    return { ...s, attempt, home: `${attempt.credentialId}:claude-code` }
  }

  it('cancel closes the terminal, removes the home it made, and leaves no credential', async () => {
    const { store, service, calls, attempt, home } = await started()
    await service.cancel(attempt.credentialId, OWNER)
    expect(calls).toEqual([`close ${attempt.terminalSessionId}`, `remove ${home} on ${MINE}`])
    expect(service.status(attempt.credentialId, OWNER)).toEqual({
      state: 'failed',
      reason: 'The sign-in was cancelled.',
    })
    expect(await store.credentials.get(attempt.credentialId)).toBeUndefined()
    expect(await store.credentials.listVisibleTo(OWNER)).toEqual([])
    // A late report changes nothing.
    await service.onInventory(MINE, reporting('claude-code', home, { fingerprint: FP_A, email: A }))
    expect(await store.credentials.listVisibleTo(OWNER)).toEqual([])
  })

  it('a sign-in terminal that ends without signing in removes the home', async () => {
    const { store, service, calls, attempt, home } = await started()
    await service.onExit(attempt.terminalSessionId, 1)
    expect(calls).toEqual([`remove ${home} on ${MINE}`])
    expect(service.status(attempt.credentialId, OWNER).state).toBe('failed')
    expect(await store.credentials.listVisibleTo(OWNER)).toEqual([])
  })

  it('a terminal that ended well waits for the report, then succeeds', async () => {
    const { service, calls, attempt, home } = await started()
    await service.onExit(attempt.terminalSessionId, 0)
    expect(calls).toEqual([`inventory? ${MINE}`])
    await service.onInventory(MINE, reporting('claude-code', home, { fingerprint: FP_A, email: A }))
    expect(service.status(attempt.credentialId, OWNER).state).toBe('signed-in')
    // The terminal already ended: nothing to close.
    expect(calls).toEqual([`inventory? ${MINE}`])
  })

  it('an abandoned sign-in times out, closes the terminal and removes the home', async () => {
    const store = await openTestStore(':memory:')
    await store.machines.upsertMachine({
      id: MINE,
      name: 'm',
      hostname: 'm.invalid',
      tokenHash: 'h',
      ownerUserId: OWNER,
    })
    await memberFacts(store).create(
      {
        id: OWNER,
        displayName: 'o',
        role: 'member',
        createdAt: new Date().toISOString(),
        disabledAt: null,
      },
      'not-a-real-hash',
    )
    const calls: string[] = []
    const service = new HomeSignInService({
      store,
      daemon: { isOnline: () => true, supports: () => true },
      rpc: {
        homeEnsure: async (c, h) => ({ ok: true, homeId: `${c}:${h}`, created: true }),
        homeRemove: async (homeId) => (calls.push(`remove ${homeId}`), { ok: true }),
      },
      terminals: {
        open: async () => asSessionId('abandoned-terminal'),
        close: async (id) => void calls.push(`close ${id}`),
      },
      requestInventory: () => {},
      ttlMs: 20,
    })
    services.push(service)
    const attempt = await service.start({
      ownerUserId: OWNER,
      type: 'anthropic.claude-login',
      machineId: MINE,
    })
    const deadline = Date.now() + 5_000
    while (
      service.status(attempt.credentialId, OWNER).state === 'waiting' &&
      Date.now() < deadline
    ) {
      await new Promise((r) => setTimeout(r, 10))
    }
    expect(service.status(attempt.credentialId, OWNER)).toEqual({
      state: 'failed',
      reason: 'The sign-in was not finished in time.',
    })
    expect(calls).toEqual([
      'close abandoned-terminal',
      `remove ${attempt.credentialId}:claude-code`,
    ])
    expect(await store.credentials.listVisibleTo(OWNER)).toEqual([])
  })

  it('never removes a home that already existed (signing an existing credential in again)', async () => {
    const { store, service, calls } = await setup({ created: false })
    const a = await store.credentials.insert({
      ownerUserId: OWNER,
      label: 'Account A',
      type: 'anthropic.claude-login',
      identity: { fingerprint: FP_A, email: A },
    })
    const attempt = await service.start({
      ownerUserId: OWNER,
      type: a.type,
      machineId: MINE,
      credentialId: a.id,
    })
    await service.cancel(attempt.credentialId, OWNER)
    expect(calls.filter((c) => c.startsWith('remove'))).toEqual([])
    expect((await store.credentials.get(a.id))?.status).toBe('ok')
  })
})

describe('one home per credential on a machine', () => {
  it('a new home that signed in as an account with a home there replaces it', async () => {
    const { store, service, calls } = await setup()
    const b = await store.credentials.insert({
      ownerUserId: OWNER,
      label: 'Account B',
      type: 'anthropic.claude-login',
      identity: { fingerprint: FP_B, email: B },
    })
    await store.credentials.recordPlacement({
      credentialId: b.id as CredentialId,
      machineId: MINE as MachineId,
      kind: 'home',
    })
    const started = await service.start({ ownerUserId: OWNER, type: b.type, machineId: MINE })
    const home = `${started.credentialId}:claude-code`
    await service.onInventory(MINE, reporting('claude-code', home, { fingerprint: FP_B, email: B }))
    expect(calls).toContain(`remove ${b.id}:claude-code on ${MINE}`)
    expect(await store.credentials.listPlacements(b.id)).toEqual([
      expect.objectContaining({ homeId: home, state: 'present' }),
    ])
  })
})
