/**
 * POD-7547 — the relation-read check (`relation-reads.ts`): what it calls
 * each relation, and the message it fails with on a declaration that reads
 * an on-demand record without holding or loading it.
 */
import { RECORDS, type RecordDeclaration } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { IN_MEMORY_RELATIONS, relationReadProblems, relationReads } from './relation-reads'
import { type ModelSchema, SCHEMA } from './schema'

const readOf = (relation: string, schema: ModelSchema = SCHEMA, records = RECORDS) =>
  relationReads(schema, records).find((row) => row.relation === relation)?.read

/** The record declarations with one record's collections replaced. */
function withCollections(
  kind: string,
  collections: (record: RecordDeclaration) => RecordDeclaration['collections'],
): readonly RecordDeclaration[] {
  return RECORDS.map((record) =>
    record.kind === kind
      ? ({ ...record, collections: collections(record) } as RecordDeclaration)
      : record,
  )
}

describe('the declarations', () => {
  it('have no relation that reads an on-demand record without holding or loading it', () => {
    expect(relationReadProblems()).toEqual([])
  })

  it('give every listed exception a reason', () => {
    for (const [relation, why] of Object.entries(IN_MEMORY_RELATIONS)) {
      expect(why.trim(), relation).not.toBe('')
      expect(readOf(relation)?.kind, relation).toBe('unprotected')
    }
  })
})

describe('the classification, from the declarations alone', () => {
  it('finds a target present when its group is always or the source comes with it', () => {
    expect(readOf('issue.repo')).toEqual({
      kind: 'present',
      why: 'group always: every device holds all of it',
    })
    // An issue comes with its parent (`issueProjection.one` bound to parentId),
    // a session with its issue.
    expect(readOf('issue.parent')).toEqual({
      kind: 'present',
      why: 'issueProjection comes with issueProjection.one',
    })
    expect(readOf('session.issue')?.kind).toBe('present')
  })

  it('calls a to-many relation over an on-demand kind holding when a collection is keyed by its foreign key', () => {
    expect(readOf('issue.descriptionRecords')).toEqual({
      kind: 'holding',
      collection: 'issueDescription.ofIssue',
    })
    for (const relation of ['sessions', 'missionSessions', 'handoffSessions', 'pageSessions'])
      expect(readOf(`issue.${relation}`), relation).toEqual({
        kind: 'holding',
        collection: 'session.ofIssue',
      })
  })

  it('calls a single relation to a kind looked up by id a lookup', () => {
    expect(readOf('issue.startedBy')).toEqual({ kind: 'lookup' })
    expect(readOf('issue.discoveredFrom')).toEqual({ kind: 'lookup' })
    expect(readOf('issueDescription.issue')).toEqual({ kind: 'lookup' })
  })
})

describe('a wrong declaration', () => {
  it('fails when a to-many relation over an on-demand kind has no collection keyed by its foreign key', () => {
    // `session.ofIssue` keyed by another field: `issue.sessions` would read
    // only the sessions that happen to be in memory.
    const records = withCollections('session', (record) => {
      const { ofIssue, ...rest } = record.collections as Record<string, unknown>
      return {
        ...rest,
        ofIssue: { ...(ofIssue as object), where: { machineId: { eq: { param: 'issueId' } } } },
      } as unknown as RecordDeclaration['collections']
    })
    const problems = relationReadProblems(SCHEMA, records)
    expect(problems).toContain(
      'issue.sessions reads session (group byRule) without holding or loading it. Fix: session (group byRule) needs one collection keyed by issueId, has 0.',
    )
  })

  it('fails when a single relation reaches a kind that is neither present nor looked up', () => {
    // A session that the pool cannot look up by id: `issue.startedBy` would
    // answer null for a session not in memory.
    const { loadable: _loadable, ...session } = SCHEMA.session
    const schema = { ...SCHEMA, session } as ModelSchema
    expect(relationReadProblems(schema)).toContain(
      "issue.startedBy reads session (group byRule) without holding or loading it. Fix: look it up by id: make session loadable (a lookup that loads) or bring it in the source's comesWith.",
    )
  })

  it('fails on an exception that is protected, undeclared or without a reason', () => {
    const problems = relationReadProblems(SCHEMA, RECORDS, {
      ...IN_MEMORY_RELATIONS,
      'issue.sessions': 'Held through session.ofIssue.',
      'issue.nothing': 'Not a relation.',
      'issue.children': ' ',
    })
    expect(problems).toEqual([
      'issue.children is listed as reading memory without a reason',
      'issue.sessions is listed as reading memory but is holding: remove it from the list',
      'issue.nothing is listed as reading memory but is not declared',
    ])
  })

  it('fails on every unprotected relation once nothing is listed', () => {
    const problems = relationReadProblems(SCHEMA, RECORDS, {})
    expect(problems).toHaveLength(Object.keys(IN_MEMORY_RELATIONS).length)
    expect(problems).toContain(
      'issue.children reads issueProjection (group byRule) without holding or loading it. Fix: issueProjection (group byRule) needs one collection keyed by parentId, has 0.',
    )
  })
})
