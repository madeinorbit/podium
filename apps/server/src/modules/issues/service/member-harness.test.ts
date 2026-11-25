/** Issue launches and harness changes resolve one member's preferences, never
 *  the first admin's. Alice and Bob deliberately choose different harnesses. */
import { asSessionId, asUserId, firstAdminMemberId, type UserId } from '@podium/model'
import { normalizeSettings } from '@podium/runtime'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MODEL_CATALOG_VERSION } from '../../../model-catalog'
import { SessionRegistry } from '../../../relay'
import type { SessionStore } from '../../../store'
import { memberFacts } from '../../../store/fixtures/test-support'
import { issueRowFixture } from '../../../test-support/issue-row'
import { TEST_MACHINE_ID } from '../../../test-support/machine-id'
import { openTestStore } from '../../../test-support/open-test-store'
import { sessionReadPorts } from '../../../test-support/session-facts'
import { countStatements } from '../../../test-support/statement-count'
import { IssueService } from './index'
import { issueTestPlumbing } from './test-plumbing'
import type { IssueDeps } from './types'

const AT = '2026-11-25T12:00:00.000Z'
const BOB = asUserId('user:member-harness-bob')
const stores: SessionStore[] = []
const registries: SessionRegistry[] = []

afterEach(async () => {
  for (const registry of registries.splice(0)) await registry.dispose()
  for (const store of stores.splice(0)) await store.close()
  vi.restoreAllMocks()
})

async function memberStore() {
  const store = await openTestStore(':memory:', TEST_MACHINE_ID)
  stores.push(store)
  const alice = await firstAdminMemberId(store)
  await memberFacts(store).create(
    {
      id: BOB,
      displayName: 'Bob',
      email: null,
      role: 'member',
      createdAt: AT,
      disabledAt: null,
    },
    'not-a-real-hash',
  )
  await store.repos.addRepo('/repo', TEST_MACHINE_ID)
  for (const [user, harness, model, effort] of [
    [alice, 'claude-code', 'alice-model', 'low'],
    [BOB, 'codex', 'bob-model', 'high'],
  ] as const) {
    await store.settings.setSettingsFor(
      user,
      normalizeSettings({
        roles: { coding: { accountId: `native:${harness}`, model, effort } },
      }),
      AT,
    )
  }
  await store.settings.setModelCatalog({
    machineId: TEST_MACHINE_ID,
    version: MODEL_CATALOG_VERSION,
    fetchedAt: 1,
    byAgent: {
      'claude-code': [{ value: 'alice-model', label: 'Alice model', efforts: ['low'] }],
      codex: [
        { value: 'bob-model', label: 'Bob model', efforts: ['high'] },
        { value: 'picked-model', label: 'Picked model', efforts: ['high'] },
      ],
    },
  })
  return { store, alice }
}

async function fixture() {
  const { store, alice } = await memberStore()
  const deps: IssueDeps = {
    store,
    ...sessionReadPorts(() => []),
    getSettings: async (user) =>
      user ? await store.settings.getSettingsFor(user) : await store.settings.getSettings(),
    spawnSession: vi.fn(async () => ({
      sessionId: asSessionId('ses_member-harness'),
      machine: 'test-machine',
    })),
    repoOp: vi.fn(async () => ({ ok: true, output: '' })),
    resolveMachine: async () => TEST_MACHINE_ID,
    ...issueTestPlumbing(() => {}, { store }),
    setSessionArchived: vi.fn(),
    now: () => AT,
  }
  const svc = await IssueService.create(deps)
  // issueTestPlumbing begins attaching capture; finish before measuring reads.
  await store.attachChangeLog()
  const create = async (owner: UserId = BOB, picks: { model?: string; effort?: string } = {}) =>
    await svc.crud.create(svc.reports.store.serverWriter, {
      repoPath: '/repo',
      title: 'Member preferences',
      ownerUserId: owner,
      createdByActor: alice,
      createdByOnBehalfOf: alice,
      defaultModel: picks.model,
      defaultEffort: picks.effort,
      startNow: false,
    })
  return { store, svc, deps, alice, create }
}

