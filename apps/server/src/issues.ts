import { randomUUID } from 'node:crypto'
import type { PodiumSettings } from '@podium/core'
import { type DoctorReport, type DuplicateCandidate, type EpicStatus, type IssueCount, type IssueGraph, type IssueSearchFilter, type IssueStats, type IssueWire, type LintFinding, type OrphanIssue, type RepoOp, type ServerMessage, type SessionMeta } from '@podium/protocol'
import { jaccard, tokenize } from './issue-similarity'
import { lintIssue } from './issue-lint'
import { sessionsForIssue, slugifyBranch, summarizeSessions } from './issue-util'
import type { IssueRow, SessionStore } from './store'
import { buildAssistantMessages, parseAssistantJson } from './issueAssistant'
import { llmClient } from './llm'
import { type LinearIssue, searchIssues } from './linear'

export interface IssueDeps {
  store: SessionStore
  listSessions(): SessionMeta[]
  getSettings(): PodiumSettings
  /** Spawn a session in the issue's worktree. `initialPrompt` hands the agent its
   *  first prompt at spawn (argv for capable agents, draft-seed fallback otherwise —
   *  resolved inside createSession), which is the race-free way to start the work. */
  spawnSession(o: { cwd: string; agentKind?: string; initialPrompt?: string }): { sessionId: string }
  repoOp(op: RepoOp, cwd: string, args?: Record<string, string>): Promise<{ ok: boolean; output: string }>
  broadcast(msg: ServerMessage): void
  now?(): string
  defaultRepoBranch?(repoPath: string): Promise<string>
  llm?: typeof llmClient
  linearSearch?(key: string, q: string): Promise<LinearIssue[]>
}

export interface CreateIssueInput {
  repoPath: string
  title: string
  description?: string
  parentBranch?: string
  defaultAgent?: string
  startNow: boolean
  linear?: { id?: string; identifier: string; url: string }
  priority?: number
  type?: string
  assignee?: string
  labels?: string[]
  parentId?: string
}

export class IssueService {
  private readonly rows = new Map<string, IssueRow>()
  constructor(private readonly deps: IssueDeps) {
    this.reload()
  }

  /** Clear and re-hydrate the in-memory row map from the store. Lets tests (and
   *  future external mutators) refresh `this.rows` after a direct store write. */
  reload(): void {
    this.rows.clear()
    for (const r of this.deps.store.listIssueRows()) this.rows.set(r.id, r)
  }

  /** Worktree paths of all issues (for cwd-based worker-role resolution). */
  worktreePaths(): string[] {
    return [...this.rows.values()].map((r) => r.worktreePath).filter((p): p is string => !!p)
  }

  private now(): string {
    return this.deps.now ? this.deps.now() : new Date().toISOString()
  }

  private isClosed(row: IssueRow): boolean {
    return row.stage === 'done' || row.closedReason != null
  }

  private isDeferred(row: IssueRow): boolean {
    return row.deferUntil != null && row.deferUntil > this.now()
  }

  /** blocked = open AND ≥1 `blocks` dep whose target issue is not closed. */
  private computeBlocked(row: IssueRow): boolean {
    if (this.isClosed(row)) return false
    return this.deps.store
      .listIssueDeps(row.id)
      .filter((d) => d.type === 'blocks')
      .some((d) => {
        const target = this.rows.get(d.toId)
        return target ? !this.isClosed(target) : false
      })
  }

