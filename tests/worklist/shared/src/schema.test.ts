/**
 * POD-4546 (L1a) — the declared schema must hold up as data.
 *
 * Two gates. `validateStructure` (no zod) checks the shape of the declaration:
 * inverses point back, kinds are duals, keys name declared fields, lazy obeys
 * Rule L, nothing is declared twice. `validateSources` (zod) resolves every
 * field citation against the real `@podium/model` shape at runtime, so an
 * invented field fails here rather than surviving as a comment.
 *
 * EVERY rule has a negative control below. A validator that cannot be shown to
 * fire is not evidence (round-two pitfall: enforcement that only warns).
 */

import { dedupeSessionsByResume } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { buildCorpus } from '../../harness/src/fixture/index'
import {
  allRelations,
  collapseLosers,
  type EntityName,
  expectedLazy,
  longestPrefixPath,
  type ModelSchema,
  normalizeRootPath,
  prefixCandidates,
  type RelationSpec,
  SCHEMA,
  validateStructure,
} from '@podium/client-graph/shared/schema'
import { fieldsOf, validateSources } from './schema-sources'

/** A deep-enough copy to mutate one corner for a negative control. */
type MutableSchema = { -readonly [E in keyof ModelSchema]: ModelSchema[E] }

function clone(): MutableSchema {
  const out: Record<string, unknown> = {}
  for (const [name, entity] of Object.entries(SCHEMA)) {
    out[name] = {
      ...entity,
      components: { ...entity.components },
      fields: { ...entity.fields },
      relations: { ...entity.relations },
    }
  }
  return out as MutableSchema
}

function relationsOf(entity: EntityName): Record<string, RelationSpec> {
  return SCHEMA[entity].relations as Record<string, RelationSpec>
}

describe('the declared schema', () => {
  it('declares the synced record models, with the issue projection remaining a component', () => {
    expect(Object.keys(SCHEMA).sort()).toEqual(['agentProfile', 'automation', 'automationRun', 'credential', 'device', 'effect', 'inboxNotice', 'instancePreferences', 'issue', 'issueBrief', 'issueDescription', 'issuePanelArtifact', 'issuePanelDeferred', 'issuePanelState', 'issuePanelTodo', 'machine', 'member', 'messageRecord', 'pendingInteraction', 'pin', 'repo', 'repository', 'session', 'subscription', 'superagentThread', 'tabOrder', 'userLayout', 'userPreferences', 'userReadPosition', 'workflow', 'workflowBinding', 'workflowRevision', 'workflowRun', 'worktree'])
    // The projection is composed into `issue` by id, not a separate entity.
    expect(Object.keys(SCHEMA.issue.components).sort()).toEqual(['issueProjection'])
    expect(SCHEMA.issue.components.issueProjection?.joinKey).toBe('id')
    expect(SCHEMA.issue.components.issueProjection?.arrivesOn).toBe('replica:issueProjections')
  })

  it('gives every field a type and a source', () => {
    for (const [entityName, entity] of Object.entries(SCHEMA)) {
      for (const [fieldName, field] of Object.entries(entity.fields)) {
        expect(field.type, `${entityName}.${fieldName}.type`).toBeTruthy()
        expect(field.source.schema, `${entityName}.${fieldName}.source`).toBeTruthy()
        expect(field.source.arrivesOn, `${entityName}.${fieldName}.arrivesOn`).toBeTruthy()
      }
    }
  })

  it('declares the four relations of the frozen slice', () => {
    const bySlice = new Map<string, string[]>()
    for (const { from, name, relation } of allRelations()) {
      if (relation.slice === undefined) continue
      bySlice.set(relation.slice, [...(bySlice.get(relation.slice) ?? []), `${from}.${name}`])
    }
    expect([...bySlice.keys()].sort()).toEqual(['R1', 'R2', 'R3', 'R4'])

    // R1 — children/parent by issue.parentId.
    const parent = relationsOf('issue').parent!
    expect(parent).toMatchObject({
      kind: 'belongsTo',
      to: 'issue',
      foreignKey: 'parentId',
      targetKey: 'id',
      inverse: 'children',
    })
    expect(relationsOf('issue').children).toMatchObject({
      kind: 'hasMany',
      to: 'issue',
      inverse: 'parent',
    })

    // R2 — sessions by session.issueId.
    expect(relationsOf('session').issue).toMatchObject({
      kind: 'belongsTo',
      to: 'issue',
      foreignKey: 'issueId',
      targetKey: 'id',
      inverse: 'sessions',
    })
    expect(relationsOf('issue').sessions).toMatchObject({
      kind: 'hasMany',
      to: 'session',
      inverse: 'issue',
    })

    // R3 — sessions by worktree prefix. NOT a key join: the resolver is declared.
    expect(relationsOf('session').worktree).toMatchObject({
      kind: 'prefix',
      to: 'worktree',
      sourceField: 'cwd',
      targetKey: 'path',
      resolver: 'longestPrefixPath',
      inverse: 'sessions',
    })
    expect(relationsOf('worktree').sessions).toMatchObject({
      kind: 'hasMany',
      to: 'session',
      inverse: 'worktree',
    })

    // R4 — the discovered-from edge over issue.deps, both directions.
    expect(relationsOf('issue').discoveredFrom).toMatchObject({
      kind: 'edge',
      to: 'issue',
      edgeField: 'deps',
      edgeType: 'discovered-from',
      direction: 'out',
      inverse: 'spinOffs',
    })
    expect(relationsOf('issue').spinOffs).toMatchObject({
      kind: 'edge',
      direction: 'in',
      inverse: 'discoveredFrom',
    })
  })

  it('derives every lazy flag from Rule L rather than hand-setting it', () => {
    for (const { from, name, relation } of allRelations()) {
      expect(relation.lazy, `${from}.${name}`).toBe(expectedLazy(SCHEMA, relation))
    }
    // The flag is per RELATION, not per entity: an issue reaches its sessions
    // lazily (they can be off the device) while reaching its lane eagerly.
    expect(relationsOf('issue').sessions!.lazy).toBe(true)
    expect(relationsOf('issue').worktree!.lazy).toBe(false)
  })
})