describe('issue harness and model preferences belong to the issue member', () => {
  it('placement without a starter reads the assignee’s preferences', async () => {
    const { store, svc, create } = await fixture()
    const issue = await create()
    const personal = vi.spyOn(store.settings, 'getSettingsFor')
    expect(await svc.gitWorkflow.workMachine(issue.id)).toBe(TEST_MACHINE_ID)
    expect(personal).toHaveBeenCalledExactlyOnceWith(BOB)
  })

  it('system starts and added sessions use each assignee’s own harness, model and effort', async () => {
    const { svc, deps, alice, create } = await fixture()
    for (const [owner, agentKind, model, effort] of [
      [alice, 'claude-code', 'alice-model', 'low'],
      [BOB, 'codex', 'bob-model', 'high'],
    ] as const) {
      const issue = await create(owner)
      await svc.gitWorkflow.start(issue.id)
      expect(deps.spawnSession).toHaveBeenLastCalledWith(
        expect.objectContaining({ ownerUserId: owner, agentKind, model, effort }),
      )
      await svc.gitWorkflow.addSession(issue.id)
      expect(deps.spawnSession).toHaveBeenLastCalledWith(
        expect.objectContaining({ ownerUserId: owner, agentKind, model, effort }),
      )
    }
  })

  it('an explicit starter takes precedence over the assignee for both launch paths', async () => {
    const { svc, deps, alice, create } = await fixture()
    const issue = await create(alice)
    await svc.gitWorkflow.start(issue.id, undefined, { onBehalfOf: BOB })
    expect(deps.spawnSession).toHaveBeenLastCalledWith(
      expect.objectContaining({
        ownerUserId: BOB,
        agentKind: 'codex',
        model: 'bob-model',
        effort: 'high',
      }),
    )
    await svc.gitWorkflow.addSession(issue.id, undefined, { onBehalfOf: BOB })
    expect(deps.spawnSession).toHaveBeenLastCalledWith(
      expect.objectContaining({
        ownerUserId: BOB,
        agentKind: 'codex',
        model: 'bob-model',
        effort: 'high',
      }),
    )
  })

  it('naming the assignee’s default harness in an edit preserves stored picks', async () => {
    const { svc, create } = await fixture()
    const issue = await create(BOB, { model: 'picked-model', effort: 'high' })
    const updated = await svc.crud.update(svc.reports.store.serverWriter, issue.id, {
      defaultAgent: 'codex',
    })
    expect(updated).toMatchObject({ defaultModel: 'picked-model', defaultEffort: 'high' })
  })

  it('switching away from the assignee’s default harness clears stored picks', async () => {
    const { svc, create } = await fixture()
    const issue = await create(BOB, { model: 'picked-model', effort: 'high' })
    const updated = await svc.crud.update(svc.reports.store.serverWriter, issue.id, {
      defaultAgent: 'claude-code',
    })
    expect(updated).toMatchObject({ defaultModel: 'auto', defaultEffort: 'auto' })
  })

  it('changing assignee and harness together resolves the new assignee’s default', async () => {
    const { svc, alice, create } = await fixture()
    const issue = await create(alice, { model: 'picked-model', effort: 'high' })
    const updated = await svc.crud.update(
      svc.reports.store.serverWriter,
      issue.id,
      { defaultAgent: 'codex' },
      { owner: BOB },
    )
    expect(updated).toMatchObject({ defaultModel: 'picked-model', defaultEffort: 'high' })
  })

  it.each([
    false,
    true,
  ])('start harness comparison uses the resolved starter (explicit=%s)', async (explicit) => {
    const { svc, deps, alice, create } = await fixture()
    const issue = await create(explicit ? alice : BOB, { model: 'picked-model', effort: 'high' })
    await svc.gitWorkflow.start(issue.id, 'codex', explicit ? { onBehalfOf: BOB } : undefined)
    expect(deps.spawnSession).toHaveBeenLastCalledWith(
      expect.objectContaining({ agentKind: 'codex', model: 'picked-model', effort: 'high' }),
    )
    expect(await svc.reports.get(issue.id)).toMatchObject({
      defaultModel: 'picked-model',
      defaultEffort: 'high',
    })
  })

  it('an explicit launch choice still overrides member preferences', async () => {
    const { svc, deps, create } = await fixture()
    const issue = await create()
    await svc.gitWorkflow.start(issue.id, 'claude-code', { model: 'alice-model', effort: 'low' })
    expect(deps.spawnSession).toHaveBeenLastCalledWith(
      expect.objectContaining({ agentKind: 'claude-code', model: 'alice-model', effort: 'low' }),
    )
  })

  it('falls back to the creating human without an assignee, with two settings reads', async () => {
    const { store, svc, alice } = await fixture()
    // An agent actor is provenance; the human it created for owns the preferences.
    const row = issueRowFixture({
      defaultAgent: 'auto',
      ownerUserId: undefined,
      createdByActor: 'session:creator-agent',
      createdByOnBehalfOf: BOB,
    })
    const personal = vi.spyOn(store.settings, 'getSettingsFor')
    const read = await countStatements(store, async () => await svc.reports.store.settingsFor(row))
    expect(read.result.roles.coding.model).toBe('bob-model')
    expect(read.statements).toBe(2)
    expect(personal).toHaveBeenCalledExactlyOnceWith(BOB)
    expect(personal).not.toHaveBeenCalledWith(alice)
    expect(await svc.crud.switchesHarness(row, 'codex')).toBe(false)
  })

  it('uses workspace defaults with nobody known, even when the first admin has preferences', async () => {
    const { store } = await memberStore()
    const registry = await SessionRegistry.create(store, undefined, {
      instanceId: 'default',
      backgroundWork: false,
    })
    registries.push(registry)
    const row = issueRowFixture({
      defaultAgent: 'auto',
      ownerUserId: undefined,
      createdByActor: 'session:creator-agent',
      createdByOnBehalfOf: null,
    })
    const workspace = await store.settings.getSettings()
    const admin = vi.spyOn(store.users, 'earliestAdmin')
    const personal = vi.spyOn(store.settings, 'getSettingsFor')
    const read = await countStatements(
      store,
      async () => await registry.modules.issues.reports.store.settingsFor(row),
    )
    expect(read.result).toEqual(workspace)
    expect(read.result.roles.coding.model).toBe('auto')
    expect(read.statements).toBe(1)
    expect(admin).not.toHaveBeenCalled()
    expect(personal).not.toHaveBeenCalled()
    expect(await registry.modules.issues.crud.switchesHarness(row, 'codex')).toBe(true)
  })
})
