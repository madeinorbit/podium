/**
 * Issues aggregate — owns the `issues` table and its child tables:
 * `issue_labels`, `issue_deps`, `issue_comments` and `issue_messages`
 * (agent mail, issue #103).
 *
 * Cross-aggregate note: an issue's stable repo identity (repo_id, #74) is
 * resolved by the repos aggregate; the resolver is injected.
 */

import type { SqlDatabase } from '@podium/core/sqlite'
import { IssueStage } from '@podium/protocol'
import { parseStringArray } from './helpers'
import type { IssueCommentRow, IssueMessageRow, IssueRow } from './types'

export class IssuesRepository {
  constructor(
    private readonly db: SqlDatabase,
    /** Repos-aggregate lookup: stable repo_id for an issue's repoPath. */
    private readonly resolveRepoIdForPath: (repoPath: string) => string,
  ) {}

  upsertIssue(row: IssueRow): void {
    // Strict on write: stage is a load-bearing enum (the board column + zod-validated
    // on the wire). defaultAgent is intentionally NOT validated here — 'auto' is a
    // legal stored sentinel resolved to a concrete kind only at spawn time.
    if (!IssueStage.safeParse(row.stage).success) {
      throw new Error(
        `upsertIssue: refusing to persist invalid stage ${JSON.stringify(row.stage)} for ${row.id}`,
      )
    }
    // Normalize blockedBy so the column is always a clean string[] JSON value.
    const blockedBy = Array.isArray(row.blockedBy)
      ? row.blockedBy.filter((x): x is string => typeof x === 'string')
      : []
    this.db
      .prepare(
        `INSERT INTO issues
           (id, repo_path, repo_id, seq, title, description, stage, worktree_path, branch, parent_branch,
            default_agent, default_model, default_effort, machine_id,
            linear_id, linear_identifier, linear_url, activity_notes, notes_updated_at,
            suggested_stage, suggested_reason, blocked_by, dependency_note, pr_url,
            priority, type, assignee, parent_id, design, acceptance, notes, due_at,
            defer_until, closed_reason, superseded_by, duplicate_of, pinned, estimate_min,
            needs_human, human_question, panel,
            created_at, updated_at, archived, origin, draft, read_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           repo_id = excluded.repo_id,
           title = excluded.title, description = excluded.description, stage = excluded.stage,
           worktree_path = excluded.worktree_path, branch = excluded.branch,
           parent_branch = excluded.parent_branch, default_agent = excluded.default_agent,
           default_model = excluded.default_model, default_effort = excluded.default_effort,
           machine_id = excluded.machine_id,
           linear_id = excluded.linear_id, linear_identifier = excluded.linear_identifier,
           linear_url = excluded.linear_url, activity_notes = excluded.activity_notes,
           notes_updated_at = excluded.notes_updated_at, suggested_stage = excluded.suggested_stage,
           suggested_reason = excluded.suggested_reason, blocked_by = excluded.blocked_by,
           dependency_note = excluded.dependency_note, pr_url = excluded.pr_url,
           priority = excluded.priority, type = excluded.type, assignee = excluded.assignee,
           parent_id = excluded.parent_id, design = excluded.design,
           acceptance = excluded.acceptance, notes = excluded.notes, due_at = excluded.due_at,
           defer_until = excluded.defer_until, closed_reason = excluded.closed_reason,
           superseded_by = excluded.superseded_by, duplicate_of = excluded.duplicate_of,
           pinned = excluded.pinned, estimate_min = excluded.estimate_min,
           needs_human = excluded.needs_human, human_question = excluded.human_question,
           panel = excluded.panel,
           updated_at = excluded.updated_at, archived = excluded.archived,
           origin = excluded.origin, draft = excluded.draft, read_at = excluded.read_at`,
      )
      .run(
        row.id,
        row.repoPath,
        row.repoId ?? this.resolveRepoIdForPath(row.repoPath),
        row.seq,
        row.title,
        row.description,
        row.stage,
        row.worktreePath,
        row.branch,
        row.parentBranch,
        row.defaultAgent,
        row.defaultModel,
        row.defaultEffort,
        row.machineId ?? null,
        row.linearId,
        row.linearIdentifier,
        row.linearUrl,
        row.activityNotes,
        row.notesUpdatedAt,
        row.suggestedStage,
        row.suggestedReason,
        JSON.stringify(blockedBy),
        row.dependencyNote,
        row.prUrl,
        row.priority,
        row.type,
        row.assignee,
        row.parentId,
        row.design,
        row.acceptance,
        row.notes,
        row.dueAt,
        row.deferUntil,
        row.closedReason,
        row.supersededBy,
        row.duplicateOf,
        row.pinned ? 1 : 0,
        row.estimateMin,
        row.needsHuman ? 1 : 0,
        row.humanQuestion,
        row.panel ?? null,
        row.createdAt,
        row.updatedAt,
        row.archived ? 1 : 0,
        row.origin ?? 'human',
        row.draft ? 1 : 0,
        row.readAt ?? null,
      )
  }

