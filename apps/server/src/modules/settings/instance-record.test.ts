/**
 * THE INSTANCE SETTINGS AS ONE SYNCED RECORD (POD-6677).
 *
 * Through the real composed server over `sync.submit` (the path the apps'
 * outbox takes), then through the Authority's feed with the real visibility
 * policy: every member's devices receive the record, only an admin writes it,
 * and no secret is ever on it. The boot back-fill puts the stored blob on the
 * log once.
 */

import {
  asUserId,
  firstAdminMemberId,
  INSTANCE_PREFERENCE_LEAVES,
  INSTANCE_PREFERENCES_ROW_ID,
  InstancePreferencesWire,
  SERVER_SECRET_KEYS,
  SETTINGS_CLASSIFICATION,
} from '@podium/model'
import { asCapabilityRef, asDeviceId, MetadataChange, type Principal } from '@podium/protocol'
import { Authority, GrantEdgeVisibilityPolicy, NoDelegationsGranted } from '@podium/sync'
import { afterEach, describe, expect, it } from 'vitest'
import { userCommandPrincipal } from '../../command-principal'
import { makeFeedVisibility } from '../../feed-visibility'
import { withPlainCommand } from '../../plain-command-scope'
import type { SessionStore } from '../../store'
import { openTestStore } from '../../test-support/open-test-store'
import { disposeOracles, makeOracle, type Oracle } from '../sessions/oracle-support'
import { envelope, expectAppliedOnPath, submit } from '../sync-write/outbox-test-support'
import { reconcileInstancePreferences } from './instance-record'

afterEach(() => disposeOracles())

const ME = firstAdminMemberId()
const ID = INSTANCE_PREFERENCES_ROW_ID
const SECRET = 'sk-ant-instance-record-must-never-carry-this'

const refusalOf = (reply: Awaited<ReturnType<typeof submit>>) =>
  reply.outcome === 'rejected' ? reply.refusal : undefined

const principal = (user: string): Principal => ({
  kind: 'user',
  user: asUserId(user),
  device: asDeviceId(`device:${user}`),
  capability: asCapabilityRef(`cap:${user}`),
})

/** A second person on the instance, with this role. */
async function member(o: Oracle, id: string, role: 'member' | 'admin' = 'member') {
  const user = asUserId(id)
  await o.store.users.createUnclaimed({
    id: user,
    displayName: id,
    email: null,
    role,
    createdAt: new Date().toISOString(),
    disabledAt: null,
  })
  return user
}

const trailOf = async (o: Oracle) =>
  (await o.store.settingsAudit.list()).filter(
    (row) => row.command === 'records.instancePreferences.edit',
  )

/** The instance record on a principal's bootstrap, or undefined. */
async function recordOn(o: Oracle, user: string) {
  const changes = (await o.reg.changeLedger.authority.bootstrap(principal(user))).changes
  const row = changes.find((c) => c.entity === 'instancePreferences')
  return row?.op === 'upsert' ? (row.value as Record<string, unknown>) : undefined
}