  toWire(row: IssueRow): IssueWire {
    const sessions = sessionsForIssue(row.worktreePath, this.deps.listSessions())
    const labels = this.deps.store.getIssueLabels(row.id)
    const deps = this.deps.store.listIssueDeps(row.id).map((d) => ({ id: d.toId, type: d.type }))
    const dependents = this.deps.store
      .listDependents(row.id)
      .map((d) => ({ id: d.fromId, type: d.type }))
    const comments = this.deps.store.listIssueComments(row.id)
    const children = [...this.rows.values()].filter((r) => r.parentId === row.id)
    const blocked = this.computeBlocked(row)
    const deferred = this.isDeferred(row)
    const ready = !this.isClosed(row) && !deferred && !blocked
    return {
      id: row.id, repoPath: row.repoPath, seq: row.seq, title: row.title, description: row.description,
      stage: row.stage as IssueWire['stage'], worktreePath: row.worktreePath, branch: row.branch,
      parentBranch: row.parentBranch, defaultAgent: row.defaultAgent,
      ...(row.linearId ? { linearId: row.linearId } : {}),
      ...(row.linearIdentifier ? { linearIdentifier: row.linearIdentifier } : {}),
      ...(row.linearUrl ? { linearUrl: row.linearUrl } : {}),
      ...(row.activityNotes ? { activityNotes: row.activityNotes } : {}),
      ...(row.notesUpdatedAt ? { notesUpdatedAt: row.notesUpdatedAt } : {}),
      ...(row.suggestedStage ? { suggestedStage: row.suggestedStage as IssueWire['stage'] } : {}),
      ...(row.suggestedReason ? { suggestedReason: row.suggestedReason } : {}),
      blockedBy: row.blockedBy,
      ...(row.dependencyNote ? { dependencyNote: row.dependencyNote } : {}),
      ...(row.prUrl ? { prUrl: row.prUrl } : {}),
      priority: row.priority, type: row.type as IssueWire['type'], pinned: row.pinned,
      ...(row.supersededBy ? { supersededBy: row.supersededBy } : {}),
      ...(row.duplicateOf ? { duplicateOf: row.duplicateOf } : {}),
      ...(row.assignee ? { assignee: row.assignee } : {}),
      ...(row.parentId ? { parentId: row.parentId } : {}),
      ...(row.design ? { design: row.design } : {}),
      ...(row.acceptance ? { acceptance: row.acceptance } : {}),
      ...(row.notes ? { notes: row.notes } : {}),
      ...(row.dueAt ? { dueAt: row.dueAt } : {}),
      ...(row.deferUntil ? { deferUntil: row.deferUntil } : {}),
      ...(row.closedReason ? { closedReason: row.closedReason } : {}),
      ...(row.estimateMin != null ? { estimateMin: row.estimateMin } : {}),
      labels, deps, dependents, comments,
      ready, blocked, deferred,
      childCount: children.length,
      childDoneCount: children.filter((c) => this.isClosed(c)).length,
      createdAt: row.createdAt, updatedAt: row.updatedAt, archived: row.archived,
      sessions, sessionSummary: summarizeSessions(sessions),
    }
  }

  list(repoPath?: string): IssueWire[] {
    return [...this.rows.values()]
      .filter((r) => !repoPath || r.repoPath === repoPath)
      .sort((a, b) => (a.repoPath === b.repoPath ? a.seq - b.seq : a.repoPath.localeCompare(b.repoPath)))
      .map((r) => this.toWire(r))
  }
  readyList(repoPath?: string): IssueWire[] {
    return [...this.rows.values()]
      .filter((r) => !repoPath || r.repoPath === repoPath)
      .map((r) => this.toWire(r))
      .filter((w) => w.ready)
      .sort((a, b) => (a.priority !== b.priority ? a.priority - b.priority : a.seq - b.seq))
  }

  blockedList(repoPath?: string): IssueWire[] {
    return [...this.rows.values()]
      .filter((r) => !repoPath || r.repoPath === repoPath)
      .map((r) => this.toWire(r))
      .filter((w) => w.blocked)
      .sort((a, b) => (a.priority !== b.priority ? a.priority - b.priority : a.seq - b.seq))
  }

  graph(repoPath?: string): IssueGraph {
    const rows = [...this.rows.values()].filter((r) => !repoPath || r.repoPath === repoPath)
    const nodes = rows.map((r) => {
      const w = this.toWire(r)
      return {
        id: r.id, seq: r.seq, title: r.title, stage: r.stage as IssueGraph['nodes'][number]['stage'],
        priority: r.priority, type: r.type as IssueGraph['nodes'][number]['type'],
        ready: w.ready, blocked: w.blocked,
      }
    })
    const edges = rows.flatMap((r) =>
      this.deps.store.listIssueDeps(r.id).map((d) => ({ from: r.id, to: d.toId, type: d.type })),
    )
    return { nodes, edges }
  }

  epicStatus(id: string): EpicStatus {
    const row = this.rowOrThrow(id)
    const children = [...this.rows.values()].filter((r) => r.parentId === row.id)
    const childDoneCount = children.filter((c) => this.isClosed(c)).length
    return {
      id: row.id, childCount: children.length, childDoneCount,
      complete: children.length > 0 && childDoneCount === children.length,
    }
  }

