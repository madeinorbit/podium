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

import type {
  SessionId,
  SessionMeta,
  SessionReadResult,
  SessionRecapResult,
  SessionStatusResult,
  SessionStatusSubagent,
  TranscriptItem,
  MachineId,
} from '@podium/model'
import { parseSessionRef, resolveSessionIdentifier } from '@podium/protocol'
import { selectMailNudgeSession, sessionsForIssue } from '../../issue-util'
import type { EventsRepository } from '../../store/events'
import type { ReadWatermarksRepository } from '../../store/read-watermarks'
import type { IssueService } from '../issues/service'
import type { MessageDeliveryService } from '../messages/service'
import { buildBtwDelta, buildBtwRecap, lineForItem } from '../superagent/btw'
import type { SessionFacts } from './facts'

/** Hard caps: transcript lines per read call and turns per window. */
export const READ_LINE_CAP = 200
export const READ_TURN_CAP = 50
/** Recap (tier 3): max transcript items summarized per call and max recap chars. */
export const RECAP_ITEM_CAP = 400
export const RECAP_CHAR_CAP = 12_000

/** The read models now live in `@podium/model` so `apps/cli` can name them too
 *  (POD-366, inventory §2.1 #22). Re-exported here because this module is the
 *  server's read-toolkit entry point and its consumers import them from it — the
 *  definition moved, the import surface did not. `SessionStatusSubagent` and the
 *  runtime keys ab75ab1e added to `SessionStatusResult` moved with them. */
export type {
  SessionReadResult,
  SessionRecapResult,
  SessionStatusResult,
  SessionStatusSubagent,
}

export interface SessionReadToolkitDeps {
  /**
   * THE CHEAP FLEET READ [POD-3857]. Every question this toolkit asks of the
   * fleet — which session does this ref name, which issue's members are
   * candidates, which sessions descend from this one — is decided by fields the
   * live registry already holds. Only the sessions that SURVIVE those decisions
   * are wired, through the two narrow reads below.
   */
  sessionFacts(): SessionFacts[]
  /** ONE session by id, wired [POD-1646]. */
  sessionById(sessionId: SessionId): Promise<SessionMeta | undefined>
  /** A KNOWN SET, wired [POD-2322] — the subagent tree, once it is known. */
  sessionsById(sessionIds: Iterable<SessionId>): Promise<SessionMeta[]>
  issues: IssueService
  messages: MessageDeliveryService
  events: Pick<EventsRepository, 'appendEvent'>
  /** Persisted per-(reader, target) recap watermarks (tier 3). */
  watermarks: Pick<ReadWatermarksRepository, 'getRecapWatermark' | 'setRecapWatermark'>
  /** Allowlisted daemon git op ('log' → oneline -20, 'status' → porcelain -b). */
  repoOp(
    op: 'log' | 'status',
    cwd: string,
    machineId?: MachineId,
  ): Promise<{ ok: boolean; output: string }>
  /** The uuid-cursor transcript window read (modules/machines/rpc.readTranscript). */
  readTranscript(input: {
    sessionId: SessionId
    anchor?: string
    direction: 'before' | 'after'
    limit: number
  }): Promise<{ items: TranscriptItem[]; hasMore: boolean }>
  now(): string
}

/**
 * WHO is reading — a Podium session, or the operator (POD-362).
 *
 * NOT a bare `SessionId`: `router.ts` passes `capability.actorSessionId ??
 * 'operator'`, and `'operator'` is a SENTINEL, not an id. Branding it would
 * launder a non-id into the session space — the same mistake ADR 1 Am2 D16.2
 * carves MachineId's 'local' out to prevent. As a union the sentinel stays
 * visible and every consumer that cares must narrow.
 */
export type ReaderRef = SessionId | 'operator' | 'superagent' | `superagent:${string}`

// The `superagent:` arm is NOT decoration: `superagent/tools.ts` passes
// `superagent:${threadId}` (a THREAD id, a different brand) or the bare
// 'superagent' string. The union found it — a `SessionId` reader type would have
// needed a cast there and buried a third reader kind.

