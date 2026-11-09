/**
 * THE SYNC FAMILY BUILDER AND ITS FIRST FAMILIES (POD-6412, plan Task 16).
 *
 * Through the registry the server actually composes: agent profiles (a
 * generic record kind since POD-6676), conversations, read positions and the instance settings tier. Each write
 * arrives through `submit` with its provenance and a receipt; a replay answers
 * the recorded result and runs nothing; the target check refuses before the
 * handler; a handler's own refusal carries its message; and the old routes are
 * either thin adapters (shipped clients still call them) or gone.
 */

import { asUserId, type UserId } from '@podium/model'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { type CommandPrincipal, userCommandPrincipal } from '../../command-principal'
import { appRouter } from '../../router'
import { disposeOracles, makeOracle, type Oracle } from '../sessions/oracle-support'
import { FAMILY_COMMAND_NAMES } from './family-commands'
import { appliedReply, envelope, expectAppliedOnPath, rowsOf, submit } from './outbox-test-support'

afterEach(() => disposeOracles())

const routerRecord = (name: string): Record<string, unknown> =>
  (appRouter as unknown as { _def: { record: Record<string, Record<string, unknown>> } })._def
    .record[name] ?? {}

/** A device-minted profile id per name, stable within a test. */
const profileId = (name: string) =>
  `agp_00000000-0000-4000-8000-${Buffer.from(name).toString('hex').padEnd(12, '0').slice(0, 12)}`

/** `records.agentProfile.create`'s input (POD-6676). */
const profileCreate = (name: string) => ({
  id: profileId(name),
  fields: {
    name,
    candidates: [{ harness: 'claude-code' as const, model: 'auto', effort: 'high' }],
  },
})

/** A member account that exists, so its role is read live. */
async function member(o: Oracle, id = 'usr_member_6412'): Promise<UserId> {
  const user = asUserId(id)
  await o.store.users.createUnclaimed({
    id: user,
    displayName: 'Member',
    email: null,
    role: 'member',
    createdAt: new Date().toISOString(),
    disabledAt: null,
  })
  return user
}

const submitAs = async (o: Oracle, principal: CommandPrincipal, command: string, input: unknown) =>
  await o.reg.modules.syncWrite.submit(
    envelope(command, input, `mut_${command}_${Math.random()}`),
    principal,
    'trpc',
  )

