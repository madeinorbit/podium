/**
 * PERSONAL PROVIDER ACCOUNTS WITH TWO MEMBERS (POD-6300; design §2.4, §2.5,
 * §4.6, Q1). Rows MU-26 and MU-28 of the acceptance matrix, and the admin rule:
 *
 * - MU-26: Alice's and Bob's connections, login attempts and quotas stay
 *   separate, and a missing selection never falls through to the other's.
 * - Admin: Alice is an admin and still cannot see, use or edit Bob's connection.
 * - MU-28: Bob's run on Alice's machine uses only Bob's own connection, which he
 *   sent there, and never Alice's logins. The shared-machine warning appears
 *   when Alice grants Bob `use`, before Bob's first run there, and when Bob
 *   sends a connection there. A missing or conflicting connection fails clearly.
 *
 * Every act goes through the production transport as the member (their own
 * login cookie); only selections and quota samples are seeded through the store.
 */

import {
  asAccountId,
  type MachineId,
  quotaAccountKey,
  type SessionId,
  SHARED_MACHINE_ACCOUNT_WARNING,
  type UserId,
} from '@podium/model'
import type { ControlMessage } from '@podium/protocol/daemon'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { fixtureInventory } from './test-support/daemon-inventory'
import {
  MEMBERS,
  type MemberName,
  startTwoMemberInstance,
  type TwoMemberInstance,
} from './test-support/two-member-instance'

let f: TwoMemberInstance
beforeAll(async () => {
  f = await startTwoMemberInstance()
}, 60_000)
afterAll(async () => {
  await f?.close()
})

// The tRPC client is typed per procedure; these tests address several of them
// by the same loose shape.
// biome-ignore lint/suspicious/noExplicitAny: see above
const trpc = async (who: MemberName): Promise<any> => (await f.as(who)).trpc
const store = () => f.handle.registry.sessionStore

const ALICE_KEY = 'sk-ant-alice-0000000000'
const BOB_KEY = 'sk-ant-bob-11111111111111'
const mask = (key: string) => `${key.slice(0, 4)}…${key.slice(-4)}`

type View = {
  id: string
  identity?: string
  status: string
  source: string
  sentTo?: Array<{ id: string }>
  sendableTo?: Array<{ id: string }>
  loginAttempt?: { sessionId: string; machineId: string }
  machines?: string[]
  harness?: string
}
const list = async (who: MemberName): Promise<View[]> =>
  (await (await trpc(who)).accounts.list.query()) as View[]
const view = async (who: MemberName, id: string) =>
  (await list(who)).find((account) => account.id === id)

/** Point the member's coding role at an account (their personal preference). */
const select = async (who: MemberName, accountId: string) => {
  const userId: UserId = MEMBERS[who].id
  const settings = await store().settings.getSettingsFor(userId)
  await store().settings.setSettingsFor(
    userId,
    {
      ...settings,
      roles: {
        ...settings.roles,
        coding: { ...settings.roles.coding, accountId: asAccountId(accountId) },
      },
    },
    new Date().toISOString(),
  )
}

const spawnFrames = (machineId: MachineId) =>
  f
    .daemonFrames(machineId)
    .filter((frame): frame is Extract<ControlMessage, { type: 'spawn' }> => frame.type === 'spawn')

const startClaude = async (who: MemberName, machineId: MachineId, cwd: string) =>
  (await (
    await trpc(who)
  ).sessions.create.mutate({
    agentKind: 'claude-code',
    cwd,
    machineId,
  })) as { sessionId: SessionId }

const frameOf = (machineId: MachineId, sessionId: SessionId) =>
  spawnFrames(machineId).find((frame) => frame.sessionId === sessionId)

beforeAll(async () => {
  await (await trpc('alice')).accounts.connect.mutate({
    provider: 'anthropic',
    kind: 'api-key',
    credential: ALICE_KEY,
  })
  await (await trpc('bob')).accounts.connect.mutate({
    provider: 'anthropic',
    kind: 'api-key',
    credential: BOB_KEY,
  })
})

