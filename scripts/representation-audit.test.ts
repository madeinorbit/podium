import { describe, expect, it } from 'vitest'
import type { AuditContext, SourceFile } from './rearch-audit'
import { stripComments } from './rearch-audit'
import {
  assertInlineDetectorMatchesControl,
  assertVocabularyLoaded,
  capabilitySnapshots,
  danglingRegistryEntries,
  ENTITY_SHAPE_THRESHOLD,
  entityShapedDeclarations,
  GENERIC_KEYS,
  inlineEntityShapedLiterals,
  instancePartitions,
  NOT_A_REPRESENTATION,
  perUserSingletons,
  physicalTableColumns,
  unregisteredRestatements,
} from './representation-audit'

/** A one-file context, so each case is exactly the source it names. */
function ctxOf(source: string, file = 'apps/server/src/probe.ts'): AuditContext {
  const files: SourceFile[] = [{ file, stripped: stripComments(source), isTest: false }]
  return { repoRoot: process.cwd(), files, listDir: () => [] }
}

/**
 * The shape the OLD name-list detector could not see and this one must: a
 * hand-written session field list under a name that appears on no list anywhere.
 */
const RESTATED = `
export interface WhateverWeCallIt {
  sessionId: string
  cwd: string
  agentKind: string
  machineId?: string
}
`

describe('entityShapedDeclarations — it can say YES', () => {
  it('finds a hand-restated session field list', () => {
    const found = entityShapedDeclarations(ctxOf(RESTATED))
    expect(found.map((d) => d.symbol)).toEqual(['WhateverWeCallIt'])
    expect(found[0]?.sessionKeys.length).toBeGreaterThanOrEqual(ENTITY_SHAPE_THRESHOLD)
  })

  /**
   * THE PROPERTY THE OLD DETECTOR DID NOT HAVE. POD-367 refused to extend
   * `ISSUE_SHAPES` to seventeen names precisely because that leaves the criterion
   * zeroable by renaming an identifier. This is the assertion that the refusal
   * bought: the same fields under a different name are still found.
   */
  it('still finds it after the symbol is RENAMED — the count is not zeroable by rename', () => {
    const renamed = RESTATED.replace('WhateverWeCallIt', 'SomethingEntirelyDifferent')
    const found = entityShapedDeclarations(ctxOf(renamed))
    expect(found.map((d) => d.symbol)).toEqual(['SomethingEntirelyDifferent'])
  })

  it('survives reformatting — it matches statements, not line layout', () => {
    const reflowed = `
export interface WhateverWeCallIt { sessionId: string; cwd: string
  agentKind: string
  machineId?: string }
`
    expect(entityShapedDeclarations(ctxOf(reflowed)).map((d) => d.symbol)).toEqual([
      'WhateverWeCallIt',
    ])
  })

  it('is silent on the COMPOSED form of the same shape', () => {
    // This is the limit that defines the unit, asserted rather than described:
    // composition leaves no key list behind, so the detector cannot see it. A
    // falling count means "more is composed"; a zero does NOT mean "these are all
    // the representations".
    const composed = `
export type WhateverWeCallIt = Pick<SessionMeta, 'sessionId' | 'cwd' | 'agentKind' | 'machineId'>
`
    const found = entityShapedDeclarations(ctxOf(composed))
    // The `Pick` names its members, so the forbidden-key checks can still read
    // them — but it restates no TYPES, so it is not counted as a restatement.
    expect(unregisteredRestatements(ctxOf(composed), 'session')).toEqual([])
    expect(found[0]?.keys ?? []).toContain('sessionId')
  })

  it('is silent on a service, a deps interface and a class', () => {
    for (const source of [
      // Members are behaviour: a port, not a shape.
      `export interface SessionDeps {
         listSessions(): unknown
         spawnSession(cwd: string, agentKind: string, machineId: string): void
       }`,
      `export interface Callbacks {
         onSession: (sessionId: string, cwd: string, agentKind: string) => void
       }`,
      `export class SessionsRepository {
         sessionId = ''
         cwd = ''
         agentKind = ''
         machineId = ''
       }`,
    ]) {
      expect(entityShapedDeclarations(ctxOf(source))).toEqual([])
    }
  })

  it('is silent on a key-NAME array and on a string-literal union', () => {
    const source = `
export const PER_USER_KEYS = ['readAt', 'snoozedUntil', 'tuckedAt', 'pinned'] as const
export type SessionVolatileField = 'geometry' | 'status' | 'machineId' | 'handoffTarget'
`
    expect(entityShapedDeclarations(ctxOf(source))).toEqual([])
  })

  /**
   * The regression this detector's first revision actually had: a brace-less type
   * alias absorbed the inline parameter object of the FUNCTION below it, so
   * `type ExitedAction = 'restart' | 'resume' | 'remove'` was reported as a
   * four-key session restatement. The window now stops at a function.
   */
  it('does not attribute a following function’s parameter object to a brace-less alias', () => {
    const source = `
export type ExitedAction = 'restart' | 'resume' | 'remove'

export function exitedRecovery(opts: {
  exitCode: number | undefined
  spawnFailure?: string
  resumable: boolean
  worktreePath?: string
}): ExitedAction {
  return 'remove'
}
`
    expect(entityShapedDeclarations(ctxOf(source)).map((d) => d.symbol)).toEqual([])
  })

  it('does not count a migration, a generated file or a wire fixture', () => {
    for (const file of [
      'apps/server/src/migrations/schema.ts',
      'apps/server/src/migrations/drizzle-manifest.generated.ts',
      'packages/protocol/src/messages/wire-golden.fixtures.ts',
    ]) {
      expect(entityShapedDeclarations(ctxOf(RESTATED, file)), file).toEqual([])
    }
  })

  it('does not count a field group as a restatement of itself', () => {
    expect(
      entityShapedDeclarations(ctxOf(RESTATED, 'packages/model/src/fields/session.ts')),
    ).toEqual([])
  })
})

