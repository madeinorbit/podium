/**
 * Server-owned facts at the write funnel (POD-3869).
 *
 * OWNERSHIP AUDIT (apps/, packages/, scripts/, including non-server callers):
 * - Issues: store/issues.ts owns upsert, shipping CAS, delete, renumber, repo
 *   reassignment and machine backfill. The existing IssueStore retains the full
 *   issue-row map and its boot loader/commit projection. This index adds only
 *   worktree lookup keys (id, path and collision ordering), avoiding a second
 *   full-row copy. SessionRegistry likewise retains its existing session map.
 * - LEASES EXCLUDED, option (b): observation checkpoints retain their documented
 *   foreign-writer freshness contract (daemon-lifecycle.ts). No lease() capability
 *   is exposed here; POD-3862 must settle that contract before switching it.
 *
 * These are facts of ONE server database, not a cross-process cache protocol.
 * cli.ts executeStartup registers/reclaims the server role before startServer;
 * runtime/run-registry.ts reclaim waits for the outgoing process to die. Named
 * instances use distinct state roots (docs/agents/multi-instance.md). A second writer
 * opening the SAME database outside that lifecycle, online SQL edits, or future
 * federation would invalidate this ownership proof and require a new protocol.
 * Migrations/heals run before loading; no cached authorization survives restart.
 *
 * COMMIT CHOICE: sync ChangeRow contains wire projections, not all owned facts.
 * The issues repository instead publish typed write RETURNING results through
 * CommittedRows.write and applyAfterCommit (the same mandatory mechanism used
 * by Authority's onCommit adapter in relay.ts). This includes standalone writes,
 * changes absent from the sync log, and bulk updates. Rollback drops application;
 * failed application poisons the executor. No SELECT follows a write. RETURNING
 * changes the result shape, not the mutation or its predicates.
 *
 * Load and the corresponding apply branch live together here and use the SAME
 * repository decoders. Loading holds one transaction through subscription, so
 * there is no snapshot/subscription gap. Readers are committed snapshots: they must not be used for read-your-writes
 * inside an open mutation span. No hot-path reader is switched by this module.
 */
import type { IssueId } from '@podium/model'
import type { SessionStore } from '../../store'
import type { CommittedRowChange } from '../../store/committed-rows'
import { applyAfterCommit, spanOpen } from '../../store/executor/executor'
import type { IssueWorktreeRow } from '../../store/issues'
import type { issues } from '../../migrations/schema'

export interface WorldIndexReader {
  issueForWorktree(path: string): IssueId | undefined
}

export type ChangeRow = { readonly kind: 'issues' } & CommittedRowChange<typeof issues.$inferSelect>

const loaded = new WeakMap<SessionStore, Promise<WorldIndex>>()
const compareIssues = (a: IssueWorktreeRow, b: IssueWorktreeRow) =>
  a.repoPath.localeCompare(b.repoPath) || a.seq - b.seq || a.id.localeCompare(b.id)

export class WorldIndex {
  private readonly issuesById = new Map<string, IssueWorktreeRow>()
  private readonly worktreeMembers = new Map<string, Set<string>>()
  private readonly issuesByWorktree = new Map<string, IssueId>()
  private elapsedMs = 0
  get loadMs(): number {
    return this.elapsedMs
  }
  private constructor() {}

  readonly reader: WorldIndexReader = Object.freeze({
    issueForWorktree: (path: string) => {
      // Probe only component boundaries, deepest first: O(cwd depth), never
      // O(issue count). Preserve literal path semantics, including trailing '/'.
      let end = path.length
      while (end >= 0) {
        const issue = this.issuesByWorktree.get(path.slice(0, end))
        if (issue) return issue
        end = path.lastIndexOf('/', end - 1)
        if (end === 0) return this.issuesByWorktree.get('')
      }
      return undefined
    },
  })

  static load(store: SessionStore): Promise<WorldIndex> {
    if (spanOpen()) throw new Error('WorldIndex.load must run outside a mutation span')
    const existing = loaded.get(store)
    if (existing) return existing
    const loading = store.transact(async () => {
      const started = performance.now()
      // One table read, independent of the number of facts.
      const issues = await store.issues.loadWorldIssuePaths()
      const index = new WorldIndex()
      for (const row of issues) {
        index.issuesById.set(row.id, row)
        if (!row.worktreePath || row.deletedAt) continue
        const members = index.worktreeMembers.get(row.worktreePath) ?? new Set<string>()
        members.add(row.id)
        index.worktreeMembers.set(row.worktreePath, members)
        const previousId = index.issuesByWorktree.get(row.worktreePath)
        const previous = previousId ? index.issuesById.get(previousId) : undefined
        if (!previous || compareIssues(row, previous) < 0) {
          index.issuesByWorktree.set(row.worktreePath, row.id)
        }
      }
      index.elapsedMs = performance.now() - started
      applyAfterCommit(() => {
        store.issues.committed.subscribe((change) => index.apply({ kind: 'issues', ...change }))
      }, 'world-index:load')
      return index
    })
    loaded.set(store, loading)
    void loading.catch(() => loaded.delete(store))
    return loading
  }

  apply(change: ChangeRow): void {
    for (const raw of change.rows) {
      if (change.operation === 'upsert' && !raw.deletedAt) this.putIssue(raw.id, raw)
      else this.putIssue(raw.id, undefined)
    }
  }

  private putIssue(id: string, next: IssueWorktreeRow | undefined): void {
    const previous = this.issuesById.get(id)
    if (previous?.worktreePath) this.worktreeMembers.get(previous.worktreePath)?.delete(id)
    if (next)
      this.issuesById.set(id, {
        id: next.id,
        repoPath: next.repoPath,
        seq: next.seq,
        worktreePath: next.worktreePath,
        deletedAt: next.deletedAt,
      })
    else this.issuesById.delete(id)
    if (next?.worktreePath) {
      const members = this.worktreeMembers.get(next.worktreePath) ?? new Set<string>()
      members.add(id)
      this.worktreeMembers.set(next.worktreePath, members)
    }
    for (const path of new Set([previous?.worktreePath, next?.worktreePath])) {
      if (!path) continue
      const members = this.worktreeMembers.get(path)
      if (!members?.size) {
        this.worktreeMembers.delete(path)
        this.issuesByWorktree.delete(path)
        continue
      }
      const rows = [...members].map((member) => this.issuesById.get(member)!)
      rows.sort(compareIssues)
      this.issuesByWorktree.set(path, rows[0]!.id)
    }
  }
}
