/**
 * POD-4758 (A5) — typed relation navigation, derived from the declared
 * schema: by id (`shared/src/links.ts`), and as getters on the pool's one
 * object per row (`models.ts`).
 *
 * COMPILE TIME. `typeChecks` below is never called; it exists to be
 * typechecked. Each `// @ts-expect-error` is a negative control (a
 * misspelled relation, a collection read as a single one, a single one read
 * as a collection, a subset the collection does not declare, a row ref on a
 * relation not resolved from its row): if the types ever widen to accept
 * one, the directive is unused and
 * `bun run typecheck -- --filter @podium/worklist-proto` fails.
 *
 * RUN TIME. Over the live pool's fenced reader, every declared relation of
 * every row in memory answers through its typed link exactly as the reader
 * answers it by name, every declared subset included, and `refs` answers
 * exactly `relationRef`. The test walks `SCHEMA`, not a list of its own: a
 * relation added to the schema is covered with no edit.
 *
 * Off the objects, every relation of every row in memory is held to the
 * reader: a single relation is the target's object (the pool's one
 * instance), `LOADING` exactly while the target is cold, else null; a
 * collection's ready objects and loading count partition its members, and
 * every declared subset likewise. Then one lazy case end to end: a cold
 * parent reads `LOADING`, loads, and the same getter answers its object.
 */

import { autorun } from 'mobx'
import { describe, expect, it } from 'vitest'
import { createReplaySource } from '../../../harness/src/count-harness'
import { buildCorpus } from '../../../harness/src/fixture/index'
import { type RelationLinks, refs, relationLinks, relationRef } from '../../../shared/src/links'
import { settableLocals } from '../../../shared/src/locals-source'
import { type EntityName, SCHEMA } from '../../../shared/src/schema'
import { harnessMobxPoolArm, tracked } from '../../../harness/src/adapters/mobx-pool'
import { installMobxWarnTrap } from './mobx-trap'
import type { LazyCollection, ModelOf } from './models'
import { ENTITIES } from './tables'
import { LOADING } from './worklist/rollup'

const trap = installMobxWarnTrap()

// ------------------------------------------------------------ compile time

function typeChecks(links: RelationLinks): unknown[] {
  const repoId: string | null = links.issue.repo('x')
  const children: Iterable<string> = links.issue.children.ids('x')
  const spinOffs: number = links.issue.spinOffs.size('x')
  const lane: string | null = links.session.worktree('x')
  const unowned: Iterable<string> = links.worktree.sessions.issueless('x')
  const parentKey: string | null = refs.issue.parent({})
  // @ts-expect-error a misspelled relation does not compile
  const misspelled = links.issue.parnet('x')
  // @ts-expect-error a collection is not a single relation
  const single: string | null = links.issue.children('x')
  // @ts-expect-error a single relation has no member ids
  const ids = links.issue.parent.ids('x')
  // @ts-expect-error `issue.children` declares no subset
  const noSubset = links.issue.children.issueless('x')
  // @ts-expect-error a prefix relation is not resolved from its row
  const prefixRef = refs.session.worktree
  return [repoId, children, spinOffs, lane, unowned, parentKey].concat([
    misspelled,
    single,
    ids,
    noSubset,
    prefixRef,
  ])
}

function objectTypeChecks(
  issue: ModelOf['issue'],
  session: ModelOf['session'],
  worktree: ModelOf['worktree'],
): unknown[] {
  const parent: ModelOf['issue'] | typeof LOADING | null = issue.parent
  const repo: ModelOf['repo'] | null = issue.repo
  const lane: ModelOf['worktree'] | null = session.worktree
  const children: readonly ModelOf['issue'][] = issue.children.ready
  const loading: number = issue.sessions.loading
  const unowned: readonly ModelOf['session'][] = worktree.sessions.issueless.ready
  // @ts-expect-error a misspelled relation getter does not compile
  const misspelled = issue.parnet
  // @ts-expect-error a collection is not a single relation
  const single: ModelOf['issue'] | typeof LOADING | null = issue.children
  // @ts-expect-error a lazy relation can be loading
  const sure: ModelOf['issue'] | null = issue.parent
  // @ts-expect-error `issue.children` declares no subset
  const noSubset = issue.children.issueless
  return [parent, repo, lane, children, loading, unowned].concat([
    misspelled,
    single,
    sure,
    noSubset,
  ])
}

