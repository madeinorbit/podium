/**
 * Agent profiles, workflows and trigger subscriptions as synced records cost a
 * constant number of statements (POD-6676, rule 8 of docs/agents/server-data.md).
 *
 *  - The feed's visibility pass over a batch naming `size` workflows, revisions,
 *    bindings, runs and subscriptions reads each table once, whatever the size.
 *  - A profile edit, a binding edit and a subscription toggle on `sync.submit`,
 *    against a store holding `size` others of each, read and write their one row,
 *    and the change entry is the record they changed, never a scan.
 *  - A workflow revision through `workflows.revise` reads back the records it
 *    touched (the revision and its workflow), never the library.
 */

import {
  asSessionId,
  asUserId,
  firstAdminMemberId,
  subscriptionRowId,
  workflowBindingRowId,
} from '@podium/model'
import type { EntityRef } from '@podium/sync'
import { afterEach, describe, expect, it } from 'vitest'
import { makeFeedVisibility } from './feed-visibility'
import { disposeOracles, makeOracle, type Oracle } from './modules/sessions/oracle-support'
import { appliedReply, envelope, submit } from './modules/sync-write/outbox-test-support'
import type { SessionStore } from './store'
import { openTestStore } from './test-support/open-test-store'
import {
  expectArmed,
  expectConstantStatements,
  type StatementPin,
} from './test-support/statement-count'

afterEach(() => disposeOracles())

const owner = asUserId('owner')
const stranger = asUserId('stranger')
const AT = '2026-11-09T00:00:00.000Z'
const actor = { kind: 'operator' as const, id: null }
let seq = 0

/** `size` workflows, each with a revision, a binding on its own task and a run. */
async function seedWorkflows(store: SessionStore, size: number, who = owner): Promise<void> {
  for (let i = 0; i < size; i++) {
    await store.workflows.insertWorkflow({
      id: `wf_${i}`,
      name: `Workflow ${i}`,
      description: '',
      scope: 'repository',
      scopeRef: 'repo',
      actor,
      ownerUserId: who,
      now: AT,
    })
    await store.workflows.insertRevision({
      id: `wfr_${i}`,
      workflowId: `wf_${i}`,
      instructions: 'x',
      steps: [],
      actor,
      now: AT,
    })
    await store.workflows.setBinding({
      targetKind: 'issue',
      targetId: `iss_${i}`,
      revisionId: `wfr_${i}`,
      actor,
      ownerUserId: who,
      now: AT,
    })
    await store.workflows.insertRun({
      run: {
        id: `wrun_${i}`,
        subjectKind: 'issue',
        subjectId: `iss_${i}`,
        coordinatorSessionId: asSessionId(`sess_${i}`),
        revisionId: `wfr_${i}`,
        status: 'active',
        supersedesRunId: null,
        startedAt: AT,
        completedAt: null,
        ownerUserId: who,
      },
      steps: [],
    })
  }
}

interface VisibilityFixture {
  store: SessionStore
  policy: ReturnType<typeof makeFeedVisibility>
  size: number
}

async function visibilityFixture(size: number): Promise<VisibilityFixture> {
  const store = await openTestStore(':memory:')
  await seedWorkflows(store, size)
  const policy = makeFeedVisibility({
    store,
    audiencesFor: (kind, ids) => store.grants.visibilityAudiencesFor(kind, ids),
    authorizationRevision: () => store.grants.visibilityRevision(),
  })
  return { store, policy, size }
}

const workflowRefs = (size: number): EntityRef[] =>
  Array.from({ length: size }, (_, i): EntityRef[] => [
    { entity: 'workflow', entityId: `wf_${i}` },
    { entity: 'workflowRevision', entityId: `wfr_${i}` },
    { entity: 'workflowBinding', entityId: workflowBindingRowId('issue', `iss_${i}`) },
    { entity: 'workflowRun', entityId: `wrun_${i}` },
    { entity: 'subscription', entityId: subscriptionRowId('session', `sess_${i}`, `sub_${i}`) },
    { entity: 'agentProfile', entityId: `agp_${i}` },
  ]).flat()

interface WriteFixture {
  readonly o: Oracle
  readonly session: string
}

