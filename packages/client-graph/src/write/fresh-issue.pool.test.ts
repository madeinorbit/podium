// @vitest-environment happy-dom
/**
 * A NEW ISSUE SHOWS AT ONCE WHERE THE USER LOOKS (POD-6400), through the real
 * pool over the real runtime: `records.create` paints the whole row before any
 * reply, under the repo this device holds at the create's path, with its number
 * pending (`PREFIX-…`, never `PREFIX-0`).
 *
 * The device is offline, so the create stays queued: the state "before the
 * server answers" for as long as the test looks.
 */

import type { RecordsApi } from '@podium/client-core/records'
import { isPendingIssueSeq, PENDING_ISSUE_NUMBER } from '@podium/protocol'
import { runInAction } from 'mobx'
import { expect, it } from 'vitest'
import { startScenarioEngine } from '../../../../tests/worklist/shared/src/scenarios'
import { here } from '../lookup'
import { createRuntimeWorklistPool } from '../runtime-pool'

const OFFLINE = { isOnline: () => false, onlineEvents: { add: () => {}, remove: () => {} } }

it('a new issue paints under its repo with a pending ref, before the server answers', async () => {
  const ctx = await startScenarioEngine(1, { network: OFFLINE })
  const handle = createRuntimeWorklistPool(ctx.engine)
  try {
    for (let turn = 0; turn < 32 && handle.pool.hydrate(); turn++) {}
    const { repoId, repoPath } = ctx.targets.newIssueRepo
    // The device holds exactly this repo at the path, so the guess is safe.
    const atPath = [...handle.pool.tables.repo].filter(
      ([, row]) => (row as { repoPath?: unknown }).repoPath === repoPath,
    )
    expect(atPath.map(([id]) => id)).toEqual([repoId])
    const prefix = (handle.pool.tables.repo.get(repoId) as { prefix?: string | null }).prefix

    const rejected: unknown[] = []
    handle.transactions.onRejected((r) => rejected.push(r))
    // The store's one generic write API, as the apps call it.
    const records = ctx.engine.commands.records
    const id = records.newId('issueProjection')
    await records.create('issueProjection', id, { title: 'Fresh', repoPath })
    // The pool's publication runs on a microtask; let it.
    await new Promise((resolve) => setTimeout(resolve, 0))

    runInAction(() => {
      const issue = here(handle.pool.model('issue', id)) as
        | { storedField(p: string): unknown; displayRef: string }
        | undefined
      expect(rejected, 'the queued create was not refused').toEqual([])
      expect(issue, 'the new issue is in the pool').toBeDefined()
      expect(issue?.storedField('title')).toBe('Fresh')
      expect(isPendingIssueSeq(Number(issue?.storedField('seq')))).toBe(true)
      // Under its repo, as the worklist and every ref reader join it.
      expect(handle.pool.relations.one('issue', id, 'repo')).toBe(repoId)
      expect(issue?.displayRef).toBe(
        prefix ? `${prefix}-${PENDING_ISSUE_NUMBER}` : `#${PENDING_ISSUE_NUMBER}`,
      )
      expect(issue?.displayRef).not.toMatch(/-0$/)
    })
  } finally {
    handle.dispose()
    ctx.dispose()
  }
}, 120_000)
