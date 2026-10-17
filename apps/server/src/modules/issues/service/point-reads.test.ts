/**
 * Single-issue reads answer from the database (POD-6190, part of POD-6158;
 * design §7 step 3.2).
 *
 * This file pins the point reads (row, liveRow, rowsByIds, the viewer's
 * markers, resolveRef and resolveRefs) over edge fixtures: deleted, archived
 * and quarantined rows, nested parents, labels, deps, legacy rows without a
 * repository id, ambiguous and unknown references. Until POD-6158 removed the
 * issue map, these reads were also compared with it.
 */

import { asIssueId, firstAdminMemberId } from '@podium/model'
import { afterEach, describe, expect, it } from 'vitest'
import type { SessionStore } from '../../../store'
import { type CorpusIssue, rawSql, rowOf, seededStore } from '../../../test-support/issue-corpus'
import { IssueStore } from './core'
import type { IssueDeps } from './types'

const stores: SessionStore[] = []
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close()
})

describe('issue point reads over the database', () => {
  it('over the edge fixtures', async () => {
    const live = (seq: number, patch: Partial<CorpusIssue> = {}): CorpusIssue => ({
      id: `iss_${seq}`, seq, repoPath: '/a', worktreePath: null, parentId: null, stage: 'backlog',
      archived: false, deletedAt: null, ...patch,
    })
    const rows: CorpusIssue[] = [
      live(1),
      live(2, { parentId: 'iss_1' }),
      live(3, { parentId: 'iss_2', worktreePath: '/a/.worktrees/issue-3' }),
      live(4, { deletedAt: '2026-10-01T00:00:00.000Z' }),
      live(5, { archived: true, stage: 'done' }),
      // The same numbers in a second repository: bare `#N` is ambiguous.
      live(1, { id: 'iss_b1', repoPath: '/b' }),
      live(4, { id: 'iss_b4', repoPath: '/b', deletedAt: '2026-10-01T00:00:00.000Z' }),
      // Legacy rows (no repository id) under the same paths.
      live(6, { id: 'iss_legacy_a' }),
      live(7, { id: 'iss_legacy_b', repoPath: '/b' }),
    ]
    const store = await seededStore(rows, ['/a', '/b'], [
      { fromId: 'iss_2', toId: 'iss_1', type: 'blocked-by' },
      { fromId: 'iss_3', toId: 'iss_4', type: 'related' },
    ])
    stores.push(store)
    await store.issues.setIssueLabels(asIssueId('iss_1'), ['one', 'two'])
    const viewer = await firstAdminMemberId(store)
    await store.issues.setIssueUserState(viewer, asIssueId('iss_1'), { readAt: '2026-10-01T00:00:00.000Z' })
    await store.issues.setIssueUserState(viewer, asIssueId('iss_4'), { pinnedAt: '2026-10-01T00:00:00.000Z' })
    rawSql(store, 'UPDATE issues SET repo_id = NULL WHERE id IN (?, ?)', 'iss_legacy_a', 'iss_legacy_b')
    // Quarantined: SQLite allows a NULL in a TEXT primary key, and the boot
    // load skips such a row (issues.boot-quarantine.test.ts); so do the reads.
    await store.issues.upsertIssue(rowOf(live(8, { id: 'iss_corrupt' }), '/a', store.hostMachineId))
    rawSql(store, 'UPDATE issues SET id = NULL WHERE id = ?', 'iss_corrupt')
    const issues = new IssueStore({ store } as IssueDeps)

    // Rows by id: deleted rows included, unknown ids absent.
    expect((await issues.row('iss_4'))?.deletedAt).toBe('2026-10-01T00:00:00.000Z')
    expect((await issues.liveRow('iss_4'))?.id).toBe('iss_4')
    expect(await issues.row('iss_missing')).toBeUndefined()
    expect(await issues.liveRow('iss_missing')).toBeUndefined()
    expect([...(await issues.rowsByIds(['iss_1', 'iss_b4', 'iss_missing'])).keys()].sort()).toEqual(['iss_1', 'iss_b4'])

    // The viewer's markers.
    expect(await issues.issueUserState(asIssueId('iss_1'))).toEqual({ readAt: '2026-10-01T00:00:00.000Z', tuckedAt: null, pinnedAt: null })
    expect(await issues.issueUserState(asIssueId('iss_4'))).toEqual({ readAt: null, tuckedAt: null, pinnedAt: '2026-10-01T00:00:00.000Z' })
    expect(await issues.issueUserState(asIssueId('iss_2'))).toBeUndefined()

    // References.
    await expect(issues.resolveRef('#1')).rejects.toThrow(/ambiguous issue ref #1/)
    expect(await issues.resolveRef('#1', '/b')).toBe('iss_b1')
    expect(await issues.resolveRef('#2')).toBe('iss_2')
    expect(await issues.resolveRef('/b#1')).toBe('iss_b1')
    expect(await issues.resolveRef('AB-4')).toBe('iss_b4')
    expect(await issues.resolveRef('AA-6')).toBe('iss_legacy_a')
    expect(await issues.resolveRef('AB-7')).toBe('iss_legacy_b')
    // An unresolvable reference comes back unchanged, the quarantined row's too.
    expect(await issues.resolveRef('iss_missing')).toBe('iss_missing')
    expect(await issues.resolveRef('garbage')).toBe('garbage')
    expect(await issues.resolveRef('AA-8')).toBe('AA-8')
    expect(await issues.resolveRefs(['#1', '#2', 'AB-4', 'AA-8', 'ZZ-1', 'garbage'])).toEqual([
      { ref: '#1', id: null },
      { ref: '#2', id: 'iss_2' },
      { ref: 'AB-4', id: 'iss_b4' },
      { ref: 'AA-8', id: null },
      { ref: 'ZZ-1', id: null },
      { ref: 'garbage', id: null },
    ])
  })
})