// Typechecked, never run.
void typeChecks
void objectTypeChecks

// ----------------------------------------------------------------- run time

const corpus = buildCorpus(1)

type Link = ((id: string) => unknown) & Record<string, (id: string) => unknown>
type Ref = (row: object) => string | null

function isCollection(entity: EntityName, relation: string): boolean {
  const spec = SCHEMA[entity].relations[relation]
  return spec?.kind === 'hasMany' || (spec?.kind === 'edge' && spec.direction === 'in')
}

describe('typed relation links (POD-4758)', () => {
  it('answer every declared relation and subset of every row as the reader does by name', () => {
    const replay = createReplaySource({
      issues: corpus.sliceIssues.map((value) => ({ kind: 'issue', id: value.id, value })),
      sessions: corpus.sliceSessions.map((value) => ({
        kind: 'session',
        id: value.sessionId,
        value,
      })),
      worktrees: corpus.sliceWorktrees.map((value) => ({
        kind: 'worktree',
        id: value.path,
        value,
      })),
    })
    const locals = settableLocals({ selectedIssueId: null, coarseNow: corpus.fixedNow })
    const handle = harnessMobxPoolArm.create(replay.source, locals.source)
    try {
      const { pool } = handle
      const links = relationLinks(pool.relations) as unknown as Record<string, Record<string, Link>>
      const rowRefs = refs as unknown as Record<string, Record<string, Ref>>
      const seen = { targets: 0, members: 0, subsetMembers: 0, refs: 0 }
      tracked(() => {
        for (const entity of ENTITIES) {
          for (const [id, row] of [...pool.tables[entity].entries()]) {
            for (const [name, spec] of Object.entries(SCHEMA[entity].relations)) {
              const link = links[entity]?.[name] as Link
              if (!isCollection(entity, name)) {
                const want = pool.relations.one(entity, id, name)
                expect(link(id), `${entity}:${id}.${name}`).toBe(want)
                if (want !== null) seen.targets += 1
                if (spec.kind !== 'prefix') {
                  const ref = rowRefs[entity]?.[name] as Ref
                  expect(ref(row as object)).toBe(relationRef(entity, name, row as object))
                  seen.refs += 1
                }
                continue
              }
              const want = [...pool.relations.many(entity, id, name)].sort()
              const got = [...(link['ids']?.(id) as Iterable<string>)].sort()
              expect(got, `${entity}:${id}.${name}`).toEqual(want)
              expect(link['size']?.(id)).toBe(want.length)
              seen.members += want.length
              if (spec.kind !== 'hasMany') continue
              for (const subset of Object.keys(spec.subsets ?? {})) {
                const members = [...pool.relations.subset(entity, id, name, subset)].sort()
                const read = [...(link[subset]?.(id) as Iterable<string>)].sort()
                expect(read, `${entity}:${id}.${name}.${subset}`).toEqual(members)
                seen.subsetMembers += members.length
              }
            }
          }
        }
      })
      // Not vacuous: every answer shape was seen.
      expect(seen.targets).toBeGreaterThan(100)
      expect(seen.members).toBeGreaterThan(100)
      expect(seen.subsetMembers).toBeGreaterThan(0)
      expect(seen.refs).toBeGreaterThan(100)
    } finally {
      handle.dispose()
      locals.dispose()
      expect(trap.warnings).toEqual([])
    }
  })
})

/** A pool over the corpus whose load window fires only when the test says. */
function lazyRig() {
  const replay = createReplaySource({
    issues: corpus.sliceIssues.map((value) => ({ kind: 'issue', id: value.id, value })),
    sessions: corpus.sliceSessions.map((value) => ({
      kind: 'session',
      id: value.sessionId,
      value,
    })),
    worktrees: corpus.sliceWorktrees.map((value) => ({ kind: 'worktree', id: value.path, value })),
  })
  const locals = settableLocals({ selectedIssueId: null, coarseNow: corpus.fixedNow })
  const due: (() => void)[] = []
  const handle = harnessMobxPoolArm.create(replay.source, locals.source, undefined, {
    schedule: (run) => {
      due.push(run)
      return () => {}
    },
  })
  return {
    pool: handle.pool,
    fire: () => {
      for (const run of due.splice(0)) run()
    },
    dispose: () => {
      handle.dispose()
      locals.dispose()
    },
  }
}