  private mapIssueRow(r: Record<string, unknown>): IssueRow {
    return {
      id: r.id as string,
      repoPath: r.repo_path as string,
      repoId: (r.repo_id as string | null) ?? null,
      seq: r.seq as number,
      title: r.title as string,
      description: (r.description as string) ?? '',
      stage: r.stage as string,
      worktreePath: (r.worktree_path as string | null) ?? null,
      branch: (r.branch as string | null) ?? null,
      parentBranch: r.parent_branch as string,
      defaultAgent: r.default_agent as string,
      defaultModel: (r.default_model as string | null) ?? 'auto',
      defaultEffort: (r.default_effort as string | null) ?? 'auto',
      machineId: (r.machine_id as string | null) ?? null,
      linearId: (r.linear_id as string | null) ?? null,
      linearIdentifier: (r.linear_identifier as string | null) ?? null,
      linearUrl: (r.linear_url as string | null) ?? null,
      activityNotes: (r.activity_notes as string | null) ?? null,
      notesUpdatedAt: (r.notes_updated_at as string | null) ?? null,
      suggestedStage: (r.suggested_stage as string | null) ?? null,
      suggestedReason: (r.suggested_reason as string | null) ?? null,
      blockedBy: parseStringArray(r.blocked_by, `issue ${String(r.id)} blocked_by`),
      dependencyNote: (r.dependency_note as string | null) ?? null,
      prUrl: (r.pr_url as string | null) ?? null,
      priority: (r.priority as number) ?? 2,
      type: (r.type as string) ?? 'task',
      assignee: (r.assignee as string | null) ?? null,
      parentId: (r.parent_id as string | null) ?? null,
      design: (r.design as string | null) ?? null,
      acceptance: (r.acceptance as string | null) ?? null,
      notes: (r.notes as string | null) ?? null,
      dueAt: (r.due_at as string | null) ?? null,
      deferUntil: (r.defer_until as string | null) ?? null,
      closedReason: (r.closed_reason as string | null) ?? null,
      supersededBy: (r.superseded_by as string | null) ?? null,
      duplicateOf: (r.duplicate_of as string | null) ?? null,
      pinned: r.pinned === 1,
      estimateMin: (r.estimate_min as number | null) ?? null,
      needsHuman: r.needs_human === 1,
      humanQuestion: (r.human_question as string | null) ?? null,
      panel: (r.panel as string | null) ?? null,
      createdAt: r.created_at as string,
      updatedAt: r.updated_at as string,
      archived: r.archived === 1,
      origin: (r.origin as string | null) ?? 'human',
      draft: r.draft === 1,
      readAt: (r.read_at as string | null) ?? null,
    }
  }