describe('MU-26: each member’s connections are their own', () => {
  it('each member lists only their own connection under the same account id', async () => {
    expect((await view('alice', 'managed:anthropic'))?.identity).toBe(mask(ALICE_KEY))
    expect((await view('bob', 'managed:anthropic'))?.identity).toBe(mask(BOB_KEY))
    expect(JSON.stringify(await list('bob'))).not.toContain(mask(ALICE_KEY))
  })

  it('a run uses the starter’s own connection, on each member’s own machine', async () => {
    await select('alice', 'managed:anthropic')
    await select('bob', 'managed:anthropic')
    const alice = await startClaude('alice', f.machines.alice, '/wt/alice-keyed')
    const bob = await startClaude('bob', f.machines.bob, '/wt/bob-keyed')
    expect(frameOf(f.machines.alice, alice.sessionId)?.env).toEqual({
      ANTHROPIC_API_KEY: ALICE_KEY,
    })
    expect(frameOf(f.machines.bob, bob.sessionId)?.env).toEqual({ ANTHROPIC_API_KEY: BOB_KEY })
  })

  it('a selection with no connection of the member’s own fails clearly and borrows nobody’s', async () => {
    // Only Alice has an OpenAI key.
    await (await trpc('alice')).accounts.connect.mutate({
      provider: 'openai',
      kind: 'api-key',
      credential: 'sk-openai-alice-2222222222',
    })
    await select('bob', 'managed:openai')
    const before = spawnFrames(f.machines.bob).length
    await expect(startClaude('bob', f.machines.bob, '/wt/bob-no-openai')).rejects.toThrow(
      /You have no OpenAI connection, and Podium never uses someone else's/,
    )
    expect(spawnFrames(f.machines.bob)).toHaveLength(before)
    await select('bob', 'managed:anthropic')
  })

  it('login attempts are per member, and only on the member’s own machine', async () => {
    const attempt = (await (
      await trpc('alice')
    ).accounts.login.mutate({
      harness: 'codex',
      machineId: f.machines.alice,
    })) as { sessionId: string; machineId: string }
    expect(attempt.machineId).toBe(f.machines.alice)
    expect((await view('alice', 'native:codex'))?.loginAttempt?.sessionId).toBe(attempt.sessionId)
    expect((await view('bob', 'native:codex'))?.loginAttempt).toBeUndefined()

    // Bob, a member, logs in on his own machine: his attempt, not Alice's.
    const bobs = (await (
      await trpc('bob')
    ).accounts.login.mutate({
      harness: 'codex',
      machineId: f.machines.bob,
    })) as { sessionId: string }
    expect(bobs.sessionId).not.toBe(attempt.sessionId)
    expect((await view('bob', 'native:codex'))?.loginAttempt?.sessionId).toBe(bobs.sessionId)
    expect((await view('alice', 'native:codex'))?.loginAttempt?.sessionId).toBe(attempt.sessionId)
  })

  it('plan quota and its history answer only to the member whose login it is', async () => {
    // Each machine reports its custodian's Claude login by email.
    for (const [who, machineId] of [
      ['alice', f.machines.alice],
      ['bob', f.machines.bob],
    ] as const) {
      await f.handle.registry.modules.machines.recordInventory(
        machineId,
        fixtureInventory({
          agents: fixtureInventory().agents.map((agent) =>
            agent.kind === 'claude-code'
              ? { ...agent, login: { state: 'in' as const, account: MEMBERS[who].email } }
              : agent,
          ),
        }),
      )
    }
    const now = Date.now()
    for (const who of ['alice', 'bob'] as const) {
      await store().quotaHistory.record(
        {
          accountKey: quotaAccountKey('claude-code', MEMBERS[who].email, 'unused'),
          agent: 'claude-code',
          windowKey: 'five_hour',
          label: '5h',
          usedPercent: who === 'alice' ? 40 : 70,
          resetsAtMs: now + 60 * 60 * 1000,
          windowMinutes: 300,
          atMs: now - 60_000,
          source: 'live',
        },
        15 * 60 * 1000,
      )
    }
    const history = async (who: MemberName) =>
      (
        (await (await trpc(who)).quota.history.query({ days: 1 })) as Array<{ accountKey: string }>
      ).map((row) => row.accountKey)
    expect(await history('alice')).toEqual([`claude-code::${MEMBERS.alice.email}`])
    expect(await history('bob')).toEqual([`claude-code::${MEMBERS.bob.email}`])
  })
})

describe('an admin cannot see, use or edit another member’s connection', () => {
  it('Alice (admin) sees only her own connection, and disconnecting hers leaves Bob’s', async () => {
    expect(JSON.stringify(await list('alice'))).not.toContain(mask(BOB_KEY))
    await (await trpc('alice')).accounts.disconnect.mutate({ id: 'managed:anthropic' })
    expect((await view('alice', 'managed:anthropic'))?.status).toBe('not-configured')
    expect((await view('bob', 'managed:anthropic'))?.identity).toBe(mask(BOB_KEY))
  })

  it('Alice cannot run with Bob’s connection: with hers gone, her run fails', async () => {
    const before = spawnFrames(f.machines.alice).length
    await expect(startClaude('alice', f.machines.alice, '/wt/alice-no-key')).rejects.toThrow(
      /You have no Anthropic connection/,
    )
    expect(spawnFrames(f.machines.alice)).toHaveLength(before)
    expect(JSON.stringify(f.daemonFrames(f.machines.alice))).not.toContain(BOB_KEY)
  })

  it('Alice cannot send Bob’s connection anywhere', async () => {
    await expect(
      (await trpc('alice')).accounts.send.mutate({
        id: 'managed:anthropic',
        machineId: f.machines.alice,
        acknowledgeSharedMachine: true,
      }),
    ).rejects.toThrow(/you have no connection managed:anthropic to send/)
    // Alice reconnects hers for the next section.
    await (await trpc('alice')).accounts.connect.mutate({
      provider: 'anthropic',
      kind: 'api-key',
      credential: ALICE_KEY,
    })
    await select('alice', 'managed:anthropic')
  })
})

