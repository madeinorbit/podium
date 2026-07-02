import type { PodiumSettings } from '@podium/core'
import type { IssueWire, SessionMeta } from '@podium/protocol'
import { sessionsForIssue } from './issue-util'
import type { IssueService } from './issues'
import type { SessionStore } from './store'

/** One row read back from the durable event log (`podium_events`). */
export interface StewardEvent {
  id: number
  ts: string
  kind: string
  subject: string
  repoPath: string | null
  payload: unknown
}

/**
 * Event kind → coalescing key. Events sharing a key in one poll are handled as
 * ONE batch; kinds with no rule are consumed silently (the cursor moves past
 * them). Pure and data-like so rules are inspectable/testable in isolation.
 *
 * Follow-up rule slots (NOT this issue):
 * - session.phase → reconcile (issue-stage suggestions off agent phase)
 * - a periodic tidy tick (stale/doctor sweeps)
 */
export const TRIGGER_RULES: Record<string, (e: StewardEvent) => string> = {
  'issue.closed': (e) => `unblock:${e.repoPath ?? ''}`,
  'issue.ready': (e) => `unblock:${e.repoPath ?? ''}`,
  'issue.needs_human': (e) => `needshuman:${e.subject}`,
}

/** Everything the steward needs, injected. `issues` is a narrow seam on purpose:
 *  mutations run in-process as author 'steward' today, and a capability-gated
 *  caller can replace the same surface later without touching the registry. */
export interface StewardDeps {
  store: Pick<
    SessionStore,
    'listEventsSince' | 'getStewardState' | 'setStewardState' | 'appendEvent' | 'maxEventId'
  >
  issues: Pick<IssueService, 'get' | 'list' | 'addComment'>
  listSessions: () => SessionMeta[]
  /** Durable-queue a nudge into a live session (relay.queueText). */
  sendTextWhenReady: (sessionId: string, text: string) => void
  getSettings: () => PodiumSettings
  intervalMs?: number
  now?: () => string
}

const CURSOR_KEY = 'cursor'
const COMPLETION_NOTE_TAG = '[completion-note]'

/** The closed issue's latest completion-note comment body (tag stripped), else its title. */
function completionNote(closed: IssueWire | undefined): string {
  if (!closed) return ''
  const note = [...closed.comments]
    .reverse()
    .find((c) => c.body.includes(COMPLETION_NOTE_TAG))?.body
  return (note ? note.replace(COMPLETION_NOTE_TAG, '').trim() : closed.title).trim()
}

/**
 * The steward's trigger queue: a poll loop over the durable event log that turns
 * issue events into deterministic actions (no LLM at this layer). P1 shape:
 *
 * - Poll, not push: every `intervalMs` (15s) read `podium_events` past the
 *   persisted cursor, group through TRIGGER_RULES, run one handler per key.
 * - Serialization: batches run sequentially on the single tick loop — that IS
 *   the per-repo serialization at P1; no extra locking exists or is needed.
 * - Cursor discipline: the cursor advances only AFTER the whole run's handlers
 *   completed, so a crash mid-run re-reads the same events. Handlers must
 *   therefore be idempotent-ish (the unblock handler dedups on its own comment).
 * - Never wedge: a throwing handler is logged and the cursor STILL advances —
 *   we drop a trigger rather than replay a poison event forever.
 * - Ships dark: the loop only acts while `settings.steward.enabled`, re-read
 *   every tick so a settings flip takes effect without a restart.
 */
export class StewardService {
  private timer: ReturnType<typeof setInterval> | undefined

  constructor(private readonly deps: StewardDeps) {}

  private now(): string {
    return this.deps.now ? this.deps.now() : new Date().toISOString()
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => void this.tick(), this.deps.intervalMs ?? 15_000)
    this.timer.unref?.()
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  /** The cursor to read past, seeding/healing the persisted row when needed:
   *  - absent (first enable): seed to MAX(id) — the log accumulated while the
   *    steward ran dark, and weeks of stale events must never replay as fresh
   *    unblock comments/nudges. Persisted immediately so a crash right after
   *    doesn't re-open history.
   *  - corrupt (non-numeric): a NaN cursor would match nothing and never be
   *    rewritten (permanent silent wedge) — log and re-seed to MAX(id). */
  private resolveCursor(): number {
    const raw = this.deps.store.getStewardState(CURSOR_KEY)
    if (raw !== undefined) {
      const cursor = Number(raw)
      if (Number.isFinite(cursor)) return cursor
      console.warn(`[podium:steward] corrupt cursor ${JSON.stringify(raw)} — re-seeding to now`)
    }
    const seeded = this.deps.store.maxEventId()
    this.deps.store.setStewardState(CURSOR_KEY, String(seeded))
    return seeded
  }