export class SessionReadToolkit {
  constructor(private readonly deps: SessionReadToolkitDeps) {}

  private phaseOf(session: {
    agentState?: { phase?: string | undefined } | undefined
    busy?: boolean | undefined
  }): string {
    const phase = session.agentState?.phase
    if (phase === 'needs_user') return 'blocked'
    return phase ?? (session.busy ? 'working' : 'idle')
  }

  /**
   * The spawn subtree under one session.
   *
   * The WALK runs on facts — `spawnedBy` is a plain durable field — and only
   * the descendants it finds are wired [POD-3857]. That matters here more than
   * anywhere else in this file: the walk is over the WHOLE fleet at every level
   * of the queue, and a status read on a session with no children used to build
   * the full reader-scoped projection to discover exactly that.
   *
   * `displayRef` is why the survivors still need wiring: it resolves the ref
   * issue's row and its repo prefix, which is a store read per session and so
   * cannot come from memory.
   */
  private async subagentsOf(target: { sessionId: SessionId }): Promise<SessionStatusSubagent[]> {
    const all = this.deps.sessionFacts()
    const found: Array<{ child: SessionFacts; parentSessionId: SessionId }> = []
    const seen = new Set([target.sessionId])
    const queue: SessionId[] = [target.sessionId]
    while (queue.length > 0) {
      const parentSessionId = queue.shift()
      if (!parentSessionId) break
      for (const child of all) {
        if (seen.has(child.sessionId)) continue
        if (child.spawnedBy !== `session:${parentSessionId}`) continue
        seen.add(child.sessionId)
        queue.push(child.sessionId)
        found.push({ child, parentSessionId })
      }
    }
    if (found.length === 0) return []
    const wired = new Map(
      (await this.deps.sessionsById(found.map((f) => f.child.sessionId))).map((s) => [
        s.sessionId,
        s,
      ]),
    )
    // AN INVISIBLE ANCESTOR HIDES ITS DESCENDANTS, as it did before POD-3857.
    //
    // The walk above runs on facts, which have no visibility rule, so it
    // reaches children the old walk never got to: that one enumerated a
    // reader-scoped list, so an unreadable child was simply not there to be
    // queued, and its own children were unreachable through it. Dropping only
    // the unreadable rows at the end would therefore PROMOTE a hidden session's
    // children into a reader's view. Re-walk from the target instead, admitting
    // a session only when it is readable AND its parent was kept.
    const visible = new Set([target.sessionId])
    let grew = true
    while (grew) {
      grew = false
      for (const { child, parentSessionId } of found) {
        if (visible.has(child.sessionId)) continue
        if (!visible.has(parentSessionId) || !wired.has(child.sessionId)) continue
        visible.add(child.sessionId)
        grew = true
      }
    }
    const result: SessionStatusSubagent[] = []
    for (const { child, parentSessionId } of found) {
      if (!visible.has(child.sessionId)) continue
      const displayRef = wired.get(child.sessionId)?.displayRef
      result.push({
        sessionId: child.sessionId,
        ...(displayRef ? { displayRef } : {}),
        parentSessionId,
        harness: child.agentKind,
        model: child.observedModel ?? child.requestedModel ?? child.model ?? null,
        effort: child.observedEffort ?? child.requestedEffort ?? child.effort ?? null,
        contextUsagePercent: child.contextUsagePercent ?? null,
        status: child.status,
        phase: this.phaseOf(child),
      })
    }
    return result
  }