/**
 * THE SECOND SYNTAX FORM (POD-1525).
 *
 * POD-408 consolidated two inline restatements of the same four session keys —
 * `ExitedPane` and `ExitedBanner` in AgentPanel.tsx, each with its own
 * hand-written prop type — into one named `ExitedProps`, and `session-shapes`
 * went 1 → 2 and rejected the change. The tree got better; the number got worse,
 * because the detector counted DECLARATION and the defect is RESTATEMENT.
 *
 * These cases pin the fix in both directions: the inline form is now found, and
 * the forms that merely NAME keys without restating their types are still not,
 * because a detector that counted those would count most of the repo and get
 * muted.
 */
describe('the INLINE form — it can say YES', () => {
  /** POD-408's shape, as it stood in AgentPanel.tsx before the refactor. */
  const INLINE_PANE = `
function ExitedPane({ sessionId, exitCode, spawnFailure, resumable }: {
  sessionId: SessionId
  exitCode: number | undefined
  spawnFailure?: string
  resumable: boolean
}): JSX.Element {
  return <div>{sessionId}</div>
}
`
  const TSX = 'apps/web/src/features/terminal/AgentPanel.tsx'

  it('finds an inline prop type the named pass cannot see', () => {
    expect(entityShapedDeclarations(ctxOf(INLINE_PANE, TSX))).toEqual([])
    const inline = inlineEntityShapedLiterals(ctxOf(INLINE_PANE, TSX))
    expect(inline).toHaveLength(1)
    expect(inline[0]?.symbol).toBe('ExitedPane#1')
    expect(inline[0]?.sessionKeys.length).toBeGreaterThanOrEqual(ENTITY_SHAPE_THRESHOLD)
    expect(unregisteredRestatements(ctxOf(INLINE_PANE, TSX), 'session')).toHaveLength(1)
  })

  /**
   * THE PROPERTY THIS WHOLE ITEM EXISTS FOR. Under the old detector this
   * refactor read as +1. It must now read as an improvement, or the ratchet goes
   * on paying agents to inline the debt this epic is deleting.
   */
  it('scores consolidating two inline restatements into one named interface as a WIN', () => {
    const before = `${INLINE_PANE}\n${INLINE_PANE.replace(/ExitedPane/g, 'ExitedBanner')}`
    const after = `
interface ExitedProps {
  sessionId: SessionId
  exitCode: number | undefined
  spawnFailure?: string
  resumable: boolean
}
function ExitedPane({ sessionId }: ExitedProps): JSX.Element { return <div>{sessionId}</div> }
function ExitedBanner({ sessionId }: ExitedProps): JSX.Element { return <div>{sessionId}</div> }
`
    expect(unregisteredRestatements(ctxOf(before, TSX), 'session')).toHaveLength(2)
    expect(unregisteredRestatements(ctxOf(after, TSX), 'session')).toHaveLength(1)
  })

  it('finds the inline parameter object the named pass deliberately walks past', () => {
    // The named pass has a case asserting this literal is NOT attributed to the
    // brace-less alias above it. That was right, and it left the literal
    // uncounted by anything. It is a restatement; here is where it counts.
    const source = `
export type ExitedAction = 'restart' | 'resume' | 'remove'

export function exitedRecovery(opts: {
  exitCode: number | undefined
  spawnFailure?: string
  resumable: boolean
  worktreePath?: string
}): ExitedAction {
  return 'remove'
}
`
    expect(entityShapedDeclarations(ctxOf(source))).toEqual([])
    expect(inlineEntityShapedLiterals(ctxOf(source)).map((d) => d.symbol)).toEqual([
      'exitedRecovery#1',
    ])
  })
})

