/**
 * POD-4758 (A5) — typed relation navigation by id (`shared/src/links.ts`),
 * derived from the declared schema.
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
 * The model getters (`issue.parent` as an object or `LOADING`) land after
 * POD-4755, on its one-object model (draft: branch `draft/4758-full`).
 */

import { describe, expect, it } from 'vitest'
import { createReplaySource } from '../../../harness/src/count-harness'
import { buildCorpus } from '../../../harness/src/fixture/index'
import { type RelationLinks, refs, relationLinks, relationRef } from '../../../shared/src/links'
import { settableLocals } from '../../../shared/src/locals-source'
import { type EntityName, SCHEMA } from '../../../shared/src/schema'
import { mobxPoolArm } from './arm'
import { installMobxWarnTrap } from './mobx-trap'
import { tracked } from './pool'
import { ENTITIES } from './tables'

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

// Typechecked, never run.
void typeChecks

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
    const handle = mobxPoolArm.create(replay.source, locals.source)
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
