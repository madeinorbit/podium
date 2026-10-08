import { autorun } from 'mobx'
import { expect, it } from 'vitest'
import { insideReader, measureWork } from '../../../tests/worklist/harness/src/work-meter'
import { MobxPool } from './pool'
import type { RowRecord } from './shared/source'

it('shares first observed owner query registration with an existing identity reader', async () => {
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: 0 })
  pool.apply({ type: 'replace', rows: [{ kind: 'session', id: 'a', value: {
    sessionId: 'a', issueId: 'one', agentKind: 'codex', status: 'live', archived: false,
  } }] as RowRecord[] })
  let stop = () => {}
  const question = { kind: 'commandIssueSessions', issueId: 'one', archived: false, includeShells: true } as const
  const stopIds = autorun(() => { void pool.queries.ids(question) })
  try {
    const result = await measureWork(async () => {
      insideReader('registration', () => {
        stop = autorun(() => { void pool.queries.project(question, 'registration', id => id) })
      })
    }, { pool })
    console.info('[shared registration]', JSON.stringify(result.work))
    expect(result.work.rows).toBe(0)
    expect(result.work.elements).toBe(4)
  } finally { stop(); stopIds(); pool.dispose() }
})
