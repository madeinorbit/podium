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
  coldByRule,
  collapseLosers,
  type EntityName,
  expectedLazy,
  keeperOf,
  laneKeepOf,
  laneSources,
  longestPrefixPath,
  type ModelSchema,
  normalizeRootPath,
  prefixCandidates,
  type RelationSpec,
  SCHEMA,
  tableColdContext,
  validateStructure,
  viaTargetOf,
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
  it('declares four entities, with the issue projection as a component rather than a fifth', () => {
    expect(Object.keys(SCHEMA).sort()).toEqual(['issue', 'repo', 'session', 'worktree'])
    // The projection is composed into `issue` by id, not a separate entity.
    expect(Object.keys(SCHEMA.issue.components).sort()).toEqual(['issue', 'issueProjection'])
    expect(SCHEMA.issue.components.issueProjection?.joinKey).toBe('id')
    expect(SCHEMA.issue.components.issueProjection?.arrivesOn).toBe('replica:issueProjections')
    // The wire wins when both are present.
    expect(SCHEMA.issue.components.issue!.precedence).toBeLessThan(
      SCHEMA.issue.components.issueProjection!.precedence,
    )
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

  it('declares residency: a closed issue nothing can show and its sessions are cold, lanes and repos are not', () => {
    const cold = SCHEMA.issue.cold
    expect(cold.kind).toBe('unlessShown')
    if (cold.kind !== 'unlessShown') throw new Error('unreachable')
    expect(cold.dependsOn).toContain('closedAt')
    expect(cold.predicate({ closedAt: '2026-09-01T00:00:00.000Z' })).toBe(true)
    expect(cold.predicate({ closedAt: null })).toBe(false)
    expect(cold.predicate({})).toBe(false)
    // POD-4665: the members that can keep it shown are its sessions; POD-4745:
    // and the issueless sessions its own checkout seats (R3).
    expect(cold.keptBy).toMatchObject([
      { kind: 'members', relation: 'sessions' },
      { kind: 'lane', through: 'worktree', relation: 'sessions', subset: 'issueless' },
    ])
    // POD-4758: the lane's subset is declared once, on the collection.
    const lane = SCHEMA.worktree.relations['sessions']
    if (lane?.kind !== 'hasMany') throw new Error('unreachable')
    expect(lane.subsets?.['issueless']?.fields).toEqual(['issueId'])

    // Bound sessions inherit; stopped unbound sessions use their own decay.
    expect(SCHEMA.session.cold).toMatchObject({ kind: 'via', relation: 'issue' })
    expect(cold.dependsOn).toEqual(expect.arrayContaining(['archived', 'deletedAt', 'audience', 'parentId']))
    expect(SCHEMA.session.cold.kind === 'via' && SCHEMA.session.cold.unbound?.dependsOn)
      .toEqual(expect.arrayContaining(['issueId', 'stoppedAt', 'agentState', 'unread', 'readAt', 'archived', 'agentKind']))
    expect(SCHEMA.worktree.cold.kind).toBe('never')
    expect(SCHEMA.repo.cold.kind).toBe('never')
  })

  it('derives every lazy flag from Rule L rather than hand-setting it', () => {
    for (const { from, name, relation } of allRelations()) {
      expect(relation.lazy, `${from}.${name}`).toBe(expectedLazy(SCHEMA, relation))
    }
    // The flag is per RELATION, not per entity: a hot issue reaches cold
    // sessions lazily while reaching its (never-cold) lane eagerly.
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
    const schema = clone()
    const { where: _where, ...unfiltered } = relationsOf('session').issue as RelationSpec & {
      where?: unknown
    }
    ;(schema.session.relations as Record<string, RelationSpec>).anyIssue = {
      ...unfiltered,
      inverse: 'anySessions',
    } as RelationSpec
    ;(schema.issue.relations as Record<string, RelationSpec>).anySessions = {
      ...relationsOf('issue').sessions!,
      inverse: 'anyIssue',
    } as RelationSpec
    expect(validateStructure(schema).join('\n')).not.toMatch(/declares the same edge/)
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

  /** The schema with the issue's lane source replaced by `change` of it. */
  function withLane(change: Record<string, unknown>): ModelSchema {
    const schema = clone()
    const cold = SCHEMA.issue.cold
    if (cold.kind !== 'unlessShown') throw new Error('unreachable')
    ;(schema as Record<string, unknown>).issue = {
      ...schema.issue,
      cold: {
        ...cold,
        keptBy: cold.keptBy.map((source) =>
          source.kind === 'lane' ? { ...source, ...change } : source,
        ),
      },
    }
    return schema
  }

  it('fires when the lane source names a lane through something other than a belongsTo', () => {
    expect(validateStructure(withLane({ through: 'children' })).join('\n')).toMatch(
      /issue\.cold\.keptBy \(lane\): through "children" must name a belongsTo/,
    )
  })

  it("fires when the lane source's members are not a prefix relation's inverse", () => {
    expect(validateStructure(withLane({ relation: 'issues' })).join('\n')).toMatch(
      /"worktree\.issues"'s inverse must be a prefix \(got belongsTo\)/,
    )
  })

  it('fires when the lane source names a subset its collection does not declare', () => {
    expect(validateStructure(withLane({ subset: 'unowned' })).join('\n')).toMatch(
      /subset "unowned" is not declared on worktree\.sessions/,
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

  it('fires when the lane source reads a member field that is not declared', () => {
    expect(
      validateStructure(withLane({ dependsOn: ['stoppedAt', 'issueRef'] })).join('\n'),
    ).toMatch(/issue\.cold\.keptBy\.dependsOn names undeclared session field "issueRef"/)
  })
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

  it('fires when a relation name shadows an undeclared property of the row (the `origin` trap)', () => {
    const schema = clone()
    const relations = schema.issue.relations as Record<string, RelationSpec>
    relations.origin = { ...relationsOf('issue').children!, inverse: 'parent' } as RelationSpec
    // `IssueWire.origin` is a real field ('human' | 'agent'). The schema does
    // not declare it, but the composed row still carries it, so the name is
    // taken — which is why R4 is `discoveredFrom`, not `origin`.
    expect(fieldsOf('IssueWire')).toContain('origin')
    expect(Object.keys(SCHEMA.issue.fields)).not.toContain('origin')
    expect(validateSources(schema).join('\n')).toMatch(
      /issue\.origin: relation name shadows IssueWire\.origin/,
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
    expect(fieldsOf('IssueWire')).not.toContain('unread')
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
    'starting and reconnecting also keep the group': [
      { sessionId: 'a', status: 'exited', lastActiveAt: at(1), resume: ref },
      { sessionId: 'b', status: 'reconnecting', lastActiveAt: at(2), resume: ref },
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

describe('the cold rule (coldByRule, POD-4580, POD-4665)', () => {
  const DAY = 24 * 60 * 60 * 1000
  const NOW = Date.parse('2026-09-24T00:00:00.000Z')
  const ago = (days: number) => new Date(NOW - days * DAY).toISOString()
  /** A closed formal child of a human mission: kept only by its own decay window or a session. */
  const child = (id: string, closedDaysAgo: number, more: object = {}) => ({
    id,
    parentId: 'p',
    audience: 'human',
    stage: 'done',
    closedReason: 'completed',
    closedAt: ago(closedDaysAgo),
    updatedAt: ago(closedDaysAgo),
    ...more,
  })
  const session = (sessionId: string, issueId: string, more: object = {}) => ({
    sessionId,
    issueId,
    cwd: '/w',
    lastActiveAt: ago(30),
    ...more,
  })
  function ruleAt(
    issues: readonly Record<string, unknown>[],
    sessions: readonly Record<string, unknown>[] = [],
    now = NOW,
    lanes: readonly string[] = [],
    schema: ModelSchema = SCHEMA,
  ) {
    const tables = {
      issue: new Map(issues.map((row) => [row['id'] as string, row])),
      session: new Map(sessions.map((row) => [row['sessionId'] as string, row])),
      worktree: new Map(lanes.map((path) => [path, { path }])),
    } as Record<string, Map<string, unknown>>
    const ctx = tableColdContext(schema, (entity) => tables[entity], now)
    return {
      issue: (id: string) => coldByRule(schema, 'issue', tables['issue']!.get(id) as object, ctx),
      session: (id: string) =>
        coldByRule(schema, 'session', tables['session']!.get(id) as object, ctx),
    }
  }

  it('applies own, via and never from the declaration', () => {
    const rule = ruleAt(
      [child('i1', 30), { id: 'i2', closedAt: null, stage: 'in_progress', audience: 'human' }],
      [
        session('s1', 'i1', { stoppedAt: ago(30) }),
        session('s2', 'i2'),
        session('s9', 'i9'),
        { sessionId: 's0', cwd: '/w' },
      ],
    )
    expect(rule.issue('i1')).toBe(true)
    expect(rule.issue('i2')).toBe(false)
    expect(rule.session('s1')).toBe(true)
    expect(rule.session('s2')).toBe(false)
    // An unknown issue, or none: nothing makes the session cold.
    expect(rule.session('s9')).toBe(false)
    expect(rule.session('s0')).toBe(false)
    const ctx = tableColdContext(SCHEMA, () => undefined, NOW)
    expect(coldByRule(SCHEMA, 'worktree', { path: '/a' }, { ...ctx, coldTarget: () => true })).toBe(
      false,
    )
    expect(coldByRule(SCHEMA, 'repo', { id: 'r' }, { ...ctx, coldTarget: () => true })).toBe(false)
  })

  it('history predicate: archived and deleted open issues are cold, and clearing either warms them', () => {
    for (const excluded of [{ archived: true }, { deletedAt: ago(30) }]) {
      const row = { id: 'i', stage: 'in_progress', audience: 'human', closedAt: null, ...excluded }
      expect(ruleAt([row]).issue('i')).toBe(true)
      expect(ruleAt([{ ...row, archived: false, deletedAt: null }]).issue('i')).toBe(false)
      const schema = clone()
      const cold = schema.issue.cold
      if (cold.kind !== 'unlessShown') throw new Error('unreachable')
      schema.issue = { ...schema.issue, cold: { ...cold, predicate: (r) => r['closedAt'] != null } }
      expect(ruleAt([row], [], NOW, [], schema).issue('i')).toBe(false)
    }
  })

  it('excluded keeper control: members and lanes cannot keep an excluded closed issue', () => {
    for (const excluded of [{ archived: true }, { deletedAt: ago(30) }, { stage: 'proposed' }, { stage: 'shipping' }]) {
      const row = child('i', 30, { worktreePath: '/w', ...excluded })
      const seats = [session('bound', 'i'), { sessionId: 'unbound', cwd: '/w' }]
      expect(ruleAt([row], seats, NOW, ['/w']).issue('i')).toBe(true)
      const schema = clone()
      const cold = schema.issue.cold
      if (cold.kind !== 'unlessShown') throw new Error('unreachable')
      schema.issue = { ...schema.issue, cold: { ...cold, canShow: undefined } }
      expect(ruleAt([row], seats, NOW, ['/w'], schema).issue('i')).toBe(false)
    }
  })

  it('nesting keeper control: a closed agent child without a warm human ancestor cannot show', () => {
    const agent = child('i', 30, { audience: 'agent' })
    const seats = [session('s', 'i')]
    for (const parent of [child('p', 30, { parentId: null, archived: true }),
      child('p', 30, { parentId: 'older' }), child('p', 30, { parentId: null, audience: 'agent' })]) {
      const rows = [agent, parent, child('older', 30, { parentId: null, archived: true })]
      expect(ruleAt(rows, seats).issue('i')).toBe(true)
      expect(ruleAt(rows, seats).session('s')).toBe(true)
      const schema = clone()
      const cold = schema.issue.cold
      if (cold.kind !== 'unlessShown') throw new Error('unreachable')
      schema.issue = { ...schema.issue, cold: { ...cold, canShow: undefined } }
      expect(ruleAt(rows, seats, NOW, [], schema).issue('i')).toBe(false)
    }
    // Unknown ancestor remains conservative. A warm human above an excluded
    // intermediate still provides nesting, and parentless started-by is untouched.
    expect(ruleAt([agent], seats).issue('i')).toBe(false)
    const human = { id: 'root', audience: 'human', stage: 'in_progress' }
    expect(ruleAt([agent, child('p', 30, { parentId: 'root', archived: true }), human], seats).issue('i')).toBe(false)
    expect(ruleAt([{ ...agent, parentId: null, startedBySession: 'starter' }], seats).issue('i')).toBe(false)
    expect(ruleAt([agent, { id: 'p', audience: 'human', stage: 'review' }], seats).issue('i')).toBe(false)
  })

  it('unbound decay control: stopped sessions use the keeper deadline, and a restart warms them', () => {
    const rows = [
      { sessionId: 'old', stoppedAt: ago(8) },
      { sessionId: 'unread', stoppedAt: ago(6), unread: true },
      { sessionId: 'read', stoppedAt: ago(3), readAt: ago(2) },
      { sessionId: 'reread', stoppedAt: ago(30), readAt: new Date(NOW - DAY / 2).toISOString() },
      { sessionId: 'ended', agentState: { phase: 'ended', since: ago(8) } },
      { sessionId: 'running', stoppedAt: null, agentState: { phase: 'working' } },
    ]
    const rule = ruleAt([], rows)
    for (const id of ['old', 'read', 'ended']) expect(rule.session(id), id).toBe(true)
    for (const id of ['unread', 'reread', 'running']) expect(rule.session(id), id).toBe(false)
    expect(ruleAt([], [{ ...rows[0], stoppedAt: null }]).session('old')).toBe(false)
    // Inclusive deadline, exactly as sessionKeep: one millisecond later is cold.
    expect(ruleAt([], [rows[0]!], NOW - DAY).session('old')).toBe(false)
    expect(ruleAt([], [rows[0]!], NOW - DAY + 1).session('old')).toBe(true)
    const schema = clone()
    const cold = schema.session.cold
    if (cold.kind !== 'via') throw new Error('unreachable')
    schema.session = { ...schema.session, cold: { ...cold, unbound: undefined } }
    expect(ruleAt([], rows, NOW, [], schema).session('old')).toBe(false)
  })

  it('keeps a closed agent child when its parentless agent ancestor has a started-by fallback', () => {
    const agent = child('i', 30, { audience: 'agent' })
    const parent = child('p', 30, { parentId: null, audience: 'agent', startedBySession: 'starter' })
    const rows = [agent, parent, { id: 'root', audience: 'human', stage: 'in_progress' }]
    const seats = [session('s', 'i'), session('ps', 'p'), session('starter', 'root')]
    expect(ruleAt(rows, seats).issue('i')).toBe(false)
    expect(ruleAt(rows, seats).session('s')).toBe(false)
    expect(ruleAt([agent, { ...parent, startedBySession: null }, rows[2]!], seats).issue('i')).toBe(true)
    const spec = SCHEMA.issue.cold
    if (spec.kind !== 'unlessShown') throw new Error('unreachable')
    expect(spec.dependsOn).toContain('startedBySession')
  })

  it('follows the raw reference: a headless session of a closed issue is cold', () => {
    const headless = session('s', 'i1', { headless: true })
    const rule = ruleAt([child('i1', 30)], [headless])
    expect(viaTargetOf(SCHEMA, 'session', headless)).toEqual({ to: 'issue', id: 'i1' })
    expect(rule.session('s')).toBe(true)
    expect(viaTargetOf(SCHEMA, 'issue', child('i1', 30))).toBeNull()
  })

  it('keeps resident a closed issue its own standing can show (R-VIS 2, the sessionless keep)', () => {
    const rule = ruleAt([
      // The closed fold: a closed top-level human issue never decays.
      {
        id: 'top',
        audience: 'human',
        stage: 'done',
        closedReason: 'completed',
        closedAt: ago(400),
        updatedAt: ago(400),
      },
      // A finished child inside the unread window (7 d), and past it.
      child('recent', 6),
      child('old', 8),
      // Read 12 h ago: the read window (24 h past the later of finish and read) still holds.
      child('reread', 8, { readAt: new Date(NOW - DAY / 2).toISOString() }),
      // Agent-audience children and closed agent roots never show without a session.
      child('agent', 1, { audience: 'agent' }),
      {
        id: 'agentRoot',
        audience: 'agent',
        stage: 'done',
        closedReason: 'completed',
        closedAt: ago(1),
        updatedAt: ago(1),
      },
      // Excluded: archived, even at the top level.
      {
        id: 'archived',
        archived: true,
        audience: 'human',
        stage: 'done',
        closedReason: 'completed',
        closedAt: ago(1),
        updatedAt: ago(1),
      },
    ])
    expect(rule.issue('top')).toBe(false)
    expect(rule.issue('recent')).toBe(false)
    expect(rule.issue('old')).toBe(true)
    expect(rule.issue('reread')).toBe(false)
    expect(rule.issue('agent')).toBe(true)
    expect(rule.issue('agentRoot')).toBe(true)
    expect(rule.issue('archived')).toBe(true)
  })

  it('keeps resident a closed issue a member session can keep shown (sessionRetainsWorklistRow)', () => {
    const issues = [
      'open',
      'stoppedUnread',
      'stoppedRead',
      'archived',
      'shell',
      'headless',
      'idleRecent',
      'idleOld',
      'idleUnfinished',
    ].map((id): Record<string, unknown> => child(id, 30, { audience: 'agent' }))
    issues[8] = { ...issues[8], stage: 'in_progress', closedReason: null }
    const idle = { agentState: { phase: 'idle', since: ago(40), idle: { kind: 'done' } } }
    const rule = ruleAt(issues, [
      session('s-open', 'open'),
      session('s-stoppedUnread', 'stoppedUnread', { stoppedAt: ago(3) }),
      session('s-stoppedRead', 'stoppedRead', { stoppedAt: ago(3), readAt: ago(2) }),
      session('s-archived', 'archived', { archived: true }),
      session('s-shell', 'shell', { agentKind: 'shell' }),
      session('s-headless', 'headless', { headless: true }),
      session('s-idleRecent', 'idleRecent', idle),
      session('s-idleOld', 'idleOld', idle),
      session('s-idleUnfinished', 'idleUnfinished', idle),
    ])
    // A run that never finished keeps its issue without limit.
    expect(rule.issue('open')).toBe(false)
    // A finished run: unread for 7 days, read for 24 h past the read.
    expect(rule.issue('stoppedUnread')).toBe(false)
    expect(rule.issue('stoppedRead')).toBe(true)
    // Not a seat, or not a member: keeps nothing.
    expect(rule.issue('archived')).toBe(true)
    expect(rule.issue('shell')).toBe(true)
    expect(rule.issue('headless')).toBe(true)
    // An idle finished turn decays from its ISSUE's finish (30 days ago here)...
    expect(rule.issue('idleOld')).toBe(true)
    // ...and never while its issue is unfinished.
    expect(rule.issue('idleUnfinished')).toBe(false)
    // Its sessions follow it.
    expect(rule.session('s-open')).toBe(false)
    expect(rule.session('s-idleOld')).toBe(true)
    const recent = ruleAt(
      [child('idleRecent', 2, { audience: 'agent' })],
      [session('s-idleRecent', 'idleRecent', idle)],
    )
    expect(recent.issue('idleRecent')).toBe(false)
  })

  it('keeps resident a finished row awaiting merge, without limit (issueAwaitingMerge)', () => {
    const delivery = {
      branch: 'task',
      gitState: { shared: false, ahead: 3 },
    }
    const rule = ruleAt([
      // The live shape (POD-4940): a finished agent child decayed past every
      // window, kept by its unlanded private branch alone.
      child('merged', 8, { audience: 'agent', ...delivery }),
      // No branch, a shared checkout, a landed branch: nothing keeps them.
      child('nobranch', 8, { audience: 'agent' }),
      child('shared', 8, {
        audience: 'agent',
        branch: 'task',
        gitState: { shared: true, ahead: 3 },
      }),
      child('landed', 8, {
        audience: 'agent',
        ...delivery,
        gitState: { shared: false, ahead: 3, merged: true },
      }),
      // An abandoned closure asks nothing, even with an unlanded branch.
      child('cancelled', 8, { audience: 'agent', closedReason: 'cancelled', ...delivery }),
      child('dupe', 8, { audience: 'agent', closedReason: 'dupe', ...delivery }),
      // Blocked: the merge is not the question.
      child('blocked', 8, { audience: 'agent', blocked: true, ...delivery }),
      // Excluded rows never show, merge verdict or not.
      child('archived', 8, { audience: 'agent', archived: true, ...delivery }),
    ])
    expect(rule.issue('merged')).toBe(false)
    for (const id of ['nobranch', 'shared', 'landed', 'cancelled', 'dupe', 'blocked', 'archived']) {
      expect(rule.issue(id), id).toBe(true)
    }
  })

  /**
   * POD-4745 (R3): an issueless session running in the issue's own checkout
   * is one of its seats by containment (`indexSessionOwnership`,
   * session-ownership.ts:152-158), so it keeps a closed issue shown exactly
   * as an explicit member does. Each closed issue here is agent-audience (it
   * never shows on its own) and has no explicit member: only its lane can
   * keep it. Returns the issues the rule keeps resident.
   */
  function laneKept(schema: ModelSchema): string[] {
    const wt = (name: string) => `/repo/.worktrees/${name}`
    const closed = (id: string, more: object = {}): Record<string, unknown> =>
      child(id, 30, { audience: 'agent', worktreePath: wt(id), ...more })
    const issueless = (sessionId: string, cwd: string, more: object = {}) => ({
      sessionId,
      cwd,
      lastActiveAt: ago(30),
      ...more,
    })
    const idle = { agentState: { phase: 'idle', since: ago(40), idle: { kind: 'done' } } }
    const twin = (status: string, lastActiveAt: string) => ({
      resume: { kind: 'claude', value: 'r-twin' },
      status,
      lastActiveAt,
    })
    const issues = [
      'open',
      'nested',
      'unscanned',
      'owned',
      'nullOwner',
      'headless',
      'shell',
      'stoppedOld',
      'stoppedRecent',
      'idleOld',
      'stolen',
      'twinLoser',
      'twinWinner',
      'noLane',
    ].map((id) => closed(id))
    issues[issues.length - 1] = closed('noLane', { worktreePath: null })
    const rule = ruleAt(
      issues,
      [
        // A run that never finished, in the checkout itself and deeper.
        issueless('s-open', wt('open')),
        issueless('s-nested', `${wt('nested')}/packages/app`),
        // No scan reported this checkout: the issue's own path is a root all the same.
        issueless('s-unscanned', `${wt('unscanned')}/src`),
        // Owned elsewhere: an explicit member of ANOTHER issue never counts here.
        issueless('s-owned', wt('owned'), { issueId: 'elsewhere' }),
        // The legacy tests `issueId !== undefined`: a null owner is an owner.
        issueless('s-nullOwner', wt('nullOwner'), { issueId: null }),
        // Not a member of the lane, or not a seat.
        issueless('s-headless', wt('headless'), { headless: true }),
        issueless('s-shell', wt('shell'), { agentKind: 'shell' }),
        // The same decay windows as an explicit member.
        issueless('s-stoppedOld', wt('stoppedOld'), { stoppedAt: ago(20) }),
        issueless('s-stoppedRecent', wt('stoppedRecent'), { stoppedAt: ago(3) }),
        // An idle finished turn decays from the OWNER's finish (30 days ago).
        issueless('s-idleOld', wt('idleOld'), idle),
        // A deeper scanned lane is the longest root: it takes the session.
        issueless('s-stolen', `${wt('stolen')}/inner/x`),
        // Resume twins collapse to one: the loser is not in any lane.
        issueless('s-twinLoser', wt('twinLoser'), twin('exited', ago(40))),
        issueless('s-twinWinner', wt('twinWinner'), twin('hibernated', ago(35))),
      ],
      NOW,
      // The scan: the repo root, every checkout but `unscanned`, and a lane inside `stolen`'s.
      [
        '/repo',
        ...issues
          .filter((row) => row['id'] !== 'unscanned' && row['id'] !== 'noLane')
          .map((row) => row['worktreePath'] as string),
        `${wt('stolen')}/inner`,
      ],
      schema,
    )
    return issues.map((row) => row['id'] as string).filter((id) => !rule.issue(id))
  }

  it('keeps resident a closed issue an issueless session in its own checkout can keep shown (R3)', () => {
    expect(laneKept(SCHEMA)).toEqual(['open', 'nested', 'unscanned', 'stoppedRecent', 'twinWinner'])
  })

  it('negative control: without the lane clause, R3 keeps nothing', () => {
    const schema = clone()
    const cold = SCHEMA.issue.cold
    if (cold.kind !== 'unlessShown') throw new Error('unreachable')
    ;(schema as Record<string, unknown>).issue = {
      ...schema.issue,
      cold: { ...cold, keptBy: cold.keptBy.filter((source) => source.kind !== 'lane') },
    }
    expect(laneKept(schema)).toEqual([])
  })

  it('only ever turns cold as the clock moves forward (deadlines pass)', () => {
    const issues = [child('a', 6), child('b', 1, { audience: 'agent' }), child('c', 8)]
    const sessions = [session('s', 'b', { stoppedAt: ago(1) })]
    for (const days of [0, 1, 2, 7, 30, 365]) {
      const earlier = ruleAt(issues, sessions, NOW + days * DAY)
      const later = ruleAt(issues, sessions, NOW + (days + 1) * DAY)
      for (const { id } of issues) {
        if (earlier.issue(id)) expect(later.issue(id), `${id} at +${days}d`).toBe(true)
      }
    }
    expect(ruleAt(issues, sessions, NOW + 365 * DAY).issue('a')).toBe(true)
  })

  it('counts a lane member only while it is unowned (laneKeepOf)', () => {
    const [lane] = laneSources(SCHEMA)
    expect(lane).toMatchObject({
      owner: 'issue',
      lane: 'worktree',
      owners: 'issues',
      member: 'session',
      prefixName: 'worktree',
    })
    expect(laneKeepOf(lane!, { sessionId: 's', cwd: '/w' })).toBe(Number.POSITIVE_INFINITY)
    expect(laneKeepOf(lane!, session('s', 'i1'))).toBeNull()
    expect(laneKeepOf(lane!, { sessionId: 's', cwd: '/w', issueId: null })).toBeNull()
    expect(laneKeepOf(lane!, { sessionId: 's', cwd: '/w', archived: true })).toBe(
      Number.NEGATIVE_INFINITY,
    )
  })

  it('names the member by its raw reference, headless excluded (keeperOf)', () => {
    expect(keeperOf(SCHEMA, 'session', session('s', 'i1'))).toMatchObject({ to: 'issue', id: 'i1' })
    expect(keeperOf(SCHEMA, 'session', session('s', 'i1', { headless: true }))).toBeNull()
    expect(keeperOf(SCHEMA, 'session', { sessionId: 's', cwd: '/w' })).toBeNull()
    expect(keeperOf(SCHEMA, 'issue', child('i1', 1))).toBeNull()
  })
})

/**
 * POD-4675 (H3-F4): the declared input lists are complete. Both relation
 * engines skip re-resolving a link when none of `where.fields` (and the key)
 * moved, and skip re-deciding a collapse group when none of
 * `collapse.fields` moved (`arms/*\/pool/relations.ts`). Those lists are
 * written by hand beside the functions they describe; `validateStructure`
 * only checks that each named field exists. A `where.test` or collapse
 * function that starts reading an unlisted field would leave relations stale
 * on changes of that field, seen by the gate only if the generator moves it.
 * So every `where.test` and every collapse function (`groupKey`,
 * `keepsGroup`, `rank`, the `recency` field) runs over every row of the 1x
 * corpus through a recording proxy, and any top-level field read outside its
 * list is named. It sees only the branches the corpus's rows take; H3's probe
 * (`harness/review/h3-shape-probes.test.ts`) also runs it over a live export.
 */
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