describe('records.instancePreferences', () => {
  it('an admin edit writes the leaves it names, publishes the record, and a reset restores the default', async () => {
    const o = await makeOracle()
    const { rows } = await expectAppliedOnPath(
      o,
      envelope(
        'records.instancePreferences.edit',
        { id: ID, patch: { 'hibernation.memoryPct': 90, 'gitWorkflow.mergeStyle': 'pr' } },
        'i-1',
      ),
      { writes: true },
    )
    expect(rows.map((r) => [r.entity, r.entityId])).toEqual([['instancePreferences', ID]])
    // Another admin device changes a different leaf: neither overwrites the other.
    await expectAppliedOnPath(
      o,
      envelope(
        'records.instancePreferences.edit',
        { id: ID, patch: { experimental: { 'git-panel': true } } },
        'i-2',
      ),
      { writes: true },
    )
    const stored = await o.store.settings.getSettings()
    expect(stored.hibernation.memoryPct).toBe(90)
    expect(stored.gitWorkflow.mergeStyle).toBe('pr')
    expect(stored.experimental).toEqual({ 'git-panel': true })
    expect(await recordOn(o, ME)).toMatchObject({
      'hibernation.memoryPct': 90,
      'gitWorkflow.mergeStyle': 'pr',
      experimental: { 'git-panel': true },
    })

    await expectAppliedOnPath(
      o,
      envelope(
        'records.instancePreferences.edit',
        { id: ID, patch: {}, unset: ['hibernation.memoryPct'] },
        'i-3',
      ),
      { writes: true },
    )
    expect((await o.store.settings.getSettings()).hibernation.memoryPct).toBe(80)
    expect(await recordOn(o, ME)).toMatchObject({ 'hibernation.memoryPct': 80 })

    // The settings audit trail keeps a row per applied write, attributed to me.
    const trail = await trailOf(o)
    expect(trail.map((row) => row.outcome)).toEqual(['applied', 'applied', 'applied'])
    expect(trail.every((row) => row.actorId === ME)).toBe(true)
  })

  it('a replay runs nothing, and a secret or a personal path is no field of the record', async () => {
    const o = await makeOracle()
    const env = envelope(
      'records.instancePreferences.edit',
      { id: ID, patch: { 'steward.enabled': false } },
      'i-r',
    )
    await expectAppliedOnPath(o, env, { writes: true })
    const replay = await submit(o, env)
    expect(replay.outcome === 'applied' && replay.replayed).toBe(true)
    expect(await trailOf(o)).toHaveLength(1)

    for (const path of ['apiKeys.openai', 'notifications.telegramBotToken', 'sidebar.repoSort']) {
      const reply = await submit(
        o,
        envelope('records.instancePreferences.edit', { id: ID, patch: { [path]: SECRET } }, path),
      )
      expect(refusalOf(reply)?.kind, path).toBe('invalid')
    }
    expect(await o.store.secrets.getOrEmpty('apiKeys.openai')).toBe('')
  })

  it('only an admin writes it: a member and a disabled admin are refused, and the refusal is trailed', async () => {
    const o = await makeOracle()
    const asMember = await member(o, 'user:member-6677')
    const memberReply = await o.reg.modules.syncWrite.submit(
      envelope(
        'records.instancePreferences.edit',
        { id: ID, patch: { 'hibernation.enabled': false } },
        'i-member',
      ),
      userCommandPrincipal(asMember, 'member'),
      'trpc',
    )
    expect(memberReply).toEqual({ outcome: 'rejected', refusal: { kind: 'unauthorized' } })

    const formerAdmin = await member(o, 'user:former-admin-6677', 'admin')
    await o.store.users.disable(formerAdmin, new Date().toISOString())
    const disabledReply = await o.reg.modules.syncWrite.submit(
      envelope(
        'records.instancePreferences.edit',
        { id: ID, patch: { 'hibernation.enabled': false } },
        'i-disabled',
      ),
      userCommandPrincipal(formerAdmin, 'admin'),
      'trpc',
    )
    expect(disabledReply).toEqual({ outcome: 'rejected', refusal: { kind: 'unauthorized' } })

    // Nothing moved. The member's capability is below the kind's admin floor,
    // so the entry point's front door refuses it before anything is read; the
    // disabled admin passes the front door and the live role refuses it, which
    // is an audit fact.
    expect((await o.store.settings.getSettings()).hibernation.enabled).toBe(true)
    expect((await trailOf(o)).map((row) => [row.actorId, row.outcome])).toEqual([
      [formerAdmin, 'refused'],
    ])
    // The positive control: an admin's same write applies.
    await expectAppliedOnPath(
      o,
      envelope(
        'records.instancePreferences.edit',
        { id: ID, patch: { 'hibernation.enabled': false } },
        'i-admin',
      ),
      { writes: true },
    )
    expect((await o.store.settings.getSettings()).hibernation.enabled).toBe(false)
  })

  it('an id other than the instance record is unknown', async () => {
    const o = await makeOracle()
    const reply = await submit(
      o,
      envelope(
        'records.instancePreferences.edit',
        { id: 'not-the-instance', patch: { 'steward.enabled': false } },
        'i-wrong-id',
      ),
    )
    expect(refusalOf(reply)).toBeDefined()
    expect((await o.store.settings.getSettings()).steward.enabled).toBe(true)
  })

  it('a write that fails rolls back, and the refusal is trailed outside it', async () => {
    const o = await makeOracle()
    const settings = o.store.settings as { setSettings: (next: unknown) => Promise<void> }
    const original = settings.setSettings.bind(settings)
    settings.setSettings = async () => {
      throw new Error('settings write failed')
    }
    try {
      // Not the patch's fault: it propagates, so the outbox retries it.
      await expect(
        submit(
          o,
          envelope(
            'records.instancePreferences.edit',
            { id: ID, patch: { 'worktreeGc.afterDays': 3 } },
            'i-fail',
          ),
        ),
      ).rejects.toThrow('settings write failed')
    } finally {
      settings.setSettings = original
    }
    expect((await o.store.settings.getSettings()).worktreeGc.afterDays).toBe(14)
    expect((await trailOf(o)).map((row) => row.outcome)).toEqual(['refused'])
  })
})

describe('the instance record reaches every member', () => {
  it('is on every member’s bootstrap and deltas, an admin’s change included', async () => {
    const o = await makeOracle()
    const other = await member(o, 'user:reader-6677')
    const before = await o.reg.changeLedger.authority.cursor()
    await expectAppliedOnPath(
      o,
      envelope(
        'records.instancePreferences.edit',
        { id: ID, patch: { 'issues.assistantEnabled': false } },
        'v-1',
      ),
      { writes: true },
    )
    // The admin and an ordinary member hold the same record.
    expect(await recordOn(o, ME)).toMatchObject({ 'issues.assistantEnabled': false })
    expect(await recordOn(o, other)).toEqual(await recordOn(o, ME))

    const theirDelta = await o.reg.changeLedger.authority.changesSince(before, principal(other))
    const ids =
      theirDelta?.kind === 'batch'
        ? theirDelta.changes
            .filter((c) => c.entity === 'instancePreferences')
            .map((c) => c.entityId)
        : []
    expect(ids).toEqual([ID])
  })

  it('a deployment write publishes the record too, from a plain command as well (the capture is on the blob write)', async () => {
    const o = await makeOracle()
    const before = await o.reg.changeLedger.authority.cursor()
    // From inside a plain command, as `setup.setChannel` writes it: the record is
    // the blob's projection, republished as the server's own write.
    await withPlainCommand(
      'setup.setChannel',
      async () => await o.store.settings.updateDeployment({ updateChannel: 'edge' }),
    )
    const delta = await o.reg.changeLedger.authority.changesSince(before, principal(ME))
    const values =
      delta?.kind === 'batch'
        ? delta.changes
            .filter((c) => c.entity === 'instancePreferences' && c.op === 'upsert')
            .map((c) => (c as { value: Record<string, unknown> }).value)
        : []
    expect(values.at(-1)).toMatchObject({ 'deployment.updateChannel': 'edge' })
  })
})