describe('the INLINE form — it can say NO', () => {
  /**
   * THE LINE, asserted rather than described. A component that DESTRUCTURES
   * three session fields is coupled to three names; one that hand-writes their
   * types has declared the shape a second time. Only the second is a
   * restatement — the same line the named pass already draws on `Pick`, which
   * names its members and is never counted as a restatement either.
   */
  it('is silent on a destructuring pattern that names the same keys', () => {
    const source = `
function ExitedPane({ sessionId, exitCode, spawnFailure, resumable }: ExitedProps): JSX.Element {
  return <div>{sessionId}{exitCode}{spawnFailure}{resumable}</div>
}
`
    expect(inlineEntityShapedLiterals(ctxOf(source, 'apps/web/src/p.tsx'))).toEqual([])
  })

  it('is silent on a VALUE object literal that names the same keys', () => {
    const source = `
export function toRow(s: Session) {
  return { sessionId: s.sessionId, cwd: s.cwd, agentKind: s.agentKind, machineId: s.machineId }
}
`
    expect(inlineEntityShapedLiterals(ctxOf(source))).toEqual([])
  })

  it('is silent on an inline literal whose members are BEHAVIOUR', () => {
    const source = `
export function wire(deps: {
  sessionId(): string
  cwd: () => string
  agentKind(): string
  machineId(): string
}): void {}
`
    expect(inlineEntityShapedLiterals(ctxOf(source))).toEqual([])
  })

  /**
   * THE THRESHOLD BOUNDARY. An off-by-one here silently changes what the whole
   * ratchet measures, so both sides of it are pinned rather than reasoned about.
   */
  it('needs exactly ENTITY_SHAPE_THRESHOLD keys — two do not trip it, three do', () => {
    const two = `export function f(o: { sessionId: string; cwd: string }): void {}`
    const three = `export function f(o: { sessionId: string; cwd: string; agentKind: string }): void {}`
    expect(ENTITY_SHAPE_THRESHOLD).toBe(3)
    expect(inlineEntityShapedLiterals(ctxOf(two))).toEqual([])
    expect(inlineEntityShapedLiterals(ctxOf(three))).toHaveLength(1)
  })

  it('counts a nested literal ONCE, not once per enclosing window', () => {
    // The named pass reads a declaration's text flat, so it has already absorbed
    // the nested keys. Counting them again would inflate the baseline with the
    // same site twice.
    const source = `
export interface Envelope {
  sessionId: string
  cwd: string
  agentKind: string
  inner: { sessionId: string; cwd: string; machineId: string }
}
`
    expect(unregisteredRestatements(ctxOf(source), 'session')).toHaveLength(1)
  })

  it('does not count an inline literal in a test, a migration or a fixture', () => {
    const source = `export function f(o: { sessionId: string; cwd: string; agentKind: string }): void {}`
    for (const file of [
      'apps/server/src/migrations/schema.ts',
      'apps/server/src/x.generated.ts',
      'packages/protocol/src/messages/wire-golden.fixtures.ts',
      'packages/model/src/fields/session.ts',
    ]) {
      expect(inlineEntityShapedLiterals(ctxOf(source, file)), file).toEqual([])
    }
  })

  /**
   * The guard that stops a parser failure from reading as a deletion. A
   * regex detector that breaks usually breaks loudly; a parser handed the wrong
   * script kind just walks a tree with nothing in it and reports a serene zero,
   * which the ratchet would bank as progress.
   */
  it('REFUSES to run when it stops matching its own control shape', () => {
    expect(() => assertInlineDetectorMatchesControl()).not.toThrow()
    expect(() => assertInlineDetectorMatchesControl('const x = 1')).toThrow(/control shape/)
    expect(() =>
      assertInlineDetectorMatchesControl(
        undefined,
        'export function f(o: { sessionId: string; cwd: string; agentKind: string }): void {}',
      ),
    ).toThrow(/DESTRUCTURING|restating a shape/)
  })
})

