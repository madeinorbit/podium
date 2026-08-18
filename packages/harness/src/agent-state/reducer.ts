import type { AgentNeed, AgentRuntimeState } from '@podium/model'
import type { AgentStateEvent } from './types.js'

/**
 * Is this the same wait, restated? A harness may announce one wait on several
 * channels (Claude Code names an interview on PreToolUse AND again on
 * PermissionRequest), and a restatement must not restamp `since` — the user is
 * shown how long the agent has been waiting, and that clock starts at the first
 * announcement, not the last echo of it.
 */
function sameNeed(a: AgentNeed, b: AgentNeed): boolean {
  return (
    a.kind === b.kind &&
    a.summary === b.summary &&
    a.ask?.toolName === b.ask?.toolName &&
    a.ask?.detail === b.ask?.detail &&
    a.ask?.canAlwaysAllow === b.ask?.canAlwaysAllow
  )
}

/** Stronger observations suppress lower-confidence reports for one live-transition window. */
export const STATE_CHANNEL_STALENESS_MS = 5_000

function stateProvenance(
  event: AgentStateEvent,
  now: string,
): Pick<AgentRuntimeState, 'stateSource' | 'stateConfidence' | 'stateObservedAt'> {
  if (event.source === undefined || event.confidence === undefined) return {}
  return {
    stateSource: event.source,
    stateConfidence: event.confidence,
    stateObservedAt: event.observedAt ?? now,
  }
}

function lowerConfidenceIsStale(
  prev: AgentRuntimeState,
  event: AgentStateEvent,
  now: string,
): boolean {
  if (event.confidence === undefined || prev.stateConfidence === undefined) return false
  if (event.confidence >= prev.stateConfidence) return false
  const previousObserved = Date.parse(prev.stateObservedAt ?? prev.since)
  const nextObserved = Date.parse(event.observedAt ?? now)
  if (!Number.isFinite(previousObserved) || !Number.isFinite(nextObserved)) return false
  const age = nextObserved - previousObserved
  return age >= 0 && age <= STATE_CHANNEL_STALENESS_MS
}

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
function withSubagents(list: NonNullable<AgentRuntimeState['nativeSubagents']> | undefined): {
  nativeSubagents?: NonNullable<AgentRuntimeState['nativeSubagents']>
} {
  return list && list.length > 0 ? { nativeSubagents: list } : {}
}

/**
 * THE carried set: everything a transcript rebuild cannot reconstruct.
 *
 * A reconnect rebuilds the turn from `initialAgentState` plus transcript-derived
 * boot events, which is legitimate for what the transcript actually records —
 * phase, turn boundaries, verdicts. It is destructive for everything else, and
 * "everything else" is exactly two things:
 *
 *  - The live subagents. `nativeSubagents` moves on SubagentStart/Stop alone, so
 *    a rebuild reports no children whether or not any are running. That erasure
 *    is permanent: with the identity list gone the real SubagentStop reduces to
 *    nothing (see {@link applyTaskDelta}'s anonymous floor), so the count never
 *    comes back. Terminal proof reads the count to refuse a verdict while a
 *    child is live, and every subagent surface reads the pair.
 *  - The accumulated working time. {@link workingMsAt} can only ADD to `prev`,
 *    so a rebuilt zero is proof of a reseed rather than a measurement — it
 *    resets the user-visible clocks and reorders attention ranking with them.
 *
 * Add any future field the transcript cannot rebuild here, in this one place.
 * [POD-1130]
 *
 * The rebuild keeps its phase, with one exception: idle. A parent whose children
 * are live is not idle — that is the hold `turn_completed` already applies while
 * the count is positive [spec:SP-dae6], restated here because a rebuild reaches
 * idle without the reducer ever seeing the count (the classifier resolves the
 * turn from the transcript, and often resolves no verdict at all). Leaving the
 * idle in place is the other half of the reported symptom: the parent reads idle
 * while it is still waiting on the child.
 *
 * Idempotent, so callers layered over one another (the daemon builds the state,
 * the observer inherits it) cannot double-count: the clock takes the greater of
 * the two totals rather than their sum.
 */
