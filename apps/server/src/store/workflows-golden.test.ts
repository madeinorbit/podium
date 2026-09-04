/**
 * GOLDEN TESTS FOR THE WORKFLOWS AGGREGATE — written BEFORE the drizzle
 * conversion, against the synchronous code, so they are the oracle it is judged
 * against (POD-3398, execution method §3 item 10).
 *
 * WHY THESE METHODS. The store coverage census (POD-3244) marks fifteen of
 * `workflows.ts`'s twenty-six public methods as executed-but-never-NAMED —
 * more than half the surface, and it includes `ownerOf`, which is the
 * AUTHORIZATION read for every workflow resource. Nothing asserted its five
 * kinds before this file.
 *
 * THE TWO SPANS ARE THE OTHER REASON. `insertRevision` allocates a version with
 * `SELECT COALESCE(MAX(version),0)+1` and then inserts at it; `insertRun` writes
 * a run and its steps together. Both are atomic today only because the span
 * holds and the driver is synchronous. These tests pin the OBSERVABLE result of
 * that atomicity — a monotonic version per workflow, and steps that arrive with
 * their run — so the conversion cannot quietly drop the boundary.
 *
 * AGAINST THE REAL MIGRATED SCHEMA, like the attribution suite next door: the
 * CHECK constraints on `subject_kind`, `status` and `created_by_kind` are real
 * here, so a conversion that writes an out-of-enum value fails rather than
 * persisting it.
 */

import { asAccountId, asMachineId, asSessionId, asUserId, type UserId } from '@podium/model'
import type { openDatabase } from '@podium/runtime/sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import { openMigratedTestDatabase } from '../test-support/migrated-database'
import { createBunStoreExecutor } from './executor'
import { type WorkflowActor, WorkflowsRepository } from './workflows'

/** The Stage A seam the store asserts once; a test builds it the same way. */
const stageQueries = (database: ReturnType<typeof openDatabase>) => {
  const stage = createBunStoreExecutor({ database }).syncQueries
  if (!stage) throw new Error('the synchronous query capability is absent on this handle')
  return stage
}

const OWNER: UserId = asUserId('user:alice')
const OPERATOR: WorkflowActor = { kind: 'operator', id: null }
const AGENT: WorkflowActor = { kind: 'session', id: asSessionId('sess-1') }

let db: ReturnType<typeof openDatabase>
let workflows: WorkflowsRepository

beforeEach(() => {
  db = openMigratedTestDatabase()
  const stage = stageQueries(db)
  workflows = new WorkflowsRepository(stage)
})

const makeWorkflow = async (
  id: string,
  over: { name?: string; scope?: 'global' | 'repository'; scopeRef?: string | null } = {},
): Promise<void> => {
  await workflows.insertWorkflow({
    id,
    name: over.name ?? id,
    description: 'd',
    scope: (over.scope ?? 'global') as never,
    scopeRef: over.scopeRef ?? null,
    actor: OPERATOR,
    ownerUserId: OWNER,
    now: 't0',
  })
}

const makeRevision = async (id: string, workflowId: string) =>
  await workflows.insertRevision({
    id,
    workflowId,
    instructions: 'do it',
    steps: [{ id: 'step-a', title: 'A', instructions: 'i', completionGuidance: 'g' } as never],
    actor: OPERATOR,
    now: 't0',
  })

const makeProfile = async (id: string, over: { name?: string; model?: string } = {}) =>
  await workflows.upsertProfile({
    id,
    name: over.name ?? id,
    accountId: asAccountId('acct-1'),
    machineId: asMachineId('machine-1'),
    harness: 'claude-code',
    model: over.model ?? 'opus',
    effort: 'high',
    actor: OPERATOR,
    ownerUserId: OWNER,
    now: 't0',
  })

// ---------------------------------------------------------------------------
// ownerOf — the authorization read, five kinds and a default
// ---------------------------------------------------------------------------