describe('validateStructure', () => {
  it('passes on the declared schema', () => {
    expect(validateStructure()).toEqual([])
  })

  it('fires when an inverse does not point back', () => {
    const schema = clone()
    ;(schema.issue.relations as Record<string, RelationSpec>).parent = {
      ...relationsOf('issue').parent!,
      inverse: 'sessions',
    } as RelationSpec
    expect(validateStructure(schema).join('\n')).toMatch(
      /issue\.parent: inverse issue\.sessions points at/,
    )
  })

  it('fires when an inverse is missing entirely', () => {
    const schema = clone()
    ;(schema.issue.relations as Record<string, RelationSpec>).parent = {
      ...relationsOf('issue').parent!,
      inverse: 'nope',
    } as RelationSpec
    expect(validateStructure(schema).join('\n')).toMatch(/inverse "issue\.nope" is not declared/)
  })

  it('fires when the same edge is declared twice under two names', () => {
    const schema = clone()
    ;(schema.session.relations as Record<string, RelationSpec>).owner = {
      ...relationsOf('session').issue!,
      inverse: 'sessions',
    } as RelationSpec
    expect(validateStructure(schema).join('\n')).toMatch(/declares the same edge as session\.issue/)
  })

  it('counts a where-less twin of a filtered edge as a different edge (POD-4757)', () => {
    // The raw twin is now declared for mission provenance (headless included).
    // Adding a third copy would correctly fail duplicate-edge validation.
    expect(relationsOf('session').issue?.where).toBeDefined()
    expect(relationsOf('session').missionIssue?.where).toBeUndefined()
    expect(validateStructure(SCHEMA).join('\n')).not.toMatch(/declares the same edge/)
    const schema = clone()
    ;(schema.session.relations as Record<string, RelationSpec>).anyIssue = {
      ...relationsOf('session').missionIssue!, inverse: 'anySessions',
    } as RelationSpec
    ;(schema.issue.relations as Record<string, RelationSpec>).anySessions = {
      ...relationsOf('issue').missionSessions!, inverse: 'anyIssue',
    } as RelationSpec
    expect(validateStructure(schema).join('\n')).toMatch(/declares the same edge as session\.missionIssue/)

  })

  it('fires when a relation name collides with a declared field name', () => {
    const schema = clone()
    ;(schema.issue.relations as Record<string, RelationSpec>).deps = {
      ...relationsOf('issue').children!,
      inverse: 'parent',
    } as RelationSpec
    expect(validateStructure(schema).join('\n')).toMatch(
      /issue\.deps: relation name collides with a declared field/,
    )
  })

  it('fires when a lazy flag contradicts Rule L', () => {
    const schema = clone()
    ;(schema.issue.relations as Record<string, RelationSpec>).sessions = {
      ...relationsOf('issue').sessions!,
      lazy: false,
    } as RelationSpec
    expect(validateStructure(schema).join('\n')).toMatch(
      /issue\.sessions: lazy=false contradicts Rule L/,
    )
  })

  it('fires when a key names a field that is not declared', () => {
    const schema = clone()
    ;(schema.session.relations as Record<string, RelationSpec>).worktree = {
      ...relationsOf('session').worktree!,
      sourceField: 'worktreePath',
    } as RelationSpec
    // There is no `session.worktreePath`; the prefix relation runs off `cwd`.
    expect(validateStructure(schema).join('\n')).toMatch(
      /sourceField "worktreePath" is not a declared field of session/,
    )
  })

  it('fires when a kind is not the dual of its inverse', () => {
    const schema = clone()
    ;(schema.issue.relations as Record<string, RelationSpec>).children = {
      kind: 'belongsTo',
      to: 'issue',
      foreignKey: 'parentId',
      targetKey: 'id',
      inverse: 'parent',
      lazy: true,
      why: 'negative control',
    } as RelationSpec
    expect(validateStructure(schema).join('\n')).toMatch(/is not the dual of/)
  })

  it('fires when the collapse rule reads a field that is not declared', () => {
    const schema = clone()
    const collapse = SCHEMA.session.collapse!
    ;(schema as Record<string, unknown>).session = {
      ...schema.session,
      collapse: { ...collapse, fields: [...collapse.fields, 'resumeRef'] },
    }
    expect(validateStructure(schema).join('\n')).toMatch(
      /session\.collapse names undeclared field "resumeRef"/,
    )
  })

  it('fires when the collapse tie-break field is not among the fields it reads', () => {
    const schema = clone()
    const collapse = SCHEMA.session.collapse!
    ;(schema as Record<string, unknown>).session = {
      ...schema.session,
      collapse: {
        ...collapse,
        fields: collapse.fields.filter((field) => field !== 'lastActiveAt'),
      },
    }
    expect(validateStructure(schema).join('\n')).toMatch(
      /collapse\.recency "lastActiveAt" is not among its fields/,
    )
  })

  /** The schema with `worktree.sessions`' `issueless` subset replaced by `change` of it (under `name`). */
  function withSubset(change: Record<string, unknown>, name = 'issueless'): ModelSchema {
    const schema = clone()
    const sessions = SCHEMA.worktree.relations['sessions']
    if (sessions?.kind !== 'hasMany') throw new Error('unreachable')
    const subset = sessions.subsets?.['issueless']
    ;(schema as Record<string, unknown>).worktree = {
      ...schema.worktree,
      relations: {
        ...schema.worktree.relations,
        sessions: { ...sessions, subsets: { [name]: { ...subset, ...change } } },
      },
    }
    return schema
  }

  it('fires when a subset reads a member field that is not declared (POD-4758)', () => {
    expect(validateStructure(withSubset({})).join('\n')).toBe('')
    expect(validateStructure(withSubset({ fields: ['issueRef'] })).join('\n')).toMatch(
      /worktree\.sessions\.subsets\.issueless names undeclared session field "issueRef"/,
    )
  })

  it('fires when a subset declares no fields (POD-4758)', () => {
    expect(validateStructure(withSubset({ fields: [] })).join('\n')).toMatch(
      /worktree\.sessions\.subsets\.issueless: declares no fields/,
    )
  })

  it('fires when a subset takes a reserved name (POD-4758)', () => {
    expect(validateStructure(withSubset({}, 'size')).join('\n')).toMatch(
      /worktree\.sessions\.subsets\.size: the name is reserved/,
    )
  })

})

