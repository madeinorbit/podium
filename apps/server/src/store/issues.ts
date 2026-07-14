/**
 * Issues aggregate — owns the `issues` table and its child tables:
 * `issue_labels`, `issue_deps`, `issue_comments` and `issue_messages`
 * (agent mail, issue #103).
 *
 * Cross-aggregate note: an issue's stable repo identity (repo_id, #74) is
 * resolved by the repos aggregate; the resolver is injected.
 */

import { isIssueColorSlot } from '@podium/domain'
import { IssueStage, letterForIndex } from '@podium/protocol'
import { type SqlDatabase, transaction } from '@podium/runtime/sqlite'
import { parseStringArray } from './helpers'
import type { IssueCommentRow, IssueMessageRow, IssueRow } from './types'

export class IssuesRepository {
  /** Rows skipped by the last {@link listIssueRows} because they were
   *  structurally corrupt (row-level quarantine). Diagnostic counter. */
  quarantinedRowCount = 0

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
            defer_until, closed_reason, superseded_by, duplicate_of, pinned, color, estimate_min,
            needs_human, human_question, panel,
            created_at, updated_at, archived, origin, audience, draft, read_at, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
           pinned = excluded.pinned, color = excluded.color,
           estimate_min = excluded.estimate_min,
           needs_human = excluded.needs_human, human_question = excluded.human_question,
           panel = excluded.panel,
           updated_at = excluded.updated_at, archived = excluded.archived,
           origin = excluded.origin, audience = excluded.audience,
           draft = excluded.draft, read_at = excluded.read_at,
           deleted_at = excluded.deleted_at`,
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
        row.color ?? null,
        row.estimateMin,
        row.needsHuman ? 1 : 0,
        row.humanQuestion,
        row.panel ?? null,
        row.createdAt,
        row.updatedAt,
        row.archived ? 1 : 0,
        row.origin ?? 'human',
        row.audience ?? 'human',
        row.draft ? 1 : 0,
        row.readAt ?? null,
        row.deletedAt ?? null,
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
      color: isIssueColorSlot(r.color) ? r.color : null,
      estimateMin: (r.estimate_min as number | null) ?? null,
      needsHuman: r.needs_human === 1,
      humanQuestion: (r.human_question as string | null) ?? null,
      panel: (r.panel as string | null) ?? null,
      createdAt: r.created_at as string,
      updatedAt: r.updated_at as string,
      archived: r.archived === 1,
      deletedAt: (r.deleted_at as string | null) ?? null,
      origin: (r.origin as string | null) ?? 'human',
      audience: (r.audience as string | null) ?? 'human',
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

  /**
   * All issue rows (optionally one repo), with ROW-LEVEL QUARANTINE: a row
   * that is structurally corrupt (or whose mapping throws for any reason) is
   * skipped, logged and counted — never propagated. This is the boot-hydration
   * read (IssueService), where one corrupt row aborting the whole load would
   * crash-loop the server. Individual JSON columns additionally self-quarantine
   * to safe defaults (see parseStringArray), which keeps the row.
   */
  listIssueRows(repoPath?: string): IssueRow[] {
    // Repo-scoped reads key on the stable repo_id (issue #164): the given path
    // resolves to its logical repo, so two registered clones of one repository
    // (or an issue filed under a sub-path of the root) list together. The
    // NULL-repo_id fallback keeps legacy rows the boot heal hasn't stamped yet
    // visible under their exact path.
    const rows = (
      repoPath
        ? this.db
            .prepare(
              `SELECT * FROM issues
               WHERE repo_id = ? OR (repo_id IS NULL AND repo_path = ?)
               ORDER BY seq ASC`,
            )
            .all(this.resolveRepoIdForPath(repoPath), repoPath)
        : this.db.prepare('SELECT * FROM issues ORDER BY repo_path ASC, seq ASC').all()
    ) as Record<string, unknown>[]
    const out: IssueRow[] = []
    this.quarantinedRowCount = 0
    for (const r of rows) {
      try {
        // Load-bearing TEXT columns must actually be strings: a NULL id (SQLite
        // allows NULL in a TEXT PRIMARY KEY) or NULL stage/title row would poison
        // every downstream consumer — quarantine it instead of mapping it.
        if (
          typeof r.id !== 'string' ||
          typeof r.repo_path !== 'string' ||
          typeof r.stage !== 'string' ||
          typeof r.title !== 'string'
        ) {
          throw new Error('structurally corrupt row (non-string id/repo_path/stage/title)')
        }
        out.push(this.mapIssueRow(r))
      } catch (err) {
        this.quarantinedRowCount += 1
        console.error(
          `[podium] issues: quarantined corrupt row ${JSON.stringify(r.id ?? null)} — skipped (${String(err)})`,
        )
      }
    }
    return out
  }

  deleteIssue(id: string): void {
    // Referential integrity is the ENGINE's job since migration 006 (#164):
    // child rows (labels/deps/comments/messages) go via ON DELETE CASCADE and
    // scalar back-references on OTHER rows (parent_id / superseded_by /
    // duplicate_of) clear via ON DELETE SET NULL — no manual scrub needed
    // (PRAGMA foreign_keys is enabled per-connection by the store facade).
    this.db.prepare('DELETE FROM issues WHERE id = ?').run(id)
  }

  /** Next human-facing issue number, allocated per LOGICAL repo — scoped by the
   *  stable `repo_id` (issue #164, #140) so every checkout of one origin shares a
   *  single seq sequence and two machines with different paths can no longer mint
   *  colliding numbers. Callers resolve the path to a repo_id (resolveRepoIdForPath)
   *  before allocating. UNIQUE(repo_id, seq) enforces the invariant at the SQL layer. */
  nextIssueSeq(repoId: string): number {
    const r = this.db.prepare('SELECT MAX(seq) AS m FROM issues WHERE repo_id = ?').get(repoId) as {
      m: number | null
    }
    return (r.m ?? 0) + 1
  }

  /**
   * #140 heal, ported from main's boot-time migrate(): make `seq` unique per
   * `repo_id` by renumbering the loser of each `(repo_id, seq)` collision. For each
   * repo_id the canonical path is the one with the most issues (tie-break: path
   * ascending); within a colliding seq the kept row is the one on the canonical path
   * (then earliest created_at, then id), and every other row is bumped to append
   * after that repo_id's current MAX(seq). Idempotent: a DB with no collisions is
   * untouched. Returns the number of issues renumbered.
   *
   * On this branch migration 005 already dedupes historic collisions and installs
   * UNIQUE(repo_id, seq), so post-migration writes cannot recreate them — this heal
   * is defense in depth for databases restored from a pre-index build.
   */
  renumberCollidingIssueSeqs(): number {
    const rows = this.db
      .prepare('SELECT id, repo_id, repo_path, seq, created_at FROM issues')
      .all() as {
      id: string
      repo_id: string | null
      repo_path: string
      seq: number
      created_at: string
    }[]
    const byRepo = new Map<string, typeof rows>()
    for (const r of rows) {
      const rid = r.repo_id ?? this.resolveRepoIdForPath(r.repo_path)
      const g = byRepo.get(rid)
      if (g) g.push(r)
      else byRepo.set(rid, [r])
    }
    const updates: { id: string; seq: number }[] = []
    for (const group of byRepo.values()) {
      const counts = new Map<string, number>()
      for (const r of group) counts.set(r.repo_path, (counts.get(r.repo_path) ?? 0) + 1)
      const canonPath = [...counts.entries()].sort(
        (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
      )[0]![0]
      const bySeq = new Map<number, typeof group>()
      for (const r of group) {
        const g = bySeq.get(r.seq)
        if (g) g.push(r)
        else bySeq.set(r.seq, [r])
      }
      let maxSeq = group.reduce((m, r) => Math.max(m, r.seq), 0)
      for (const clash of bySeq.values()) {
        if (clash.length < 2) continue
        const ordered = [...clash].sort(
          (a, b) =>
            (a.repo_path === canonPath ? 0 : 1) - (b.repo_path === canonPath ? 0 : 1) ||
            a.created_at.localeCompare(b.created_at) ||
            a.id.localeCompare(b.id),
        )
        for (const loser of ordered.slice(1)) updates.push({ id: loser.id, seq: ++maxSeq })
      }
    }
    if (updates.length === 0) return 0
    const stmt = this.db.prepare('UPDATE issues SET seq = ? WHERE id = ?')
    transaction(this.db, () => {
      for (const u of updates) stmt.run(u.seq, u.id)
    })
    return updates.length
  }

  /** Repo-identity upgrade (#74): stamp repoId onto issues under repoPath.
   *  Called by the repos aggregate when a path-fallback id upgrades to the
   *  origin-derived one. Collision-safe under UNIQUE(repo_id, seq): when the
   *  upgrade merges two path-keyed buckets into one logical repo, any seq
   *  already taken in the target bucket is renumbered to the next free seq
   *  (oldest row first keeps its number), loudly logged. */
  assignRepoIdToIssuesUnder(repoId: string, repoPath: string): void {
    const rows = this.db
      .prepare(
        `SELECT id, seq FROM issues
         WHERE (repo_path = ? OR repo_path LIKE ? || '/%')
           AND (repo_id IS NULL OR repo_id != ?)
         ORDER BY created_at ASC, rowid ASC`,
      )
      .all(repoPath, repoPath, repoId) as { id: string; seq: number }[]
    if (rows.length === 0) return
    const max = this.db
      .prepare('SELECT MAX(seq) AS m FROM issues WHERE repo_id = ?')
      .get(repoId) as { m: number | null }
    let next = (max.m ?? 0) + 1
    const taken = this.db.prepare('SELECT id FROM issues WHERE repo_id = ? AND seq = ?')
    const upd = this.db.prepare('UPDATE issues SET repo_id = ?, seq = ? WHERE id = ?')
    for (const r of rows) {
      let seq = r.seq
      const holder = taken.get(repoId, seq) as { id: string } | undefined
      if (holder && holder.id !== r.id) {
        while (taken.get(repoId, next)) next += 1
        seq = next
        next += 1
        console.warn(
          `[podium] issues: repo-id upgrade merged buckets — seq #${r.seq} already taken in ` +
            `${repoId}; reassigning issue ${r.id} to seq ${seq} (issue ids are unchanged)`,
        )
      }
      upd.run(repoId, seq, r.id)
    }
  }

  /**
   * Allocate the next session column letter for an issue (`A`, `B`, … `Z`, `AA`,
   * #474). Backed by the `issue_ref_letters` high-water counter so a letter is
   * NEVER reused within an issue — even after the session that held it is deleted.
   * Transactional: the read-increment-return is atomic, so two concurrent
   * allocations can never mint the same `POD-13-A`.
   */
  allocateSessionLetter(issueId: string): string {
    return transaction(this.db, () => {
      const row = this.db
        .prepare('SELECT next_index FROM issue_ref_letters WHERE issue_id = ?')
        .get(issueId) as { next_index: number } | undefined
      const index = row?.next_index ?? 0
      this.db
        .prepare(
          `INSERT INTO issue_ref_letters (issue_id, next_index) VALUES (?, ?)
           ON CONFLICT(issue_id) DO UPDATE SET next_index = ?`,
        )
        .run(issueId, index + 1, index + 1)
      return letterForIndex(index)
    })
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

  /** Comment count for ONE issue — the single-issue toWire path (#175). */
  countIssueComments(issueId: string): number {
    const r = this.db
      .prepare('SELECT COUNT(*) AS n FROM issue_comments WHERE issue_id = ?')
      .get(issueId) as { n: number }
    return r.n
  }

  /** Comment counts for ALL issues in one GROUP BY (#175) — list serializations
   *  share this map so N-issue toWire runs don't cost N comment queries (the
   *  same batching posture as the shared sessionList). Issues with no comments
   *  are simply absent (read as 0). */
  countIssueCommentsByIssue(): Map<string, number> {
    const rows = this.db
      .prepare('SELECT issue_id, COUNT(*) AS n FROM issue_comments GROUP BY issue_id')
      .all() as { issue_id: string; n: number }[]
    return new Map(rows.map((r) => [r.issue_id, r.n]))
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