describe('ownerOf', () => {
  it('resolves the owner for every kind it claims to know', async () => {
    await makeWorkflow('wf-1')
    await makeRevision('rev-1', 'wf-1')
    await makeProfile('prof-1')
    await workflows.setBinding({
      targetKind: 'issue' as never,
      targetId: 'iss_a',
      revisionId: 'rev-1',
      actor: OPERATOR,
      ownerUserId: OWNER,
      now: 't0',
    })
    await workflows.insertRun({
      run: {
        id: 'run-1',
        subjectKind: 'issue',
        subjectId: 'iss_a',
        coordinatorSessionId: asSessionId('sess-1'),
        revisionId: 'rev-1',
        status: 'active',
        supersedesRunId: null,
        startedAt: 't0',
        completedAt: null,
        ownerUserId: OWNER,
      },
      steps: [],
    })

    // A workflow is reachable under two kind spellings, and the revision reaches
    // its owner through a JOIN rather than a column of its own.
    expect(await workflows.ownerOf('workflow-definition', 'wf-1')).toBe(OWNER)
    expect(await workflows.ownerOf('workflow-library-entry', 'wf-1')).toBe(OWNER)
    expect(await workflows.ownerOf('workflow-revision', 'rev-1')).toBe(OWNER)
    expect(await workflows.ownerOf('workflow-binding', 'issue:iss_a')).toBe(OWNER)
    expect(await workflows.ownerOf('execution-profile', 'prof-1')).toBe(OWNER)
    expect(await workflows.ownerOf('workflow-run', 'run-1')).toBe(OWNER)
  })

  it('returns null for an unknown kind, an absent id, and an unsplittable binding ref', async () => {
    // Each denial is a different branch, and all three must fail CLOSED — this is
    // the read an authorization decision is made from.
    expect(await workflows.ownerOf('not-a-kind', 'wf-1')).toBeNull()
    expect(await workflows.ownerOf('workflow-definition', 'absent')).toBeNull()
    // No ':' in the composite id: the method returns before touching the database.
    expect(await workflows.ownerOf('workflow-binding', 'no-colon')).toBeNull()
  })

  it('splits a binding ref at the FIRST colon, so an id containing colons survives', async () => {
    await makeWorkflow('wf-1')
    await makeRevision('rev-1', 'wf-1')
    await workflows.setBinding({
      targetKind: 'issue' as never,
      targetId: 'iss:a:b',
      revisionId: 'rev-1',
      actor: OPERATOR,
      ownerUserId: OWNER,
      now: 't0',
    })
    expect(await workflows.ownerOf('workflow-binding', 'issue:iss:a:b')).toBe(OWNER)
  })
})

// ---------------------------------------------------------------------------
// Listing and the latest_version subquery
// ---------------------------------------------------------------------------

