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

/** Carry the identity list only when non-empty (field is optional/additive). */
function withSubagents(
  list: NonNullable<AgentRuntimeState['nativeSubagents']> | undefined,
): { nativeSubagents?: NonNullable<AgentRuntimeState['nativeSubagents']> } {
  return list && list.length > 0 ? { nativeSubagents: list } : {}
}

/**
 * Apply a task_delta to the identity list + count.
 * Identity mode (non-empty nativeSubagents): list is the single source of truth;
 * nativeSubagentCount = list.length. Anonymous deltas (no agentId) are ignored so
 * the two count rules cannot silently diverge. Unknown-id Stop is a no-op.
 * Anonymous mode (empty/undefined list — Grok / dead Claude TaskCreated): pure ±1
 * on the count only.
 */
function applyTaskDelta(
  prev: AgentRuntimeState,
  event: Extract<AgentStateEvent, { kind: 'task_delta' }>,
): { nativeSubagentCount: number; nativeSubagents?: NonNullable<AgentRuntimeState['nativeSubagents']> } | null {
  const prevList = prev.nativeSubagents ?? []
  const identityMode = prevList.length > 0
  if (event.agentId) {
    if (event.delta > 0) {
      if (prevList.some((s) => s.id === event.agentId)) return null // duplicate start
      const nextList = [
        ...prevList,
        {
          id: event.agentId,
          ...(event.agentType !== undefined ? { type: event.agentType } : {}),
        },
      ]
      return { nativeSubagentCount: nextList.length, ...withSubagents(nextList) }
    }
    // delta < 0
    if (!prevList.some((s) => s.id === event.agentId)) {
      // Unknown id: ignore in identity mode; else treat as anonymous floor.
      if (identityMode) return null
      const nativeSubagentCount = Math.max(0, prev.nativeSubagentCount + event.delta)
      if (nativeSubagentCount === prev.nativeSubagentCount) return null
      return { nativeSubagentCount }
    }
    const nextList = prevList.filter((s) => s.id !== event.agentId)
    return { nativeSubagentCount: nextList.length, ...withSubagents(nextList) }
  }
  // Anonymous count-only path. Once identity mode is active the list owns the
  // count — ignore so a stray TaskCreated/Completed cannot diverge it.
  if (identityMode) return null
  const nativeSubagentCount = Math.max(0, prev.nativeSubagentCount + event.delta)
  if (nativeSubagentCount === prev.nativeSubagentCount) return null
  return { nativeSubagentCount }
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
  // transitions clear the held-working flag and phase detail. Identity list
  // and count both survive phase transitions (subagents outlive a single phase).
  const base = {
    since,
    workingMsTotal: workingMsAt(prev, since),
    nativeSubagentCount: prev.nativeSubagentCount,
    ...withSubagents(prev.nativeSubagents),
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
      const applied = applyTaskDelta(prev, event)
      if (!applied) return prev
      const { nativeSubagentCount } = applied
      // Turn already completed but idle was deferred for live subagents — once
      // they all finish, settle to idle (hooks have no ordering guarantee, so
      // TaskCompleted/SubagentStop may arrive after turn_completed with no further turn).
      if (nativeSubagentCount === 0 && prev.awaitingSubagents) {
        return {
          phase: 'idle',
          since,
          workingMsTotal: workingMsAt(prev, since),
          nativeSubagentCount: 0,
          idle: { kind: 'done' as const },
        }
      }
      return {
        ...prev,
        nativeSubagentCount,
        // Drop the key when empty so wire payloads stay lean / back-compat.
        nativeSubagents: applied.nativeSubagents,
      }
    }
    case 'session_ended':
      // Terminal: drop live-subagent bookkeeping so identities / holds never
      // leak into an ended session (base would otherwise carry them forward).
      return {
        phase: 'ended',
        since,
        workingMsTotal: workingMsAt(prev, since),
        nativeSubagentCount: 0,
      }
  }
}