it.each(['many', 'allTypes'] as const)('rejects edge matching or cardinality disagreement: %s', policy => {
  const schema = clone(), original = schema.issue.relations.pageDependencies
  if (original?.kind !== 'edge') throw new Error('Missing edge collection declaration')
  ;(schema.issue.relations as Record<string, RelationSpec>).pageDependencies = { ...original, [policy]: undefined }
  expect(validateStructure(schema).join('\n')).toMatch(/edge matching\/cardinality disagrees with its inverse/)
})

describe('validateSources', () => {
  it('resolves every declared field against @podium/model', () => {
    expect(validateSources()).toEqual([])
  })

  it('fires on a field that @podium/model does not declare', () => {
    const schema = clone()
    ;(schema.session.fields as Record<string, unknown>).worktreePath = {
      type: 'string',
      source: { schema: 'SessionMeta', arrivesOn: 'replica:sessions' },
    }
    expect(validateSources(schema).join('\n')).toMatch(
      /session\.worktreePath: "worktreePath" is not a property of SessionMeta/,
    )
  })

  it('fires when a relation name shadows a durable property of the row (the `intentOrigin` trap)', () => {
    const schema = clone()
    const relations = schema.issue.relations as Record<string, RelationSpec>
    relations.intentOrigin = { ...relationsOf('issue').children!, inverse: 'parent' } as RelationSpec
    // The page now declares the durable field too; its name is still taken.
    expect(fieldsOf('IssueProjection')).toContain('intentOrigin')
    expect(Object.keys(SCHEMA.issue.fields)).toContain('intentOrigin')
    expect(validateSources(schema).join('\n')).toMatch(
      /issue\.intentOrigin: relation name shadows SlimIssueProjection\.intentOrigin/,
    )
  })

  it('does not count a nested row set the feed explodes into rows of another entity', () => {
    // `GitRepositoryWire.worktrees` is the source of the `worktree` rows, not
    // a property of the repo instance, so `repo.worktrees` is free to be the
    // maintained relation.
    expect(fieldsOf('GitRepositoryWire')).toContain('worktrees')
    expect(SCHEMA.repo.components.repoScan?.notComposed).toHaveProperty('worktrees')
    expect(validateSources()).toEqual([])
  })

  it('fires on a nested property that does not exist', () => {
    const schema = clone()
    const agentState = SCHEMA.session.fields.agentState!
    ;(schema.session.fields as Record<string, unknown>).agentState = {
      ...agentState,
      parts: {
        ...agentState.parts,
        tokensUsed: { type: 'number', source: { schema: 'AgentRuntimeState' } },
      },
    }
    expect(validateSources(schema).join('\n')).toMatch(
      /agentState\.tokensUsed: "tokensUsed" is not a property of AgentRuntimeState/,
    )
  })

  it('confirms the two fields the schema deliberately does NOT declare are rollups, not model fields', () => {
    // `issue.unread` is a rollup over the issue's sessions (issue-views.ts:391-410)
    // and `issue.prefix` arrives by joining the repo — reached here as
    // `issue.repo.prefix`. Neither is a property of the issue's own rows.
    expect(fieldsOf('IssueProjection')).not.toContain('unread')
    expect(fieldsOf('IssueProjection')).not.toContain('unread')
    expect(Object.keys(SCHEMA.issue.fields)).not.toContain('unread')
    expect(Object.keys(SCHEMA.issue.fields)).not.toContain('prefix')
    expect(Object.keys(SCHEMA.repo.fields)).toContain('prefix')
  })
})

