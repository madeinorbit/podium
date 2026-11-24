/**
 * POD-7547 — the relation-read check (`relation-reads.ts`): what it calls
 * each relation, and the message it fails with on a declaration that reads
 * an on-demand record without holding or loading it. POD-7582 added the
 * tree hold, the incoming edge hold and the relations that read the policy.
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

  it('give every listed exception a reason and follow-up issue', () => {
    for (const [relation, why] of Object.entries(IN_MEMORY_RELATIONS)) {
      expect(why.trim(), relation).not.toBe('')
      expect(why, relation).toMatch(/\bPOD-\d+\b/)
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

  it('holds the tree for a child relation, and the edge records keyed by target for incoming edges', () => {
    for (const relation of ['children', 'treeChildren'])
      expect(readOf(`issue.${relation}`), relation).toEqual({
        kind: 'holding',
        collection: 'issueProjection.tree',
      })
    for (const relation of ['spinOffs', 'pageDependents'])
      expect(readOf(`issue.${relation}`), relation).toEqual({
        kind: 'holding',
        collection: 'issueDep.toIssue',
      })
    expect(readOf('issue.bornSessions')).toEqual({ kind: 'holding', collection: 'session.bornOf' })
    expect(readOf('session.startedIssues')).toEqual({
      kind: 'holding',
      collection: 'issueProjection.startedBy',
    })
  })

  it('calls exactly the relations that declare it policy reads', () => {
    // Pinned: a new `readsPolicy` changes this list, so it cannot pass unreviewed.
    const policy = relationReads()
      .filter((row) => row.read.kind === 'policy')
      .map((row) => row.relation)
      .sort()
    expect(policy).toEqual(['repo.issues', 'worktree.issues', 'worktree.sessions'])
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
      'issue.sessions getter reads session (group byRule) without holding or loading it. Fix: session (group byRule) needs one collection keyed by issueId, has 0.',
    )
  })

  it('fails when a single relation reaches a kind that is neither present nor looked up', () => {
    // A session that the pool cannot look up by id: `issue.startedBy` would
    // answer null for a session not in memory.
    const { loadable: _loadable, ...session } = SCHEMA.session
    const schema = { ...SCHEMA, session } as ModelSchema
    expect(relationReadProblems(schema)).toContain(
      "issue.startedBy getter reads session (group byRule) without holding or loading it. Fix: look it up by id: make session loadable (a lookup that loads) or bring it in the source's comesWith.",
    )
  })

  it('fails on an exception that is protected, undeclared or without a reason', () => {
    const problems = relationReadProblems(SCHEMA, RECORDS, {
      ...IN_MEMORY_RELATIONS,
      'issue.sessions': 'Held through session.ofIssue. POD-7547.',
      'issue.nothing': 'Not a relation. POD-7547.',
      'issue.effects': ' ',
    })
    expect(problems).toEqual([
      'issue.effects is listed as reading memory without a reason',
      'issue.sessions is listed as reading memory but is holding: remove it from the list',
      'issue.nothing is listed as reading memory but is not declared',
    ])
  })

  it('rejects a reason that has no follow-up POD issue', () => {
    expect(
      relationReadProblems(SCHEMA, RECORDS, {
        ...IN_MEMORY_RELATIONS,
        'issue.effects': 'Read only what happens to be in memory.',
      }),
    ).toEqual(['issue.effects is listed as reading memory without a POD issue for its follow-up'])
  })

  it('fails on every unprotected relation once nothing is listed', () => {
    const problems = relationReadProblems(SCHEMA, RECORDS, {})
    expect(problems).toHaveLength(Object.keys(IN_MEMORY_RELATIONS).length)
    expect(problems).toContain(
      'issue.effects getter reads effect (group windowed) without holding or loading it. Fix: effect is in group windowed, which no relation read holds; declare it present or give it a holding group and a collection keyed by issueId.',
    )
  })

  it('fails when a child relation has neither a keyed collection nor a tree', () => {
    // Without the tree, nothing holds the issues under one parent.
    const records = withCollections('issueProjection', (record) => {
      const { tree: _tree, ...rest } = record.collections as Record<string, unknown>
      return rest as unknown as RecordDeclaration['collections']
    })
    expect(relationReadProblems(SCHEMA, records)).toContain(
      'issue.children getter reads issueProjection (group byRule) without holding or loading it. Fix: issueProjection (group byRule) needs one collection keyed by parentId, has 0.',
    )
  })

  it('fails when the edges into an issue do not come with the issue that depends', () => {
    // The relation index reads the depending issue's deps list, so edges alone
    // would leave it empty.
    const records = withCollections('issueDep', (record) => {
      const { toIssue, ...rest } = record.collections as Record<string, unknown>
      return {
        ...rest,
        toIssue: { ...(toIssue as object), comesWith: [] },
      } as unknown as RecordDeclaration['collections']
    })
    expect(relationReadProblems(SCHEMA, records)).toContain(
      'issue.spinOffs getter reads issueProjection (group byRule) without holding or loading it. Fix: issueDep.toIssue must come with the issueProjection of each edge, whose deps list the relation reads.',
    )
  })

  it('fails on a policy declaration the relation does not need, or without a reason', () => {
    const issue = SCHEMA.issue
    const schema = {
      ...SCHEMA,
      issue: {
        ...issue,
        relations: {
          ...issue.relations,
          sessions: { ...issue.relations.sessions, readsPolicy: 'Reads the sidebar.' },
        },
      },
      repo: {
        ...SCHEMA.repo,
        relations: {
          ...SCHEMA.repo.relations,
          issues: { ...SCHEMA.repo.relations.issues, readsPolicy: ' ' },
        },
      },
    } as ModelSchema
    expect(relationReadProblems(schema)).toEqual([
      'issue.sessions declares that it reads what the policy holds but is holding: remove its readsPolicy',
      'repo.issues declares that it reads what the policy holds without a reason',
    ])
  })
})
