/**
 * Read toolkit tiers 1–2 (#237) [spec:SP-34d7 read-toolkit]: the escalation
 * ladder's cheap rungs.
 *
 *  - status: structured snapshot — phase, issue stage/todos, last commits on
 *    the session's branch, files touched, unacked message count. NO transcript
 *    text, ~200 tokens.
 *  - read: bounded raw-transcript window over the existing uuid-cursor
 *    transcriptRead infra, hard-capped per call.
 *
 * Authz mirrors messaging (the caller gates live in the relay/router arms);
 * every cross-session read is event-logged here (transcripts can carry secrets).
 */

import { resolveSessionIdentifier, type SessionMeta, type TranscriptItem } from '@podium/protocol'
import { selectMailNudgeSession, sessionsForIssue } from '../../issue-util'
import type { EventsRepository } from '../../store/events'
import type { ReadWatermarksRepository } from '../../store/read-watermarks'
import type { IssueService } from '../issues/service'
import type { MessageDeliveryService } from '../messages/service'
import { buildBtwDelta, buildBtwRecap, lineForItem } from '../superagent/btw'

/** Hard caps: transcript lines per read call and turns per window. */
export const READ_LINE_CAP = 200
export const READ_TURN_CAP = 50
/** Recap (tier 3): max transcript items summarized per call and max recap chars. */
export const RECAP_ITEM_CAP = 400
export const RECAP_CHAR_CAP = 12_000

export interface SessionStatusResult {
  sessionId: string
  agentKind: string
  status: string
  phase: string
  issue: { seq: number; stage: string; title: string; todos: string[] } | null
  /** Last ≤5 one-line commits on the session's branch (git -C <cwd> log). */
  commits: string[]
  /** Working-tree touched files (git status --porcelain), capped. */
  files: string[]
  /** Messages delivered to this session still awaiting its ack. */
  unackedMessages: number
}

export interface SessionReadResult {
  sessionId: string
  items: {
    role: string
    text: string
    toolName?: string
    toolInput?: string
    ts?: string
  }[]
  /** Cursor of the OLDEST item returned — pass as --cursor to page further back. */
  cursor: string | null
  hasMore: boolean
  truncated: boolean
}

export interface SessionRecapResult {
  sessionId: string
  /** Deterministic Hermes-style recap of the window since the watermark. */
  recap: string
  /** Pass back as --since (also persisted per (reader, target)) — the next
   *  call summarizes only what happened after this cursor. */
  watermark: string | null
  /** Items the recap covered; 0 = nothing new since the watermark. */
  newItems: number
  /** True when this call summarized a delta (a watermark was in effect). */
  delta: boolean
}

export interface SessionReadToolkitDeps {
  listSessions(): SessionMeta[]
  issues(): IssueService
  messages(): MessageDeliveryService
  events: Pick<EventsRepository, 'appendEvent'>
  /** Persisted per-(reader, target) recap watermarks (tier 3). */
  watermarks: Pick<ReadWatermarksRepository, 'getRecapWatermark' | 'setRecapWatermark'>
  /** Allowlisted daemon git op ('log' → oneline -20, 'status' → porcelain -b). */
  repoOp(
    op: 'log' | 'status',
    cwd: string,
    machineId?: string,
  ): Promise<{ ok: boolean; output: string }>
  /** The uuid-cursor transcript window read (modules/machines/rpc.readTranscript). */
  readTranscript(input: {
    sessionId: string
    anchor?: string
    direction: 'before' | 'after'
    limit: number
  }): Promise<{ items: TranscriptItem[]; hasMore: boolean }>
  now(): string
}

export class SessionReadToolkit {
  constructor(private readonly deps: SessionReadToolkitDeps) {}

  /** Resolve a status ref — a session id/birth ref, or an issue ref
   *  (#N/seq/id) whose best member session (live preferred, else most recent
   *  agent) is picked. */
  resolveTarget(ref: string): SessionMeta | undefined {
    const all = this.deps.listSessions()
    const direct = resolveSessionIdentifier(ref, all)
    if (direct) return direct
    let issueId: string
    try {
      issueId = this.deps.issues().resolveRef(ref)
    } catch {
      return undefined
    }
    const issue = this.deps.issues().get(issueId)
    if (!issue) return undefined
    const members = sessionsForIssue(issue.worktreePath ?? null, all, issue.id)
    const live = selectMailNudgeSession(members)
    if (live) return members.find((s) => s.sessionId === live.sessionId)
    return [...members]
      .filter((s) => s.agentKind !== 'shell')
      .sort((a, b) => (b.lastActiveAt ?? '').localeCompare(a.lastActiveAt ?? ''))
      .at(0)
  }

  async status(ref: string, reader: string): Promise<SessionStatusResult> {
    const target = this.resolveTarget(ref)
    if (!target) throw new Error(`no session found for ${ref}`)
    this.logRead('session.status_read', target.sessionId, reader)
    const issues = this.deps.issues()
    const issueId = target.issueId ?? issues.issueForCwd(target.cwd)
    const issue = issueId ? issues.get(issueId) : null
    const [log, status] = await Promise.all([
      this.deps.repoOp('log', target.cwd, target.machineId).catch(() => ({
        ok: false,
        output: '',
      })),
      this.deps.repoOp('status', target.cwd, target.machineId).catch(() => ({
        ok: false,
        output: '',
      })),
    ])
    const lines = (r: { ok: boolean; output: string }): string[] =>
      r.ok ? r.output.split('\n').filter(Boolean) : []
    const todos = (issue?.panel?.todos ?? []).map(
      (t: { text: string; done: boolean }) => `[${t.done ? 'x' : ' '}] ${t.text}`,
    )
    return {
      sessionId: target.sessionId,
      agentKind: target.agentKind,
      status: target.status,
      phase: target.agentState?.phase ?? (target.busy ? 'working' : 'idle'),
      issue: issue ? { seq: issue.seq, stage: issue.stage, title: issue.title, todos } : null,
      commits: lines(log).slice(0, 5),
      // First porcelain -b line is the branch header — keep it (names the branch),
      // then the touched files, capped so status stays ~200 tokens.
      files: lines(status).slice(0, 21),
      unackedMessages: this.deps.messages().deliveredUnacked(target.sessionId).length,
    }
  }

