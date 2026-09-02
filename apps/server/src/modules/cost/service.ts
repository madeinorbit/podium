/**
 * WHAT A TASK COST (POD-1858) — the read path, and the fold that fills it.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE WALK IS NOT OURS. WE ATTRIBUTE THE ONE THAT ALREADY HAPPENS.
 * ─────────────────────────────────────────────────────────────────────────────
 * Measured on this machine, a live scan is 856ms for ONE task and 69.9s for all
 * of them, and `exec.ts` says in its own comment why a second walk is not on
 * offer: the existing usage scan runs on the daemon's event loop, the loop that
 * carries every agent's keystrokes, which is why it is memoised for 120s and
 * serves stale while rescanning. So this service adds no scan. It rides the
 * usage read the sheet and the status chip already make, and folds the per-file
 * half of that answer into durable rows — the same shape `quota.summary` uses,
 * where the write is a fold of what was just read.
 *
 * `ingest` is therefore the ONLY writer, and every read below is a DB read that
 * touches no transcript. That is what "never block a render" means here: the
 * task-detail path cannot walk the disk, because it has no code that could.
 *
 * THE CLAIM STOPS THERE. Adding no second walk is not the same as making the
 * first one safe: the harvest still runs on the daemon's event loop, and this
 * feature did not move it off. See the header of `apps/daemon/src/usage-scan.ts`
 * for the measurements and for what would still have to be built.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ONE INDEXED LOOKUP PER FILE, NEVER PER RECORD
 * ─────────────────────────────────────────────────────────────────────────────
 * A 7-day harvest is ~28,000 usage records across ~400 transcripts. Resolving
 * per record would be seventy times the work for the same answer, so resolution
 * is per PATH, batched: paths → segments (`conversation_segments_path`), native
 * ids → sessions (`idx_sessions_machine_resume`), and for a delegate transcript
 * the parent-conversation edge → the session that spawned it.
 *
 * THE PARENT HOP IS NOT A NICETY. A Claude session's subagents write their own
 * transcripts and have no session row of their own; on this machine they carried
 * $85 of Claude spend in one 7-day window. Without the hop that money is
 * unattributed, and the floor rule — "any Claude session is fully counted" —
 * stops being true.
 */

import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  type ConversationId,
  type CostHarness,
  type CostModelTotalWire,
  type CostTotalsWire,
  descendantsOf,
  floorOf,
  foldModelTotals,
  type IssueId,
  type MachineId,
  messagesOf,
  type SessionCostWire,
  type SessionId,
  type TaskCostRowWire,
  type TaskCostWire,
  taskCostState,
  type UsageModelTotalWire,
  type UsageSourceWire,
} from '@podium/model'
import { formatIssueRef } from '@podium/protocol'
import type { SessionStore } from '../../store'
import type { TranscriptCostRecord } from '../../store/transcript-costs'
import type { SessionRow } from '../../store/types'

/**
 * The composite key a transcript is held under while a harvest is resolved.
 *
 * THE SEPARATOR IS THE ESCAPE `\u0000`, NEVER A LITERAL NUL BYTE. A literal one
 * makes this whole file binary to git and to every search tool — `grep -n` and
 * `rg -n` suppress line hits in it, so the heart of this feature stops being
 * diffable, blamable or greppable by the next person. `bun run lint:no-nul`
 * enforces exactly this and names this file when it regresses. NUL is still the
 * right separator: it is the one byte that cannot occur in a machine id or a
 * native id, so no pair of them can collide by concatenation.
 */
const transcriptKey = (machineId: MachineId, nativeId: string): string =>
  `${machineId}\u0000${nativeId}`

/** A session that is still producing tokens — its figure is provisional. */
const RUNNING: ReadonlySet<SessionRow['status']> = new Set(['live', 'starting', 'reconnecting'])

/** How far a delegate chain is followed to the session that owns it. Subagents
 *  nest, but not deeply; the bound is what stops a cyclic identity row looping. */
const MAX_PARENT_HOPS = 4

const EMPTY_TOTALS: CostTotalsWire = { models: [], messages: 0, sessionCount: 0 }

export class CostService {
  constructor(private readonly store: SessionStore) {}

