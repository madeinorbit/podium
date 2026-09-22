/**
 * POD-4565 (Ma1) — every field the schema declares is readable on a model,
 * and reads the row it was fed. The test iterates `SCHEMA`, not a list of
 * its own: a field added to the schema is covered here with no edit, and a
 * field the models could not read fails.
 */

import { describe, expect, it } from 'vitest'
import { createReplaySource } from '../../../harness/src/count-harness'
import { buildCorpus } from '../../../harness/src/fixture/index'
import { fixedLocals } from '../../../shared/src/locals-source'
import { type EntityName, SCHEMA } from '../../../shared/src/schema'
import { mobxPoolArm } from './arm'
import { installMobxWarnTrap } from './mobx-trap'
import { FEED_SPELLING } from './models'
import { tracked } from './pool'
import { ENTITIES } from './tables'

installMobxWarnTrap()

describe('schema fields on models', () => {
  it('reads every declared field of every entity off a model, from the fed row', () => {
    const corpus = buildCorpus(1)
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
    const locals = fixedLocals({ selectedIssueId: null, coarseNow: corpus.fixedNow })
    const handle = mobxPoolArm.create(replay.source, locals.source)
    try {
      const { pool } = handle
      expect([...ENTITIES].sort()).toEqual((Object.keys(SCHEMA) as EntityName[]).sort())
      const covered: Record<string, number> = {}
      let checked = 0
      tracked(() => {
        for (const entity of ENTITIES) {
          const spec = SCHEMA[entity]
          const spelling = FEED_SPELLING[entity] ?? {}
          const rows = [...pool.tables[entity].entries()]
          expect(rows.length, `${entity}: the corpus feeds rows of every entity`).toBeGreaterThan(0)
          for (const [id, row] of rows) {
            const model = pool.model(entity, id) as unknown as Record<string, unknown>
            expect(model, `${entity}:${id}`).toBeDefined()
            for (const field of Object.keys(spec.fields)) {
              expect(field in model, `${entity}.${field} has no getter`).toBe(true)
              const want =
                field === spec.key ? id : (row as Record<string, unknown>)[spelling[field] ?? field]
              expect(model[field], `${entity}:${id}.${field}`).toBe(want)
              if (want !== undefined)
                covered[`${entity}.${field}`] = (covered[`${entity}.${field}`] ?? 0) + 1
              checked += 1
            }
          }
        }
      })
      // Not vacuous: every required (non-optional) field was seen with a value.
      for (const entity of ENTITIES) {
        for (const [field, spec] of Object.entries(SCHEMA[entity].fields)) {
          if (spec.optional === true) continue
          expect(
            covered[`${entity}.${field}`] ?? 0,
            `${entity}.${field} never had a value`,
          ).toBeGreaterThan(0)
        }
      }
      expect(checked).toBeGreaterThan(1000)
    } finally {
      handle.dispose()
      locals.dispose()
    }
  })
})
