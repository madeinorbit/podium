/**
 * POD-4565 (Ma1) — every field the schema declares is readable on a model,
 * and reads the row it was fed. The test iterates `SCHEMA`, not a list of
 * its own: a field added to the schema is covered here with no edit, and a
 * field the models could not read fails.
 *
 * POD-4756: the issue implements `RowView`, and five of its schema fields
 * are the row's too (`IssueModel.answers`: `title`, `seq`, `createdAt`,
 * `pinned`, `sortKey`). Those read the row's value: the display title (the
 * fed title for a non-draft in memory; a draft's name is checked against
 * the independent legacy projection), and the flags
 * normalized (`pinned` a boolean, `sortKey` null when absent). Checked here
 * against the fed row by those rules.
 */

import { issueDisplayTitle } from '@podium/client-core/viewmodels'
import { describe, expect, it } from 'vitest'
import { createReplaySource } from '../../../harness/src/count-harness'
import { buildCorpus } from '../../../harness/src/fixture/index'
import { runLegacyDerivation } from '../../../harness/src/oracle/index'
import { fixedLocals } from '@podium/client-graph/shared/locals-source'
import { FEED_SPELLING } from '@podium/client-graph/shared/repo-from-lane'
import { type EntityName, SCHEMA } from '@podium/client-graph/shared/schema'
import { harnessMobxPoolArm, tracked } from '../../../harness/src/adapters/mobx-pool'
import { IssueModel } from '@podium/client-graph/models'
import { installMobxWarnTrap } from '../../../harness/src/mobx-trap'
import { ENTITIES } from '@podium/client-graph/tables'

installMobxWarnTrap()

describe('schema fields on models', () => {
  it('reads every declared field of every entity off a model, from the fed row', () => {
    const corpus = buildCorpus(1)
    const projections = new Map<string, (typeof corpus.issueProjections)[number]>(
      corpus.issueProjections.map((issue) => [issue.id, issue]),
    )
    const replay = createReplaySource({
      // SliceIssue is the worklist payload. The schema test also feeds the
      // normalized projection's required fields (priority, type, labels).
      issues: corpus.sliceIssues.map((value) => ({
        kind: 'issue', id: value.id, value: { ...projections.get(value.id), ...value },
      })),
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
    const legacy = runLegacyDerivation(corpus, locals.source.get())
    const titles = new Map<string, string>(legacy.models.map((issue) => [
      issue.id, issueDisplayTitle(issue, legacy.sessions, legacy.allWorktreePaths),
    ]))
    expect(titles.get('i1405'), 'the draft-title contract regression').toBe('New Codex session')
    const handle = harnessMobxPoolArm.create(replay.source, locals.source)
    try {
      const { pool } = handle
      expect([...ENTITIES].sort()).toEqual((Object.keys(SCHEMA) as EntityName[]).sort())
      const covered: Record<string, number> = {}
      let checked = 0
      let answered = 0
      let draftTitles = 0
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
              const fed = row as Record<string, unknown>
              let want =
                field === spec.key ? id : fed[spelling[field] ?? field]
              if (entity === 'issue' && IssueModel.answers.has(field)) {
                if (field === 'pinned') want = want === true
                else if (field === 'sortKey') want = want ?? null
                else if (field === 'title') {
                  // Check the display projection for every title, including
                  // drafts and cold rows, rather than skipping either field.
                  if (model['inMemory'] !== true) want = ''
                  else {
                    want = titles.get(id)
                    expect(want, `${entity}:${id} has no legacy title`).toBeDefined()
                    if (fed['isDraftVessel'] === true) draftTitles += 1
                  }
                }
                answered += 1
              }
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
      expect(answered, 'the row-answered fields were checked').toBeGreaterThan(100)
      expect(draftTitles, 'draft display titles were checked').toBeGreaterThan(0)
    } finally {
      handle.dispose()
      locals.dispose()
    }
  })
})