  closeEligibleEpics(repoPath?: string): IssueWire[] {
    return [...this.rows.values()]
      .filter((r) => (!repoPath || r.repoPath === repoPath) && r.type === 'epic' && !this.isClosed(r))
      .filter((r) => this.epicStatus(r.id).complete)
      .map((r) => this.toWire(r))
  }

  /** Mechanical (Jaccard) duplicate detection over open issues in a repo.
   *  Returns id pairs (`a.seq < b.seq`) whose token-set similarity over
   *  `title + ' ' + description` is >= threshold, sorted by score desc. */
  findDuplicates(repoPath?: string, threshold = 0.6): DuplicateCandidate[] {
    const open = [...this.rows.values()]
      .filter((r) => (!repoPath || r.repoPath === repoPath) && !this.isClosed(r))
      .sort((a, b) => a.seq - b.seq)
    const toks = new Map(open.map((r) => [r.id, tokenize(`${r.title} ${r.description}`)]))
    const out: DuplicateCandidate[] = []
    for (let i = 0; i < open.length; i++) {
      for (let j = i + 1; j < open.length; j++) {
        const a = open[i]!
        const b = open[j]!
        const score = jaccard(toks.get(a.id)!, toks.get(b.id)!)
        if (score >= threshold) out.push({ a: a.id, b: b.id, score })
      }
    }
    return out.sort((x, y) => y.score - x.score)
  }

  /** Open issues whose `updatedAt` is older than `days` days before `nowMs`,
   *  oldest-first. `nowMs` is injectable so tests can pin "now". */
  staleList(repoPath?: string, days = 30, nowMs = Date.now()): IssueWire[] {
    const cutoff = nowMs - days * 24 * 60 * 60 * 1000
    return [...this.rows.values()]
      .filter((r) => (!repoPath || r.repoPath === repoPath) && !this.isClosed(r))
      .filter((r) => Date.parse(r.updatedAt) < cutoff)
      .sort((a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt))
      .map((r) => this.toWire(r))
  }

  /** Open issues with ≥1 template-completeness finding (see `lintIssue`). */
  lint(repoPath?: string): LintFinding[] {
    return [...this.rows.values()]
      .filter((r) => (!repoPath || r.repoPath === repoPath) && !this.isClosed(r))
      .map((r) => ({ id: r.id, seq: r.seq, findings: lintIssue(r) }))
      .filter((f) => f.findings.length > 0)
  }

  doctor(repoPath?: string): DoctorReport {
    const rows = [...this.rows.values()].filter((r) => !repoPath || r.repoPath === repoPath)
    const ids = new Set(rows.map((r) => r.id))
    const danglingDeps: DoctorReport['danglingDeps'] = []
    const adj = new Map<string, string[]>()
    for (const r of rows) {
      for (const d of this.deps.store.listIssueDeps(r.id)) {
        if (!ids.has(d.toId)) danglingDeps.push({ from: r.id, to: d.toId, type: d.type })
        if (d.type === 'blocks' || d.type === 'parent-child') {
          adj.set(r.id, [...(adj.get(r.id) ?? []), d.toId])
        }
      }
    }
    // cycle detection over blocks+parent-child edges (DFS colouring).
    const cycles: string[][] = []
    const colour = new Map<string, number>() // 0=white,1=grey,2=black
    const stack: string[] = []
    const visit = (u: string): void => {
      colour.set(u, 1)
      stack.push(u)
      for (const v of adj.get(u) ?? []) {
        if (!ids.has(v)) continue
        if (colour.get(v) === 1) cycles.push([...stack.slice(stack.indexOf(v)), v])
        else if (!colour.get(v)) visit(v)
      }
      stack.pop()
      colour.set(u, 2)
    }
    for (const r of rows) if (!colour.get(r.id)) visit(r.id)
    return {
      cycles, danglingDeps,
      lintCount: this.lint(repoPath).length,
      staleCount: this.staleList(repoPath).length,
    }
  }

  preflight(repoPath?: string): { ok: boolean; report: DoctorReport } {
    const report = this.doctor(repoPath)
    return { ok: report.cycles.length === 0 && report.danglingDeps.length === 0, report }
  }

