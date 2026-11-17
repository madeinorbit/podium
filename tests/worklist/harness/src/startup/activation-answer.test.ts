import { MobxPool } from '@podium/client-graph/pool'
import { LOADING } from '@podium/client-graph/worklist/rollup'
import { describe, expect, it, vi } from 'vitest'
import { buildCorpusCell, type CorpusCell } from '../fixture'
import {
  ask,
  assertNoWrongNumber,
  checkNoWrongNumber,
  type StartupSetupFacts,
  startupQuestions,
} from './no-wrong-number'

const cells: CorpusCell[] = [
  { history: 1, active: 1 },
  { history: 10, active: 1 },
  { history: 1, active: 4 },
  { history: 10, active: 4 },
]

describe('setup answers on the two-axis startup corpus', () => {
  for (const cell of cells)
    it(`matches full truth or LOADING at h${cell.history}a${cell.active}`, () => {
      const corpus = buildCorpusCell(cell)
      const rows = corpus.sliceSessions.map((value) => ({
        kind: 'session' as const,
        id: value.sessionId,
        value,
      }))
      const control = new MobxPool({ selectedIssueId: null, coarseNow: corpus.fixedNow })
      const candidate = new MobxPool({ selectedIssueId: null, coarseNow: corpus.fixedNow })
      const facts: StartupSetupFacts = {
        loaded: true,
        setsUpServer: true,
        setupFinished: corpus.sessions.length > 0,
        setupInProgress: true,
        hasActivationCheckpoint: false,
        hasVpsCheckpoint: false,
      }
      let server: StartupSetupFacts | typeof LOADING = facts
      const questions = startupQuestions(
        { roots: [], parents: [], needles: [] },
        () => server,
      ).filter((question) => question.name.startsWith('first-screen:setup-'))
      try {
        control.apply({ type: 'replace', rows })
        const expected = ask(control, questions)
        expect(expected.get('first-screen:setup-eligible')).toBe(false)
        expect(expected.get('first-screen:setup-stale')).toBe(true)
        // No activation reader may count even the sessions this device does hold.
        vi.spyOn(candidate.queries, 'setupSessionCount').mockImplementation(() => {
          throw new Error('session count read')
        })
        for (const count of [0, 1, rows.length]) {
          candidate.apply({ type: 'replace', rows: rows.slice(0, count) })
          assertNoWrongNumber(checkNoWrongNumber(expected, ask(candidate, questions)))
        }
        server = LOADING
        const pending = checkNoWrongNumber(expected, ask(candidate, questions))
        assertNoWrongNumber(pending)
        expect(pending.loading).toHaveLength(4)
        // Armed: the formerly inferred "unfinished" on an empty device is wrong.
        server = { ...facts, setupFinished: false }
        expect(() =>
          assertNoWrongNumber(checkNoWrongNumber(expected, ask(candidate, questions))),
        ).toThrow(/wrong numbers/)
      } finally {
        control.dispose()
        candidate.dispose()
      }
    }, 120_000)
})