describe('the forbidden key classes fire on planted keys', () => {
  it('fires on a per-user singleton', () => {
    const planted = RESTATED.replace('cwd: string', 'readAt: string | null\n  cwd: string')
    expect(perUserSingletons(ctxOf(planted)).map((s) => s.text)).toEqual([
      'WhateverWeCallIt.readAt',
    ])
  })

  it('fires on a serialized capability under several spellings', () => {
    for (const key of [
      'capabilities',
      'effectiveRights',
      'permissions',
      'grants',
      'scope',
      'role',
      'acl',
    ]) {
      const planted = RESTATED.replace('cwd: string', `${key}: string[]\n  cwd: string`)
      expect(
        capabilitySnapshots(ctxOf(planted)).map((s) => s.text),
        key,
      ).toEqual([`WhateverWeCallIt.${key}`])
    }
  })

  it('does NOT fire on the attribution pair — it must survive export', () => {
    const planted = RESTATED.replace(
      'cwd: string',
      'owner: string\n  actor: string\n  onBehalfOf: string | null\n  cwd: string',
    )
    expect(capabilitySnapshots(ctxOf(planted))).toEqual([])
  })

  it('fires on an instance or tenant partition', () => {
    for (const key of ['instance_id', 'instanceId', 'tenant_id', 'tenantId']) {
      const planted = RESTATED.replace('cwd: string', `${key}: string\n  cwd: string`)
      expect(
        instancePartitions(ctxOf(planted)).map((s) => s.text),
        key,
      ).toEqual([`WhateverWeCallIt.${key}`])
    }
  })
})

/**
 * THE SECOND SYNTAX FORM (POD-1168). A drizzle table is a CALL EXPRESSION whose
 * columns live in an object argument, so no key of it is ever a key of a
 * declaration — POD-1162's P4 planted `instance_id` on `sessions` and every gate
 * stayed green. These fix the concept, not the line: a partition is caught
 * wherever it can be WRITTEN.
 */