  async orphans(repoPath: string): Promise<OrphanIssue[]> {
    const res = await this.deps.repoOp('log', repoPath).catch(() => ({ ok: false, output: '' }))
    if (!res.ok || !res.output) return []
    const log = res.output
    const out: OrphanIssue[] = []
    for (const r of this.rows.values()) {
      if (r.repoPath !== repoPath || this.isClosed(r)) continue
      // Reference forms: the branch stem `issue/<seq>-`, or a `#<seq>` token.
      const hashRef = new RegExp(`#${r.seq}\\b`).exec(log)?.[0]
      const branchRef = log.includes(`issue/${r.seq}-`) ? `issue/${r.seq}-` : undefined
      const ref = hashRef ?? branchRef
      if (ref) out.push({ id: r.id, seq: r.seq, title: r.title, ref })
    }
    return out.sort((a, b) => a.seq - b.seq)
  }

  search(filter: IssueSearchFilter): IssueWire[] {
    const text = filter.text?.toLowerCase()
    return [...this.rows.values()]
      .filter((r) => !filter.repoPath || r.repoPath === filter.repoPath)
      .map((r) => this.toWire(r))
      .filter((w) => {
        if (filter.stage && w.stage !== filter.stage) return false
        if (filter.priority != null && w.priority !== filter.priority) return false
        if (filter.type && w.type !== filter.type) return false
        if (filter.assignee && w.assignee !== filter.assignee) return false
        if (filter.parentId && w.parentId !== filter.parentId) return false
        if (filter.label && !w.labels.includes(filter.label)) return false
        if (filter.status === 'open' && (w.stage === 'done' || w.closedReason)) return false
        if (filter.status === 'closed' && !(w.stage === 'done' || w.closedReason)) return false
        if (filter.status === 'ready' && !w.ready) return false
        if (filter.status === 'blocked' && !w.blocked) return false
        if (filter.status === 'deferred' && !w.deferred) return false
        if (text) {
          const hay = `${w.title} ${w.description} ${w.notes ?? ''}`.toLowerCase()
          if (!hay.includes(text)) return false
        }
        return true
      })
      .sort((a, b) => (a.priority !== b.priority ? a.priority - b.priority : a.seq - b.seq))
  }

  count(repoPath?: string): IssueCount {
    const rows = [...this.rows.values()].filter((r) => !repoPath || r.repoPath === repoPath)
    const c: IssueCount = { byStage: {}, byPriority: {}, byType: {}, byAssignee: {} }
    const bump = (m: Record<string, number>, k: string): void => {
      m[k] = (m[k] ?? 0) + 1
    }
    for (const r of rows) {
      bump(c.byStage, r.stage)
      bump(c.byPriority, String(r.priority))
      bump(c.byType, r.type)
      bump(c.byAssignee, r.assignee ?? '(unassigned)')
    }
    return c
  }

  stats(repoPath?: string): IssueStats {
    const wires = [...this.rows.values()]
      .filter((r) => !repoPath || r.repoPath === repoPath)
      .map((r) => this.toWire(r))
    const closed = wires.filter((w) => w.stage === 'done' || w.closedReason).length
    return {
      total: wires.length, closed, open: wires.length - closed,
      ready: wires.filter((w) => w.ready).length,
      blocked: wires.filter((w) => w.blocked).length,
      deferred: wires.filter((w) => w.deferred).length,
    }
  }

  get(id: string): IssueWire | null {
    const r = this.rows.get(id)
    return r ? this.toWire(r) : null
  }
  allWire(): IssueWire[] {
    return this.list()
  }

  private persist(row: IssueRow): IssueWire {
    row.updatedAt = this.now()
    this.rows.set(row.id, row)
    this.deps.store.upsertIssue(row)
    const wire = this.toWire(row)
    this.deps.broadcast({ type: 'issueUpdated', issue: wire })
    this.deps.broadcast({ type: 'issuesChanged', issues: this.allWire() })
    return wire
  }

