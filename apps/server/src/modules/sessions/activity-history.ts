/**
 * PER-SESSION PHASE HISTORY (POD-1854) — the durable on/off record behind the
 * Flight Deck waterfall's segmented bars.
 *
 * `AgentRuntimeState` is a snapshot: `since` is overwritten on every flip and
 * `workingMsTotal` folds all past stretches into one integer, so "worked,
 * waited for review, worked again" is unreconstructable from `SessionMeta`.
 * The bus, however, already narrates every transition (`session.stateChanged`
 * carries prev AND next), and `podium_events` is subject-indexed. This module
 * mirrors the fleet-level `AgentConcurrencyHistory` recorder one level down:
 * one `session.phase_sample` event per real phase flip, keyed by the session id.
 *
 * The log is observational. Append failures are swallowed for the same reason
 * the concurrency recorder swallows them: a full or read-only event store must
 * never interfere with the agent-state transition it is watching. Absence of
 * rows is a legal state (sessions born before this feature, pruned history) —
 * readers must treat "no samples" as "no segmentation known", not as idle.
 */

import type { AgentPhase, SessionId } from '@podium/model'
import type { EventsRepository } from '../../store/events'
import type { EventBus } from '../bus'

/**
 * This recorder OWNS its kind, exactly as the fleet concurrency recorder owns
 * `fleet.agent_concurrency`. It must not reuse `session.phase` (POD-3331): that
 * kind is the notification service's semantic transition log, whose readers
 * (steward triggers, the superagent's turn watcher) expect one row per real
 * flip carrying `agentKind`/`cwd`/`verdict`. Sharing it appended a SECOND row
 * per transition and — because this recorder deliberately keeps the opening
 * edge a waterfall segment starts from — a prev-undefined seed row that the
 * semantic log is designed never to contain.
 */
export const SESSION_PHASE_EVENT = 'session.phase_sample'
/** Matches the waterfall's maximum lookback; older history is clipped anyway. */
export const SESSION_ACTIVITY_WINDOW_MS = 48 * 60 * 60 * 1_000

export interface SessionPhaseSample {
  /** ISO timestamp of the transition. */
  at: string
  phase: AgentPhase
}

export interface SessionActivityHistoryResult {
  sampledAt: string
  /** Missing key = no recorded history for that session (NOT "always idle"). */
  sessions: Record<string, SessionPhaseSample[]>
}

function samplePhase(record: { payload: unknown; ts: string }): SessionPhaseSample | null {
  if (!record.payload || typeof record.payload !== 'object') return null
  const phase = (record.payload as { phase?: unknown }).phase
  if (typeof phase !== 'string' || phase.length === 0) return null
  if (!Number.isFinite(Date.parse(record.ts))) return null
  return { at: record.ts, phase: phase as AgentPhase }
}

/** Durable per-session phase-transition recorder + windowed read model. */
export class SessionActivityHistory {
  /** Last phase we durably recorded per session — the dedupe for the frequent
   *  same-phase refreshes (`stateSource: poll` re-asserts the current phase). */
  private readonly lastRecorded = new Map<SessionId, AgentPhase>()
  private readonly unsubscribe: () => void

  constructor(
    private readonly deps: {
      events: Pick<EventsRepository, 'appendEvent' | 'listKindSubjectSinceWithPrior'>
      bus: EventBus
      now: () => number
    },
  ) {
    const offState = deps.bus.on('session.stateChanged', ({ sessionId, prev, next }) => {
      this.record(sessionId, next.phase, prev?.phase)
    })
    // A process that dies mid-turn never emits a closing state event; the exit
    // is the closing edge or the working segment runs to Now forever.
    const offExit = deps.bus.on('session.exited', ({ sessionId }) => {
      this.record(sessionId, 'ended', undefined)
    })
    this.unsubscribe = () => {
      offState()
      offExit()
    }
  }

  dispose(): void {
    this.unsubscribe()
  }

  private record(sessionId: SessionId, phase: AgentPhase, prev: AgentPhase | undefined): void {
    const known = this.lastRecorded.get(sessionId) ?? prev
    if (known === phase) return
    try {
      this.deps.events.appendEvent({
        ts: new Date(this.deps.now()).toISOString(),
        kind: SESSION_PHASE_EVENT,
        subject: sessionId,
        payload: { phase, from: known ?? null },
      })
      this.lastRecorded.set(sessionId, phase)
    } catch {
      // Observational log; the transition it describes must proceed regardless.
    }
  }

  history(sessionIds: readonly SessionId[]): SessionActivityHistoryResult {
    const nowMs = this.deps.now()
    const since = new Date(nowMs - SESSION_ACTIVITY_WINDOW_MS).toISOString()
    const sessions: Record<string, SessionPhaseSample[]> = {}
    for (const sessionId of new Set(sessionIds)) {
      const rows = this.deps.events.listKindSubjectSinceWithPrior(
        SESSION_PHASE_EVENT,
        sessionId,
        since,
      )
      if (rows.length === 0) continue
      const samples = rows
        .map(samplePhase)
        .filter((sample): sample is SessionPhaseSample => sample !== null)
      if (samples.length > 0) sessions[sessionId] = samples
    }
    return { sampledAt: new Date(nowMs).toISOString(), sessions }
  }
}