  async read(
    input: { sessionId: string; turns?: number; cursor?: string },
    reader: string,
  ): Promise<SessionReadResult> {
    const target = resolveSessionIdentifier(input.sessionId, this.deps.listSessions())
    if (!target) throw new Error(`unknown session ${input.sessionId}`)
    this.logRead('session.transcript_read', target.sessionId, reader)
    const limit = Math.min(Math.max(1, input.turns ?? 20), READ_TURN_CAP)
    const slice = await this.deps.readTranscript({
      sessionId: target.sessionId,
      ...(input.cursor ? { anchor: input.cursor } : {}),
      direction: 'before',
      limit,
    })
    // Hard line cap across the whole window: drop OLDER items first so the most
    // recent context survives, and truncate any single oversized body.
    let lines = 0
    let truncated = false
    const kept: TranscriptItem[] = []
    for (const item of [...slice.items].reverse()) {
      const text = item.text.split('\n').slice(0, READ_LINE_CAP).join('\n')
      const n = text.split('\n').length + 1
      if (lines + n > READ_LINE_CAP) {
        truncated = true
        break
      }
      lines += n
      kept.unshift({ ...item, text })
    }
    if (kept.length < slice.items.length) truncated = true
    return {
      sessionId: target.sessionId,
      items: kept.map((i) => ({
        role: i.role,
        text: i.text,
        ...(i.toolName ? { toolName: i.toolName } : {}),
        ...(i.toolInput ? { toolInput: i.toolInput } : {}),
        ...(i.ts ? { ts: i.ts } : {}),
      })),
      cursor: kept[0]?.cursor ?? slice.items[0]?.cursor ?? null,
      hasMore: slice.hasMore || truncated,
      truncated,
    }
  }

  /**
   * Tier 3 — `podium session recap <id> [--since <watermark>]`: a server-side
   * summary of the session's transcript SINCE a watermark, over the existing
   * Hermes-recap machinery (buildBtwRecap/buildBtwDelta — the btw-thread
   * digest infra), never a new summarizer. The advanced watermark is returned
   * AND persisted per (reader, target), so a parent polling its child pays
   * only for the delta on every check-in. Explicit --since overrides the
   * persisted mark (re-summarize from an older point without losing it is not
   * a goal — the persisted mark still advances).
   */
  async recap(
    input: { sessionId: string; since?: string },
    reader: string,
  ): Promise<SessionRecapResult> {
    const target = resolveSessionIdentifier(input.sessionId, this.deps.listSessions())
    if (!target) throw new Error(`unknown session ${input.sessionId}`)
    this.logRead('session.recap_read', target.sessionId, reader)
    const since =
      input.since ?? this.deps.watermarks.getRecapWatermark(reader, target.sessionId) ?? undefined
    // Delta read when a watermark exists ('after' the cursor); first contact
    // summarizes the latest window instead of the whole history.
    const slice = since
      ? await this.deps.readTranscript({
          sessionId: target.sessionId,
          anchor: since,
          direction: 'after',
          limit: RECAP_ITEM_CAP,
        })
      : await this.deps.readTranscript({
          sessionId: target.sessionId,
          direction: 'before',
          limit: RECAP_ITEM_CAP,
        })
    const items = slice.items
    if (items.length === 0) {
      return {
        sessionId: target.sessionId,
        recap: since
          ? `No new activity since watermark ${since}.`
          : 'No transcript items found for this session.',
        watermark: since ?? null,
        newItems: 0,
        delta: since !== undefined,
      }
    }
    const head = buildBtwRecap(items)
    const body = since
      ? buildBtwDelta({ prev: { itemId: since }, delta: items, now: this.deps.now() })
      : `Latest activity (${items.length} items):\n${items.map(lineForItem).join('\n')}`
    const recap = `${head}\n\n${body}`.slice(0, RECAP_CHAR_CAP)
    // The watermark is the newest item's cursor (the transcriptRead paging
    // anchor). Items without a cursor keep the previous mark rather than
    // corrupting it.
    const last = [...items].reverse().find((i) => i.cursor)
    const watermark = last?.cursor ?? since ?? null
    if (watermark) {
      this.deps.watermarks.setRecapWatermark(reader, target.sessionId, watermark, this.deps.now())
    }
    return {
      sessionId: target.sessionId,
      recap,
      watermark,
      newItems: items.length,
      delta: since !== undefined,
    }
  }

  /** Event-log every cross-session read [spec:SP-34d7 read-toolkit authz]. */
  private logRead(kind: string, sessionId: string, reader: string): void {
    try {
      this.deps.events.appendEvent({
        ts: this.deps.now(),
        kind,
        subject: sessionId,
        payload: { reader },
      })
    } catch {}
  }
}
