import type { AgentRuntimeState } from '@podium/protocol'
import type { AgentStateEvent } from './types.js'

export function initialAgentState(now: string): AgentRuntimeState {
  return { phase: 'unknown', since: now, openTaskCount: 0 }
}

/**
 * Pure transition. Returns `prev` (same reference) when the event changes
 * nothing, so callers can dedupe wire sends by identity. Detail fields
 * (idle/need/error) never leak across phases: each transition rebuilds the
 * state from scratch.
 */
export function reduceAgentState(
  prev: AgentRuntimeState,
  event: AgentStateEvent,
  now: string,
): AgentRuntimeState {
  const base = { since: now, openTaskCount: prev.openTaskCount }
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
        verdict.kind === 'done' && prev.openTaskCount > 0
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
      const openTaskCount = Math.max(0, prev.openTaskCount + event.delta)
      if (openTaskCount === prev.openTaskCount) return prev
      return { ...prev, openTaskCount }
    }
    case 'session_ended':
      return { phase: 'ended', ...base }
  }
}
