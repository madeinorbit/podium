import { describe, expect, it } from 'vitest'
import type { AuditContext, SourceFile } from './rearch-audit'
import { stripComments } from './rearch-audit'
import {
  assertVocabularyLoaded,
  capabilitySnapshots,
  danglingRegistryEntries,
  ENTITY_SHAPE_THRESHOLD,
  entityShapedDeclarations,
  GENERIC_KEYS,
  instancePartitions,
  NOT_A_REPRESENTATION,
  perUserSingletons,
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
    expect(entityShapedDeclarations(ctxOf(RESTATED, 'packages/model/src/fields/session.ts'))).toEqual(
      [],
    )
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
      expect(capabilitySnapshots(ctxOf(planted)).map((s) => s.text), key).toEqual([
        `WhateverWeCallIt.${key}`,
      ])
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
      expect(instancePartitions(ctxOf(planted)).map((s) => s.text), key).toEqual([
        `WhateverWeCallIt.${key}`,
      ])
    }
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
      { symbol: 'RETAINED_REPRESENTATIONS', site: 'packages/model/src/representations/registry.ts' },
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
    expect(() =>
      assertVocabularyLoaded(new Set(['sessionId']), new Set(['issueId'])),
    ).not.toThrow()
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
    expect(NOT_A_REPRESENTATION.length).toBe(34)
    for (const e of NOT_A_REPRESENTATION) {
      expect(e.file, e.symbol).toMatch(/^(apps|packages)\/.*\.tsx?$/)
      expect(e.symbol, e.file).toMatch(/^\w+$/)
      expect(e.reason.length, `${e.file}::${e.symbol}`).toBeGreaterThan(60)
    }
    const keys = NOT_A_REPRESENTATION.map((e) => `${e.file}::${e.symbol}`)
    expect(new Set(keys).size).toBe(keys.length)
  })
})
