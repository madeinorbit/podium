import type { AgentRuntimeState } from '@podium/protocol'
import type { AgentStateEvent } from './types.js'

export function initialAgentState(now: string): AgentRuntimeState {
  return { phase: 'unknown', since: now, workingMsTotal: 0, nativeSubagentCount: 0 }
}

function workingMsAt(prev: AgentRuntimeState, nextSince: string): number {
  const total = prev.workingMsTotal ?? 0
  if (prev.phase !== 'working' && prev.phase !== 'compacting') return total
  const from = Date.parse(prev.since)
  const to = Date.parse(nextSince)
  if (!Number.isFinite(from) || !Number.isFinite(to)) return total
  return total + Math.max(0, to - from)
}

/**
 * Pure transition. Returns `prev` (same reference) when the event changes
 * nothing, so callers can dedupe wire sends by identity. Detail fields
 * (idle/need/error) never leak across phases: each transition rebuilds the
 * state from scratch.
 */
/**
 * Stamp a record's source timestamp onto translated events so the reducer can use
 * it as the phase `since`. Recency then reflects when the agent actually acted, not
 * when we observed it — so a poller replaying its recent tail on reattach carries
 * the original (old) times and can't restamp every session to "now". No-op for
 * events that already set `at`, and when no event-time is available (→ falls back
 * to `now` downstream).
 */
export function withEventTime(
  events: AgentStateEvent[],
  at: string | undefined,
): AgentStateEvent[] {
  if (!at) return events
  return events.map((e) => (e.at === undefined ? { ...e, at } : e))
}

export function reduceAgentState(
  prev: AgentRuntimeState,
  event: AgentStateEvent,
  now: string,
): AgentRuntimeState {
  const since = event.at ?? now
  const base = {
    since,
    workingMsTotal: workingMsAt(prev, since),
    nativeSubagentCount: prev.nativeSubagentCount,
  }
  switch (event.kind) {
    case 'session_started':
      return { phase: 'idle', ...base }
    case 'prompt_submitted':
      return { phase: 'working', ...base }
    case 'activity':
      return prev.phase === 'working' ? prev : { phase: 'working', ...base }
    case 'needs_user':
      return {
        phase: 'needs_user',
        ...base,
        need: {
          kind: event.need,
          ...(event.summary !== undefined ? { summary: event.summary } : {}),
        },
      }
    case 'turn_completed': {
      const verdict = event.verdict ?? { kind: 'done' as const }
      // Open todos outrank a bare "done" — the agent stopped mid-list. They do
      // NOT outrank question/approval: those already say why it stopped.
      const idle =
        verdict.kind === 'done' && prev.nativeSubagentCount > 0
          ? { kind: 'open_todos' as const }
          : verdict
      return { phase: 'idle', ...base, idle }
    }
    case 'turn_failed':
      return {
        phase: 'errored',
        ...base,
        error: { class: event.errorClass, retryable: event.retryable },
      }
    case 'compaction':
      return event.phase === 'start'
        ? { phase: 'compacting', ...base }
        : { phase: 'working', ...base }
    case 'task_delta': {
      const nativeSubagentCount = Math.max(0, prev.nativeSubagentCount + event.delta)
      if (nativeSubagentCount === prev.nativeSubagentCount) return prev
      return { ...prev, nativeSubagentCount }
    }
    case 'session_ended':
      return { phase: 'ended', ...base }
  }
}