describe('no secret is ever on the instance record', () => {
  it('the schema has no secret leaf, and every leaf is the instance tier', () => {
    const fields = Object.keys(InstancePreferencesWire.shape)
    expect(fields.length).toBeGreaterThan(10)
    const secrets = new Set(
      SETTINGS_CLASSIFICATION.filter((c) => c.tier === 'server-secret').map((c) => c.path),
    )
    // The non-vacuity control: the secret tier is not empty, so the disjointness
    // below is a finding rather than an empty set.
    expect(secrets.size).toBeGreaterThan(0)
    for (const key of SERVER_SECRET_KEYS) expect(secrets.has(key)).toBe(true)
    for (const field of fields) {
      expect(secrets.has(field), field).toBe(false)
      expect(SETTINGS_CLASSIFICATION.find((c) => c.path === field)?.tier, field).toBe(
        'instance-preference',
      )
    }
    expect([...INSTANCE_PREFERENCE_LEAVES.keys()].sort()).toEqual([...fields].sort())
    // The wire refuses a secret leaf outright.
    expect(InstancePreferencesWire.safeParse({ 'apiKeys.openai': SECRET }).success).toBe(false)
    expect(
      MetadataChange.safeParse({
        seq: 1,
        entity: 'instancePreferences',
        id: ID,
        op: 'upsert',
        value: { 'apiKeys.openai': SECRET },
      }).success,
    ).toBe(false)
  })

  it('a feed sample after a secret is set carries no secret material', async () => {
    const o = await makeOracle()
    await o.call.settings.setSecret({ key: 'apiKeys.openai', value: SECRET })
    await expectAppliedOnPath(
      o,
      envelope(
        'records.instancePreferences.edit',
        { id: ID, patch: { 'hibernation.idleMinutes': 45 } },
        's-1',
      ),
      { writes: true },
    )
    const changes = (await o.reg.changeLedger.authority.bootstrap(principal(ME))).changes
    const record = changes.filter((c) => c.entity === 'instancePreferences')
    expect(record).toHaveLength(1)
    expect(JSON.stringify(record)).not.toContain(SECRET)
    expect(JSON.stringify(changes)).not.toContain(SECRET)
  })
})

// ---------------------------------------------------------------------------
// The back-fill: the stored blob reaches the log at boot, once
// ---------------------------------------------------------------------------

const stores: SessionStore[] = []
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close()
})

async function feedFixture() {
  const store = await openTestStore(':memory:')
  stores.push(store)
  const policy = makeFeedVisibility({
    store,
    audiencesFor: (kind, ids) => store.grants.visibilityAudiencesFor(kind, ids),
    authorizationRevision: () => store.grants.visibilityRevision(),
  })
  const authority = new Authority({
    store: store.sync,
    now: () => 1_000,
    transact: async (fn) => await store.transact(fn),
    visibility: new GrantEdgeVisibilityPolicy(policy.state, new NoDelegationsGranted()),
    anchors: policy.anchors,
  })
  return { store, authority }
}

describe('the boot reconcile back-fills the stored instance settings', () => {
  it('the stored blob becomes one log row every member holds, and a restart appends nothing', async () => {
    const { store, authority } = await feedFixture()
    const stored = await store.settings.getSettings()
    await store.settings.setSettings({
      ...stored,
      hibernation: { ...stored.hibernation, memoryPct: 70 },
    })
    const writer = {
      reconcile: async (
        entity: Parameters<Authority['reconcile']>[0],
        rows: { id: string; value: unknown }[],
      ) => await authority.reconcile(entity, rows),
    }

    await reconcileInstancePreferences(writer, store)
    for (const user of [ME, 'user:anyone-6677']) {
      const rows = (await authority.bootstrap(principal(user))).changes.filter(
        (c) => c.entity === 'instancePreferences',
      )
      const values = rows.map((c) => [
        c.entityId,
        c.op === 'upsert' && (c.value as Record<string, unknown>)['hibernation.memoryPct'],
      ])
      expect(values).toEqual([[ID, 70]])
    }

    const head = await authority.cursor()
    await reconcileInstancePreferences(writer, store)
    expect(await authority.cursor()).toBe(head)
  })
})
