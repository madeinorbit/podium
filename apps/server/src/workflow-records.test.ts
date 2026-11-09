/**
 * AGENT PROFILES, WORKFLOWS AND TRIGGER SUBSCRIPTIONS AS SYNCED RECORDS
 * (POD-6676, ADR 12 D1; design POD-5620 §1.9-1.11), through the registry the
 * server composes:
 *
 *  - every write puts the records it changed on the change log, in its commit,
 *    with its provenance: a workflow command its workflow and revision, a run
 *    the server starts its run, a binding edit its binding, a profile edit its
 *    profile, a subscription toggle or removal its subscription under its feed
 *    id;
 *  - the generic edits keep today's rules: profiles are written by people who
 *    are admins, a binding's checks are `workflows.assign`'s, a subscription is
 *    its subscriber's;
 *  - rows stored before the kinds were synced reach the log at boot;
 *  - the workflow repository's write list is total.
 */

import { asMutationId, asUserId, firstAdminMemberId, subscriptionRowId } from '@podium/model'
import { afterEach, describe, expect, it } from 'vitest'
import { resolvePrincipalAsync, userCommandPrincipal } from './command-principal'
import { disposeOracles, makeOracle, type Oracle } from './modules/sessions/oracle-support'
import {
  appliedReply,
  changeRows,
  envelope,
  rowsOf,
  submit,
} from './modules/sync-write/outbox-test-support'
import {
  reconcileWorkflowRecords,
  WORKFLOW_STORE_UNSYNCED_WRITES,
  WORKFLOW_STORE_WRITES,
} from './modules/workflows/records'
import { WorkflowsRepository } from './store/workflows'
import { withWriteProvenance } from './write-provenance'

afterEach(() => disposeOracles())

const AT = '2026-11-09T00:00:00.000Z'
const NEW_PROFILE = 'agp_00000000-0000-4000-8000-000000006676'

const entries = async (o: Oracle, mutationId: string) =>
  (await rowsOf(o, mutationId)).map((row) => [row.entity, row.entityId, row.op])

async function member(o: Oracle, id = 'usr_member_6676') {
  const user = asUserId(id)
  await o.store.users.createUnclaimed({
    id: user,
    displayName: 'Member',
    email: null,
    role: 'member',
    createdAt: AT,
    disabledAt: null,
  })
  return user
}