describe('listWorkflows and getWorkflow', () => {
  it('computes latest_version from the revisions, and reports 0 when there are none', async () => {
    await makeWorkflow('wf-1')
    await makeRevision('rev-1', 'wf-1')
    await makeRevision('rev-2', 'wf-1')
    await makeWorkflow('wf-2')

    const listed = await workflows.listWorkflows()
    expect(listed.find((w) => w.id === 'wf-1')?.latestVersion).toBe(2)
    // COALESCE(..., 0): a workflow with no revisions is 0, never null.
    expect(listed.find((w) => w.id === 'wf-2')?.latestVersion).toBe(0)
    expect((await workflows.getWorkflow('wf-1'))?.latestVersion).toBe(2)
    expect(await workflows.getWorkflow('absent')).toBeNull()
  })

  it('hides archived workflows unless asked, and the flag is the only difference', async () => {
    await makeWorkflow('wf-live')
    await makeWorkflow('wf-gone')
    db.prepare('UPDATE workflows SET archived_at = ? WHERE id = ?').run('t9', 'wf-gone')

    expect((await workflows.listWorkflows()).map((w) => w.id)).toEqual(['wf-live'])
    expect(
      (await workflows.listWorkflows({ includeArchived: true })).map((w) => w.id).sort(),
    ).toEqual(['wf-gone', 'wf-live'])
  })

  it('filters by scope and by scopeRef independently', async () => {
    await makeWorkflow('global-1', { scope: 'global' })
    await makeWorkflow('repo-a', { scope: 'repository', scopeRef: 'repo:a' })
    await makeWorkflow('repo-b', { scope: 'repository', scopeRef: 'repo:b' })

    expect(
      (await workflows.listWorkflows({ scope: 'repository' as never })).map((w) => w.id).sort(),
    ).toEqual(['repo-a', 'repo-b'])
    expect((await workflows.listWorkflows({ scopeRef: 'repo:a' })).map((w) => w.id)).toEqual([
      'repo-a',
    ])
    // Omitting scopeRef is "no filter", which is a different thing again.
    expect((await workflows.listWorkflows()).map((w) => w.id).sort()).toEqual([
      'global-1',
      'repo-a',
      'repo-b',
    ])
  })

  it('PINS TODAY BEHAVIOUR: an explicit null scopeRef matches nothing', async () => {
    // NOT AN ENDORSEMENT, A PIN. The method branches on `!== undefined`, so an
    // explicit null pushes `w.scope_ref = ?` and binds null — and SQL `=` never
    // matches null, so the global rows this reads as asking for are exactly what
    // it cannot return.
    //
    // It is UNREACHABLE from production today: the wire schema types scopeRef as
    // `z.string().optional()` (modules/workflows/queries.ts:75) and the handler
    // spreads the key only when it is not undefined
    // (modules/workflows/handlers/library.ts:112), so null never arrives.
    //
    // It is here because the CONVERSION is what could change it. drizzle's
    // `eq(col, null)` emits `= null` and preserves this; reaching for `isNull()`
    // instead would silently turn a filter that matches nothing into one that
    // selects every global workflow. Pinning the current answer makes that a
    // failing test rather than an improvement nobody asked for.
    await makeWorkflow('global-1', { scope: 'global' })
    expect(
      (await workflows.listWorkflows({ scopeRef: null as unknown as string })).map((w) => w.id),
    ).toEqual([])
  })

  it('orders by name case-INSENSITIVELY', async () => {
    // COLLATE NOCASE: with a binary collation 'Zebra' sorts before 'apple',
    // which is the whole point of the clause and is invisible to a same-case
    // fixture.
    await makeWorkflow('wf-1', { name: 'Zebra' })
    await makeWorkflow('wf-2', { name: 'apple' })
    expect((await workflows.listWorkflows()).map((w) => w.name)).toEqual(['apple', 'Zebra'])
  })
})

// ---------------------------------------------------------------------------
// insertRevision — the version-allocating span
// ---------------------------------------------------------------------------

describe('insertRevision — read-decide-write inside one span', () => {
  it('allocates monotonically per workflow, starting at 1', async () => {
    await makeWorkflow('wf-1')
    await makeWorkflow('wf-2')

    expect((await makeRevision('rev-1', 'wf-1')).version).toBe(1)
    expect((await makeRevision('rev-2', 'wf-1')).version).toBe(2)
    // Per WORKFLOW, not global: wf-2's first revision is version 1 even though
    // two revisions already exist in the table.
    expect((await makeRevision('rev-3', 'wf-2')).version).toBe(1)
  })

  it('points the workflow at the new revision, in the same span as the insert', async () => {
    await makeWorkflow('wf-1')
    await makeRevision('rev-1', 'wf-1')
    expect((await workflows.getWorkflow('wf-1'))?.latestRevisionId).toBe('rev-1')
    await makeRevision('rev-2', 'wf-1')
    // The pointer moves with every revision; a span that committed the insert
    // without the UPDATE would leave it on rev-1 and nothing else would notice.
    expect((await workflows.getWorkflow('wf-1'))?.latestRevisionId).toBe('rev-2')
  })

  it('returns the persisted revision, read back rather than echoed', async () => {
    await makeWorkflow('wf-1')
    const made = await makeRevision('rev-1', 'wf-1')
    // `required(getRevision(...))` refuses rather than returning a half-written
    // object — a rule 6 decision. The returned value must equal the stored one.
    expect(made).toEqual(await workflows.getRevision('rev-1'))
    expect(made.steps).toHaveLength(1)
    expect(made.publishedAt).toBeNull()
  })

  it('lists a workflow revisions newest version first', async () => {
    await makeWorkflow('wf-1')
    await makeRevision('rev-1', 'wf-1')
    await makeRevision('rev-2', 'wf-1')
    expect((await workflows.listRevisions('wf-1')).map((r) => r.id)).toEqual(['rev-2', 'rev-1'])
  })
})