  create(input: CreateIssueInput): IssueWire {
    const seq = this.deps.store.nextIssueSeq(input.repoPath)
    const ts = this.now()
    const row: IssueRow = {
      id: `iss_${randomUUID()}`, repoPath: input.repoPath, seq, title: input.title,
      description: input.description ?? '', stage: 'backlog', worktreePath: null, branch: null,
      parentBranch: input.parentBranch || this.deps.getSettings().gitWorkflow.defaultParentBranch || 'main',
      defaultAgent: input.defaultAgent || this.deps.getSettings().sessionDefaults.agent || 'claude-code',
      linearId: input.linear?.id ?? null, linearIdentifier: input.linear?.identifier ?? null,
      linearUrl: input.linear?.url ?? null, activityNotes: null, notesUpdatedAt: null,
      suggestedStage: null, suggestedReason: null, blockedBy: [], dependencyNote: null, prUrl: null,
      priority: 2, type: 'task', assignee: null, parentId: null, design: null, acceptance: null,
      notes: null, dueAt: null, deferUntil: null, closedReason: null, supersededBy: null,
      duplicateOf: null, pinned: false, estimateMin: null,
      createdAt: ts, updatedAt: ts, archived: false,
    }
    if (input.priority != null) row.priority = input.priority
    if (input.type) row.type = input.type
    if (input.assignee) row.assignee = input.assignee
    // parentId handled after persist via reparent (edge-maintaining): the row
    // must be registered in this.rows first so wouldCycle/rowOrThrow work.
    let wire = this.persist(row)
    if (input.parentId) wire = this.reparent(row.id, input.parentId)
    if (input.labels?.length) wire = this.setLabels(row.id, input.labels)
    return wire
  }

  update(id: string, patch: Partial<Pick<IssueRow,
    'title' | 'description' | 'stage' | 'worktreePath' | 'branch' | 'parentBranch' | 'defaultAgent'
    | 'archived' | 'priority' | 'type' | 'assignee' | 'parentId' | 'design' | 'acceptance'
    | 'notes' | 'dueAt' | 'deferUntil' | 'closedReason' | 'supersededBy' | 'duplicateOf'
    | 'pinned' | 'estimateMin'>>): IssueWire {
    const row = this.rows.get(id)
    if (!row) throw new Error(`unknown issue ${id}`)
    if ('parentId' in patch) {
      this.setParent(row, patch.parentId ?? null)
      const { parentId: _ignored, ...rest } = patch
      Object.assign(row, rest)
    } else {
      Object.assign(row, patch)
    }
    return this.persist(row)
  }

  archive(id: string): IssueWire {
    return this.update(id, { archived: true })
  }

  delete(id: string): void {
    this.rowOrThrow(id)
    this.deps.store.deleteIssue(id)
    // Re-hydrate from the store: deleteIssue also clears scalar back-refs
    // (parent_id / superseded_by / duplicate_of) on OTHER rows, so a plain
    // map delete would leave those stale pointers in the broadcast.
    this.reload()
    this.deps.broadcast({ type: 'issuesChanged', issues: this.allWire() })
  }

  setLabels(id: string, labels: string[]): IssueWire {
    const row = this.rowOrThrow(id)
    this.deps.store.setIssueLabels(id, labels)
    return this.persist(row)
  }

  addComment(id: string, author: string, body: string): IssueWire {
    const row = this.rowOrThrow(id)
    this.deps.store.addIssueComment({
      id: `cmt_${randomUUID()}`, issueId: id, author, body, createdAt: this.now(),
    })
    return this.persist(row)
  }

  /** Cycle check over `blocks` + `parent-child` edges, following from->to. */
  private wouldCycle(fromId: string, toId: string): boolean {
    const seen = new Set<string>()
    const stack = [toId]
    while (stack.length) {
      const cur = stack.pop() as string
      if (cur === fromId) return true
      if (seen.has(cur)) continue
      seen.add(cur)
      for (const d of this.deps.store.listIssueDeps(cur)) {
        if (d.type === 'blocks' || d.type === 'parent-child') stack.push(d.toId)
      }
    }
    return false
  }

  addDep(fromId: string, toId: string, type = 'blocks'): IssueWire {
    // parent-child is owned exclusively by reparent/setParent (the single
    // cycle-checked path that keeps the parent_id column and the edge in sync).
    // Block it here BEFORE any store write so an arbitrary-type caller can't add
    // the hierarchy edge without ever touching the column (column/edge divergence).
    if (type === 'parent-child') throw new Error('parent-child is managed by reparent, not addDep')
    const row = this.rowOrThrow(fromId)
    this.rowOrThrow(toId)
    if (fromId === toId) throw new Error('an issue cannot depend on itself (self-dep)')
    if (type === 'blocks' && this.wouldCycle(fromId, toId)) {
      throw new Error(`dependency ${fromId} -> ${toId} would create a cycle`)
    }
    this.deps.store.addIssueDep(fromId, toId, type)
    return this.persist(row)
  }