describe('instancePartitions — the drizzle column form', () => {
  const SCHEMA = `
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core"

export const sessions = sqliteTable("sessions", {
	id: text().primaryKey(),
	agentKind: text("agent_kind").notNull(),
	machineId: text("machine_id").default("__local__").notNull(),
	archived: integer().default(0).notNull(),
}, (table) => [
	index("sessions_archived_idx").on(table.archived),
])

export const issues = sqliteTable("issues", {
	id: text().primaryKey(),
	title: text().notNull(),
})
`
  const schemaCtx = (source: string) => ctxOf(source, 'apps/server/src/migrations/schema.ts')

  /** The instrument must be able to say YES about the population it parses. */
  it('parses every column of every table, including the implicitly-named ones', () => {
    const cols = physicalTableColumns(schemaCtx(SCHEMA))
    expect(cols.map((c) => `${c.table}.${c.column}`)).toEqual([
      'sessions.id',
      'sessions.agent_kind',
      'sessions.machine_id',
      'sessions.archived',
      'issues.id',
      'issues.title',
    ])
    // `id: text()` names its column after the key — the form that carries no
    // string argument at all.
    expect(cols[0]).toMatchObject({ key: 'id', column: 'id' })
  })

  it('is SILENT on the live schema as it stands — no partition column exists', () => {
    expect(instancePartitions(schemaCtx(SCHEMA))).toEqual([])
  })

  it('fires on a planted partition column under either spelling, on any table', () => {
    const cases: [string, string][] = [
      // [planted column line, expected site text]
      ['instanceId: text("instance_id"),', 'sessions.instance_id (column)'],
      ['tenantId: text("tenant_id"),', 'sessions.tenant_id (column)'],
      // camelCase key, snake_case column — and the reverse. Either spelling
      // alone is the partition.
      ['instanceId: text("owning_thing"),', 'sessions.owning_thing (column)'],
      ['owningThing: text("tenant_id"),', 'sessions.tenant_id (column)'],
      // No string argument: the key IS the column name.
      ['tenantId: text(),', 'sessions.tenantId (column)'],
    ]
    for (const [line, expected] of cases) {
      const planted = SCHEMA.replace(
        '\tid: text().primaryKey(),',
        `\t${line}\n\tid: text().primaryKey(),`,
      )
      expect(planted, line).not.toEqual(SCHEMA)
      expect(
        instancePartitions(schemaCtx(planted)).map((s) => s.text),
        line,
      ).toEqual([expected])
    }
  })

  it('fires on a table OTHER than sessions — the rule is the form, not a table list', () => {
    const planted = SCHEMA.replace(
      '\ttitle: text().notNull(),',
      '\ttitle: text().notNull(),\n\tinstanceId: text("instance_id"),',
    )
    expect(instancePartitions(schemaCtx(planted)).map((s) => s.text)).toEqual([
      'issues.instance_id (column)',
    ])
  })

  /**
   * ADR 1 D5's DEPLOYMENT partition is a real and permitted concept — POD-368
   * verified the ~150 `instanceId` sites in the tree are exactly that. What is
   * forbidden is a per-row partition COLUMN, so an identifier, a parameter or a
   * config field of that name must not read as one.
   */
  it('does NOT fire on deployment-partition code that merely mentions instanceId', () => {
    const legitimate = `
const instanceId = resolveInstanceId()
export function forInstance(instanceId: string, tenantId: string) {
  return { instanceId, tenantId }
}
export const config = { instanceId: process.env.INSTANCE_ID }
`
    expect(instancePartitions(ctxOf(legitimate))).toEqual([])
    expect(physicalTableColumns(ctxOf(legitimate))).toEqual([])
  })
})

describe('the two checks whose live answer is ZERO can say non-zero', () => {
  /**
   * `representation-registry-rot` reports 0, and a zero from a check nobody has
   * seen fire is indistinguishable from a broken one. These plant the failure.
   */
  it('fires on a registry entry whose FILE does not exist', () => {
    const planted = [{ symbol: 'Ghost', site: 'apps/server/src/does-not-exist.ts' }]
    const sites = danglingRegistryEntries(process.cwd(), planted)
    expect(sites.map((s) => s.text)).toEqual(['Ghost: registered site does not exist'])
  })

  it('fires on a registry entry whose file exists but no longer DECLARES the symbol', () => {
    // A real file that certainly does not declare this symbol. The check anchors
    // on the declaration keyword, so a mere mention would not satisfy it either.
    const planted = [{ symbol: 'NeverDeclaredAnywhere', site: 'package.json' }]
    const sites = danglingRegistryEntries(process.cwd(), planted)
    expect(sites.map((s) => s.text)).toEqual([
      'NeverDeclaredAnywhere: registered but no longer declared at this site',
    ])
  })

  it('is silent on a registry entry that is genuinely declared where it says', () => {
    // The YES case for the check above: it must be able to pass, or the two cases
    // above would be satisfied by a function that always reports a violation.
    const planted = [
      {
        symbol: 'RETAINED_REPRESENTATIONS',
        site: 'packages/model/src/representations/registry.ts',
      },
    ]
    expect(danglingRegistryEntries(process.cwd(), planted)).toEqual([])
  })

  it('REFUSES to run on an empty vocabulary rather than reporting zero', () => {
    // The guard that stops a broken import from reading as a deletion. An
    // unexercised guard is indistinguishable from an absent one.
    expect(() => assertVocabularyLoaded(new Set(), new Set(['issueId']))).toThrow(/loaded EMPTY/)
    expect(() => assertVocabularyLoaded(new Set(['sessionId']), new Set())).toThrow(/loaded EMPTY/)
    // And it permits the loaded case, so the throw is about emptiness and not
    // about being called.
    expect(() => assertVocabularyLoaded(new Set(['sessionId']), new Set(['issueId']))).not.toThrow()
  })
})

