import { type AgentRuntimeState, asSessionId } from '@podium/model'
import { describe, expect, it } from 'vitest'
import type { PodiumEventRecord } from '../../store/events'
import { EventBus } from '../bus'
import {
  SESSION_ACTIVITY_WINDOW_MS,
  SESSION_PHASE_EVENT,
  SessionActivityHistory,
} from './activity-history'

const NOW = Date.parse('2026-08-31T12:00:00.000Z')

function state(phase: AgentRuntimeState['phase']): AgentRuntimeState {
  return { phase, since: new Date(NOW).toISOString(), nativeSubagentCount: 0 }
}

function rig(clock: { now: number } = { now: NOW }): {
  bus: EventBus
  rows: PodiumEventRecord[]
  history: SessionActivityHistory
} {
  const bus = new EventBus()
  const rows: PodiumEventRecord[] = []
  const events = {
    appendEvent(input: Omit<PodiumEventRecord, 'id' | 'repoPath'> & { repoPath?: string | null }) {
      rows.push({ id: rows.length + 1, repoPath: input.repoPath ?? null, ...input })
      return rows.length
    },
    listKindSubjectSinceWithPrior(kind: string, subject: string, since: string) {
      const inWindow = rows.filter(
        (row) => row.kind === kind && row.subject === subject && row.ts >= since,
      )
      const prior = rows
        .filter((row) => row.kind === kind && row.subject === subject && row.ts < since)
        .at(-1)
      return [...(prior ? [prior] : []), ...inWindow]
    },
  }
  return { bus, rows, history: new SessionActivityHistory({ events, bus, now: () => clock.now }) }
}

describe('SessionActivityHistory', () => {
  it('records real phase flips and deduplicates same-phase refreshes', () => {
    const { bus, rows, history } = rig()
    const sessionId = asSessionId('s1')

    bus.emit('session.stateChanged', { sessionId, prev: undefined, next: state('working') })
    // A poll re-asserting the current phase is not a transition.
    bus.emit('session.stateChanged', { sessionId, prev: state('working'), next: state('working') })
    bus.emit('session.stateChanged', {
      sessionId,
      prev: state('working'),
      next: state('needs_user'),
    })
    bus.emit('session.stateChanged', {
      sessionId,
      prev: state('needs_user'),
      next: state('working'),
    })

    expect(
      rows.map((row) => [row.kind, row.subject, (row.payload as { phase: string }).phase]),
    ).toEqual([
      [SESSION_PHASE_EVENT, 's1', 'working'],
      [SESSION_PHASE_EVENT, 's1', 'needs_user'],
      [SESSION_PHASE_EVENT, 's1', 'working'],
    ])
    history.dispose()
  })

  it('closes a dying session with an ended sample even without a state event', () => {
    const { bus, rows, history } = rig()
    const sessionId = asSessionId('s1')
    bus.emit('session.stateChanged', { sessionId, prev: undefined, next: state('working') })
    bus.emit('session.exited', { sessionId, code: 1 })
    // A second exit report changes nothing.
    bus.emit('session.exited', { sessionId, code: 1 })

    expect(rows.map((row) => (row.payload as { phase: string }).phase)).toEqual([
      'working',
      'ended',
    ])
    history.dispose()
  })

  it('answers per session, omitting sessions with no recorded history', () => {
    const { bus, history } = rig()
    bus.emit('session.stateChanged', {
      sessionId: asSessionId('s1'),
      prev: undefined,
      next: state('working'),
    })

    const result = history.history([asSessionId('s1'), asSessionId('unknown')])
    expect(Object.keys(result.sessions)).toEqual(['s1'])
    expect(result.sessions.s1).toEqual([{ at: new Date(NOW).toISOString(), phase: 'working' }])
    expect(result.sampledAt).toBe(new Date(NOW).toISOString())
    history.dispose()
  })

  it('carries the pre-window phase in as the first sample', () => {
    const clock = { now: NOW - SESSION_ACTIVITY_WINDOW_MS - 60_000 }
    const { bus, history } = rig(clock)
    const sessionId = asSessionId('s1')
    bus.emit('session.stateChanged', { sessionId, prev: undefined, next: state('working') })
    clock.now = NOW
    bus.emit('session.stateChanged', { sessionId, prev: state('working'), next: state('idle') })

    const samples = history.history([sessionId]).sessions.s1
    expect(samples?.map((sample) => sample.phase)).toEqual(['working', 'idle'])
    history.dispose()
  })
})