describe('workflow records on the change log', () => {
  it('a workflow create commits its workflow and its first revision', async () => {
    const o = await makeOracle()
    const reply = appliedReply(
      await submit(
        o,
        envelope(
          'workflows.create',
          { name: 'Synced', scope: 'global', instructions: 'x', steps: [] },
          'mut_wf_create',
        ),
      ),
    )
    const { workflow, revision } = reply.result as {
      workflow: { id: string }
      revision: { id: string }
    }
    expect(await entries(o, 'mut_wf_create')).toEqual(
      expect.arrayContaining([
        ['workflow', workflow.id, 'upsert'],
        ['workflowRevision', revision.id, 'upsert'],
      ]),
    )
    // A publish moves the revision; its workflow is read back with it.
    appliedReply(
      await submit(o, envelope('workflows.publish', { revisionId: revision.id }, 'mut_wf_publish')),
    )
    expect(await entries(o, 'mut_wf_publish')).toContainEqual([
      'workflowRevision',
      revision.id,
      'upsert',
    ])
  })

  it('a binding is its generic edit: global needs a published revision, then it lands on the log', async () => {
    const o = await makeOracle()
    const created = appliedReply(
      await submit(
        o,
        envelope(
          'workflows.create',
          { name: 'Bound', scope: 'global', instructions: 'x', steps: [] },
          'mut_bind_create',
        ),
      ),
    ).result as { revision: { id: string } }
    const bind = { id: 'global:', patch: { revisionId: created.revision.id } }
    expect(
      await submit(o, envelope('records.workflowBinding.edit', bind, 'mut_bind_draft')),
    ).toEqual({
      outcome: 'rejected',
      refusal: {
        kind: 'invalid',
        message: 'shared workflow defaults require a published revision',
      },
    })
    appliedReply(
      await submit(
        o,
        envelope('workflows.publish', { revisionId: created.revision.id }, 'mut_bind_publish'),
      ),
    )
    appliedReply(await submit(o, envelope('records.workflowBinding.edit', bind, 'mut_bind')))
    expect(await entries(o, 'mut_bind')).toEqual([['workflowBinding', 'global:', 'upsert']])
    expect((await o.store.workflows.getBinding('global', ''))?.revisionId).toBe(created.revision.id)
    // A member may not set the instance default: the substrate arm's own words.
    const user = await member(o)
    const reply = await o.reg.modules.syncWrite.submit(
      envelope('records.workflowBinding.edit', bind, 'mut_bind_member'),
      userCommandPrincipal(user, 'member'),
      'trpc',
    )
    expect(reply.outcome).toBe('rejected')
  })

  it('a run a spawn starts commits its run on the feed’s origin', async () => {
    const o = await makeOracle()
    const created = appliedReply(
      await submit(
        o,
        envelope(
          'workflows.create',
          {
            name: 'Run me',
            scope: 'global',
            instructions: 'x',
            steps: [{ id: 'one', title: 'One', instructions: '', completionGuidance: '' }],
          },
          'mut_run_create',
        ),
      ),
    ).result as { revision: { id: string; workflowId: string } }
    const { sessionId } = await o.call.sessions.create({ agentKind: 'shell', cwd: '/w' })
    const run = await o.reg.modules.workflows.startRun({
      sessionId,
      cwd: '/w',
      revisionId: created.revision.id,
      onBehalfOf: firstAdminMemberId(),
    })
    const logged = (await changeRows(o)).filter(
      (row) => row.entity === 'workflowRun' && row.entityId === run.id,
    )
    expect(logged).toHaveLength(1)
    expect(JSON.parse(logged[0]!.payload ?? '{}')).toMatchObject({
      id: run.id,
      revisionId: created.revision.id,
      workflowId: created.revision.workflowId,
      status: 'active',
      steps: [expect.objectContaining({ stepId: 'one', status: 'pending', title: 'One' })],
    })
    // A spawn made inside a client command (an issue start on sync.submit)
    // starts its run inside that command: the feed's mirror origin commits
    // there too, under the command's provenance.
    const inside = await o.call.sessions.create({ agentKind: 'shell', cwd: '/w' })
    const nested = await withWriteProvenance(
      { mutationId: asMutationId('mut_spawn_inside') },
      async () =>
        await o.reg.modules.workflows.startRun({
          sessionId: inside.sessionId,
          cwd: '/w',
          revisionId: created.revision.id,
          onBehalfOf: firstAdminMemberId(),
        }),
    )
    expect(
      (await changeRows(o)).filter(
        (row) => row.entity === 'workflowRun' && row.entityId === nested.id,
      ),
    ).toHaveLength(1)
  })
})

describe('agent profile records', () => {
  it('create, edit and remove commit the profile under its device id', async () => {
    const o = await makeOracle()
    appliedReply(
      await submit(
        o,
        envelope(
          'records.agentProfile.create',
          { id: NEW_PROFILE, fields: { name: 'synced', description: 'one' } },
          'mut_p_create',
        ),
      ),
    )
    expect(await entries(o, 'mut_p_create')).toEqual([['agentProfile', NEW_PROFILE, 'upsert']])
    appliedReply(
      await submit(
        o,
        envelope(
          'records.agentProfile.edit',
          { id: NEW_PROFILE, patch: { description: 'two' } },
          'mut_p_edit',
        ),
      ),
    )
    expect((await o.store.agentProfiles.get(NEW_PROFILE))?.description).toBe('two')
    expect(await entries(o, 'mut_p_edit')).toEqual([['agentProfile', NEW_PROFILE, 'upsert']])
    appliedReply(
      await submit(o, envelope('records.agentProfile.remove', { id: NEW_PROFILE }, 'mut_p_rm')),
    )
    expect(await entries(o, 'mut_p_rm')).toEqual([['agentProfile', NEW_PROFILE, 'remove']])
    expect(await o.store.agentProfiles.get(NEW_PROFILE)).toBeNull()
  })

  it('refuses a member and an agent session before the handler', async () => {
    const o = await makeOracle()
    const create = (mutationId: string) =>
      envelope(
        'records.agentProfile.create',
        { id: NEW_PROFILE, fields: { name: 'nope' } },
        mutationId,
      )
    const user = await member(o)
    const asMember = await o.reg.modules.syncWrite.submit(
      create('mut_p_member'),
      userCommandPrincipal(user, 'member'),
      'trpc',
    )
    expect(asMember.outcome).toBe('rejected')
    const { sessionId } = await o.call.sessions.create({ agentKind: 'shell', cwd: '/a' })
    const agent = await resolvePrincipalAsync(
      await o.reg.modules.sessions.capabilityForSession(sessionId),
      { parentSessionOf: async () => undefined, onBehalfOfFor: async () => firstAdminMemberId() },
    )
    const asAgent = await o.reg.modules.syncWrite.submit(create('mut_p_agent'), agent, 'trpc')
    // The admin floor is the agent capability's: refused before the service's
    // people-only rule is asked (which refuses it too, `service.test.ts`).
    expect(asAgent.outcome).toBe('rejected')
    expect(await o.store.agentProfiles.get(NEW_PROFILE)).toBeNull()
  })
})