  /**
   * A SESSION IDENTIFIER, RESOLVED WITHOUT A FLEET PASS [POD-3857].
   *
   * An internal id answers off facts alone — that is the overwhelmingly common
   * case and it costs a `find`. A human-facing BIRTH REF cannot: `displayRef`
   * is formatted from the ref issue's row and its repo's prefix, so it lives
   * only on the projection.
   *
   * What makes the ref case cheap anyway is that the ref's own SHAPE narrows
   * the candidates first. `PREFIX-seq-LETTER` can only be a session holding
   * that letter, and `PREFIX-DRAFT-n` only one holding that draft ordinal — a
   * handful of sessions across the fleet, and usually exactly one. Those are
   * wired, and {@link resolveSessionIdentifier} then makes the SAME comparison
   * against the SAME formatted string it always did. A ref that matches nothing
   * still matches nothing.
   */
  private async resolveFacts(
    identifier: string,
    all: readonly SessionFacts[],
  ): Promise<SessionFacts | undefined> {
    const direct = all.find((session) => session.sessionId === identifier)
    if (direct) return direct
    const parsed = parseSessionRef(identifier)
    if (!parsed) return undefined
    const candidates = all.filter((session) =>
      parsed.letter !== undefined
        ? session.refLetter === parsed.letter
        : session.refDraft === parsed.draft,
    )
    if (candidates.length === 0) return undefined
    const wired = await this.deps.sessionsById(candidates.map((c) => c.sessionId))
    const hit = resolveSessionIdentifier(identifier, wired)
    return hit ? all.find((session) => session.sessionId === hit.sessionId) : undefined
  }

  /**
   * A session identifier the READER MAY SEE.
   *
   * Facts carry no visibility — they are the server's own view of its fleet —
   * so a transcript read resolves through them and then confirms against the
   * by-id projection, which applies `canReadSession` for the same principal the
   * full list applied it for. Before POD-3857 the visibility check came for
   * free, because the list this resolved against was already reader-scoped;
   * this keeps that property rather than inheriting it. It matters here more
   * than anywhere else in this file: what follows a successful resolve is
   * transcript text, which can carry secrets.
   */
  private async resolveVisible(identifier: string): Promise<SessionMeta | undefined> {
    const found = await this.resolveFacts(identifier, this.deps.sessionFacts())
    return found ? await this.deps.sessionById(found.sessionId) : undefined
  }

  /** Resolve a status ref — a session id/birth ref, or an issue ref
   *  (#N/seq/id) whose best member session (live preferred, else most recent
   *  agent) is picked. */
  async resolveTarget(ref: string): Promise<SessionFacts | undefined> {
    const all = this.deps.sessionFacts()
    const direct = await this.resolveFacts(ref, all)
    if (direct) return direct
    let issueId: string
    try {
      issueId = await this.deps.issues.resolveRef(ref)
    } catch {
      return undefined
    }
    const issue = await this.deps.issues.getMeta(issueId)
    if (!issue) return undefined
    const members = sessionsForIssue(issue.worktreePath ?? null, all, issue.id)
    const live = selectMailNudgeSession(members)
    if (live) return members.find((s) => s.sessionId === live.sessionId)
    return [...members]
      .filter((s) => s.agentKind !== 'shell')
      .sort((a, b) => (b.lastActiveAt ?? '').localeCompare(a.lastActiveAt ?? ''))
      .at(0)
  }

  /** Resolve a ref and project it, for callers that hold no opinion about WHICH
   *  session a ref names. A caller that must AUTHORIZE the target resolves it
   *  itself and calls {@link statusOf} with the id it checked — see the note
   *  there on why the two steps cannot be split across two resolutions. */
  async status(ref: string, reader: ReaderRef): Promise<SessionStatusResult> {
    const found = await this.resolveTarget(ref)
    if (!found) throw new Error(`no session found for ${ref}`)
    return await this.statusOf(found.sessionId, reader)
  }

