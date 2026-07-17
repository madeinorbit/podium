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
 * (idle/need/error/awaitingSubagents) never leak across phases: each
 * transition rebuilds the state from scratch via `base` (unless it deliberately
 * spreads `prev`, as task_delta does while the count is still live).
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
  // Intentionally omits awaitingSubagents / idle / need / error so non-hold
  // transitions clear the held-working flag and phase detail.
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
      // Genuine tool activity while held (awaitingSubagents) means the parent
      // is working again — clear the flag. Same-phase no-op only when already
      // genuinely working.
      if (prev.phase === 'working' && !prev.awaitingSubagents) return prev
      return { phase: 'working', ...base }
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
      // nativeSubagentCount is the live native-subagent count (Task hooks),
      // NOT open todos — the reducer has no openTodoCount. A positive count
      // means the parent is still effectively working: hold idle and mark
      // awaitingSubagents so a later task_delta→0 can settle. [spec:SP-dae6]
      if (prev.nativeSubagentCount > 0) {
        return { phase: 'working', ...base, awaitingSubagents: true }
      }
      const verdict = event.verdict ?? { kind: 'done' as const }
      return { phase: 'idle', ...base, idle: verdict }
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
      // Turn already completed but idle was deferred for live subagents — once
      // they all finish, settle to idle (hooks have no ordering guarantee, so
      // TaskCompleted may arrive after turn_completed with no further turn).
      if (nativeSubagentCount === 0 && prev.awaitingSubagents) {
        return {
          phase: 'idle',
          since,
          workingMsTotal: workingMsAt(prev, since),
          nativeSubagentCount: 0,
          idle: { kind: 'done' as const },
        }
      }
      return { ...prev, nativeSubagentCount }
    }
    case 'session_ended':
      return { phase: 'ended', ...base }
  }
}