async function writeFixture(size: number): Promise<WriteFixture> {
  const o = await makeOracle()
  const me = firstAdminMemberId()
  const { sessionId } = await o.call.sessions.create({ agentKind: 'shell', cwd: '/p' })
  await seedWorkflows(o.store, size, me)
  for (let i = 0; i < size; i++) {
    await o.store.agentProfiles.insert({
      id: `agp_other_${i}`,
      name: `other-${i}`,
      description: '',
      candidates: [],
      machineId: null,
      instructions: '',
      actor: me,
      now: AT,
    })
    await o.store.events.addSubscription({
      id: `sub_${i}`,
      subscriberKind: 'session',
      subscriberId: sessionId,
      event: 'issue.closed',
      sourceKind: 'relationship',
      sourceRef: 'my-children',
      deliverNudge: true,
      deliverNotify: false,
      origin: 'custom',
      enabled: true,
      createdAt: AT,
    })
  }
  // The rows each write names, beside the `size` others.
  await o.store.agentProfiles.insert({
    id: 'agp_mine',
    name: 'mine',
    description: '',
    candidates: [],
    machineId: null,
    instructions: '',
    actor: me,
    now: AT,
  })
  await o.store.events.addSubscription({
    id: 'sub_mine',
    subscriberKind: 'session',
    subscriberId: sessionId,
    event: 'session.finished',
    sourceKind: 'relationship',
    sourceRef: 'my-children',
    deliverNudge: true,
    deliverNotify: false,
    origin: 'custom',
    enabled: true,
    createdAt: AT,
  })
  return { o, session: sessionId }
}

const write = (
  name: string,
  envelopeOf: (f: WriteFixture, n: number) => ReturnType<typeof envelope>,
): StatementPin<WriteFixture> => ({
  name,
  setup: writeFixture,
  target: (f) => f.o.store,
  run: async (f) => appliedReply(await submit(f.o, envelopeOf(f, ++seq))),
  check: (reply) => expect((reply as ReturnType<typeof appliedReply>).replayed).toBe(false),
})

describe('statement counts of the profile, workflow and subscription records', () => {
  it("the feed's visibility pass reads each table once, whatever the batch", async () => {
    await expectConstantStatements(
      {
        name: 'visibility forBatch (workflow family)',
        setup: visibilityFixture,
        target: (f) => f.store,
        run: async (f) => await f.policy.state.forBatch!(workflowRefs(f.size)),
        check: (state, f) => {
          const s = state as Awaited<ReturnType<NonNullable<typeof f.policy.state.forBatch>>>
          expect(s.mayRead(owner, { entity: 'workflowRun', entityId: 'wrun_0' })).toBe(true)
          expect(s.mayRead(stranger, { entity: 'workflowRun', entityId: 'wrun_0' })).toBe(false)
        },
        teardown: async (f) => await f.store.close(),
        // The grants loader reads 500 keys a statement (POD-6217): 120 rows of
        // the four owned kinds stay inside one read, as a feed batch does.
        sizes: [5, 120],
      },
      // The admins, the four owner reads, the subscribers' sessions and one
      // grouped grant read.
      7,
    )
  })

  it('is armed: a facts read per row on the visibility path fails it', async () => {
    await expectArmed(
      {
        name: 'visibility forBatch (armed)',
        setup: visibilityFixture,
        target: (f) => f.store,
        run: async (f) => await f.policy.state.forBatch!(workflowRefs(f.size)),
        check: () => {},
        teardown: async (f) => await f.store.close(),
        sizes: [5, 120],
      },
      7,
      (f, size) => {
        const repo = f.store.workflows
        const original = repo.visibilityFacts.bind(repo)
        repo.visibilityFacts = async (asked) => {
          for (let i = 0; i < size; i++) await repo.getRun(`wrun_absent_${i}`)
          return await original(asked)
        }
        return () => {
          repo.visibilityFacts = original
        }
      },
    )
  })

  it('a profile edit does not grow with the profiles the table holds', async () => {
    await expectConstantStatements(
      write('records.agentProfile.edit', (_f, n) =>
        envelope(
          'records.agentProfile.edit',
          { id: 'agp_mine', patch: { description: `edit ${n}` } },
          `profile-${n}`,
        ),
      ),
      11,
    )
  })

  it('a subscription toggle does not grow with the subscriptions the table holds', async () => {
    await expectConstantStatements(
      write('records.subscription.edit', (f, n) =>
        envelope(
          'records.subscription.edit',
          {
            id: subscriptionRowId('session', f.session, 'sub_mine'),
            patch: { enabled: n % 2 === 0 },
          },
          `sub-${n}`,
        ),
      ),
      12,
    )
  })

  it('a binding edit does not grow with the bindings the table holds', async () => {
    await expectConstantStatements(
      write('records.workflowBinding.edit', (_f, n) =>
        envelope(
          'records.workflowBinding.edit',
          { id: workflowBindingRowId('issue', `iss_bound_${n}`), patch: { revisionId: 'wfr_0' } },
          `bind-${n}`,
        ),
      ),
      20,
    )
  })

  it('a revision reads back the records it touched, not the library', async () => {
    await expectConstantStatements(
      write('workflows.revise', (_f, n) =>
        envelope(
          'workflows.revise',
          { workflowId: 'wf_0', instructions: `revision ${n}`, steps: [] },
          `revise-${n}`,
        ),
      ),
      22,
    )
  })
})