describe('publishRevision', () => {
  it('stamps once and COALESCE keeps the first publication', async () => {
    await makeWorkflow('wf-1')
    await makeRevision('rev-1', 'wf-1')

    await workflows.publishRevision('rev-1', 't1')
    expect((await workflows.getRevision('rev-1'))?.publishedAt).toBe('t1')
    // Publishing again must not re-date it — a published revision has one
    // publication moment.
    await workflows.publishRevision('rev-1', 't2')
    expect((await workflows.getRevision('rev-1'))?.publishedAt).toBe('t1')
  })
})

// ---------------------------------------------------------------------------
// Bindings and profiles — the ON CONFLICT column sets
// ---------------------------------------------------------------------------

describe('setBinding', () => {
  it('inserts, then updates the revision in place on conflict', async () => {
    await makeWorkflow('wf-1')
    await makeRevision('rev-1', 'wf-1')
    await makeRevision('rev-2', 'wf-1')

    const bind = async (revisionId: string, now: string) =>
      await workflows.setBinding({
        targetKind: 'issue' as never,
        targetId: 'iss_a',
        revisionId,
        actor: OPERATOR,
        ownerUserId: OWNER,
        now,
      })

    expect((await bind('rev-1', 't1')).revisionId).toBe('rev-1')
    const rebound = await bind('rev-2', 't2')
    expect(rebound.revisionId).toBe('rev-2')
    expect(rebound.updatedAt).toBe('t2')
    // One row, not two: the conflict target is (target_kind, target_id).
    expect(await workflows.listBindings()).toHaveLength(1)
  })

  it('does NOT rewrite owner_user_id on conflict', async () => {
    // The ON CONFLICT body names four columns and `owner_user_id` is not one of
    // them. A conversion that reaches for "update everything" would silently let
    // a rebind change the resource owner, which is the value `ownerOf` answers
    // authorization from.
    await makeWorkflow('wf-1')
    await makeRevision('rev-1', 'wf-1')
    await workflows.setBinding({
      targetKind: 'issue' as never,
      targetId: 'iss_a',
      revisionId: 'rev-1',
      actor: OPERATOR,
      ownerUserId: OWNER,
      now: 't1',
    })
    await workflows.setBinding({
      targetKind: 'issue' as never,
      targetId: 'iss_a',
      revisionId: 'rev-1',
      actor: AGENT,
      ownerUserId: asUserId('user:mallory'),
      now: 't2',
    })
    expect(await workflows.ownerOf('workflow-binding', 'issue:iss_a')).toBe(OWNER)
  })

  it('getBinding is null for an unbound target', async () => {
    expect(await workflows.getBinding('issue' as never, 'iss_absent')).toBeNull()
  })
})

