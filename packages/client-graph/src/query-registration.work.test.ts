import { autorun } from 'mobx'
import { expect, it, vi } from 'vitest'
import { insideReader, measureWork } from '../../../tests/worklist/harness/src/work-meter'
import { MobxPool } from './pool'
import type { RowRecord } from './shared/source'

it('shares observed owner registration without rereading the identity source at either corpus size', async () => {
  const work: number[] = []
  for (const size of [128, 512]) {
    const pool = new MobxPool({ selectedIssueId: null, coarseNow: 0 })
    pool.apply({
      type: 'replace',
      rows: ['a', ...Array.from({ length: size }, (_, i) => `other-${i}`)].map((id) => ({
        kind: 'session',
        id,
        value: {
          sessionId: id,
          issueId: id === 'a' ? 'one' : 'other',
          agentKind: 'codex',
          status: 'live',
          archived: false,
        },
      })) as RowRecord[],
    })
    const question = {
      kind: 'commandIssueSessions',
      issueId: 'one',
      archived: false,
      includeShells: true,
    } as const
    let stop = () => {}
    const stopIds = autorun(() => {
      expect(pool.queries.ids(question)).toEqual(['a'])
    })
    const sourceReads = vi.spyOn(pool.deviceIndex(), 'readerIds')
    let projected: readonly string[] = []
    try {
      const result = await measureWork(
        async () => {
          insideReader('registration', () => {
            stop = autorun(() => {
              projected = pool.queries.project(question, 'registration', (id) => id)
            })
          })
        },
        { pool },
      )
      expect(projected).toEqual(['a'])
      expect(sourceReads).not.toHaveBeenCalled()
      expect(result.work.rows).toBe(0)
      work.push(result.work.elements)
      // Arm the source probe with a different, populated question.
      expect(pool.queries.ids({ ...question, issueId: 'other' })).toHaveLength(size)
      expect(sourceReads).toHaveBeenCalled()
      console.info('[shared registration]', JSON.stringify({ size, ...result.work }))
    } finally {
      sourceReads.mockRestore()
      stop()
      stopIds()
      pool.dispose()
    }
  }
  expect(work[1]).toBe(work[0])
})