  /**
   * The status projection over an ALREADY-RESOLVED session [PDM-229].
   *
   * Split out because an authorizing caller must project the same session it
   * checked. `resolveTarget` over an ISSUE ref picks the issue's best member —
   * live preferred — so resolving once to authorize and again to project opens
   * a window in which the live member changes and the answer describes a
   * session the caller was never granted. The id is the authorization subject,
   * so the id is what the projection takes.
   */
  async statusOf(sessionId: SessionId, reader: ReaderRef): Promise<SessionStatusResult> {
    // SELECTED from facts, WIRED once [POD-3857]. The status payload names the
    // machine and the bound driver, and `machineName` is resolved by the
    // machines service rather than held on the session, so the ONE session this
    // read is about goes through the by-id projection. Whoever resolved this id
    // — `status` above, or an authorizing caller — chose it from facts alone,
    // projecting nothing.
    const target = await this.deps.sessionById(sessionId)
    if (!target) throw new Error(`no session found for ${sessionId}`)
    await this.logRead('session.status_read', target.sessionId, reader)
    const issues = this.deps.issues
    const issueId = target.issueId ?? issues.issueForCwd(target.cwd)
    // Full wire is intentional: status surfaces the derived panel todo projection.
    const issue = issueId ? await issues.get(issueId) : null
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
    const agentPhase = target.agentState?.phase
    const phase = this.phaseOf(target)
    const error = agentPhase === 'errored' ? (target.agentState?.error ?? null) : null
    return {
      sessionId: target.sessionId,
      agentKind: target.agentKind,
      harness: target.agentKind,
      driverId: target.driverId ?? null,
      requestedDriverId: target.requestedDriverId ?? null,
      status: target.status,
      phase,
      machine: target.machineName || target.machineId || null,
      /**
       * OBSERVED, THEN REQUESTED, THEN LAUNCHED (POD-3081).
       *
       * ONE FIELD CANNOT SAY "asked for Y, still answering as X", so this read
       * answers the question it is actually asked — WHAT IS ANSWERING — and the
       * observation keeps precedence even right after a sticky configure. That
       * is not a gap: `configure` on every headless driver is `next-turn`, so a
       * session mid-turn genuinely IS still on the old model, and reporting the
       * new one here would be the change-looks-applied misreport this whole axis
       * exists to stop. The next assistant turn re-stamps `observedModel` and
       * the two agree again.
       *
       * The REQUESTED arm is what makes the window between them honest rather
       * than blank: a session configured before it has ever been observed has no
       * observation to fall back on, and the launch value — the weakest of the
       * three claims — would otherwise name a model nobody is on any more.
       * Consumers that need to show BOTH halves read `requestedModel` and
       * `observedModel` off `SessionMeta`; this is the single-value read.
       */
      model: target.observedModel ?? target.requestedModel ?? target.model ?? null,
      effort: target.observedEffort ?? target.requestedEffort ?? target.effort ?? null,
      contextUsagePercent: target.contextUsagePercent ?? null,
      account: target.accountId ?? null,
      error,
      draft: target.draftUpdatedAt !== undefined,
      nativeSubagentCount: target.agentState?.nativeSubagentCount ?? 0,
      nativeSubagents: target.agentState?.nativeSubagents ?? [],
      subagents: await this.subagentsOf(target),
      issue: issue ? { seq: issue.seq, stage: issue.stage, title: issue.title, todos } : null,
      commits: lines(log).slice(0, 5),
      // First porcelain -b line is the branch header — keep it (names the branch),
      // then the touched files, capped so status stays ~200 tokens.
      files: lines(status).slice(0, 21),
      unackedMessages: (await this.deps.messages.deliveredUnacked(target.sessionId)).length,
    }
  }

  async read(
    input: { sessionId: SessionId; turns?: number; cursor?: string },
    reader: ReaderRef,
  ): Promise<SessionReadResult> {
    const target = await this.resolveVisible(input.sessionId)
    if (!target) throw new Error(`unknown session ${input.sessionId}`)
    await this.logRead('session.transcript_read', target.sessionId, reader)
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
    input: { sessionId: SessionId; since?: string },
    reader: ReaderRef,
  ): Promise<SessionRecapResult> {
    const target = await this.resolveVisible(input.sessionId)
    if (!target) throw new Error(`unknown session ${input.sessionId}`)
    await this.logRead('session.recap_read', target.sessionId, reader)
    const since =
      input.since ?? await this.deps.watermarks.getRecapWatermark(reader, target.sessionId) ?? undefined
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
      await this.deps.watermarks.setRecapWatermark(reader, target.sessionId, watermark, this.deps.now())
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
  private async logRead(kind: string, sessionId: SessionId, reader: ReaderRef): Promise<void> {
    try {
      await this.deps.events.appendEvent({
        ts: this.deps.now(),
        kind,
        subject: sessionId,
        payload: { reader },
      })
    } catch {}
  }
}