describe('relation getters on the objects (POD-4758)', () => {
  it('answer every declared relation of every row in memory as the relation reader does', () => {
    const r = lazyRig()
    try {
      const { pool } = r
      const seen = { objects: 0, loading: 0, none: 0, ready: 0, pending: 0, subsets: 0 }
      tracked(() => {
        for (const entity of ENTITIES) {
          for (const id of [...pool.tables[entity].keys()]) {
            const object = pool.model(entity, id) as unknown as Record<string, unknown>
            for (const [name, spec] of Object.entries(SCHEMA[entity].relations)) {
              expect(name in object, `${entity}.${name} has no getter`).toBe(true)
              const got = object[name]
              if (!isCollection(entity, name)) {
                // A known target with no row (an issue's own checkout, a
                // union root with no scanned lane) has no object: null.
                const target = pool.relations.one(entity, id, name)
                const where = target === null ? 'absent' : pool.resident(spec.to, target)
                const want =
                  where === 'resident'
                    ? pool.model(spec.to, target as string)
                    : where === 'loading'
                      ? LOADING
                      : null
                expect(got, `${entity}:${id}.${name}`).toBe(want)
                if (want === LOADING) seen.loading += 1
                else if (want === null) seen.none += 1
                else seen.objects += 1
                continue
              }
              const check = (read: () => Iterable<string>, members: LazyCollection<unknown>) => {
                const all = [...read()]
                const ids = members.ready.map((m) => (m as { id: string }).id).sort()
                const hot = all.filter((m) => pool.resident(spec.to, m) === 'resident').sort()
                const cold = all.filter((m) => pool.resident(spec.to, m) === 'loading')
                expect(ids, `${entity}:${id}.${name}`).toEqual(hot)
                expect(members.loading).toBe(cold.length)
                for (const m of members.ready) {
                  expect(m).toBe(pool.model(spec.to, (m as { id: string }).id))
                }
                seen.ready += ids.length
                seen.pending += members.loading
              }
              const members = got as LazyCollection<unknown> & Record<string, unknown>
              check(() => pool.relations.many(entity, id, name), members)
              if (spec.kind !== 'hasMany') continue
              for (const subset of Object.keys(spec.subsets ?? {})) {
                check(
                  () => pool.relations.subset(entity, id, name, subset),
                  members[subset] as LazyCollection<unknown>,
                )
                seen.subsets += 1
              }
            }
          }
        }
      })
      // Not vacuous: every answer shape was seen.
      expect(seen.objects).toBeGreaterThan(100)
      expect(seen.loading).toBeGreaterThan(0)
      expect(seen.none).toBeGreaterThan(0)
      expect(seen.ready).toBeGreaterThan(100)
      expect(seen.pending).toBeGreaterThan(0)
      expect(seen.subsets).toBeGreaterThan(0)
    } finally {
      r.dispose()
      expect(trap.warnings).toEqual([])
    }
  })

  it('a cold parent reads LOADING, loads, and then reads as its object', () => {
    const r = lazyRig()
    try {
      const { pool } = r
      const child = tracked(() =>
        [...pool.tables.issue.keys()].find((id) => {
          const parent = pool.relations.one('issue', id, 'parent')
          return parent !== null && pool.residency?.isCold('issue', parent) === true
        }),
      )
      expect(child).toBeDefined()
      const parentId = tracked(() => pool.relations.one('issue', child as string, 'parent'))
      const seen: unknown[] = []
      const watch = autorun(() => {
        const parent = pool.issue(child as string)?.parent
        seen.push(parent === LOADING ? 'loading' : parent?.id)
      })
      r.fire()
      watch()
      expect(seen).toEqual(['loading', parentId])
    } finally {
      r.dispose()
      expect(trap.warnings).toEqual([])
    }
  })
})