describe('MU-28: Bob runs on Alice’s machine with his own connection only', () => {
  it('the warning is shown when Alice grants Bob use, and the grant needs it acknowledged', async () => {
    const share = { id: f.machines.alice, grantee: MEMBERS.bob.id, verb: 'use' as const }
    await expect((await trpc('alice')).machines.share.mutate(share)).rejects.toThrow(
      SHARED_MACHINE_ACCOUNT_WARNING,
    )
    const bobUses = async () =>
      (await store().grants.listForResource('machine', f.machines.alice)).some(
        (edge) => edge.grantee === MEMBERS.bob.id && edge.verb === 'use',
      )
    expect(await bobUses()).toBe(false)
    await (await trpc('alice')).machines.share.mutate({ ...share, acknowledgeSharedMachine: true })
    expect(await bobUses()).toBe(true)
  })

  it('Bob may not log in there: it would replace Alice’s login', async () => {
    await expect(
      (await trpc('bob')).accounts.login.mutate({
        harness: 'claude-code',
        machineId: f.machines.alice,
      }),
    ).rejects.toThrow(/someone else's machine: its claude-code login is theirs.*would replace it/)
  })

  it('a native login there is Alice’s, so Bob’s run on it fails clearly', async () => {
    await select('bob', 'native:claude-code')
    const before = spawnFrames(f.machines.alice).length
    await expect(startClaude('bob', f.machines.alice, '/wt/bob-native-on-alice')).rejects.toThrow(
      /someone else's machine: its native CLI logins are theirs/,
    )
    expect(spawnFrames(f.machines.alice)).toHaveLength(before)
  })

  it('before his first run there, Bob is shown the warning and nothing runs', async () => {
    await select('bob', 'managed:anthropic')
    const before = spawnFrames(f.machines.alice).length
    const refusal = startClaude('bob', f.machines.alice, '/wt/bob-unsent-on-alice')
    await expect(refusal).rejects.toThrow(/Before your first run on "machine-alice"/)
    await expect(refusal).rejects.toThrow(SHARED_MACHINE_ACCOUNT_WARNING)
    expect(spawnFrames(f.machines.alice)).toHaveLength(before)
    expect((await view('bob', 'managed:anthropic'))?.sendableTo).toEqual([
      { id: f.machines.alice, name: f.machines.alice },
    ])
  })

  it('sending his connection there shows the warning and needs it acknowledged', async () => {
    const send = { id: 'managed:anthropic', machineId: f.machines.alice }
    await expect((await trpc('bob')).accounts.send.mutate(send)).rejects.toThrow(
      SHARED_MACHINE_ACCOUNT_WARNING,
    )
    expect(
      await (await trpc('bob')).accounts.send.mutate({ ...send, acknowledgeSharedMachine: true }),
    ).toEqual({ ok: true, sent: true, warning: SHARED_MACHINE_ACCOUNT_WARNING })
    expect((await view('bob', 'managed:anthropic'))?.sentTo).toEqual([
      { id: f.machines.alice, name: f.machines.alice },
    ])
    // Alice's own list says nothing about where Bob sent his.
    expect(JSON.stringify(await list('alice'))).not.toContain(BOB_KEY.slice(-4))
  })

  it('then Bob’s run on Alice’s machine carries Bob’s key, and never Alice’s', async () => {
    const bob = await startClaude('bob', f.machines.alice, '/wt/bob-sent-on-alice')
    const frame = frameOf(f.machines.alice, bob.sessionId)
    expect(frame?.env).toEqual({ ANTHROPIC_API_KEY: BOB_KEY })
    expect(JSON.stringify(frame)).not.toContain(ALICE_KEY)
    expect((await store().sessions.getSession(bob.sessionId))?.ownerUserId).toBe(MEMBERS.bob.id)
  })

  it('Bob sees no native login of Alice’s machine in his hub', async () => {
    for (const account of (await list('bob')).filter((row) => row.source === 'native')) {
      expect(account.machines ?? []).not.toContain(f.machines.alice)
    }
  })
})
