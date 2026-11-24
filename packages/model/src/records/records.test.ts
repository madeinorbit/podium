import { describe, expect, it } from 'vitest'
import {
  assertWhere,
  COLLECTIONS,
  CORPUS_CASES,
  CORPUS_NOW,
  CORPUS_RECORDS,
  type Collection,
  DESIGN_COLLECTIONS,
  declaredRules,
  defineRecord,
  fieldForPath,
  isSavedField,
  matchesWhere,
  pathsRead,
  RECORD_KINDS,
  RECORDS,
  REPLICA_KIND_OF,
  type RecordDeclaration,
  RuleError,
  recordDeclarationProblems,
  recordOf,
  type Where,
} from './index'

const session = recordOf('session') as RecordDeclaration

/** The answer of the JavaScript evaluator: the row keys of the corpus records the rule selects. */
function answer(of: string, where: Where, args: Readonly<Record<string, unknown>> = {}): string[] {
  const declaration = recordOf(of)!
  const rows = CORPUS_RECORDS[of] ?? []
  const parents = new Map(
    rows.map((row) => [
      declaration.rowKey(row as never),
      row[declaration.parentLink ?? ''] as string | undefined,
    ]),
  )
  return rows
    .filter((row) =>
      matchesWhere(where, row, {
        now: CORPUS_NOW,
        args: args as never,
        parentOf: (id) => parents.get(id),
      }),
    )
    .map((row) => declaration.rowKey(row as never))
    .sort()
}

describe('the record declarations', () => {
  it('agree with each other', () => {
    expect(recordDeclarationProblems()).toEqual([])
  })

  it('declare every kind and every client collection once', () => {
    expect(new Set(RECORD_KINDS).size).toBe(RECORD_KINDS.length)
    expect(new Set(Object.values(REPLICA_KIND_OF)).size).toBe(RECORD_KINDS.length)
    expect(RECORDS.map((record) => record.kind)).toEqual(RECORD_KINDS)
  })

  it('keep the issue stub to its fixed reference, state and parent', () => {
    expect([...recordOf('issueProjection').stub].sort()).toEqual(
      [
        'id',
        'repoId',
        'seq',
        'type',
        'stage',
        'closedReason',
        'archived',
        'deletedAt',
        'isDraftVessel',
        'audience',
        'parentId',
      ].sort(),
    )
    for (const record of RECORDS) {
      if (record.kind !== 'issueProjection') expect(record.stub, record.kind).toEqual([])
    }
  })

  it('give more than one part only to issues, sessions and machines', () => {
    const multi = RECORDS.filter(
      (record) =>
        record.stub.length > 0 ||
        Object.keys(record.body).length > 0 ||
        record.live.length > 0 ||
        Object.keys(record.liveReadings).length > 0,
    ).map((record) => record.kind)
    expect(multi.sort()).toEqual(['issueProjection', 'machine', 'session'])
  })

  it('put every field in exactly one part', () => {
    for (const record of RECORDS as readonly RecordDeclaration[]) {
      const parts = new Map<string, string>()
      const claim = (field: string, part: string) => {
        expect(parts.get(field), `${record.kind}.${field}`).toBeUndefined()
        parts.set(field, part)
      }
      for (const field of record.fields) claim(field, record.partOf(field)!)
      for (const field of Object.values(record.body).flat()) claim(field, 'body')
      for (const field of Object.keys(record.liveReadings)) claim(field, 'live')
      for (const [field, part] of parts)
        expect(record.partOf(field), `${record.kind}.${field}`).toBe(part)
    }
  })

  it('give every record type its collection', () => {
    for (const record of RECORDS as readonly RecordDeclaration[]) {
      expect(Object.keys(record.collections).length, record.kind).toBeGreaterThan(0)
    }
    for (const ids of Object.values(DESIGN_COLLECTIONS)) {
      for (const id of ids) expect(COLLECTIONS.has(id), id).toBe(true)
    }
  })

  it('page and bound the record types that grow with history', () => {
    for (const kind of ['workflowRun', 'automationRun', 'conversation'] as const) {
      const collections = recordOf(kind).collections as Readonly<Record<string, Collection>>
      expect(collections['recent']?.where, kind).toBeDefined()
      expect(collections['page']?.page?.size, kind).toBeGreaterThan(0)
    }
  })
})