describe('upsertProfile', () => {
  it('updates the mutable columns and leaves the creator alone', async () => {
    await makeProfile('prof-1', { model: 'opus' })
    await workflows.upsertProfile({
      id: 'prof-1',
      name: 'renamed',
      accountId: asAccountId('acct-2'),
      machineId: null,
      harness: 'codex',
      model: 'sonnet',
      effort: 'low',
      actor: AGENT,
      ownerUserId: asUserId('user:mallory'),
      now: 't2',
    })

    const back = await workflows.getProfile('prof-1')
    expect(back?.name).toBe('renamed')
    expect(back?.model).toBe('sonnet')
    // machineId is nullable and the update must be able to CLEAR it, not just set it.
    expect(back?.machineId).toBeNull()
    // created_by_* and owner_user_id are absent from the ON CONFLICT body.
    expect(await workflows.ownerOf('execution-profile', 'prof-1')).toBe(OWNER)
  })

  it('lists profiles by name, case-insensitively', async () => {
    await makeProfile('p1', { name: 'Zeta' })
    await makeProfile('p2', { name: 'alpha' })
    expect((await workflows.listProfiles()).map((p) => p.name)).toEqual(['alpha', 'Zeta'])
  })

  it('getProfile is null for an absent id', async () => {
    expect(await workflows.getProfile('absent')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Runs, steps and the second span
// ---------------------------------------------------------------------------

describe('insertRun — the run and its steps in one span', () => {
  const run = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    subjectKind: 'issue' as const,
    subjectId: 'iss_a',
    coordinatorSessionId: asSessionId('sess-1'),
    revisionId: 'rev-1',
    status: 'active' as const,
    supersedesRunId: null,
    startedAt: 't0',
    completedAt: null,
    ownerUserId: OWNER,
    ...over,
  })

  const seedRevision = async (): Promise<void> => {
    await makeWorkflow('wf-1')
    await makeRevision('rev-1', 'wf-1')
  }

  it('writes the steps with their positions and the pending defaults', async () => {
    await seedRevision()
    await workflows.insertRun({
      run: run('run-1'),
      steps: [
        { id: 'a', title: 'A', instructions: 'ia', completionGuidance: 'ga', profile: null },
        { id: 'b', title: 'B', instructions: 'ib', completionGuidance: 'gb', profile: null },
      ] as never,
    })

    const steps = await workflows.getRunSteps('run-1')
    expect(steps.map((s) => s.stepId)).toEqual(['a', 'b'])
    // Position comes from the array index and drives the ORDER BY; the two
    // literal defaults in the INSERT ('pending', '{}') are what make a fresh
    // step readable at all.
    expect(steps.map((s) => s.position)).toEqual([0, 1])
    expect(steps.every((s) => s.status === 'pending')).toBe(true)
    // `attempt` defaults to 1 in the schema, not 0: the first run of a step IS
    // attempt one. Pinned because `resetStep` increments it and an off-by-one
    // here would read as a plausible retry count for a long time.
    expect(steps[0]?.attempt).toBe(1)
    expect(steps[0]?.executionProfileSnapshot).toBeNull()
  })

  it('snapshots a step profile as JSON beside its id', async () => {
    await seedRevision()
    await makeProfile('prof-1')
    const profile = await workflows.getProfile('prof-1')
    await workflows.insertRun({
      run: run('run-1'),
      steps: [
        {
          id: 'a',
          title: 'A',
          instructions: 'i',
          completionGuidance: 'g',
          executionProfileId: 'prof-1',
          profile,
        },
      ] as never,
    })

    const step = (await workflows.getRunSteps('run-1'))[0]
    expect(step?.executionProfileId).toBe('prof-1')
    // The SNAPSHOT is the point: the run keeps what the profile said at start,
    // so a later edit to the profile cannot rewrite history.
    expect(step?.executionProfileSnapshot).toMatchObject({ id: 'prof-1', model: 'opus' })
  })

  it('accepts a run with no steps at all', async () => {
    await seedRevision()
    await workflows.insertRun({ run: run('run-1'), steps: [] })
    expect(await workflows.getRunSteps('run-1')).toEqual([])
    expect((await workflows.getRun('run-1'))?.id).toBe('run-1')
  })
})

describe('run queries', () => {
  const seedRun = async (
    id: string,
    over: { status?: string; subjectId?: string; startedAt?: string; coordinator?: string } = {},
  ): Promise<void> => {
    await workflows.insertRun({
      run: {
        id,
        subjectKind: 'issue',
        subjectId: over.subjectId ?? 'iss_a',
        coordinatorSessionId: asSessionId(over.coordinator ?? 'sess-1'),
        revisionId: 'rev-1',
        status: (over.status ?? 'active') as never,
        supersedesRunId: null,
        startedAt: over.startedAt ?? 't0',
        completedAt: null,
        ownerUserId: OWNER,
      },
      steps: [
        { id: 'a', title: 'A', instructions: 'i', completionGuidance: 'g', profile: null },
      ] as never,
    })
  }

  beforeEach(async () => {
    await makeWorkflow('wf-1')
    await makeRevision('rev-1', 'wf-1')
  })

  it('listRuns hides terminal runs unless asked', async () => {
    await seedRun('active-1')
    await seedRun('blocked-1', { status: 'blocked', subjectId: 'iss_b' })
    await seedRun('done-1', { status: 'complete', subjectId: 'iss_c' })

    // 'blocked' counts as live: the status set is two-valued and dropping one
    // arm is invisible to a fixture with only active runs.
    expect((await workflows.listRuns()).map((r) => r.id).sort()).toEqual(['active-1', 'blocked-1'])
    expect((await workflows.listRuns(true)).map((r) => r.id).sort()).toEqual([
      'active-1',
      'blocked-1',
      'done-1',
    ])
  })

  it('findLiveRun ignores a terminal run for the same subject', async () => {
    await seedRun('done-1', { status: 'complete' })
    expect(await workflows.findLiveRun('issue', 'iss_a')).toBeNull()
    await seedRun('live-1', { startedAt: 't1' })
    expect((await workflows.findLiveRun('issue', 'iss_a'))?.id).toBe('live-1')
  })

  it('findLiveRunForSession matches the coordinator OR an assigned step', async () => {
    await seedRun('coordinated', { coordinator: 'sess-coord' })
    await seedRun('assigned', { coordinator: 'sess-other', subjectId: 'iss_b' })
    await workflows.assignStep('assigned', 'a', asSessionId('sess-worker'))

    expect((await workflows.findLiveRunForSession(asSessionId('sess-coord')))?.id).toBe(
      'coordinated',
    )
    // The LEFT JOIN arm: a session that coordinates nothing but is assigned a
    // step still has a live run. Dropping the join loses this whole case.
    expect((await workflows.findLiveRunForSession(asSessionId('sess-worker')))?.id).toBe('assigned')
    expect(await workflows.findLiveRunForSession(asSessionId('sess-stranger'))).toBeNull()
  })

  it('updateRunStatus moves the run and records completion', async () => {
    await seedRun('run-1')
    await workflows.updateRunStatus('run-1', 'complete' as never, 't9')
    const back = await workflows.getRun('run-1')
    expect(back?.status).toBe('complete')
    expect(back?.completedAt).toBe('t9')
  })
})

describe('step mutation', () => {
  beforeEach(async () => {
    await makeWorkflow('wf-1')
    await makeRevision('rev-1', 'wf-1')
    await workflows.insertRun({
      run: {
        id: 'run-1',
        subjectKind: 'issue',
        subjectId: 'iss_a',
        coordinatorSessionId: asSessionId('sess-1'),
        revisionId: 'rev-1',
        status: 'active',
        supersedesRunId: null,
        startedAt: 't0',
        completedAt: null,
        ownerUserId: OWNER,
      },
      steps: [
        { id: 'a', title: 'A', instructions: 'i', completionGuidance: 'g', profile: null },
        { id: 'b', title: 'B', instructions: 'i', completionGuidance: 'g', profile: null },
      ] as never,
    })
  })

  const stepA = async () => (await workflows.getRunSteps('run-1')).find((s) => s.stepId === 'a')

  it('updateStep writes every column it names, and only for the addressed step', async () => {
    await workflows.updateStep({
      runId: 'run-1',
      stepId: 'a',
      status: 'complete' as never,
      assignedSessionId: asSessionId('sess-w'),
      summary: 'did it',
      evidence: { notes: 'n' } as never,
      observation: null,
      warnings: ['w1'],
      startedAt: 't1',
      completedAt: 't2',
    })

    const a = await stepA()
    expect(a?.status).toBe('complete')
    expect(a?.assignedSessionId).toBe('sess-w')
    expect(a?.summary).toBe('did it')
    expect(a?.warnings).toEqual(['w1'])
    expect(a?.startedAt).toBe('t1')
    expect(a?.completedAt).toBe('t2')
    // The WHERE names both run_id and step_id; its neighbour is untouched.
    const b = (await workflows.getRunSteps('run-1')).find((s) => s.stepId === 'b')
    expect(b?.status).toBe('pending')
  })

  it('resetStep increments the attempt and clears every result column', async () => {
    await workflows.updateStep({
      runId: 'run-1',
      stepId: 'a',
      status: 'complete' as never,
      assignedSessionId: asSessionId('sess-w'),
      summary: 'did it',
      evidence: { notes: 'n' } as never,
      observation: null,
      warnings: ['w1'],
      startedAt: 't1',
      completedAt: 't2',
    })

    await workflows.resetStep('run-1', 'a')

    const a = await stepA()
    expect(a?.status).toBe('pending')
    // attempt = attempt + 1 is a READ-MODIFY-WRITE expressed in SQL. A
    // conversion that binds a computed value instead would need a prior read and
    // would be a different statement. The column starts at 1, so one reset is 2.
    expect(a?.attempt).toBe(2)
    expect(a?.summary).toBe('')
    expect(a?.warnings).toEqual([])
    expect(a?.startedAt).toBeNull()
    expect(a?.completedAt).toBeNull()
    // NOT cleared: the assignment survives a reset, so a retry stays with its
    // session unless something reassigns it.
    expect(a?.assignedSessionId).toBe('sess-w')
  })

  it('assignStep sets and clears the assignment', async () => {
    await workflows.assignStep('run-1', 'a', asSessionId('sess-w'))
    expect((await stepA())?.assignedSessionId).toBe('sess-w')
    await workflows.assignStep('run-1', 'a', null)
    expect((await stepA())?.assignedSessionId).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// The audit trail
// ---------------------------------------------------------------------------

describe('appendEvent and listRunEvents', () => {
  it('projects ONLY the attribution pair, never the payload', async () => {
    await workflows.appendEvent({
      runId: 'run-1',
      kind: 'started',
      actor: AGENT,
      onBehalfOf: String(OWNER),
      payload: { secret: 'do not project me' },
      now: 't1',
    })

    const events = await workflows.listRunEvents('run-1')
    expect(events).toHaveLength(1)
    expect(events[0]).toEqual({
      kind: 'started',
      actorKind: 'session',
      actorId: 'sess-1',
      onBehalfOf: String(OWNER),
      createdAt: 't1',
    })
    // `payload_json` HAS NO STORE READER BY DESIGN (spec §6 rule 4 names this
    // column). Adding one would be a redaction decision, so the projection must
    // stay narrow — this asserts the shape has no payload key at all.
    expect(Object.keys(events[0] ?? {})).not.toContain('payload')
  })

  it('never substitutes a missing actor id or delegating human', async () => {
    // The operator arm carries a null id by construction (POD-362's discriminated
    // union). Inventing one would be a lie in an audit trail.
    await workflows.appendEvent({ runId: 'run-1', kind: 'op', actor: OPERATOR, now: 't1' })
    const [event] = await workflows.listRunEvents('run-1')
    expect(event?.actorKind).toBe('operator')
    expect(event?.actorId).toBeNull()
    expect(event?.onBehalfOf).toBeNull()
  })

  it('returns events oldest first, and only for the run asked about', async () => {
    await workflows.appendEvent({ runId: 'run-1', kind: 'one', actor: OPERATOR, now: 't1' })
    await workflows.appendEvent({ runId: 'run-2', kind: 'other', actor: OPERATOR, now: 't1' })
    await workflows.appendEvent({ runId: 'run-1', kind: 'two', actor: OPERATOR, now: 't1' })

    // Ordered by `id`, the insertion order — not by created_at, which is equal
    // here on purpose so an ORDER BY that drifted to the timestamp would be
    // free to return either order.
    expect((await workflows.listRunEvents('run-1')).map((e) => e.kind)).toEqual(['one', 'two'])
  })
})
