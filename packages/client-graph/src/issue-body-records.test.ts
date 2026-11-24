/**
 * An issue shows its brief and description from their own synced records
 * (POD-6921, design POD-6253 §2): `issueBrief` and `issueDescription`, keyed by
 * the issue id. Record-mapping fixtures explicitly declare fullDevice; the
 * painted-text control stays loaderless and incomplete. Loading is covered
 * by `body-relations.test.ts`. No body store.
 */
import { autorun, runInAction } from 'mobx'
import { expect, it } from 'vitest'
import { fullDevice } from './full-device-fixture'
import type { LOADING } from './loading'
import { requireHere } from './lookup'
import { MobxPool } from './pool'

const stamp = '2026-11-13T00:00:00Z'
const task = (extra: Record<string, unknown> = {}) => ({
  kind: 'issue' as const,
  id: 'issue',
  value: {
    id: 'issue',
    seq: 1,
    title: 'Task',
    stage: 'in_progress',
    audience: 'human',
    repoPath: '/fixture',
    createdAt: stamp,
    updatedAt: stamp,
    ...extra,
  },
})
const brief = (text: string | undefined) => ({
  kind: 'issueBrief' as const,
  id: 'issue',
  value: text === undefined ? undefined : { id: 'issue', text },
})
const description = (text: string | undefined) => ({
  kind: 'issueDescription' as const,
  id: 'issue',
  value: text === undefined ? undefined : { id: 'issue', text },
})

it('shows the brief and description from their records, and follows each change', () => {
  const pool = fullDevice(new MobxPool({ selectedIssueId: null, coarseNow: Date.parse(stamp) }))
  pool.apply({
    type: 'replace',
    rows: [task(), brief('Agent brief'), description('Human summary')],
  })
  const issue = requireHere(pool.model('issue', 'issue'))
  const seen: {
    brief: string | undefined | typeof LOADING
    description: string | typeof LOADING
  }[] = []
  const stop = autorun(() => seen.push({ brief: issue.brief, description: issue.description }))
  try {
    expect(issue.brief).toBe('Agent brief')
    expect(issue.description).toBe('Human summary')
    // The record model is the one the issue reads.
    expect(requireHere(pool.model('issueBrief', 'issue')).text).toBe('Agent brief')

    runInAction(() => pool.apply({ type: 'update', rows: [description('Edited summary')] }))
    expect(issue.description).toBe('Edited summary')
    expect(issue.brief).toBe('Agent brief')

    // A removed record is a field with no text.
    runInAction(() => pool.apply({ type: 'update', rows: [brief(undefined)] }))
    expect(issue.brief).toBeUndefined()
    runInAction(() => pool.apply({ type: 'update', rows: [description(undefined)] }))
    expect(issue.description).toBe('')

    expect(seen.at(-1)).toEqual({ brief: undefined, description: '' })
  } finally {
    stop()
    pool.dispose()
  }
})

it('has no brief or description when the issue has no body records', () => {
  const pool = fullDevice(new MobxPool({ selectedIssueId: null, coarseNow: Date.parse(stamp) }))
  pool.apply({ type: 'replace', rows: [task()] })
  const issue = requireHere(pool.model('issue', 'issue'))
  expect(issue.brief).toBeUndefined()
  expect(issue.description).toBe('')
  pool.dispose()
})

it('keeps the bodies of one issue off another', () => {
  const pool = fullDevice(new MobxPool({ selectedIssueId: null, coarseNow: Date.parse(stamp) }))
  const other = { ...task(), id: 'other', value: { ...task().value, id: 'other', seq: 2 } }
  pool.apply({
    type: 'replace',
    rows: [task(), other, brief('Only mine'), description('Mine too')],
  })
  const mine = requireHere(pool.model('issue', 'issue'))
  const theirs = requireHere(pool.model('issue', 'other'))
  expect(mine.brief).toBe('Only mine')
  expect(theirs.brief).toBeUndefined()
  expect(theirs.description).toBe('')
  pool.dispose()
})

it('prefers a text painted on the row (a launch, a fixture) over the record', () => {
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.parse(stamp) })
  pool.apply({
    type: 'replace',
    rows: [
      task({ brief: 'Painted brief', description: { value: 'Painted summary' } }),
      brief('Synced brief'),
      description('Synced summary'),
    ],
  })
  const issue = requireHere(pool.model('issue', 'issue'))
  expect(issue.brief).toBe('Painted brief')
  expect(issue.description).toBe('Painted summary')
  pool.dispose()
})
