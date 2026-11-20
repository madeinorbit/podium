import { randomUUID } from 'node:crypto'
import { asIssueId, asIssuePanelItemId, firstAdminMemberId } from '@podium/model'
import { fixtureWriteScope } from '@podium/sync/testing'
import { afterEach, expect, it } from 'vitest'
import { type RecordReads, serverRecordBuilders } from '../../sync/record-builders'
import { issueRowFixture } from '../../test-support/issue-row'
import { TEST_MACHINE_ID } from '../../test-support/machine-id'
import { openTestStore } from '../../test-support/open-test-store'
import { expectConstantStatements } from '../../test-support/statement-count'
import { disposeOracles, makeOracle } from '../sessions/oracle-support'
import { appliedReply, envelope, rowsOf, submit } from '../sync-write/outbox-test-support'

afterEach(() => disposeOracles())
it('ticks just its stable todo record; position selectors resolve the current ordered list and an absent ID never retargets', async () => {
  const o = await makeOracle()
  await o.store.repos.addRepo('/r', o.machineId)
  const issue = appliedReply(
    await submit(
      o,
      envelope('issues.create', { repoPath: '/r', title: 'Task', startNow: false }, 'create'),
    ),
  ).result as { id: string }
  const ids = [randomUUID(), randomUUID(), randomUUID()]
  for (const [n, itemId] of ids.entries())
    appliedReply(
      await submit(
        o,
        envelope(
          'issues.panelApply',
          { id: issue.id, op: 'todo-add', text: 'Same', itemId },
          `add-${n}`,
        ),
      ),
    )
  const before = await o.store.issues.getIssue(issue.id)
  appliedReply(
    await submit(
      o,
      envelope(
        'issues.panelApply',
        { id: issue.id, op: 'todo-remove', itemId: ids[0] },
        'remove-first',
      ),
    ),
  )
  const mutation = envelope(
    'issues.panelApply',
    { id: issue.id, op: 'todo-done', itemId: ids[1] },
    'tick',
  )
  appliedReply(await submit(o, mutation))
  const changes = (await rowsOf(o, 'tick')).filter(
    (row) =>
      row.entity.startsWith('issuePanel') ||
      row.entity === 'issueProjection' ||
      row.entity === 'issueBrief' ||
      row.entity === 'issueDescription',
  )
  expect(changes).toHaveLength(1)
  expect(changes[0]).toMatchObject({ entity: 'issuePanelTodo', entityId: ids[1], op: 'upsert' })
  expect(JSON.stringify(changes[0]!.payload)).not.toContain('artifacts')
  expect(await o.store.issues.getIssue(issue.id)).toEqual(before)
  const replay = appliedReply(await submit(o, mutation))
  expect(replay.replayed).toBe(true)
  appliedReply(
    await submit(
      o,
      envelope('issues.panelApply', { id: issue.id, op: 'todo-done', index: 2 }, 'tick-position'),
    ),
  )
  const todos = (await o.store.issues.panel.read(issue.id)).todos
  expect(todos).toMatchObject([
    { id: ids[1], done: true },
    { id: ids[2], done: true },
  ])
  const missing = await submit(
    o,
    envelope('issues.panelApply', { id: issue.id, op: 'todo-undone', itemId: ids[0] }, 'missing'),
  )
  expect(missing.outcome).not.toBe('applied')
  expect((await o.store.issues.panel.read(issue.id)).todos).toMatchObject([
    { done: true },
    { done: true },
  ])
  const state = envelope('issues.setState', { id: issue.id, text: 'Ready' }, 'state')
  appliedReply(await submit(o, state))
  const stateRows = (await rowsOf(o, 'state')).filter(
    (row) =>
      row.entity.startsWith('issuePanel') ||
      row.entity === 'issueProjection' ||
      row.entity === 'issueBrief' ||
      row.entity === 'issueDescription',
  )
  expect(stateRows).toMatchObject([{ entity: 'issuePanelState', entityId: issue.id }])
  expect((await o.reg.issues.reports.get(issue.id))?.activityNotes).toBe('Ready')
})
it('replaces an artifact in place, keeps its record ID distinct from its snapshot, and clears only the selected issue', async () => {
  const o = await makeOracle()
  await o.store.repos.addRepo('/r', o.machineId)
  const writer = o.reg.issues.reports.store.serverWriter
  const issue = await o.reg.issues.crud.create(writer, {
    repoPath: '/r',
    title: 'Task',
    startNow: false,
  })
  const other = await o.reg.issues.crud.create(writer, {
    repoPath: '/r',
    title: 'Other',
    startNow: false,
  })
  for (const id of [issue.id, other.id])
    await o.reg.issues.crud.panelApply(writer, id, { op: 'todo-add', text: 'Kept' })
  await o.reg.issues.crud.panelApply(writer, issue.id, {
    op: 'artifact-add',
    path: 'review.html',
    title: 'First',
  })
  const first = (await o.store.issues.panel.read(issue.id)).artifacts[0]
  if (!first) throw new Error('artifact was not saved')
  await o.reg.issues.crud.panelApply(writer, issue.id, {
    op: 'artifact-add',
    path: 'review.html',
    title: 'Second',
    files: [{ path: 'review.html', size: 3 }],
  })
  expect((await o.store.issues.panel.read(issue.id)).artifacts).toMatchObject([
    { id: first.id, position: first.position, title: 'Second' },
  ])
  await o.reg.issues.crud.panelApply(writer, issue.id, { op: 'todo-clear' })
  expect((await o.store.issues.panel.read(issue.id)).todos).toEqual([])
  expect((await o.store.issues.panel.read(other.id)).todos).toHaveLength(1)
  const reads = {
    store: o.store,
    now: () => 0,
    effectExecutors: { get: () => undefined },
  } as RecordReads
  const builder = serverRecordBuilders().get('issuePanelArtifact')!
  const built = await builder.build(reads, [first.id])
  const streamed = []
  for await (const page of builder.streamAll(reads)) streamed.push(...page)
  expect(built).toEqual(streamed)
})
it('builds all todo IDs with one statement at 5 and 200 items', async () => {
  await expectConstantStatements(
    {
      name: 'issuePanelTodo builder',
      setup: async (size) => {
        const store = await openTestStore(':memory:', TEST_MACHINE_ID)
        await store.repos.addRepo('/repo', TEST_MACHINE_ID)
        const owner = await firstAdminMemberId(store)
        await store.issues.upsertIssue(
          fixtureWriteScope(),
          issueRowFixture({
            id: 'issue',
            ownerUserId: owner,
            parentId: null,
            repoId: null,
            machineId: null,
          }),
        )
        const ids = Array.from({ length: size }, () => randomUUID())
        for (const [position, id] of ids.entries())
          await store.issues.panel.save(fixtureWriteScope(), 'issuePanelTodo', {
            id: asIssuePanelItemId(id),
            issueId: asIssueId('issue'),
            position,
            text: 'Task',
            done: false,
          })
        return { store, ids }
      },
      target: (f) => f.store,
      run: async (f) =>
        await serverRecordBuilders()
          .get('issuePanelTodo')!
          .build(
            {
              store: f.store,
              now: () => 0,
              effectExecutors: { get: () => undefined },
            } as RecordReads,
            f.ids,
          ),
      check: (result, _f, size) => expect(result).toHaveLength(size),
      teardown: async (f) => await f.store.close(),
    },
    1,
  )
})