  /**
   * Fold one machine's harvest into the durable rows.
   *
   * Sources that resolve to no conversation segment are DROPPED rather than
   * stored unattributed: they are Codex rollouts nobody launched through Podium
   * (a `guardian` subagent has no Podium session at all), they have no stable
   * key to store under, and the sheet already states the resulting gap once, in
   * its provenance bar. Returns how many rows were written, for the caller's log.
   */
  ingest(machineId: MachineId, sources: readonly UsageSourceWire[], sinceMs: number): number {
    if (sources.length === 0) return 0
    const registry = this.store.conversations.registry

    // A Grok "transcript" is a session snapshot the scan reads from
    // `signals.json`, while the registry indexes its sibling `summary.json`.
    // Both candidates go into the one batch lookup so it stays a single query.
    const candidates = new Map<string, string[]>()
    for (const s of sources) {
      candidates.set(
        s.path,
        s.harness === 'grok' ? [s.path, join(dirname(s.path), 'summary.json')] : [s.path],
      )
    }
    const segments = registry.segmentsByPaths(machineId, [...candidates.values()].flat())

    const resolved = new Map<
      string,
      { machineId: MachineId; nativeId: string; podiumId: ConversationId }
    >()
    for (const [path, tries] of candidates) {
      for (const candidate of tries) {
        const segment = segments.get(candidate)
        if (segment) {
          resolved.set(path, segment)
          break
        }
      }
    }

    const owners = this.resolveOwners([...resolved.values()])
    const nowIso = new Date().toISOString()
    const records: TranscriptCostRecord[] = []
    for (const source of sources) {
      const segment = resolved.get(source.path)
      if (!segment) continue
      const owner = owners.get(transcriptKey(segment.machineId, segment.nativeId))
      records.push({
        machineId: segment.machineId,
        nativeId: segment.nativeId,
        path: source.path,
        harness: source.harness,
        sessionId: owner?.id ?? null,
        issueId: owner?.issueId ?? null,
        scannedBytes: source.scannedBytes,
        firstTsMs: source.firstTsMs,
        lastTsMs: source.lastTsMs,
        models: source.models.map(normaliseModelTotal),
        windowModels: source.windowModels.map(normaliseModelTotal),
        windowSinceMs: sinceMs,
      })
    }
    this.store.transcriptCosts.record(records, nowIso)
    return records.length
  }

  /**
   * Which session owns each of these transcripts.
   *
   * Direct hit first: a segment's native id IS a session's `resumeValue`. What
   * misses is a delegate transcript, which is followed up its parent-conversation
   * edge to the session that spawned it — one batched round per hop, so a
   * thousand delegates cost four queries and not four thousand.
   */
  private resolveOwners(
    segments: readonly { machineId: MachineId; nativeId: string; podiumId: ConversationId }[],
  ): Map<string, SessionRow> {
    const registry = this.store.conversations.registry
    const out = new Map<string, SessionRow>()
    let open = segments.map((s) => ({ key: transcriptKey(s.machineId, s.nativeId), ...s }))
    let searchIds = open.map((s) => s.nativeId)

    for (let hop = 0; hop <= MAX_PARENT_HOPS && open.length > 0; hop += 1) {
      const found = this.preferredSessionsByResumeValue(searchIds)
      const stillOpen: typeof open = []
      const climbing: ConversationId[] = []
      for (const entry of open) {
        const session = found.get(entry.nativeId)
        if (session) {
          out.set(entry.key, session)
          continue
        }
        stillOpen.push(entry)
        climbing.push(entry.podiumId)
      }
      open = stillOpen
      if (open.length === 0 || hop === MAX_PARENT_HOPS) break

      // Climb: each unresolved conversation becomes its parent, and the parent's
      // own segments supply the native ids the next round looks sessions up by.
      const parents = registry.parentPodiumIds(climbing)
      const nativeIds = registry.nativeIdsByPodiumIds([...new Set(parents.values())])
      const next: typeof open = []
      const nextSearch: string[] = []
      for (const entry of open) {
        const parent = parents.get(entry.podiumId)
        if (!parent) continue
        const candidates = nativeIds.get(parent) ?? []
        if (candidates.length === 0) continue
        // The conversation's FIRST segment is the launch Podium knows by
        // `resumeValue`; later ones are the same thread rolled into new files.
        const nativeId = candidates[0] as string
        next.push({ key: entry.key, machineId: entry.machineId, nativeId, podiumId: parent })
        nextSearch.push(nativeId)
      }
      open = next
      searchIds = nextSearch
    }
    return out
  }

