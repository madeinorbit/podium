/**
 * An issue's brief and description as synced records of their own (POD-6921,
 * design POD-6253 §2 "Slim records").
 *
 * - Each kind is built from the issue row alone, keyed by the issue id and
 *   holding the whole text; an empty field has no record.
 * - The synced issue record carries none of the body fields.
 * - Writes log them like every other kind: an upsert when the text changes, a
 *   remove when the field is emptied or the issue goes, nothing when a write
 *   leaves the text as it was.
 */
import { asIssueId } from '@podium/model'
import { fixtureWriteScope } from '@podium/sync/testing'
import { afterEach, describe, expect, it } from 'vitest'
import { type RecordReads, serverRecordBuilders } from '../../sync/record-builders'
import { issueRowFixture } from '../../test-support/issue-row'
import { openTestStore } from '../../test-support/open-test-store'
import { disposeOracles, makeOracle, type Oracle } from '../sessions/oracle-support'
import { changeRows } from '../sync-write/outbox-test-support'
import { slimIssueProjectionOfRow } from './projection'

afterEach(() => disposeOracles())

const BODY_KINDS = ['issueBrief', 'issueDescription'] as const

/** The body rows one write appended, as `{ entity, id, op, value }`. */
async function bodyRowsOf(o: Oracle, write: () => Promise<unknown>) {
  const before = await o.reg.changeLedger.cursor()
  await write()
  return (await changeRows(o))
    .filter((row) => row.seq > before && (BODY_KINDS as readonly string[]).includes(row.entity))
    .map((row) => ({
      entity: row.entity,
      id: row.entityId,
      op: row.op,
      value: row.payload == null ? undefined : JSON.parse(row.payload),
    }))
}

describe('issue body records: build', () => {
  it('builds each body from the issue row; an empty field has no record', async () => {
    const store = await openTestStore(':memory:')
    try {
      const rows = [
        issueRowFixture({
          id: 'both',
          seq: 1,
          parentId: null,
          brief: 'Agent brief',
          description: 'Human summary',
        }),
        issueRowFixture({ id: 'none', seq: 2, parentId: null, brief: '', description: '' }),
      ]
      for (const row of rows) await store.issues.upsertIssue(fixtureWriteScope(), row)
      const reads: RecordReads = { store, effectExecutors: { get: () => undefined }, now: Date.now }
      const registry = serverRecordBuilders()
      const ids = ['both', 'none', 'missing']
      expect(await registry.build(reads, 'issueBrief', ids)).toEqual([
        { id: 'both', value: { id: 'both', text: 'Agent brief' } },
      ])
      expect(await registry.build(reads, 'issueDescription', ids)).toEqual([
        { id: 'both', value: { id: 'both', text: 'Human summary' } },
      ])
      // Streaming every record agrees with building by id.
      for (const kind of BODY_KINDS) {
        const streamed = []
        for await (const page of registry.streamAll(reads, kind)) streamed.push(...page)
        expect(streamed).toEqual(await registry.build(reads, kind, ids))
      }
      // The synced issue record carries none of the body fields.
      const slim = slimIssueProjectionOfRow((await store.issues.getIssue('both'))!, [])
      for (const field of ['brief', 'description', 'panel', 'activityNotes', 'notesUpdatedAt'])
        expect(slim).not.toHaveProperty(field)
    } finally {
      await store.close()
    }
  })
})

describe('issue body records: logged with every write', () => {
  it('upserts a body when it changes, removes it when emptied, and leaves it alone otherwise', async () => {
    const o = await makeOracle()
    await o.store.repos.addRepo('/r', o.machineId)
    const writer = o.reg.issues.reports.store.serverWriter
    let id = asIssueId('')
    const created = await bodyRowsOf(o, async () => {
      id = (
        await o.reg.issues.crud.create(writer, {
          repoPath: '/r',
          title: 'Task',
          description: 'First summary',
          brief: 'First brief',
          startNow: false,
        })
      ).id
    })
    expect(created).toEqual([
      { entity: 'issueBrief', id, op: 'upsert', value: { id, text: 'First brief' } },
      { entity: 'issueDescription', id, op: 'upsert', value: { id, text: 'First summary' } },
    ])

    // The brief alone changes: only its record is logged.
    expect(
      await bodyRowsOf(o, () => o.reg.issues.crud.update(writer, id, { brief: 'Second brief' })),
    ).toEqual([{ entity: 'issueBrief', id, op: 'upsert', value: { id, text: 'Second brief' } }])

    // A write that leaves both texts as they were logs neither.
    expect(
      await bodyRowsOf(o, () => o.reg.issues.crud.update(writer, id, { title: 'Renamed' })),
    ).toEqual([])

    // Emptying the description removes its record.
    expect(
      await bodyRowsOf(o, () => o.reg.issues.crud.update(writer, id, { description: '' })),
    ).toEqual([{ entity: 'issueDescription', id, op: 'remove', value: undefined }])

    // Filling it again brings it back.
    expect(
      await bodyRowsOf(o, () =>
        o.reg.issues.crud.update(writer, id, { description: 'Back again' }),
      ),
    ).toEqual([{ entity: 'issueDescription', id, op: 'upsert', value: { id, text: 'Back again' } }])
  })

  it('removes both bodies when the issue goes', async () => {
    const o = await makeOracle()
    await o.store.repos.addRepo('/r', o.machineId)
    const writer = o.reg.issues.reports.store.serverWriter
    const { id } = await o.reg.issues.crud.create(writer, {
      repoPath: '/r',
      title: 'Draft',
      description: 'Summary',
      brief: 'Brief',
      startNow: false,
    })
    const rows = await bodyRowsOf(o, () => o.reg.issues.crud.purgeEmptyDraft(id))
    expect(rows).toEqual([
      { entity: 'issueBrief', id, op: 'remove', value: undefined },
      { entity: 'issueDescription', id, op: 'remove', value: undefined },
    ])
  })
})
