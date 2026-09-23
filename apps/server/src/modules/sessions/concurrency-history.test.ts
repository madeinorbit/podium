import { type AgentRuntimeState, asSessionId } from '@podium/model'
import type { SqlDatabase } from '@podium/runtime/sqlite'
import { describe, expect, it } from 'vitest'
import type { SessionStore } from '../../store'
import type { PodiumEventRecord } from '../../store/events'
import { probeStatements, type StatementProbeHolder } from '../../store/executor/statement-probe'
import { openTestStore } from '../../test-support/open-test-store'
import { EventBus } from '../bus'
import {
  AGENT_CONCURRENCY_BUCKET_MS,
  AGENT_CONCURRENCY_BUCKETS,
  AGENT_CONCURRENCY_EVENT,
  AgentConcurrencyHistory,
  buildAgentConcurrencyHistory,
  workingAgentCount,
} from './concurrency-history'
import type { Session } from './session'

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

interface FakeSession {
  status: Session['status']
  archived: boolean
  lastActiveAt: string
  /** Non-optional so these rows can also stand in as a `stateChanged` payload's
   *  `next`, which is always a state. */
  agentState: AgentRuntimeState
}

function live(phase: AgentRuntimeState['phase']): FakeSession {
  return {
    status: 'live',
    archived: false,
    lastActiveAt: new Date(NOW).toISOString(),
    agentState: state(phase),
  }
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
  it('records only changes to the working/compacting fleet count', async () => {
    const bus = new EventBus()
    const sessions: FakeSession[] = []
    const rows: PodiumEventRecord[] = []
    const events = {
      async appendEvent(
        input: Omit<PodiumEventRecord, 'id' | 'repoPath'> & { repoPath?: string | null },
      ) {
        rows.push({ id: rows.length + 1, repoPath: input.repoPath ?? null, ...input })
        return rows.length
      },
      listKindSubjectSinceWithPrior: async () => rows,
      listEventsSince: async () => [],
    }
    const history = new AgentConcurrencyHistory({
      sessions: () => sessions,
      events,
      bus,
      now: () => NOW,
    })
    const sessionId = asSessionId('s1')

    const session = live('working')
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
    expect((await history.history()).buckets.at(-1)?.count).toBe(1)
    expect(rows).toHaveLength(2)
    history.dispose()
  })

  /** POD-730: the registry keeps every session it ever saw, and their last
   *  observed phase is preserved deliberately. Counting phase alone gave the
   *  skyline a floor that only ratcheted upward. */
  it('drops an agent from the count the moment its process is gone', async () => {
    const bus = new EventBus()
    const sessions: FakeSession[] = [live('working')]
    const rows: PodiumEventRecord[] = []
    const events = {
      async appendEvent(
        input: Omit<PodiumEventRecord, 'id' | 'repoPath'> & { repoPath?: string | null },
      ) {
        rows.push({ id: rows.length + 1, repoPath: input.repoPath ?? null, ...input })
        return rows.length
      },
      listKindSubjectSinceWithPrior: async () => rows,
      listEventsSince: async () => [],
    }
    const history = new AgentConcurrencyHistory({
      sessions: () => sessions,
      events,
      bus,
      now: () => NOW,
    })
    expect(await history.capture()).toBe(1)

    // A process that dies mid-turn emits no closing state event, so the exit
    // itself has to move the count.
    const dead = sessions[0]
    if (dead) dead.status = 'exited'
    bus.emit('session.exited', { sessionId: asSessionId('s1'), code: 1 })

    expect(rows.map((row) => row.payload)).toEqual([{ count: 1 }, { count: 0 }])
    history.dispose()
  })
})

/**
 * POD-4644. Every open shell polls this graph every five minutes, and on a
 * real-size log the read froze the whole server for seconds: it walked EVERY
 * `fleet.agent_concurrency` row the log had ever kept (4,458 on the POD-4604
 * copy, each on its own page between big `session.runtime` payloads) and sorted
 * them, twice per poll. These run the recorder against the REAL store and judge
 * the SQL it actually issued — the plan decides the cost; a timing assertion on
 * a small fixture passes either way.
 */