  /**
   * One session per resume value, chosen EXPLICITLY rather than by row order.
   *
   * Two session rows can name the same native conversation — five pairs on this
   * machine — and in the live case one of them carries an `issueId` and the
   * other does not. Taking whichever row SQL returned first therefore decides,
   * by accident, whether that transcript is attributed to a task at all. The
   * order is stated instead: a session that names an issue beats one that does
   * not, and among equals the most recently created wins, because that is the
   * row a resume produced. Ties fall back to the repository's own stable order.
   */
  private preferredSessionsByResumeValue(resumeValues: string[]): Map<string, SessionRow> {
    const out = new Map<string, SessionRow>()
    for (const [resumeValue, candidates] of this.store.sessions.listSessionsByResumeValues(
      resumeValues,
    )) {
      let best = candidates[0]
      if (!best) continue
      for (const candidate of candidates.slice(1)) {
        const bestHasIssue = best.issueId != null
        const candidateHasIssue = candidate.issueId != null
        if (bestHasIssue !== candidateHasIssue) {
          if (candidateHasIssue) best = candidate
          continue
        }
        if (candidate.createdAt > best.createdAt) best = candidate
      }
      out.set(resumeValue, best)
    }
    return out
  }

  /**
   * One task's accounting: its own cost, its rollup, and the four states.
   *
   * Own and rollup are built separately and neither is derivable from the other
   * — see `TaskCostWire`. Both are DB reads over indexed columns; nothing here
   * opens a transcript.
   */
  task(issueId: IssueId): TaskCostWire {
    const childrenByParent = new Map<string, string[]>()
    for (const edge of this.store.issues.listIssueParentEdges()) {
      if (!edge.parentId) continue
      const list = childrenByParent.get(edge.parentId)
      if (list) list.push(edge.id)
      else childrenByParent.set(edge.parentId, [edge.id])
    }
    const descendants = descendantsOf(issueId, childrenByParent) as IssueId[]
    const scope = [issueId, ...descendants]

    const costs = this.store.transcriptCosts.forIssues(scope)
    const sessions = this.store.sessions.findSessionsByIssueIds(scope)
    const sessionById = new Map(sessions.map((s) => [s.id as string, s]))

    const ownCosts = costs.filter((c) => c.issueId === issueId)
    const own = totalsOf(ownCosts)
    const rollup = totalsOf(costs)

    const harnesses = [
      ...new Set(costs.filter((c) => c.messages > 0).map((c) => c.harness)),
    ].sort() as CostHarness[]

    // The three cold states, decided over the sessions the task HAS rather than
    // over the rows we happen to hold. A session with a transcript we have not
    // read yet is `pending`; one with no transcript to read is `not-recorded`.
    const costedSessions = new Set(
      costs.filter((c) => c.messages > 0 && c.sessionId).map((c) => c.sessionId as string),
    )
    const readSessions = new Set(costs.filter((c) => c.sessionId).map((c) => c.sessionId as string))
    const recordedPaths = this.recordedTranscriptPaths(sessions)
    let pendingSessionCount = 0
    for (const session of sessions) {
      if (readSessions.has(session.id)) continue
      if (recordedPaths.has(session.id)) pendingSessionCount += 1
    }

    // THE FLOOR'S OTHER REASON. A session in scope with no cost row at all has
    // never been harvested (or its transcript is gone), so the figure is a lower
    // bound whatever harness ran it — see `floorOf`. Counted over the ROLLUP
    // scope, because that is the figure the mark describes.
    const uncostedSessionCount = sessions.filter((s) => !readSessions.has(s.id)).length

    return {
      issueId,
      state: taskCostState({
        sessionCount: sessions.length,
        costedSessionCount: costedSessions.size,
        pendingSessionCount,
      }),
      own,
      rollup,
      descendantCount: descendants.length,
      provisional: sessions.some((s) => RUNNING.has(s.status)),
      floor: floorOf(harnesses, uncostedSessionCount),
      harnesses,
      uncostedSessionCount,
      // The newest harvest behind ANY row under this task, own or descendant —
      // the figure is only as fresh as the least recently read row it contains,
      // but the reading a surface reports is when we last looked at all.
      ...stampOf(costs),
      sessions: ownCosts
        .filter((c) => c.messages > 0)
        .map((c): SessionCostWire => {
          const session = c.sessionId ? sessionById.get(c.sessionId) : undefined
          return {
            sessionId: (c.sessionId as SessionId | null) ?? null,
            title: session?.name ?? session?.title ?? null,
            harness: c.harness,
            running: session ? RUNNING.has(session.status) : false,
            models: c.models,
            firstTsMs: c.firstTsMs,
            lastTsMs: c.lastTsMs,
          }
        })
        .sort((a, b) => tokensOf(b.models) - tokensOf(a.models)),
    }
  }