describe('collection rules', () => {
  it('read only saved fields', () => {
    for (const rule of declaredRules()) {
      const declaration = recordOf(rule.of)!
      for (const path of pathsRead(rule.where)) {
        const field = fieldForPath(declaration, path)
        expect(field, `${rule.id} reads ${path}`).toBeDefined()
        expect(isSavedField(declaration, field!), `${rule.id} reads ${field}`).toBe(true)
      }
    }
  })

  it('refuse a rule that reads a live, derived or undeclared field', () => {
    const planted = (where: Where) =>
      recordDeclarationProblems([
        ...(RECORDS as readonly RecordDeclaration[]).filter((record) => record.kind !== 'session'),
        {
          ...session,
          collections: {
            bad: { id: 'session.bad', of: 'session', name: 'bad', part: 'main', where, why: 'x' },
          },
        },
      ])
    expect(planted({ busy: true }).join('\n')).toMatch(/busy, which is not a saved field/)
    expect(planted({ resumable: true }).join('\n')).toMatch(/resumable, which is not a saved field/)
    expect(planted({ noSuchField: 1 }).join('\n')).toMatch(/does not declare/)
    expect(planted({ issueId: { descendantsOf: 'x' } }).join('\n')).toMatch(/not the parent link/)
  })

  it('allow only the declared tests', () => {
    expect(() => assertWhere({ a: { gt: 1 } as never })).toThrow(RuleError)
    expect(() => assertWhere({ a: { not: { newerThan: { days: 1 } } } as never })).toThrow(
      RuleError,
    )
    expect(() => assertWhere({ a: { eq: 1, in: [1] } as never })).toThrow(RuleError)
    expect(() => assertWhere({ a: { descendantsOf: 'x' } })).not.toThrow()
    expect(() => assertWhere([])).toThrow(RuleError)
  })
})

describe('the shared corpus, answered in JavaScript', () => {
  const rules = new Map(declaredRules().map((rule) => [rule.id, rule]))

  it('has a case for every declared rule, and only for declared rules', () => {
    const covered = new Set(CORPUS_CASES.map((c) => c.rule))
    expect([...rules.keys()].filter((id) => !covered.has(id))).toEqual([])
    expect([...covered].filter((id) => !rules.has(id))).toEqual([])
  })

  for (const c of CORPUS_CASES) {
    it(`${c.rule} ${JSON.stringify(c.args ?? {})}`, () => {
      const rule = rules.get(c.rule)!
      expect(answer(rule.of, rule.where, c.args)).toEqual([...c.expect].sort())
    })
  }

  it('tells a wrong rule from the right one', () => {
    // Asking without the archived test also answers the archived erroring shell.
    const asking = rules.get('session.asking')!
    const loose = (asking.where as readonly Record<string, unknown>[]).map(
      ({ archived: _, ...rest }) => rest,
    ) as Where
    expect(answer('session', loose)).not.toEqual(answer('session', asking.where))
    // Children are not the tree: the grandchild and the root are missing.
    expect(answer('issueProjection', { parentId: { eq: 'i1' } }, {})).toEqual(['i2', 'i8'])
    expect(answer('issueProjection', { parentId: { descendantsOf: 'i1' } }, {})).toEqual([
      'i1',
      'i2',
      'i3',
      'i8',
    ])
  })

  it('reads an absent value as unset, and a time at the cutoff as not newer', () => {
    expect(answer('session', { headless: { not: true } }, {})).toContain('s10')
    expect(answer('issueProjection', { updatedAt: { newerThan: { days: 7 } } })).not.toContain('i7')
  })
})

describe('defineRecord', () => {
  it('refuses a part that names a field the schema does not carry', () => {
    expect(() =>
      defineRecord({
        kind: 'x',
        replicaKind: 'xs',
        schema: session.schema,
        key: 'sessionId',
        group: 'always',
        live: ['nope' as never],
        why: 'test',
      }),
    ).toThrow(/does not carry/)
  })
})
