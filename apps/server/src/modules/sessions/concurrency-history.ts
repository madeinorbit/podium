import { isAgentConfirmedComputing } from '@podium/model'
import type { EventsRepository, PodiumEventRecord } from '../../store/events'
import type { EventBus } from '../bus'
import type { Session } from './session'

export const AGENT_CONCURRENCY_EVENT = 'fleet.agent_concurrency'
export const AGENT_CONCURRENCY_BUCKET_MS = 30 * 60 * 1_000
export const AGENT_CONCURRENCY_BUCKETS = 24
export const AGENT_CONCURRENCY_WINDOW_MS = AGENT_CONCURRENCY_BUCKET_MS * AGENT_CONCURRENCY_BUCKETS

export interface AgentConcurrencyBucket {
  start: string
  count: number
}

export interface AgentConcurrencyHistoryResult {
  sampledAt: string
  bucketMs: number
  peak: number
  buckets: AgentConcurrencyBucket[]
}

interface ConcurrencyChange {
  at: number
  count: number
}

/**
 * The registry holds every session it has ever seen, including the exited and
 * the parked, and their last observed phase is deliberately preserved. So the
 * count must ask confirmed liveness too. Without it the skyline
 * had a floor that only ratcheted upward: every agent that ever died mid-turn
 * kept counting, and the strip read "13 agents working" for hours (POD-730).
 * Reconnecting sessions are excluded as well: the preserved phase is useful
 * for recovery, but it is no longer evidence of work happening now.
 */
export function workingAgentCount(
  sessions: Iterable<Pick<Session, 'agentState' | 'status' | 'archived' | 'lastActiveAt'>>,
  nowMs: number,
): number {
  let count = 0
  for (const session of sessions) if (isAgentConfirmedComputing(session, nowMs)) count += 1
  return count
}

function concurrencyChange(event: PodiumEventRecord): ConcurrencyChange | null {
  if (!event.payload || typeof event.payload !== 'object') return null
  const count = (event.payload as { count?: unknown }).count
  const at = Date.parse(event.ts)
  if (!Number.isInteger(count) || Number(count) < 0 || !Number.isFinite(at)) return null
  return { at, count: Number(count) }
}

/**
 * Reduce the durable count step-function into 30-minute peaks. A point sample
 * would erase a ten-minute burst if it ended before the boundary; the peak
 * preserves the fleet shape the history graph exists to show. The sentence
 * beside the graph remains the exact current count.
 */
export function buildAgentConcurrencyHistory(
  events: readonly PodiumEventRecord[],
  nowMs: number,
): AgentConcurrencyHistoryResult {
  const windowStart = nowMs - AGENT_CONCURRENCY_WINDOW_MS
  const changes = events
    .map(concurrencyChange)
    .filter((change): change is ConcurrencyChange => change !== null && change.at <= nowMs)
    .sort((a, b) => a.at - b.at)
  let cursor = 0
  let count = 0
  let change = changes[cursor]
  while (change && change.at < windowStart) {
    count = change.count
    cursor += 1
    change = changes[cursor]
  }

  const buckets: AgentConcurrencyBucket[] = []
  for (let index = 0; index < AGENT_CONCURRENCY_BUCKETS; index += 1) {
    const start = windowStart + index * AGENT_CONCURRENCY_BUCKET_MS
    const sampleAt =
      index === AGENT_CONCURRENCY_BUCKETS - 1 ? nowMs : start + AGENT_CONCURRENCY_BUCKET_MS
    let bucketPeak = count
    change = changes[cursor]
    while (change && change.at <= sampleAt) {
      count = change.count
      bucketPeak = Math.max(bucketPeak, count)
      cursor += 1
      change = changes[cursor]
    }
    buckets.push({ start: new Date(start).toISOString(), count: bucketPeak })
  }

  return {
    sampledAt: new Date(nowMs).toISOString(),
    bucketMs: AGENT_CONCURRENCY_BUCKET_MS,
    peak: Math.max(0, ...buckets.map((bucket) => bucket.count)),
    buckets,
  }
}

/** Durable recorder + read model for the shell's fleet-concurrency skyline. */
export class AgentConcurrencyHistory {
  private lastRecordedCount: number | undefined
  private readonly unsubscribe: () => void

  constructor(
    private readonly deps: {
      sessions: () =>
        Iterable<Pick<Session, 'agentState' | 'status' | 'archived' | 'lastActiveAt'>>
      events: Pick<EventsRepository, 'appendEvent' | 'listKindSinceWithPrior'>
      bus: EventBus
      now: () => number
    },
  ) {
    // Phase and liveness are both inputs (see workingAgentCount), so a death is
    // as much a change to the count as a phase flip — a process that dies
    // mid-turn never emits a closing state event. Parking (hibernate/archive)
    // has no bus event of its own; it lands on the next capture, which the
    // 5-minute history() read guarantees. Same-value refreshes are common;
    // capture() deduplicates them before they touch the durable event log.
    const offState = deps.bus.on('session.stateChanged', () => this.capture())
    const offExit = deps.bus.on('session.exited', () => this.capture())
    this.unsubscribe = () => {
      offState()
      offExit()
    }
  }

  dispose(): void {
    this.unsubscribe()
  }

  capture(): number {
    const count = workingAgentCount(this.deps.sessions(), this.deps.now())
    if (count === this.lastRecordedCount) return count
    try {
      this.deps.events.appendEvent({
        ts: new Date(this.deps.now()).toISOString(),
        kind: AGENT_CONCURRENCY_EVENT,
        subject: 'fleet',
        payload: { count },
      })
      this.lastRecordedCount = count
    } catch {
      // The status strip is observational. A full/read-only event store must
      // never interfere with the agent-state transition it is observing.
    }
    return count
  }

  history(): AgentConcurrencyHistoryResult {
    const nowMs = this.deps.now()
    this.capture()
    const since = new Date(nowMs - AGENT_CONCURRENCY_WINDOW_MS).toISOString()
    return buildAgentConcurrencyHistory(
      this.deps.events.listKindSinceWithPrior(AGENT_CONCURRENCY_EVENT, since),
      nowMs,
    )
  }
}
