import { here } from '@podium/client-graph/lookup'
/**
 * POD-4565 (Ma1) — every field the schema declares is readable on a model,
 * and reads the row it was fed. The test iterates `SCHEMA`, not a list of
 * its own: a field added to the schema is covered here with no edit, and a
 * field the models could not read fails.
 *
 * The issue's schema fields are stored facts, including its unmodified title.
 * Worklist labels and normalized ordering inputs belong to its companion;
 * their answers are checked against the independent legacy projection.
 * Repository paths are joined from the normalized companion, whose canonical
 * path can differ from an issue's historical checkout path in this corpus.
 */

import { issueDisplayTitle } from '@podium/client-core/values'
import { describe, expect, it } from 'vitest'
import { createReplaySource } from '../../../harness/src/count-harness'
import { buildCorpus } from '../../../harness/src/fixture/index'
import { runLegacyDerivation } from '../../../harness/src/oracle/index'
import { fixedLocals } from '@podium/client-graph/shared/locals-source'
import { FEED_SPELLING } from '@podium/client-graph/shared/repo-from-lane'
import { type EntityName, SCHEMA } from '@podium/client-graph/shared/schema'
import { harnessMobxPoolArm, tracked } from '../../../harness/src/adapters/mobx-pool'
import { IssueModel } from '@podium/client-graph/models'
import { MobxPool } from '@podium/client-graph/pool'
import type { RowRecord } from '@podium/client-graph/shared/source'
import { autorun } from 'mobx'
import { worklistView } from '@podium/client-graph/worklist/view-model'
import { installMobxWarnTrap } from '../../../harness/src/mobx-trap'
import { ENTITIES } from '@podium/client-graph/tables'

installMobxWarnTrap()

describe('schema fields on models', () => {
  it('answers document bodies as live text while preserving absent notes', () => {
    const pool = new MobxPool({ selectedIssueId: null, coarseNow: 0 })
    const row = (description: unknown, notes?: unknown): RowRecord => ({
      kind: 'issue', id: 'body', value: { id: 'body', description, notes },
    }) as RowRecord
    pool.apply({ type: 'replace', rows: [row({ value: 'Description' }, { value: 'Notes' })] })
    const issue = pool.issueObject('body')
    const answers: [string, string | undefined][] = []
    const stop = autorun(() => answers.push([issue.description, issue.notes]))
    try {
      expect(answers.at(-1)).toEqual(['Description', 'Notes'])
      tracked(() => {
        expect(issue.description.trim()).toBe('Description')
        // Raw documents stay in storage; every model reader gets the text answer.
        expect(issue.storedField('description')).toEqual({ value: 'Description' })
      })
      pool.apply({ type: 'update', rows: [row({ value: 'Updated' }, { value: '' })] })
      expect(answers.at(-1)).toEqual(['Updated', ''])
      pool.apply({ type: 'update', rows: [row('Legacy text', 'Legacy notes')] })
      expect(answers.at(-1)).toEqual(['Legacy text', 'Legacy notes'])
      pool.apply({ type: 'update', rows: [row(undefined)] })
      expect(answers.at(-1)).toEqual(['', undefined])
    } finally {
      stop()
      pool.dispose()
    }
  })

  it('reads every declared field of every entity off a model, from the fed row', () => {
    const corpus = buildCorpus(1)
    const projections = new Map<string, (typeof corpus.issueProjections)[number]>(
      corpus.issueProjections.map((issue) => [issue.id, issue]),
    )
    const repos = new Map(corpus.repoProjections.map((repo) => [String(repo.id), repo]))
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
    const handle = harnessMobxPoolArm.create({
      ...replay.source,
      companions: () => corpus.repoProjections.map((value) => ({
        kind: 'repo' as const, id: String(value.id), value,
      })),
    }, locals.source)
    try {
      const { pool } = handle
      expect([...ENTITIES].sort()).toEqual((Object.keys(SCHEMA) as EntityName[]).sort())
      const covered: Record<string, number> = {}
      let checked = 0
      let draftTitles = 0
      let joinedPaths = 0
      tracked(() => {
        for (const entity of ENTITIES) {
          const spec = SCHEMA[entity]
          const spelling = FEED_SPELLING[entity] ?? {}
          const rows = [...pool.tables[entity].entries()]
          expect(rows.length, `${entity}: the corpus feeds rows of every entity`).toBeGreaterThan(0)
          for (const [id, row] of rows) {
            const model = here(pool.model(entity, id)) as unknown as Record<string, unknown>
            expect(model, `${entity}:${id}`).toBeDefined()
            for (const field of Object.keys(spec.fields)) {
              expect(field in model, `${entity}.${field} has no getter`).toBe(true)
              const fed = row as Record<string, unknown>
              let want =
                field === spec.key ? id : fed[spelling[field] ?? field]
              if (entity === 'issue' && field === 'repoPath' && typeof fed['repoId'] === 'string') {
                const repo = repos.get(fed['repoId'])
                expect(repo, `${entity}:${id} has no repository companion`).toBeDefined()
                want = repo!.repoPath
                joinedPaths += 1
              }
              // Issue bodies are stored as documents; the model answers their text (IssueModel.answers).
              if (entity === 'issue' && IssueModel.answers.has(field)) {
                if (want === undefined && field === 'description') want = ''
                else if (want !== undefined && typeof want !== 'string') want = (want as { value?: string }).value ?? ''
              }
              expect(model[field], `${entity}:${id}.${field}`).toBe(want)
              if (want !== undefined)
                covered[`${entity}.${field}`] = (covered[`${entity}.${field}`] ?? 0) + 1
              checked += 1
            }
            if (entity === 'issue') {
              const issue = pool.issueObject(id), work = worklistView(pool).row(issue)
              expect(work.title, `${id} worklist title`).toBe(issue.inMemory ? titles.get(id) : '')
              expect(work.pinned).toBe(issue.pinned === true)
              expect(work.sortKey).toBe(issue.sortKey ?? null)
              if (issue.isDraftVessel === true) draftTitles += 1
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
      expect([...IssueModel.answers].sort(), 'only issue body text is answered by the model').toEqual(['description', 'notes'])
      expect(draftTitles, 'draft display titles were checked').toBeGreaterThan(0)
      expect(joinedPaths, 'normalized repository paths were checked').toBeGreaterThan(100)
      expect(corpus.sliceIssues.some((issue) =>
        typeof issue.repoId === 'string' && issue.repoPath !== repos.get(issue.repoId)?.repoPath,
      ), 'the corpus exercises a checkout path that differs from its repository').toBe(true)
    } finally {
      handle.dispose()
      locals.dispose()
    }
  })
})