export function carryAcrossRebuild(
  next: AgentRuntimeState,
  prev: AgentRuntimeState | undefined,
): AgentRuntimeState {
  if (!prev) return next
  const workingMsTotal = Math.max(next.workingMsTotal ?? 0, prev.workingMsTotal ?? 0)
  if (prev.nativeSubagentCount <= 0) {
    return workingMsTotal === (next.workingMsTotal ?? 0) ? next : { ...next, workingMsTotal }
  }
  const carried = {
    ...next,
    workingMsTotal,
    nativeSubagentCount: prev.nativeSubagentCount,
    ...withSubagents(prev.nativeSubagents),
  }
  if (carried.phase !== 'idle') return carried
  const { idle: _resolved, ...held } = carried
  return { ...held, phase: 'working', awaitingSubagents: true }
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
): {
  nativeSubagentCount: number
  nativeSubagents?: NonNullable<AgentRuntimeState['nativeSubagents']>
} | null {
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
  if (lowerConfidenceIsStale(prev, event, now)) return prev
  const since = event.at ?? now
  // Intentionally omits awaitingSubagents / idle / need / error so non-hold
  // transitions clear the held-working flag and phase detail. Identity list
  // and count both survive phase transitions (subagents outlive a single phase).
  const base = {
    since,
    workingMsTotal: workingMsAt(prev, since),
    nativeSubagentCount: prev.nativeSubagentCount,
    ...withSubagents(prev.nativeSubagents),
    ...stateProvenance(event, now),
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
      if (prev.phase === 'working' && !prev.awaitingSubagents) {
        if (event.confidence !== undefined && event.confidence > (prev.stateConfidence ?? -1)) {
          return { ...prev, ...stateProvenance(event, now) }
        }
        return prev
      }
      return { phase: 'working', ...base }
    case 'needs_user': {
      // A subjectless event names nothing it waits on, so it must not overwrite a
      // need a better-informed channel already described. Claude Code announces
      // one interview three times — PreToolUse (the question), PermissionRequest
      // (the tool), then a boilerplate "Claude needs your permission" dialog
      // Notification — and last-write-wins let the emptiest of the three decide,
      // which is what turned every interview into a permission prompt.
      // It still OPENS a wait: dialogs that touch no tool arrive only here.
      if (event.subjectless && prev.phase === 'needs_user' && prev.need) return prev
      const need: AgentNeed = {
        kind: event.need,
        ...(event.summary !== undefined ? { summary: event.summary } : {}),
        ...(event.ask !== undefined ? { ask: event.ask } : {}),
        ...(event.interview !== undefined ? { interview: event.interview } : {}),
      }
      // Same wait restated on a second channel — hold the original `since`.
      if (prev.phase === 'needs_user' && prev.need && sameNeed(prev.need, need)) {
        // …unless the restatement brings the ask ITSELF. Claude Code announces
        // an interview on two channels and the chat cannot draw a card from the
        // one-line summary alone, so a channel carrying the questions upgrades
        // the need in place. The clock still belongs to the first announcement.
        if (prev.need.interview === undefined && need.interview !== undefined) {
          return { ...prev, need, ...stateProvenance(event, now) }
        }
        if (event.confidence !== undefined && event.confidence > (prev.stateConfidence ?? -1)) {
          return { ...prev, ...stateProvenance(event, now) }
        }
        return prev
      }
      return { phase: 'needs_user', ...base, need }
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
          ...stateProvenance(event, now),
          idle: { kind: 'done' as const },
        }
      }
      return {
        ...prev,
        nativeSubagentCount,
        // Drop the key when empty so wire payloads stay lean / back-compat.
        nativeSubagents: applied.nativeSubagents,
        ...stateProvenance(event, now),
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
        ...stateProvenance(event, now),
      }
  }
}