describe('the detector’s two judgement calls are pinned', () => {
  /**
   * `GENERIC_KEYS` is the one place this detector exercises taste, so its
   * membership is pinned rather than left to drift. Adding a key here makes the
   * detector blinder; removing one makes it noisier. Either is a decision, and
   * this test makes it a visible one.
   */
  it('pins the generic-key list', () => {
    expect([...GENERIC_KEYS].sort()).toEqual(
      [
        'actor',
        'archived',
        'assignee',
        'blocked',
        'brief',
        'closed',
        'color',
        'createdAt',
        'deletedAt',
        'description',
        'effort',
        'id',
        'kind',
        'labels',
        'model',
        'name',
        'notes',
        'onBehalfOf',
        'owner',
        'path',
        'prefix',
        'priority',
        'ready',
        'seq',
        'stage',
        'status',
        'title',
        'type',
        'updatedAt',
        'value',
        'visibility',
      ].sort(),
    )
  })

  it('keys every exclusion on an exact (file, symbol) pair with a reason', () => {
    // Never on a path PREFIX: a path-scoped exclusion is as blind as a
    // path-scoped detector, and this repo has shipped that bug twice. A new shape
    // in an excluded file is still counted.
    // 31 + POD-1153's `HANDOFF_BUNDLE_CORE`, the shape both handoff format arms
    // spread. Bumping this number is the deliberate act the pin exists to force.
    // 32 -> 34: POD-381 moved sessions.create / sessions.resume's procedure inputs
    // out of `appRouter` onto their command contracts, so `createInput` and
    // `resumeInput` are excluded at their NEW address for the reason `appRouter`
    // already carried. Excluding them by their old container alone would have made
    // the audit's answer depend on which file the transport edge happens to live in.
    // 34 -> 36: POD-311 split the issue registry, extracting `createInput` and
    // `updateInput` out of `def({ input: z.object({ … }) })` in
    // apps/server/src/modules/issues/registry.ts and onto the L1 contracts. They are
    // the SAME field lists the registry always declared — anonymous expressions
    // there, which this detector cannot see, and named declarations now, which it
    // can. Naming a restatement is not creating one, and the ratchet is one-way, so
    // the alternative was a gate that punishes a migration for making an existing
    // restatement legible. (The same commit moved the session pair above to their
    // third address, in @podium/commands; that is a repoint, not a bump.)
    // 36 -> 38: POD-1076 added the two per-user PROJECTION OVERLAYS. That is a
    // bump for a shape the detector structurally cannot classify (a viewer-scoped
    // argument reads exactly like a field group), not for a new restatement — and
    // the change it accompanies REMOVED six real sites, ratcheting
    // `per-user-singletons` 8 -> 2.
    // 38 -> 39: POD-314 added `cloudSourceSessionInput`, and this is the SAME
    // class as the 34 -> 36 bump above rather than a new restatement. The
    // declaration did not change; its ADDRESS did, from an inline procedure input
    // in apps/server/src/router.ts — which this detector does not scan — to its
    // contract in packages/commands, which it does. That is POD-1180's phenomenon
    // pointing the other way: debt moving INTO view. Excluded as a cloud-egress
    // SOURCE ADDRESS (inventory §2.3 / §6.5 rule 2), the category the L1 transport
    // frames already occupy, and it owes §6.4 rule 1 as POD-308 wire work exactly
    // as they do. The accompanying change took `router-triple-access` 54 -> 6.
    expect(NOT_A_REPRESENTATION.length).toBe(39)
    for (const e of NOT_A_REPRESENTATION) {
      expect(e.file, e.symbol).toMatch(/^(apps|packages)\/.*\.tsx?$/)
      expect(e.symbol, e.file).toMatch(/^\w+$/)
      expect(e.reason.length, `${e.file}::${e.symbol}`).toBeGreaterThan(60)
    }
    const keys = NOT_A_REPRESENTATION.map((e) => `${e.file}::${e.symbol}`)
    expect(new Set(keys).size).toBe(keys.length)
  })
})
