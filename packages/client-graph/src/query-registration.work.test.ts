import { autorun } from 'mobx'
import { it } from 'vitest'
import { insideReader, measureWork } from '../../../tests/worklist/harness/src/work-meter'
import { MobxPool } from './pool'
import type { RowRecord } from './shared/source'

it('traces first observed owner query registration', async () => {
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: 0 })
  pool.apply({ type: 'replace', rows: [{ kind: 'session', id: 'a', value: {
    sessionId: 'a', issueId: 'one', agentKind: 'codex', status: 'live', archived: false,
  } }] as RowRecord[] })
  let stop = () => {}
  try {
    const result = await measureWork(async () => {
      insideReader('registration', () => {
        stop = autorun(() => { void pool.queries.project({ kind: 'commandIssueSessions', issueId: 'one',
          archived: false, includeShells: true }, 'registration', id => id) })
      })
    }, { trace: true, pool })
    console.info(JSON.stringify({ work: result.work, sites: [...result.sites!] }))
  } finally { stop(); pool.dispose() }
})