describe('the prefix resolver', () => {
  it('matches the longest containing root, as the scan does', () => {
    const roots = ['/repo', '/repo/.worktrees/a', '/other']
    expect(longestPrefixPath('/repo/.worktrees/a/src', roots)).toBe('/repo/.worktrees/a')
    expect(longestPrefixPath('/repo/src', roots)).toBe('/repo')
    expect(longestPrefixPath('/repo', roots)).toBe('/repo')
    expect(longestPrefixPath('/elsewhere', roots)).toBe(null)
  })

  it('does not match a sibling whose name merely starts the same', () => {
    expect(longestPrefixPath('/repo-two/src', ['/repo'])).toBe(null)
  })

  it('treats `a` and `a/` as one root, and keeps `/`', () => {
    expect(normalizeRootPath('/repo/')).toBe('/repo')
    expect(normalizeRootPath('/')).toBe('/')
    expect(longestPrefixPath('/repo/src', ['/repo/'])).toBe('/repo/')
  })

  // POD-4579: the keyed-probe form a pool uses must give the resolver's answer.
  it('probing prefixCandidates in order finds the root longestPrefixPath picks', () => {
    // One spelling per root: with both `a` and `a/` present the resolver breaks
    // the tie by iteration order, which a keyed probe does not share.
    const pool = ['', '/', '/r', '/r/a/', '/r/a/b', '/r/ab', '/s/', 'rel', 'rel/x']
    const probes = [
      '/',
      '/r',
      '/r/',
      '/r/a',
      '/r/a/b/c',
      '/r/ab/x',
      '/r/abc',
      '/s',
      '/t',
      'rel/x/y',
      'relx',
      '',
    ]
    let seed = 7
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed / 2147483648
    }
    for (let round = 0; round < 200; round += 1) {
      const roots = pool.filter(() => rand() < 0.5)
      const present = new Set(roots)
      for (const probe of probes) {
        const probed =
          [...prefixCandidates(normalizeRootPath(probe))].find((key) => present.has(key)) ?? null
        expect(probed, `${probe} in ${JSON.stringify(roots)}`).toBe(longestPrefixPath(probe, roots))
      }
    }
  })
})