  /**
   * Every task with a stored figure, as the sheet's ranked table and the rate
   * cohort read it. OWN cost per task, not rolled up: the table lists tasks, and
   * a rolled-up parent beside its own children would count the same money twice
   * down one column.
   */
  tasks(): TaskCostRowWire[] {
    const costs = this.store.transcriptCosts.allAttributed()
    const byIssue = new Map<string, typeof costs>()
    for (const cost of costs) {
      if (!cost.issueId) continue
      const list = byIssue.get(cost.issueId)
      if (list) list.push(cost)
      else byIssue.set(cost.issueId, [cost])
    }
    const issues = this.store.issues.getIssues([...byIssue.keys()])
    // Sessions per task, in ONE query rather than one per row, so the sheet can
    // say which figures are floors for lack of a harvest as well as for harness.
    const sessionsByIssue = new Map<string, string[]>()
    for (const session of this.store.sessions.findSessionsByIssueIds([
      ...byIssue.keys(),
    ] as IssueId[])) {
      if (!session.issueId) continue
      const list = sessionsByIssue.get(session.issueId)
      if (list) list.push(session.id)
      else sessionsByIssue.set(session.issueId, [session.id])
    }
    // ROLLUP FOR EVERY COSTED TASK, IN ONE LINEAR PASS. Each costed task pushes
    // its own folds onto itself and every ancestor, rather than each task
    // walking down its own subtree — the same totals, without re-reading a deep
    // epic's descendants once per level. The visited set is the cycle guard
    // `parent_id` does not have.
    const parentOf = new Map<string, string>()
    for (const edge of this.store.issues.listIssueParentEdges()) {
      if (edge.parentId) parentOf.set(edge.id, edge.parentId)
    }
    const rollupParts = new Map<string, CostModelTotalWire[][]>()
    for (const [issueId, list] of byIssue) {
      const own = list.map((c) => c.models)
      const seen = new Set<string>()
      let cursor: string | undefined = issueId
      while (cursor !== undefined && !seen.has(cursor)) {
        seen.add(cursor)
        const acc = rollupParts.get(cursor)
        if (acc) acc.push(...own)
        else rollupParts.set(cursor, [...own])
        cursor = parentOf.get(cursor)
      }
    }
    // A row written for an OLDER window is a file the latest walk skipped on
    // mtime — no activity in the current window, so its stored window fold
    // reads as zero rather than as last week's number.
    const currentWindow = this.store.transcriptCosts.latestWindowSinceMs()
    const rows: TaskCostRowWire[] = []
    for (const [issueId, list] of byIssue) {
      const issue = issues.get(issueId)
      // Hard-missing OR tombstoned: issues are SOFT-deleted, so `getIssues`
      // still returns one the operator has deleted. Ranking it would put a task
      // in the sheet that exists nowhere else in the app, and — worse — count
      // it into `taskCount`, the median, the top-ten share and the cohort every
      // "x median" on every surface is measured against.
      if (!issue || issue.deletedAt) continue
      const totals = totalsOf(list)
      if (totals.messages === 0) continue
      const windowModels = foldModelTotals(
        list.filter((c) => c.windowSinceMs >= currentWindow).map((c) => c.windowModels),
      )
      const rollupModels = foldModelTotals(rollupParts.get(issueId) ?? [])
      const harnesses = [
        ...new Set(list.filter((c) => c.messages > 0).map((c) => c.harness)),
      ].sort() as CostHarness[]
      // Own scope: this row's floor describes this row's own figure, which is
      // the column the sheet ranks by.
      const read = new Set(list.filter((c) => c.sessionId).map((c) => c.sessionId as string))
      const uncostedSessionCount = (sessionsByIssue.get(issueId) ?? []).filter(
        (id) => !read.has(id),
      ).length
      const prefix = this.store.repos.prefixForPath(issue.repoPath)
      rows.push({
        issueId: issueId as IssueId,
        seq: issue.seq,
        // The ref the rest of the app prints. Without it every row in the sheet
        // reads `#1234` while the deck, the panel and the CLI read `POD-1234`,
        // and a ref you cannot paste is a ref you cannot chase.
        displayRef: prefix ? formatIssueRef(prefix, issue.seq) : `#${issue.seq}`,
        title: issue.title,
        stage: issue.stage,
        models: totals.models,
        messages: totals.messages,
        windowModels,
        windowMessages: messagesOf(windowModels),
        rollupModels,
        rollupMessages: messagesOf(rollupModels),
        sessionCount: totals.sessionCount,
        floor: floorOf(harnesses, uncostedSessionCount),
        harnesses,
        uncostedSessionCount,
        ...stampOf(list),
      })
    }
    return rows
  }