  removeDep(fromId: string, toId: string, type?: string): IssueWire {
    // parent-child is owned exclusively by reparent/setParent. Reject an explicit
    // parent-child removal, and on the bulk (no-type) path delete only non-parent-child
    // edges so the hierarchy edge is never silently dropped out from under the column.
    if (type === 'parent-child') throw new Error('parent-child is managed by reparent, not removeDep')
    const row = this.rowOrThrow(fromId)
    if (type) {
      this.deps.store.removeIssueDep(fromId, toId, type)
    } else {
      for (const d of this.deps.store.listIssueDeps(fromId)) {
        if (d.toId === toId && d.type !== 'parent-child') {
          this.deps.store.removeIssueDep(fromId, toId, d.type)
        }
      }
    }
    return this.persist(row)
  }

  defer(id: string, until: string | null): IssueWire {
    return this.update(id, { deferUntil: until })
  }

  /** The single cycle-checked path that keeps the parent_id column and the
   *  parent-child edge in sync. Mutates row.parentId; caller persists. */
  private setParent(row: IssueRow, newParentId: string | null): void {
    if (newParentId === row.parentId) return
    // Check-then-mutate: no store edge may be touched before the cycle check
    // passes, or a throw here would leave the edge gone while row.parentId (and
    // persist) still point at the old parent — a column/edge divergence. wouldCycle
    // returns true the instant it reaches row.id (before expanding that node), so
    // the still-present old outgoing edge is never traversed and can't skew it.
    if (newParentId) {
      this.rowOrThrow(newParentId)
      if (newParentId === row.id || this.wouldCycle(row.id, newParentId)) {
        throw new Error(`reparent ${row.id} -> ${newParentId} would create a cycle`)
      }
    }
    if (row.parentId) this.deps.store.removeIssueDep(row.id, row.parentId, 'parent-child')
    if (newParentId) this.deps.store.addIssueDep(row.id, newParentId, 'parent-child')
    row.parentId = newParentId
  }

  reparent(id: string, parentId: string | null): IssueWire {
    const row = this.rowOrThrow(id)
    this.setParent(row, parentId)
    return this.persist(row)
  }

  /** The issue's parent chain, nearest first. Cycle-safe (parent graph is invariant, but
   *  guard anyway). Used by the authz middleware to test subtree membership. */
  ancestorIds(id: string): string[] {
    const out: string[] = []
    const seen = new Set<string>()
    let cur = this.rows.get(id)?.parentId ?? null
    while (cur && !seen.has(cur)) {
      seen.add(cur)
      out.push(cur)
      cur = this.rows.get(cur)?.parentId ?? null
    }
    return out
  }

  claim(id: string, assignee: string): IssueWire {
    return this.update(id, { assignee, stage: 'in_progress' })
  }

  close(id: string, reason = 'done'): IssueWire {
    return this.update(id, { stage: 'done', closedReason: reason })
  }

  supersede(oldId: string, newId: string): IssueWire {
    this.rowOrThrow(newId)
    this.addDep(oldId, newId, 'supersedes')
    return this.update(oldId, { stage: 'done', closedReason: 'superseded', supersededBy: newId })
  }

  duplicate(id: string, canonicalId: string): IssueWire {
    this.rowOrThrow(canonicalId)
    this.addDep(id, canonicalId, 'related')
    return this.update(id, { stage: 'done', closedReason: 'duplicate', duplicateOf: canonicalId })
  }