  /** One poll: read past the cursor, coalesce, handle, then advance. Public so
   *  tests drive it directly instead of waiting on real timers. */
  async tick(): Promise<void> {
    if (!this.deps.getSettings().steward?.enabled) return
    const cursor = this.resolveCursor()
    const events = this.deps.store.listEventsSince(cursor)
    if (events.length === 0) return
    // Coalesce: all events for the same key form one batch this poll.
    const batches = new Map<string, StewardEvent[]>()
    for (const e of events) {
      const key = TRIGGER_RULES[e.kind]?.(e)
      if (!key) continue // unmatched kind — consumed silently
      const batch = batches.get(key) ?? []
      batch.push(e)
      batches.set(key, batch)
    }
    for (const [key, batch] of batches) {
      try {
        if (key.startsWith('unblock:')) await this.handleUnblock(batch)
        else if (key.startsWith('needshuman:')) this.handleNeedsHuman(batch)
      } catch (err) {
        // Drop, don't wedge: the trigger is lost but the queue keeps moving.
        console.warn(`[podium:steward] handler for ${key} failed:`, err)
      }
    }
    this.deps.store.setStewardState(CURSOR_KEY, String(events[events.length - 1]!.id))
  }

  /** For each newly-ready dependent: post an 'Unblocked by #<seq>' comment and
   *  nudge any live session working in its worktree. Idempotent via the comment
   *  dedup — a crash-replayed batch posts nothing twice. */
  private async handleUnblock(batch: StewardEvent[]): Promise<void> {
    for (const e of batch) {
      if (e.kind !== 'issue.ready') continue // issue.closed only coalesces the batch
      const closedSeq = (e.payload as { unblockedBy?: number } | null)?.unblockedBy
      if (closedSeq == null) continue
      const dependent = this.deps.issues.get(e.subject)
      if (!dependent) continue
      // Colon-anchored so '#5' never matches a prior '#55' comment. Single-server
      // assumption: this read-then-write dedup is a cross-process race — fine
      // while live is one server; revisit for multi-server.
      const marker = `Unblocked by #${closedSeq}:`
      const already = dependent.comments.some(
        (c) => c.author === 'steward' && c.body.includes(marker),
      )
      if (already) continue
      const closed = this.deps.issues
        .list(e.repoPath ?? dependent.repoPath)
        .find((w) => w.seq === closedSeq)
      this.deps.issues.addComment(dependent.id, 'steward', `${marker} ${completionNote(closed)}`)
      // Nudge only live/starting agent sessions: queueText would RESURRECT a
      // parked session with a resume ref (the steward must never respawn agents),
      // and a shell would have the text typed into bash. The nudge itself stays
      // single-line with no backticks and no agent-authored note interpolated —
      // the note lives in the issue comment only.
      const targets = sessionsForIssue(dependent.worktreePath, this.deps.listSessions()).filter(
        (s) => (s.status === 'live' || s.status === 'starting') && s.agentKind !== 'shell',
      )
      for (const s of targets) {
        this.deps.sendTextWhenReady(
          s.sessionId,
          `Blocker #${closedSeq} closed — you are unblocked. See the steward comment on your issue, or run: podium issue prime`,
        )
      }
    }
  }

  /** P1: needs-human only leaves a breadcrumb in the log (briefs are P3). */
  private handleNeedsHuman(batch: StewardEvent[]): void {
    const last = batch[batch.length - 1]!
    this.deps.store.appendEvent({
      ts: this.now(),
      kind: 'steward.observed',
      subject: last.subject,
      repoPath: last.repoPath,
      payload: { of: last.id, kind: last.kind },
    })
  }
}