  /**
   * Which of these sessions point at a transcript THAT IS STILL ON DISK.
   *
   * A registry row naming a path is not evidence the file exists: transcripts
   * are pruned, and the row outlives them. Measured, 165 of the 488 transcripts
   * behind a sample of tasks were already gone, and every one of them read as
   * `pending` — "we have not got to it yet" — when the truth is `not-recorded`,
   * a file nothing will ever read. That is the difference between a slot that
   * will fill and one that never will, which is exactly what these states are
   * for, so the check is a stat and not a row lookup.
   *
   * ONLY THIS MACHINE'S FILES CAN BE STATTED. A session on another host has a
   * path this process cannot see, so it is credited as recorded rather than
   * declared missing: claiming a remote transcript is gone because we cannot
   * reach it would be the same lie in the other direction.
   */
  private recordedTranscriptPaths(sessions: readonly SessionRow[]): Set<string> {
    const out = new Set<string>()
    const byMachine = new Map<MachineId, string[]>()
    for (const session of sessions) {
      if (!session.resumeValue || !session.machineId) continue
      const list = byMachine.get(session.machineId)
      if (list) list.push(session.resumeValue)
      else byMachine.set(session.machineId, [session.resumeValue])
    }
    const paths = new Map<string, string>()
    for (const [machine, nativeIds] of byMachine) {
      for (const [nativeId, path] of this.store.conversations.registry.pathsByNativeIds(
        machine,
        nativeIds,
      )) {
        paths.set(transcriptKey(machine, nativeId), path)
      }
    }
    const local = this.store.hostMachineId
    // One stat per DISTINCT path, memoised across the sessions of one task —
    // a resumed conversation names the same file from several session rows.
    const onDisk = new Map<string, boolean>()
    for (const session of sessions) {
      if (!session.resumeValue || !session.machineId) continue
      const path = paths.get(transcriptKey(session.machineId, session.resumeValue))
      if (!path) continue
      if (session.machineId !== local) {
        out.add(session.id)
        continue
      }
      let exists = onDisk.get(path)
      if (exists === undefined) {
        exists = existsSync(path)
        onDisk.set(path, exists)
      }
      if (exists) out.add(session.id)
    }
    return out
  }
}

/**
 * When these rows were last read, as an optional field ready to spread.
 *
 * OMITTED RATHER THAN DEFAULTED when there is nothing behind the figure: a task
 * with no rows has no read time, and stamping it with `now` would claim we had
 * checked something we never looked at — the same class of lie as a confident
 * zero, which is what the four states exist to prevent.
 */
function stampOf(costs: readonly { updatedAt: string }[]): { sampledAt?: string } {
  let newest = ''
  for (const cost of costs) if (cost.updatedAt > newest) newest = cost.updatedAt
  return newest ? { sampledAt: newest } : {}
}

function totalsOf(costs: readonly { models: CostModelTotalWire[]; sessionId: string | null }[]) {
  const models = foldModelTotals(costs.map((c) => c.models))
  const sessionIds = new Set(costs.filter((c) => c.sessionId).map((c) => c.sessionId as string))
  return models.length === 0 && sessionIds.size === 0
    ? EMPTY_TOTALS
    : { models, messages: messagesOf(models), sessionCount: sessionIds.size }
}

const tokensOf = (models: readonly CostModelTotalWire[]): number =>
  models.reduce(
    (n, m) => n + m.inputTokens + m.outputTokens + m.cacheReadTokens + m.cacheCreationTokens,
    0,
  )

/** The wire's 1h cache field is optional; the stored shape is not. */
const normaliseModelTotal = (m: UsageModelTotalWire): CostModelTotalWire => ({
  ...m,
  cacheCreation1hTokens: m.cacheCreation1hTokens ?? 0,
})