  private worktreePathFor(repoPath: string, branch: string): string {
    // branch is `issue/<seq>-<slug>`; flatten to a directory name under <repo>/.worktrees
    const dir = branch.replace(/\//g, '-')
    return `${repoPath}/.worktrees/${dir}`
  }

  async start(id: string): Promise<IssueWire> {
    const row = this.rowOrThrow(id)
    if (row.worktreePath) return this.toWire(row) // already started
    const branch = this.slug(row.seq, row.title)
    const path = this.worktreePathFor(row.repoPath, branch)
    const res = await this.d.repoOp('worktreeAdd', row.repoPath, { path, branch, startPoint: row.parentBranch })
    if (!res.ok) throw new Error(`worktree add failed: ${res.output}`)
    row.branch = branch
    row.worktreePath = path
    row.stage = 'planning'
    const wire = this.persistRow(row)
    // Hand the agent the description as its first prompt AT SPAWN. createSession
    // delivers it via argv for claude/codex/grok (`claude "<prompt>"` — consumed at
    // startup, no TUI-readiness race) or seeds the composer draft for other agents.
    this.d.spawnSession({
      cwd: path,
      agentKind: row.defaultAgent,
      ...(row.description.trim() ? { initialPrompt: row.description } : {}),
    })
    return wire
  }

  async createAndMaybeStart(input: CreateIssueInput): Promise<IssueWire> {
    const created = this.create(input)
    return input.startNow ? this.start(created.id) : created
  }

  async action(id: string, kind: 'rebase' | 'pr' | 'merge'): Promise<{ ok: boolean; output: string; issue: IssueWire }> {
    const row = this.rowOrThrow(id)
    if (!row.worktreePath || !row.branch) throw new Error('issue not started')
    const gw = this.d.getSettings().gitWorkflow
    if (kind === 'rebase') {
      const r = await this.d.repoOp('rebase', row.worktreePath, { parentBranch: row.parentBranch })
      return { ...r, issue: this.toWire(row) }
    }
    if (kind === 'pr') {
      const r = await this.d.repoOp('prCreate', row.worktreePath, { branch: row.branch, parentBranch: row.parentBranch })
      if (r.ok) {
        const url = r.output.match(/https?:\/\/\S+/)?.[0]
        if (url) row.prUrl = url
      }
      return { ...r, issue: this.persistRow(row) }
    }
    // merge
    if (gw.autoRebaseBeforeMerge) {
      const rb = await this.d.repoOp('rebase', row.worktreePath, { parentBranch: row.parentBranch })
      if (!rb.ok) return { ...rb, issue: this.toWire(row) }
    }
    // mergeFfOnly runs on the repo root (parent-branch checkout), NOT the worktree.
    // The daemon's `git merge --ff-only <branch>` merges into whatever branch the repo
    // ROOT currently has checked out. We must NOT auto-checkout the parent branch — the
    // repo root is the LIVE deployment-source checkout and switching its branch can
    // crash-loop the backend. Instead, GUARD: only merge if the root is already on the
    // parent branch; otherwise fail clearly without merging.
    const st = await this.d.repoOp('status', row.repoPath)
    const current = this.parseCurrentBranch(st.output)
    if (current !== row.parentBranch) {
      return {
        ok: false,
        output: `repo root at ${row.repoPath} is on '${current}', not the parent branch '${row.parentBranch}'. Check out ${row.parentBranch} there before merging.`,
        issue: this.toWire(row),
      }
    }
    const r = await this.d.repoOp('mergeFfOnly', row.repoPath, { branch: row.branch })
    return { ...r, issue: this.toWire(row) }
  }

  /**
   * Parse the current branch from `git status --porcelain=v1 -b` output.
   * The first line is `## <branch>...<upstream>`, `## <branch>`, or
   * `## HEAD (no branch)` when detached. Returns null for detached/unparseable.
   */
  private parseCurrentBranch(statusOutput: string): string | null {
    const first = statusOutput.split('\n', 1)[0] ?? ''
    if (!first.startsWith('## ')) return null
    const rest = first.slice(3) // strip "## "
    // Detached HEAD renders as "## HEAD (no branch)".
    if (rest.startsWith('HEAD (no branch)')) return null
    // `## <branch>...<upstream>` — the branch ends at the first "...".
    const branch = (rest.split('...', 1)[0] ?? '').trim()
    return branch || null
  }

  addSession(id: string, agentKind?: string): IssueWire {
    const row = this.rowOrThrow(id)
    if (!row.worktreePath) throw new Error('issue not started')
    this.d.spawnSession({ cwd: row.worktreePath, agentKind: agentKind ?? row.defaultAgent })
    return this.toWire(row)
  }
  addShell(id: string): IssueWire {
    return this.addSession(id, 'shell')
  }

  async linearSearch(query: string): Promise<LinearIssue[]> {
    const key = this.d.getSettings().integrations?.linearApiKey
    if (!key) return []
    const search = this.d.linearSearch ?? searchIssues
    return search(key, query)
  }

  private assistantTimers = new Map<string, ReturnType<typeof setTimeout>>()

  applySuggestion(id: string): IssueWire {
    const row = this.rowOrThrow(id)
    if (row.suggestedStage) row.stage = row.suggestedStage
    row.suggestedStage = null
    row.suggestedReason = null
    return this.persistRow(row)
  }
  dismissSuggestion(id: string): IssueWire {
    const row = this.rowOrThrow(id)
    row.suggestedStage = null
    row.suggestedReason = null
    return this.persistRow(row)
  }

  onSessionActivity(sessionId: string): void {
    if (!this.d.getSettings().issues?.assistantEnabled) return
    const sess = this.d.listSessions().find((s) => s.sessionId === sessionId)
    if (!sess) return
    const row = [...this.rows.values()].find(
      (r) => r.worktreePath && (sess.cwd === r.worktreePath || sess.cwd.startsWith(`${r.worktreePath}/`)),
    )
    if (!row) return
    const prev = this.assistantTimers.get(row.id)
    if (prev) clearTimeout(prev)
    this.assistantTimers.set(
      row.id,
      setTimeout(() => {
        this.assistantTimers.delete(row.id)
        void this.refreshAssistant(row.id).catch(() => {})
      }, 120_000),
    )
  }

  async refreshAssistant(id: string): Promise<IssueWire> {
    const row = this.rowOrThrow(id)
    if (!row.worktreePath) return this.toWire(row)
    const settings = this.d.getSettings()
    const members = sessionsForIssue(row.worktreePath, this.d.listSessions()).map((s) => ({
      agentKind: s.agentKind,
      phase: s.agentState?.phase ?? 'shell',
      tail: '',
    }))
    const [status, log] = await Promise.all([
      this.d.repoOp('status', row.worktreePath).catch(() => ({ ok: false, output: '' })),
      this.d.repoOp('log', row.worktreePath).catch(() => ({ ok: false, output: '' })),
    ])
    const others = [...this.rows.values()]
      .filter((r) => r.id !== row.id && r.repoPath === row.repoPath && !r.archived)
      .map((r) => ({ seq: r.seq, title: r.title, stage: r.stage, branch: r.branch }))
    const ctx = {
      issue: {
        title: row.title,
        description: row.description,
        stage: row.stage,
        branch: row.branch,
        ...(row.prUrl ? { prUrl: row.prUrl } : {}),
      },
      gitStatus: status.output,
      gitLog: log.output,
      members,
      otherIssues: others,
    }
    let result = null as ReturnType<typeof parseAssistantJson>
    try {
      const factory = this.d.llm ?? llmClient
      const client = factory(settings.workLlm, settings.apiKeys)
      const resp = await client.complete(buildAssistantMessages(ctx), [])
      result = parseAssistantJson(resp.text)
    } catch {
      result = null
    }
    if (!result) return this.toWire(row) // leave prior state intact on any LLM/parse failure
    row.activityNotes = result.activityNotes || row.activityNotes
    row.notesUpdatedAt = this.now()
    row.blockedBy = result.blockedBy
    row.dependencyNote = result.dependencyNote || null
    // Trust the model's stage when valid and different from current; else clear the suggestion.
    const digestStage = result.suggestedStage
    row.suggestedStage = digestStage && digestStage !== row.stage ? digestStage : null
    row.suggestedReason = row.suggestedStage ? result.suggestedReason : null
    return this.persistRow(row)
  }

  // The following are implemented in later tasks (declared here so the class is complete):
  // start(id), action(id, kind), linearSearch(query), applySuggestion(id),
  // dismissSuggestion(id), refreshAssistant(id), addSession/addShell, onSessionActivity.
  /** @internal exposed for later tasks */
  protected rowOrThrow(id: string): IssueRow {
    const r = this.rows.get(id)
    if (!r) throw new Error(`unknown issue ${id}`)
    return r
  }
  /** @internal */
  protected persistRow(row: IssueRow): IssueWire {
    return this.persist(row)
  }
  /** @internal */
  protected get d(): IssueDeps {
    return this.deps
  }
  protected slug = slugifyBranch
}
