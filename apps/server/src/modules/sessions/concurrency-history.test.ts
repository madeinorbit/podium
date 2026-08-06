import { type AgentRuntimeState, asSessionId } from '@podium/model'
import { describe, expect, it } from 'vitest'
import type { PodiumEventRecord } from '../../store/events'
import { EventBus } from '../bus'
import {
  AGENT_CONCURRENCY_BUCKET_MS,
  AGENT_CONCURRENCY_BUCKETS,
  AGENT_CONCURRENCY_EVENT,
  AgentConcurrencyHistory,
  buildAgentConcurrencyHistory,
} from './concurrency-history'

const NOW = Date.parse('2026-08-06T18:00:00.000Z')

function event(at: number, count: number, id = 1): PodiumEventRecord {
  return {
    id,
    ts: new Date(at).toISOString(),
    kind: AGENT_CONCURRENCY_EVENT,
    subject: 'fleet',
    repoPath: null,
    payload: { count },
  }
}

function state(phase: AgentRuntimeState['phase']): AgentRuntimeState {
  return { phase, since: new Date(NOW).toISOString(), nativeSubagentCount: 0 }
}

describe('buildAgentConcurrencyHistory', () => {
  it('carries the pre-window count through 24 half-hour samples', () => {
    const start = NOW - AGENT_CONCURRENCY_BUCKET_MS * AGENT_CONCURRENCY_BUCKETS
    const history = buildAgentConcurrencyHistory(
      [
        event(start - 60_000, 2),
        event(start + AGENT_CONCURRENCY_BUCKET_MS * 1.5, 5, 2),
        event(NOW - AGENT_CONCURRENCY_BUCKET_MS / 2, 1, 3),
      ],
      NOW,
    )

    expect(history.buckets).toHaveLength(24)
    expect(history.buckets.slice(0, 1).map((bucket) => bucket.count)).toEqual([2])
    expect(history.buckets[1]?.count).toBe(5)
    // Five agents were still working when the current half hour began, so its
    // peak stays at five even though the live count later dropped to one.
    expect(history.buckets.at(-1)?.count).toBe(5)
    expect(history.peak).toBe(5)
    expect(history.sampledAt).toBe('2026-08-06T18:00:00.000Z')
  })

  it('ignores malformed and future rows', () => {
    const malformed = { ...event(NOW - 1_000, 3), payload: { count: -1 } }
    const future = event(NOW + 1_000, 9, 2)
    const history = buildAgentConcurrencyHistory([malformed, future], NOW)
    expect(history.peak).toBe(0)
  })
})

describe('AgentConcurrencyHistory', () => {
  it('records only changes to the working/compacting fleet count', () => {
    const bus = new EventBus()
    const sessions: Array<{ agentState: AgentRuntimeState | undefined }> = []
    const rows: PodiumEventRecord[] = []
    const events = {
      appendEvent(
        input: Omit<PodiumEventRecord, 'id' | 'repoPath'> & { repoPath?: string | null },
      ) {
        rows.push({ id: rows.length + 1, repoPath: input.repoPath ?? null, ...input })
        return rows.length
      },
      listKindSinceWithPrior: () => rows,
    }
    const history = new AgentConcurrencyHistory({
      sessions: () => sessions,
      events,
      bus,
      now: () => NOW,
    })
    const sessionId = asSessionId('s1')

    const session = { agentState: state('working') }
    sessions.push(session)
    bus.emit('session.stateChanged', {
      sessionId,
      prev: undefined,
      next: session.agentState,
    })
    session.agentState = state('compacting')
    bus.emit('session.stateChanged', {
      sessionId,
      prev: state('working'),
      next: session.agentState,
    })
    session.agentState = state('idle')
    bus.emit('session.stateChanged', {
      sessionId,
      prev: state('compacting'),
      next: session.agentState,
    })

    expect(rows.map((row) => row.payload)).toEqual([{ count: 1 }, { count: 0 }])
    // The current sentence is zero, while the current half-hour bucket keeps
    // the brief one-agent burst visible as its peak.
    expect(history.history().buckets.at(-1)?.count).toBe(1)
    expect(rows).toHaveLength(2)
    history.dispose()
  })
})