describe('the sync families on the entry point', () => {
  it('the composed registry holds every family command', async () => {
    const o = await makeOracle()
    const names = o.reg.modules.syncWrite.registry.names()
    for (const name of FAMILY_COMMAND_NAMES) expect(names, name).toContain(name)
  })

  it('records.agentProfile.create applies once with a receipt and its change entry', async () => {
    const o = await makeOracle()
    const { rows } = await expectAppliedOnPath(
      o,
      envelope('records.agentProfile.create', profileCreate('critique'), 'mut_profile_create'),
      // A profile is a synced record (POD-6676): its row reaches the log.
      { writes: true },
    )
    expect(rows.map((row) => [row.entity, row.entityId])).toEqual([
      ['agentProfile', profileId('critique')],
    ])
    expect((await o.call.agentProfiles.list({})).map((p) => p.name)).toContain('critique')
  })

  it("a handler's own refusal is a rejected reply that carries its message", async () => {
    const o = await makeOracle()
    appliedReply(
      await submit(o, envelope('records.agentProfile.create', profileCreate('dup'), 'mut_dup_1')),
    )

    const reply = await submit(
      o,
      envelope(
        'records.agentProfile.create',
        { ...profileCreate('dup'), id: 'agp_00000000-0000-4000-8000-0000000000d2' },
        'mut_dup_2',
      ),
    )
    expect(reply).toEqual({
      outcome: 'rejected',
      refusal: {
        kind: 'invalid',
        message: "a profile named 'dup' already exists — use `podium profile update dup`",
      },
    })
  })

  it('the target check refuses a member before the handler, with no message', async () => {
    const o = await makeOracle()
    const user = await member(o)
    const create = vi.spyOn(o.reg.modules.agentProfiles, 'createRecord')

    const reply = await submitAs(
      o,
      userCommandPrincipal(user, 'member'),
      'records.agentProfile.create',
      profileCreate('nope'),
    )
    expect(reply).toMatchObject({ outcome: 'rejected', refusal: { kind: 'unauthorized' } })
    expect(create).not.toHaveBeenCalled()
  })

  it('conversations.setMeta writes the conversation row with provenance', async () => {
    const o = await makeOracle()
    const machineId = o.store.hostMachineId
    await o.reg.gateway.routeDaemonFrame(machineId, {
      type: 'conversationsChanged',
      conversations: [{ id: 'conv-6412', agentKind: 'claude-code', providerId: 'p' } as never],
      diagnostics: [],
    })
    // A conversation is readable through the session that owns it.
    const { sessionId } = await o.reg.modules.sessions.createSession({
      agentKind: 'claude-code',
      cwd: '/owned-conversation',
    })
    await o.reg.gateway.routeDaemonFrame(machineId, {
      type: 'sessionResumeRef',
      sessionId,
      resume: { kind: 'claude-session', value: 'conv-6412' },
    })
    await o.reg.modules.sessions.flushBroadcasts()
    const { rows } = await expectAppliedOnPath(
      o,
      envelope('conversations.setMeta', { id: 'conv-6412', name: 'Renamed' }, 'mut_conv_meta'),
      { writes: true },
    )
    expect(rows.map((row) => [row.entity, row.entityId])).toEqual([['conversation', 'conv-6412']])
  })

  it('a conversation the reader cannot see is not found, and nothing is written', async () => {
    const o = await makeOracle()
    const reply = await submit(
      o,
      envelope('conversations.setMeta', { id: 'conv-missing', name: 'x' }, 'mut_conv_missing'),
    )
    expect(reply).toEqual({
      outcome: 'rejected',
      refusal: { kind: 'target-not-found', message: 'conversation not found' },
    })
    expect(await rowsOf(o, 'mut_conv_missing')).toEqual([])
  })

  it('settings.updateInstance applies once; a value the schema refuses is invalid', async () => {
    const o = await makeOracle()
    await expectAppliedOnPath(
      o,
      envelope('settings.updateInstance', { values: { 'hibernation.memoryPct': 80 } }, 'mut_inst'),
      { writes: false },
    )

    const reply = await submit(
      o,
      envelope(
        'settings.updateInstance',
        { values: { 'hibernation.memoryPct': 'not-a-number' } },
        'mut_inst_bad',
      ),
    )
    expect(reply.outcome).toBe('rejected')
    if (reply.outcome === 'rejected') expect(reply.refusal.kind).toBe('invalid')
  })

  it('settings.updateInstance refuses a member: the admin floor', async () => {
    const o = await makeOracle()
    const user = await member(o)
    const reply = await submitAs(
      o,
      userCommandPrincipal(user, 'member'),
      'settings.updateInstance',
      {
        values: { 'hibernation.memoryPct': 70 },
      },
    )
    expect(reply).toEqual({ outcome: 'rejected', refusal: { kind: 'unauthorized' } })
  })
})

describe('the old routes of the sync families', () => {
  it('conversations.setMeta has no route: no client ever called one', () => {
    expect(routerRecord('conversations').setMeta).toBeUndefined()
  })

  it('agent profiles have no write route: their writes are the record kind (POD-6676)', () => {
    for (const key of ['create', 'update', 'delete', 'import']) {
      expect(routerRecord('agentProfiles')[key], `agentProfiles.${key}`).toBeUndefined()
    }
  })

  it('the routes shipped clients still call are served, as mutations', () => {
    const verbOf = (proc: unknown) => (proc as { _def?: { type?: string } } | undefined)?._def?.type
    expect(verbOf(routerRecord('settings').updateInstance)).toBe('mutation')
  })

  it('each kept route is a thin adapter onto the entry point', async () => {
    const o = await makeOracle()
    const entry = vi.spyOn(o.reg.modules.syncWrite, 'submitDetailed')
    await o.call.settings.updateInstance({ values: { 'hibernation.memoryPct': 75 } })
    expect(entry.mock.calls.map(([env]) => env.command)).toEqual(['settings.updateInstance'])
  })
})