describe('AgentConcurrencyHistory against the real event log', () => {
  const fleetRow = (ts: string, count: number) => ({
    ts,
    kind: AGENT_CONCURRENCY_EVENT,
    subject: 'fleet',
    payload: { count },
  })

  /** Every podium_events read the store executes while `during` runs. */
  const eventReads = async (store: SessionStore, during: () => Promise<unknown>) => {
    const seen: { sql: string; rows: number }[] = []
    const detach = probeStatements(store as unknown as StatementProbeHolder, (observation) => {
      if (/^\s*select\b/i.test(observation.sql) && /from\s+"?podium_events"?/i.test(observation.sql)) {
        seen.push({ sql: observation.sql, rows: observation.rows })
      }
    })
    try {
      await during()
    } finally {
      detach()
    }
    return seen
  }

  const planOf = (store: SessionStore, sql: string): string => {
    const db = (store as unknown as { db: SqlDatabase }).db
    const params = Array.from({ length: (sql.match(/\?/g) ?? []).length }, () => null)
    return (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as { detail: string }[])
      .map((row) => row.detail)
      .join(' | ')
  }

  const seeded = async () => {
    const store = await openTestStore(':memory:')
    const hour = 3_600_000
    // A long history before the window, interleaved with other kinds, so a read
    // keyed on kind alone has real rows to walk and sort.
    for (let i = 48; i >= 1; i -= 1) {
      await store.events.appendEvent(fleetRow(new Date(NOW - i * hour).toISOString(), i % 7))
      await store.events.appendEvent({
        ts: new Date(NOW - i * hour).toISOString(),
        kind: 'session.runtime',
        subject: 's1',
        payload: { t: 'item' },
      })
    }
    const history = new AgentConcurrencyHistory({
      sessions: () => [],
      events: store.events,
      bus: new EventBus(),
      now: () => NOW,
    })
    return { store, history }
  }

  it('serves every read from an index search, with no scan and no sort', async () => {
    const { store, history } = await seeded()
    const reads = [
      ...(await eventReads(store, () => history.history())),
      ...(await eventReads(store, () => history.history())),
    ]

    expect(reads.length).toBeGreaterThan(0)
    for (const read of reads) {
      const plan = planOf(store, read.sql)
      expect(plan, read.sql).toMatch(/SEARCH podium_events USING (?:COVERING )?INDEX/)
      expect(plan, read.sql).not.toContain('SCAN podium_events')
      expect(plan, read.sql).not.toContain('TEMP B-TREE')
    }
    history.dispose()
  })

  it('reads only the rows appended since its last read, and answers the same', async () => {
    const { store, history } = await seeded()
    const first = await history.history()

    await store.events.appendEvent(fleetRow(new Date(NOW - 1_000).toISOString(), 11))
    let second: Awaited<ReturnType<typeof history.history>> | undefined
    const reads = await eventReads(store, async () => {
      second = await history.history()
    })

    // The window held 12+ rows; the steady-state poll must not fetch them again.
    expect(first.buckets.some((bucket) => bucket.count > 0)).toBe(true)
    expect(reads.reduce((sum, read) => sum + read.rows, 0)).toBe(1)
    // …and the answer is exactly what a full re-read of the log gives.
    const since = new Date(NOW - AGENT_CONCURRENCY_BUCKET_MS * AGENT_CONCURRENCY_BUCKETS).toISOString()
    const full = await store.events.listKindSubjectSinceWithPrior(AGENT_CONCURRENCY_EVENT, 'fleet', since)
    expect(second).toEqual(buildAgentConcurrencyHistory(full, NOW))
    expect(second?.buckets.at(-1)?.count).toBe(11)
    history.dispose()
  })
})

describe('workingAgentCount', () => {
  it('counts only agents that are both alive and computing', () => {
    expect(
      workingAgentCount(
        [
          live('working'),
          live('compacting'),
          live('idle'),
          { ...live('working'), status: 'exited' },
          { ...live('working'), status: 'hibernated' },
          { ...live('working'), archived: true },
          { ...live('working'), status: 'starting' },
          // Neither a launching process nor a dropped daemon link is confirmed
          // current work, even if an earlier working phase is preserved.
          { ...live('working'), status: 'reconnecting' },
        ],
        NOW,
      ),
    ).toBe(2)
  })
})