describe('the resume-twin collapse (session.collapse)', () => {
  const rule = SCHEMA.session.collapse!
  type Twin = {
    sessionId: string
    status: string
    lastActiveAt: string
    headless?: boolean
    resume?: { kind: string; value: string }
  }
  const ref = { kind: 'codex-thread', value: 't-1' }
  const at = (h: number) => `2026-09-23T${String(h).padStart(2, '0')}:00:00.000Z`

  /** The kept ids by the declared rule: every row not in a losing set. */
  function keptByRule(rows: readonly Twin[]): string[] {
    const groups = new Map<string, Twin[]>()
    for (const row of rows) {
      const key = rule.groupKey(row)
      if (key !== null) groups.set(key, [...(groups.get(key) ?? []), row])
    }
    const lost = new Set<string>()
    for (const group of groups.values()) {
      for (const id of collapseLosers(
        rule,
        group.map((row) => ({ id: row.sessionId, row })),
      ))
        lost.add(id)
    }
    return rows
      .filter((row) => !lost.has(row.sessionId))
      .map((row) => row.sessionId)
      .sort()
  }
  const keptByLegacy = (rows: Twin[]) =>
    dedupeSessionsByResume(rows as Parameters<typeof dedupeSessionsByResume>[0])
      .map((row) => row.sessionId as string)
      .sort()

  const cases: Record<string, Twin[]> = {
    'rank beats recency (all inactive: collapses)': [
      { sessionId: 'a', status: 'hibernated', lastActiveAt: at(1), resume: ref },
      { sessionId: 'b', status: 'exited', lastActiveAt: at(5), resume: ref },
    ],
    'a rank tie keeps the most recent (collapses)': [
      { sessionId: 'a', status: 'hibernated', lastActiveAt: at(1), resume: ref },
      { sessionId: 'b', status: 'hibernated', lastActiveAt: at(5), resume: ref },
    ],
    'a group with a live row is kept in full (does NOT collapse)': [
      { sessionId: 'a', status: 'hibernated', lastActiveAt: at(1), resume: ref },
      { sessionId: 'b', status: 'live', lastActiveAt: at(5), resume: ref },
    ],
    'starting also keeps the group': [
      { sessionId: 'a', status: 'exited', lastActiveAt: at(1), resume: ref },
      { sessionId: 'b', status: 'hibernated', lastActiveAt: at(2), resume: ref },
      {
        sessionId: 'c',
        status: 'exited',
        lastActiveAt: at(3),
        resume: { kind: 'codex-thread', value: 't-2' },
      },
      {
        sessionId: 'd',
        status: 'starting',
        lastActiveAt: at(4),
        resume: { kind: 'codex-thread', value: 't-2' },
      },
    ],
    'a headless row neither collapses nor keeps its group': [
      { sessionId: 'a', status: 'exited', lastActiveAt: at(1), resume: ref },
      { sessionId: 'b', status: 'hibernated', lastActiveAt: at(2), resume: ref },
      { sessionId: 'h', status: 'live', lastActiveAt: at(3), resume: ref, headless: true },
    ],
    'rows without a ref are never merged': [
      { sessionId: 'a', status: 'exited', lastActiveAt: at(1) },
      { sessionId: 'b', status: 'exited', lastActiveAt: at(2) },
    ],
    'three twins keep one': [
      { sessionId: 'a', status: 'exited', lastActiveAt: at(9), resume: ref },
      { sessionId: 'b', status: 'hibernated', lastActiveAt: at(2), resume: ref },
      { sessionId: 'c', status: 'hibernated', lastActiveAt: at(3), resume: ref },
    ],
  }

  for (const [name, rows] of Object.entries(cases)) {
    it(`agrees with dedupeSessionsByResume: ${name}`, () => {
      expect(keptByRule(rows)).toEqual(keptByLegacy(rows))
    })
  }

  it('collapses the all-inactive group and keeps the active one, both directions', () => {
    expect(keptByRule(cases['rank beats recency (all inactive: collapses)']!)).toEqual(['a'])
    expect(
      keptByRule(cases['a group with a live row is kept in full (does NOT collapse)']!),
    ).toEqual(['a', 'b'])
  })
})

