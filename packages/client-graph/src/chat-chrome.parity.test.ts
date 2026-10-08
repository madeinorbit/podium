import { autorun } from 'mobx'
import { expect, it } from 'vitest'
import { createMobileSessionReader } from './mobile-session-context.before'
import { mobileSessionChromeIssue } from './mobile-session-chrome'
import { MobxPool } from './pool'

const issue = (id: string, title = 'Task', pinned = false) => ({
  kind: 'issue' as const,
  id,
  value: {
    id,
    repoId: 'repo',
    seq: id === 'shown' ? 7 : 8,
    repoPath: '/repo',
    title,
    description: '',
    stage: 'planning',
    pinned,
    archived: false,
    deps: [],
    labels: [],
    isDraftVessel: false,
    createdAt: '2026-10-01',
    updatedAt: '2026-10-01',
  } as never,
})
const answer = (row: any) =>
  row && typeof row !== 'symbol'
    ? {
        id: row.id,
        title: row.title,
        displayRef: row.displayRef,
        pinned: row.pinned,
        labels: [...row.labels],
        archived: row.archived,
        isDraftVessel: row.isDraftVessel,
      }
    : row

it('matches the old phone chrome answers without spreading the issue', () => {
  const pool = new MobxPool({ coarseNow: 0, selectedIssueId: null })
  pool.apply({
    type: 'replace',
    rows: [
      issue('shown'),
      issue('other'),
      {
        kind: 'worktree',
        id: '/repo',
        value: {
          path: '/repo',
          repoId: 'repo',
          repoPath: '/repo',
          repoName: 'Repo',
          prefix: 'POD',
        } as never,
      },
    ],
  })
  const before = createMobileSessionReader(pool)
  for (const id of [undefined, 'shown', 'other'])
    expect(answer(mobileSessionChromeIssue(pool, id))).toEqual(answer(before.chromeIssue(id)))
  pool.apply({ type: 'update', rows: [issue('shown', 'Renamed', true)] })
  expect(answer(mobileSessionChromeIssue(pool, 'shown'))).toEqual(
    answer(before.chromeIssue('shown')),
  )
  expect(() =>
    expect({ ...answer(mobileSessionChromeIssue(pool, 'shown')), title: 'wrong' }).toEqual(
      answer(before.chromeIssue('shown')),
    ),
  ).toThrow()
  pool.dispose()
})

it('routes visible title and pin changes to their leaf and ignores unrelated issue updates', () => {
  const pool = new MobxPool({ coarseNow: 0, selectedIssueId: null })
  pool.apply({ type: 'replace', rows: [issue('shown'), issue('other')] })
  const seen = { shell: 0, title: 0, pin: 0 }
  const stops = [
    autorun(() => {
      mobileSessionChromeIssue(pool, 'shown')
      seen.shell++
    }),
    autorun(() => {
      mobileSessionChromeIssue(pool, 'shown')?.title
      seen.title++
    }),
    autorun(() => {
      mobileSessionChromeIssue(pool, 'shown')?.pinned
      seen.pin++
    }),
  ]
  seen.shell = seen.title = seen.pin = 0
  pool.apply({ type: 'update', rows: [issue('other', 'Elsewhere')] })
  expect(seen).toEqual({ shell: 0, title: 0, pin: 0 })
  pool.apply({ type: 'update', rows: [issue('shown', 'New title')] })
  expect(seen.title).toBe(1)
  for (const stop of stops) stop()
  pool.dispose()
})
