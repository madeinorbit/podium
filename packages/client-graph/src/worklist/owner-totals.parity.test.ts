import { describe, expect, it, vi } from 'vitest'
import { MobxPool } from '../pool'
import type { SliceSession } from '../shared/slice-types'
import { LOADING, motionPhase, roleVerdictOf, seatVerdictOf } from './rollup'
import { roleWaiting, roleWorking, sidebarSessionFacts } from './sidebar-row'
import { worklistView } from './view-model'

const stamp = '2026-10-09T07:00:00Z'
const lane = '/synthetic/lane'
const session = (id: string, patch: object = {}) =>
  ({
    sessionId: id,
    cwd: lane,
    agentKind: 'codex',
    status: 'live',
    archived: false,
    createdAt: stamp,
    lastActiveAt: stamp,
    agentState: { phase: 'idle', since: stamp, idle: { kind: 'done' }, workingMsTotal: 42 },
    ...patch,
  }) as SliceSession
const fixtures = [
  session('done'),
  session('working', { agentState: { phase: 'working', since: stamp, workingMsTotal: 10 } }),
  session('waiting', { agentState: { phase: 'needs_user', since: stamp } }),
  session('offer', { offer: { createdAt: '2026-10-09T06:00:00Z' } }),
  session('archived', { archived: true }),
  session('headless', { headless: true }),
  session('parked', {
    status: 'hibernated',
    agentState: { phase: 'working', nativeSubagentCount: 3 },
  }),
  session('errored', { agentState: { phase: 'errored', since: stamp, error: { class: 'auth' } } }),
  session('exited', { status: 'exited', agentState: { phase: 'errored', since: stamp } }),
  session('unknown', { agentState: undefined }),
  session('invalid-stamp', { lastActiveAt: 'invalid', agentState: undefined }),
  session('zero-total', { agentState: { phase: 'ended', since: stamp, workingMsTotal: 0 } }),
]
const candidate = <T>(value: T): T | string =>
  process.env.POD5651_MUTATE === '1' ? '__wrong_answer__' : value

describe('shared session facts equal the old verdict on identical records', () => {
  for (const row of fixtures)
    it(row.sessionId, () => {
      const pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.parse(stamp) })
      pool.apply({
        type: 'replace',
        rows: [{ kind: 'session', id: row.sessionId, value: row as never }],
      })
      const model = pool.sessionObject(row.sessionId)
      try {
        const actual = {
          fleet: model.fleet,
          working: model.workingTimer,
          waitingOpen: model.motion === 'waiting' ? model.waitingTimer : undefined,
          waitingFinished: motionPhase(row, true) === 'waiting' ? model.waitingTimer : undefined,
          // The delegate role's timers and error class (POD-2171), from the shared seat derivation.
          workingDelegated: roleWorking(
            roleVerdictOf(model.delegateSeat, model.stateSinceMs),
            model.workingMsTotal,
          ),
          waitingDelegated: roleWaiting(roleVerdictOf(model.delegateSeat, model.stateSinceMs)),
          errorClassDelegated: model.delegateSeat.errorClass ?? undefined,
          doneSince: model.doneSinceMs,
          totalMs: model.workingMsTotal,
          errorClass: model.errorClass,
          allUnstarted: model.unstarted,
        }
        // Undefined optional keys compare the same through toEqual.
        expect(candidate(actual)).toEqual(sidebarSessionFacts(row))
        expect(model.unread).toEqual(row.unread)
      } finally {
        pool.dispose()
      }
    })
})

// Frozen old answers stay callable after the production companion forwards
// to the shared model. In particular, finished rows suppress only offer asks.
it('finished and unfinished issue verdicts preserve attention and timestamps', () => {
  for (const row of fixtures) {
    const pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.parse(stamp) })
    pool.apply({
      type: 'replace',
      rows: [{ kind: 'session', id: row.sessionId, value: row as never }],
    })
    try {
      const verdict = worklistView(pool).session(pool.sessionObject(row.sessionId)).verdict
      expect(candidate(verdict)).toEqual(seatVerdictOf(row))
    } finally {
      pool.dispose()
    }
  }
})