describe('declared input lists (POD-4675)', () => {
  type Row = Readonly<Record<string, unknown>>
  const corpus = buildCorpus(1)
  const rowsOf = (entity: EntityName): Row[] =>
    entity === 'issue'
      ? (corpus.sliceIssues as unknown as Row[])
      : entity === 'session'
        ? (corpus.sliceSessions as unknown as Row[])
        : entity === 'worktree'
          ? (corpus.sliceWorktrees as unknown as Row[])
          : []

  /** The top-level fields `fn` reads from each row, beyond `declared`. */
  function undeclaredReads(
    declared: readonly string[],
    rows: readonly Row[],
    fn: (row: Row) => unknown,
  ): string[] {
    const allowed = new Set(declared)
    const extra = new Set<string>()
    for (const row of rows) {
      fn(
        new Proxy(row, {
          get(target, key, receiver) {
            if (typeof key === 'string' && !allowed.has(key)) extra.add(key)
            return Reflect.get(target, key, receiver)
          },
        }),
      )
    }
    return [...extra].sort()
  }

  /** Every declared filter's and collapse function's undeclared reads, one line each. */
  function inputGaps(schema: ModelSchema): { gaps: string[]; checked: string[] } {
    const gaps: string[] = []
    const checked: string[] = []
    for (const { from, name, relation } of allRelations(schema)) {
      const where = (
        relation as { where?: { fields: readonly string[]; test: (r: Row) => boolean } }
      ).where
      if (where === undefined) continue
      const rows = rowsOf(from)
      expect(rows.length, `${from} rows for ${from}.${name}.where`).toBeGreaterThan(0)
      checked.push(`${from}.${name}.where`)
      const extra = undeclaredReads(where.fields, rows, (row) => where.test(row))
      if (extra.length > 0) gaps.push(`${from}.${name}.where reads ${extra.join(', ')}`)
    }
    for (const entity of Object.keys(schema) as EntityName[]) {
      const rule = schema[entity].collapse
      if (rule === undefined) continue
      const rows = rowsOf(entity)
      expect(rows.length, `${entity} rows for ${entity}.collapse`).toBeGreaterThan(0)
      const fns: [string, (row: Row) => unknown][] = [
        ['groupKey', (row) => rule.groupKey(row)],
        ['keepsGroup', (row) => rule.keepsGroup(row)],
        ['rank', (row) => rule.rank(row)],
        ['recency', (row) => row[rule.recency]],
      ]
      for (const [label, fn] of fns) {
        checked.push(`${entity}.collapse.${label}`)
        const extra = undeclaredReads(rule.fields, rows, fn)
        if (extra.length > 0) gaps.push(`${entity}.collapse.${label} reads ${extra.join(', ')}`)
      }
    }
    return { gaps, checked }
  }

  it('every where.test and collapse function reads only its declared fields', () => {
    const { gaps, checked } = inputGaps(SCHEMA)
    // The declared filters and the one collapse rule were all run.
    expect(checked).toEqual(expect.arrayContaining(['session.collapse.groupKey']))
    expect(checked.filter((line) => line.endsWith('.where')).length).toBeGreaterThan(0)
    expect(gaps).toEqual([])
  })

  it('names a where.test that reads an undeclared field (the check is armed)', () => {
    const issue = SCHEMA.session.relations['issue'] as unknown as {
      where: { fields: readonly string[]; test: (r: Row) => boolean; why: string }
    }
    const planted = {
      ...SCHEMA,
      session: {
        ...SCHEMA.session,
        relations: {
          ...SCHEMA.session.relations,
          issue: {
            ...issue,
            where: {
              ...issue.where,
              test: (row: Row) => issue.where.test(row) && row['status'] !== 'deleted',
            },
          },
        },
      },
    } as unknown as ModelSchema
    expect(inputGaps(planted).gaps).toContain('session.issue.where reads status')
  })

  it('names a collapse function that reads an undeclared field (the check is armed)', () => {
    const rule = SCHEMA.session.collapse!
    const planted = {
      ...SCHEMA,
      session: {
        ...SCHEMA.session,
        collapse: { ...rule, rank: (row: Row) => rule.rank(row) + (row['cwd'] === '' ? 1 : 0) },
      },
    } as unknown as ModelSchema
    expect(inputGaps(planted).gaps).toContain('session.collapse.rank reads cwd')
  })
})