describe('trigger subscription records', () => {
  it('a toggle and a removal commit the subscription under its subscriber’s feed id', async () => {
    const o = await makeOracle()
    const { sessionId } = await o.call.sessions.create({ agentKind: 'shell', cwd: '/s' })
    const sub = await o.call.issues.subscriptionAdd({
      event: 'session.finished',
      source: { kind: 'relationship', ref: 'my-children' },
      subscriber: { kind: 'session', id: sessionId },
    })
    const id = subscriptionRowId('session', sessionId, sub.id)
    appliedReply(
      await submit(
        o,
        envelope('records.subscription.edit', { id, patch: { enabled: false } }, 'mut_s_off'),
      ),
    )
    expect(await entries(o, 'mut_s_off')).toEqual([['subscription', id, 'upsert']])
    expect((await o.store.events.getSubscription(sub.id))?.enabled).toBe(false)
    appliedReply(await submit(o, envelope('records.subscription.remove', { id }, 'mut_s_rm')))
    expect(await entries(o, 'mut_s_rm')).toEqual([['subscription', id, 'remove']])
    expect(await o.store.events.getSubscription(sub.id)).toBeUndefined()
  })

  it('another person’s subscription is refused, and nothing changes', async () => {
    const o = await makeOracle()
    const { sessionId } = await o.call.sessions.create({ agentKind: 'shell', cwd: '/s' })
    const sub = await o.call.issues.subscriptionAdd({
      event: 'session.finished',
      source: { kind: 'relationship', ref: 'my-children' },
      subscriber: { kind: 'session', id: sessionId },
    })
    const user = await member(o)
    const reply = await o.reg.modules.syncWrite.submit(
      envelope(
        'records.subscription.edit',
        { id: subscriptionRowId('session', sessionId, sub.id), patch: { enabled: false } },
        'mut_s_other',
      ),
      userCommandPrincipal(user, 'member'),
      'trpc',
    )
    // One answer for a missing record and another person's (no oracle).
    expect(reply).toEqual({ outcome: 'rejected', refusal: { kind: 'unauthorized' } })
    expect((await o.store.events.getSubscription(sub.id))?.enabled).toBe(true)
  })
})

describe('the boot back-fill', () => {
  it('puts every stored workflow, revision, binding and run on the log, once', async () => {
    const o = await makeOracle()
    const store = o.store.workflows
    await store.insertWorkflow({
      id: 'wf_old',
      name: 'Old',
      description: '',
      scope: 'global',
      scopeRef: null,
      actor: { kind: 'operator', id: null },
      ownerUserId: firstAdminMemberId(),
      now: AT,
    })
    await store.insertRevision({
      id: 'wfr_old',
      workflowId: 'wf_old',
      instructions: '',
      steps: [],
      actor: { kind: 'operator', id: null },
      now: AT,
    })
    const seen: Array<[string, string[]]> = []
    await reconcileWorkflowRecords(
      {
        reconcile: async (entity, rows) => {
          seen.push([entity, rows.map((row) => row.id)])
        },
      },
      store,
    )
    expect(seen).toEqual([
      ['workflow', ['wf_old']],
      ['workflowRevision', ['wfr_old']],
      ['workflowBinding', []],
      ['workflowRun', []],
    ])
  })
})

describe('the workflow repository’s writes', () => {
  it('every method that writes is recorded, or named as writing no synced row', () => {
    const methods = Object.getOwnPropertyNames(WorkflowsRepository.prototype).filter(
      (name) => name !== 'constructor',
    )
    const writes = methods.filter((name) =>
      /^(insert|update|set|publish|assign|reset|append|delete|remove|archive)/.test(name),
    )
    for (const name of writes) {
      expect(
        Object.hasOwn(WORKFLOW_STORE_WRITES, name) || WORKFLOW_STORE_UNSYNCED_WRITES.includes(name),
        name,
      ).toBe(true)
    }
    for (const name of [...Object.keys(WORKFLOW_STORE_WRITES), ...WORKFLOW_STORE_UNSYNCED_WRITES]) {
      expect(methods, name).toContain(name)
    }
  })
})