  getIssue(id: string): IssueRow | null {
    const r = this.db.prepare('SELECT * FROM issues WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined
    return r ? this.mapIssueRow(r) : null
  }

  listIssueRows(repoPath?: string): IssueRow[] {
    const rows = (
      repoPath
        ? this.db.prepare('SELECT * FROM issues WHERE repo_path = ? ORDER BY seq ASC').all(repoPath)
        : this.db.prepare('SELECT * FROM issues ORDER BY repo_path ASC, seq ASC').all()
    ) as Record<string, unknown>[]
    return rows.map((r) => this.mapIssueRow(r))
  }

  deleteIssue(id: string): void {
    this.deleteIssueChildRows(id)
    this.db.prepare('DELETE FROM issues WHERE id = ?').run(id)
    // Clear dangling scalar back-references on OTHER rows so a deleted id never
    // lingers as a ghost parent/supersede/duplicate pointer (column-vs-edge
    // divergence P3b fixed). The dep EDGES were already removed above.
    this.db.prepare('UPDATE issues SET parent_id = NULL WHERE parent_id = ?').run(id)
    this.db.prepare('UPDATE issues SET superseded_by = NULL WHERE superseded_by = ?').run(id)
    this.db.prepare('UPDATE issues SET duplicate_of = NULL WHERE duplicate_of = ?').run(id)
  }

  nextIssueSeq(repoPath: string): number {
    const r = this.db
      .prepare('SELECT MAX(seq) AS m FROM issues WHERE repo_path = ?')
      .get(repoPath) as { m: number | null }
    return (r.m ?? 0) + 1
  }

  /** Repo-identity dual-write (#74): stamp repoId onto issues under repoPath.
   *  Called by the repos aggregate when a path-fallback id upgrades. */
  assignRepoIdToIssuesUnder(repoId: string, repoPath: string): void {
    this.db
      .prepare("UPDATE issues SET repo_id = ? WHERE repo_path = ? OR repo_path LIKE ? || '/%'")
      .run(repoId, repoPath, repoPath)
  }

  /** Per-boot heal: fill NULL repo_id via the injected resolver (idempotent). */
  backfillNullRepoIds(): void {
    const issues = this.db
      .prepare('SELECT id, repo_path FROM issues WHERE repo_id IS NULL')
      .all() as { id: string; repo_path: string }[]
    const setIssue = this.db.prepare('UPDATE issues SET repo_id = ? WHERE id = ?')
    for (const i of issues) setIssue.run(this.resolveRepoIdForPath(i.repo_path), i.id)
  }

  // ---- labels ----

  setIssueLabels(issueId: string, labels: string[]): void {
    const clean = [...new Set(labels.filter((l) => typeof l === 'string' && l.trim()))].map((l) =>
      l.trim(),
    )
    this.db.prepare('DELETE FROM issue_labels WHERE issue_id = ?').run(issueId)
    const ins = this.db.prepare(
      'INSERT OR IGNORE INTO issue_labels (issue_id, label) VALUES (?, ?)',
    )
    for (const l of clean) ins.run(issueId, l)
  }

  getIssueLabels(issueId: string): string[] {
    return (
      this.db
        .prepare('SELECT label FROM issue_labels WHERE issue_id = ? ORDER BY label ASC')
        .all(issueId) as { label: string }[]
    ).map((r) => r.label)
  }

  listAllLabels(): string[] {
    return (
      this.db.prepare('SELECT DISTINCT label FROM issue_labels ORDER BY label ASC').all() as {
        label: string
      }[]
    ).map((r) => r.label)
  }

  // ---- deps ----

  addIssueDep(fromId: string, toId: string, type = 'blocks'): void {
    this.db
      .prepare('INSERT OR IGNORE INTO issue_deps (from_id, to_id, type) VALUES (?, ?, ?)')
      .run(fromId, toId, type)
  }

  removeIssueDep(fromId: string, toId: string, type?: string): void {
    if (type) {
      this.db
        .prepare('DELETE FROM issue_deps WHERE from_id = ? AND to_id = ? AND type = ?')
        .run(fromId, toId, type)
    } else {
      this.db.prepare('DELETE FROM issue_deps WHERE from_id = ? AND to_id = ?').run(fromId, toId)
    }
  }

  listIssueDeps(fromId: string): { toId: string; type: string }[] {
    return (
      this.db
        .prepare(
          'SELECT to_id, type FROM issue_deps WHERE from_id = ? ORDER BY to_id ASC, type ASC',
        )
        .all(fromId) as { to_id: string; type: string }[]
    ).map((r) => ({ toId: r.to_id, type: r.type }))
  }

  listDependents(toId: string): { fromId: string; type: string }[] {
    return (
      this.db
        .prepare(
          'SELECT from_id, type FROM issue_deps WHERE to_id = ? ORDER BY from_id ASC, type ASC',
        )
        .all(toId) as { from_id: string; type: string }[]
    ).map((r) => ({ fromId: r.from_id, type: r.type }))
  }

  /** One-time, idempotent per-boot heal: mirror legacy issues.blocked_by arrays
   *  into issue_deps edges. */
  backfillIssueDeps(): void {
    const rows = this.db
      .prepare("SELECT id, blocked_by FROM issues WHERE blocked_by != '[]'")
      .all() as {
      id: string
      blocked_by: string
    }[]
    const ins = this.db.prepare(
      "INSERT OR IGNORE INTO issue_deps (from_id, to_id, type) VALUES (?, ?, 'blocks')",
    )
    // blocked_by is populated by the AI assistant with branch names (e.g.
    // "issue/3-foo"), NOT issue ids. Only mirror an edge when the target resolves
    // to a real issue id, so phantom branch-name edges never accumulate on
    // every boot.
    const exists = this.db.prepare('SELECT 1 FROM issues WHERE id = ?')
    for (const r of rows) {
      let ids: unknown
      try {
        ids = JSON.parse(r.blocked_by)
      } catch {
        ids = []
      }
      if (Array.isArray(ids)) {
        for (const to of ids) if (typeof to === 'string' && to && exists.get(to)) ins.run(r.id, to)
      }
    }
  }

  // ---- comments ----

  addIssueComment(c: IssueCommentRow): void {
    this.db
      .prepare(
        'INSERT INTO issue_comments (id, issue_id, author, body, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(c.id, c.issueId, c.author, c.body, c.createdAt)
  }

  listIssueComments(issueId: string): IssueCommentRow[] {
    return (
      this.db
        .prepare('SELECT * FROM issue_comments WHERE issue_id = ? ORDER BY created_at ASC, id ASC')
        .all(issueId) as Record<string, unknown>[]
    ).map((r) => ({
      id: r.id as string,
      issueId: r.issue_id as string,
      author: r.author as string,
      body: r.body as string,
      createdAt: r.created_at as string,
    }))
  }

  /** Substring match over issue comment bodies — comments have no FTS (bounded
   *  volume), so LIKE is enough for the omni-search's comment source. */
  searchIssueComments(
    query: string,
    limit = 30,
  ): { issueId: string; body: string; createdAt: string }[] {
    const q = query.trim()
    if (!q) return []
    const rows = this.db
      .prepare(
        `SELECT issue_id, body, created_at FROM issue_comments
         WHERE body LIKE ? ESCAPE '\\' ORDER BY created_at DESC LIMIT ?`,
      )
      .all(
        `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`,
        Math.min(200, Math.max(1, limit)),
      ) as Record<string, unknown>[]
    return rows.map((r) => ({
      issueId: r.issue_id as string,
      body: r.body as string,
      createdAt: r.created_at as string,
    }))
  }

  // ---- issue mail (issue #103) ----

  private mapIssueMessage(r: Record<string, unknown>): IssueMessageRow {
    return {
      id: r.id as string,
      issueId: r.issue_id as string,
      fromAuthor: r.from_author as string,
      body: r.body as string,
      createdAt: r.created_at as string,
      status: r.status as IssueMessageRow['status'],
      claimedBy: (r.claimed_by as string | null) ?? null,
      readAt: (r.read_at as string | null) ?? null,
      claimedAt: (r.claimed_at as string | null) ?? null,
    }
  }

  addIssueMessage(m: IssueMessageRow): void {
    this.db
      .prepare(
        `INSERT INTO issue_messages
           (id, issue_id, from_author, body, created_at, status, claimed_by, read_at, claimed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        m.id,
        m.issueId,
        m.fromAuthor,
        m.body,
        m.createdAt,
        m.status,
        m.claimedBy,
        m.readAt,
        m.claimedAt,
      )
  }

  getIssueMessage(id: string): IssueMessageRow | null {
    const r = this.db.prepare('SELECT * FROM issue_messages WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined
    return r ? this.mapIssueMessage(r) : null
  }

  listIssueMessages(
    issueId: string,
    opts?: { status?: IssueMessageRow['status'] },
  ): IssueMessageRow[] {
    const rows = (
      opts?.status
        ? this.db
            .prepare(
              'SELECT * FROM issue_messages WHERE issue_id = ? AND status = ? ORDER BY created_at ASC, id ASC',
            )
            .all(issueId, opts.status)
        : this.db
            .prepare(
              'SELECT * FROM issue_messages WHERE issue_id = ? ORDER BY created_at ASC, id ASC',
            )
            .all(issueId)
    ) as Record<string, unknown>[]
    return rows.map((r) => this.mapIssueMessage(r))
  }

  countUnreadIssueMessages(issueId: string): number {
    const r = this.db
      .prepare("SELECT COUNT(*) AS n FROM issue_messages WHERE issue_id = ? AND status = 'unread'")
      .get(issueId) as { n: number }
    return r.n
  }

  /** Mark the given messages read. Only flips 'unread' rows (idempotent; never
   *  regresses a 'claimed' message back to 'read'). */
  markIssueMessagesRead(issueId: string, ids: string[], readAt: string): void {
    const upd = this.db.prepare(
      `UPDATE issue_messages SET status = 'read', read_at = ?
       WHERE issue_id = ? AND id = ? AND status = 'unread'`,
    )
    for (const id of ids) upd.run(readAt, issueId, id)
  }

  /** Atomic claim: exactly one caller wins; a second claim on the same message
   *  returns false. Single UPDATE guarded on status, so there is no read-then-write race. */
  claimIssueMessage(id: string, claimedBy: string, claimedAt: string): boolean {
    const r = this.db
      .prepare(
        `UPDATE issue_messages SET status = 'claimed', claimed_by = ?, claimed_at = ?
         WHERE id = ? AND status != 'claimed'`,
      )
      .run(claimedBy, claimedAt, id)
    return r.changes === 1
  }

  deleteIssueMessagesForIssue(issueId: string): void {
    this.db.prepare('DELETE FROM issue_messages WHERE issue_id = ?').run(issueId)
  }

  deleteIssueChildRows(issueId: string): void {
    this.db.prepare('DELETE FROM issue_labels WHERE issue_id = ?').run(issueId)
    this.db.prepare('DELETE FROM issue_deps WHERE from_id = ? OR to_id = ?').run(issueId, issueId)
    this.db.prepare('DELETE FROM issue_comments WHERE issue_id = ?').run(issueId)
    this.deleteIssueMessagesForIssue(issueId)
  }
}
