/**
 * Server-owned facts at the write funnel (POD-3869).
 *
 * OWNERSHIP AUDIT (apps/, packages/, scripts/, including non-server callers):
 * - Grants: store/grants.ts owns the three INSERT/DELETE writers; authorization
 *   and enrollment handlers call that repository, never a daemon SQLite handle.
 * - Issues: store/issues.ts owns upsert, shipping CAS, delete, renumber, repo
 *   reassignment and machine backfill. The existing IssueStore retains the full
 *   issue-row map and its boot loader/commit projection. This index adds only
 *   worktree lookup keys (id, path and collision ordering), avoiding a second
 *   full-row copy. SessionRegistry likewise retains its existing session map.
 * - Pending counts: store/messages.ts owns INSERT and every status mutation,
 *   including read/dead-letter/refusal. Janitor observations become server-side
 *   expireObserved writes; the janitor does not mutate the messages table.
 * - Users: store/users.ts owns create, disable and credential replacement. The
 *   credential writer republishes the unchanged account; secrets are not indexed.
 * - Machines: store/machines.ts owns all twelve mutation statements. Daemon and
 *   supervisor reports enter MachinesService/enrollment and call this repository;
 *   those remote processes do not write the server's machines table themselves.
 * - LEASES EXCLUDED, option (b): observation checkpoints retain their documented
 *   foreign-writer freshness contract (daemon-lifecycle.ts). No lease() capability
 *   is exposed here; POD-3862 must settle that contract before switching it.
 *
 * These are facts of ONE server database, not a cross-process cache protocol.
 * cli.ts executeStartup registers/reclaims the server role before startServer;
 * runtime/run-registry.ts reclaim waits for the outgoing process to die. Named
 * instances use distinct state roots (docs/multi-instance.md). A second writer
 * opening the SAME database outside that lifecycle, online SQL edits, or future
 * federation would invalidate this ownership proof and require a new protocol.
 * Migrations/heals run before loading; no cached authorization survives restart.
 *
 * COMMIT CHOICE: sync ChangeRow contains wire projections, not all owned facts.
 * All five repositories instead publish typed write RETURNING results through
 * CommittedRows.write and applyAfterCommit (the same mandatory mechanism used
 * by Authority's onCommit adapter in relay.ts). This includes standalone writes,
 * changes absent from the sync log, and bulk updates. Rollback drops application;
 * failed application poisons the executor. No SELECT follows a write. RETURNING
 * changes the result shape, not the mutation or its predicates.
 *
 * Load and the corresponding apply branch live together here and use the SAME
 * repository decoders. Loading holds one transaction through subscription, so
 * there is no snapshot/subscription gap. Queued IDs come from the single grouped
 * count statement and distinguish mixed-status transitions without a read.
 * Readers are committed snapshots: they must not be used for read-your-writes
 * inside an open mutation span. No hot-path reader is switched by this module.
 */
import type { IssueId } from '@podium/model'
import type { SessionStore } from '../../store'
import type { CommittedRowChange } from '../../store/committed-rows'
import { applyAfterCommit, spanOpen } from '../../store/executor/executor'
import { grantFromRow, type GrantRow } from '../../store/grants'
import type { IssueWorktreeRow } from '../../store/issues'
import { machineRecordFromRow } from '../../store/machines'
import type { MessageQueueFact } from '../../store/messages'
import type { MachineRecord } from '../../store/types'
import { userFromRow, type UserAccountRow } from '../../store/users'
import type { grants, issues, machines, users } from '../../migrations/schema'

export interface DeliveryTarget {
  readonly kind: string
  readonly id?: string | null
}
export interface WorldIndexReader {
  grantsFor(kind: string, id: string): readonly Readonly<GrantRow>[]
  issueForWorktree(path: string): IssueId | undefined
  pendingCount(target: DeliveryTarget): number
  user(id: string): Readonly<UserAccountRow> | undefined
  machine(id: string): Readonly<MachineRecord> | undefined
}

export type ChangeRow =
  | ({ readonly kind: 'grants' } & CommittedRowChange<typeof grants.$inferSelect>)
  | ({ readonly kind: 'issues' } & CommittedRowChange<typeof issues.$inferSelect>)
  | ({ readonly kind: 'messages' } & CommittedRowChange<MessageQueueFact>)
  | ({ readonly kind: 'users' } & CommittedRowChange<typeof users.$inferSelect>)
  | ({ readonly kind: 'machines' } & CommittedRowChange<typeof machines.$inferSelect>)

const key = (kind: string, id: string | null | undefined) => JSON.stringify([kind, id ?? null])
const clone = <T>(value: T): T => (value === undefined ? value : structuredClone(value))
const loaded = new WeakMap<SessionStore, Promise<WorldIndex>>()
const compareIssues = (a: IssueWorktreeRow, b: IssueWorktreeRow) =>
  a.repoPath.localeCompare(b.repoPath) || a.seq - b.seq || a.id.localeCompare(b.id)

export class WorldIndex {
  private readonly grantsByResource = new Map<string, GrantRow[]>()
  private readonly issuesById = new Map<string, IssueWorktreeRow>()
  private readonly worktreeMembers = new Map<string, Set<string>>()
  private readonly issuesByWorktree = new Map<string, IssueId>()
  private readonly pendingByTarget = new Map<string, number>()
  private readonly queuedTargets = new Map<string, string>()
  private readonly usersById = new Map<string, UserAccountRow>()
  private readonly machineRecords = new Map<string, MachineRecord>()
  private elapsedMs = 0
  get loadMs(): number {
    return this.elapsedMs
  }
  private constructor() {}

  readonly reader: WorldIndexReader = Object.freeze({
    grantsFor: (kind: string, id: string) => clone(this.grantsByResource.get(key(kind, id)) ?? []),
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
    pendingCount: (target: DeliveryTarget) =>
      this.pendingByTarget.get(key(target.kind, target.id)) ?? 0,
    user: (id: string) => clone(this.usersById.get(id)),
    machine: (id: string) => clone(this.machineRecords.get(id)),
  })

  static load(store: SessionStore): Promise<WorldIndex> {
    if (spanOpen()) throw new Error('WorldIndex.load must run outside a mutation span')
    const existing = loaded.get(store)
    if (existing) return existing
    const loading = store.transact(async () => {
      const started = performance.now()
      // Five grouped/table reads, independent of the number of facts.
      const grants = await store.grants.loadWorldGrants()
      const issues = await store.issues.loadWorldIssuePaths()
      const pending = await store.messages.loadWorldPending()
      const users = await store.users.loadWorldUsers()
      const machines = await store.machines.listMachines()
      const index = new WorldIndex()
      for (const row of grants) index.putGrant(row)
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
      for (const row of pending) {
        const target = key(row.toKind, row.toId)
        index.pendingByTarget.set(target, row.count)
        for (const id of row.ids) index.queuedTargets.set(id, target)
      }
      for (const row of users) index.usersById.set(row.id, row)
      for (const row of machines) index.machineRecords.set(row.id, row)
      index.elapsedMs = performance.now() - started
      applyAfterCommit(() => {
        store.grants.committed.subscribe((change) => index.apply({ kind: 'grants', ...change }))
        store.issues.committed.subscribe((change) => index.apply({ kind: 'issues', ...change }))
        store.messages.committed.subscribe((change) => index.apply({ kind: 'messages', ...change }))
        store.users.committed.subscribe((change) => index.apply({ kind: 'users', ...change }))
        store.machines.committed.subscribe((change) => index.apply({ kind: 'machines', ...change }))
      }, 'world-index:load')
      return index
    })
    loaded.set(store, loading)
    void loading.catch(() => loaded.delete(store))
    return loading
  }

  apply(change: ChangeRow): void {
    switch (change.kind) {
      case 'grants':
        for (const raw of change.rows) {
          const resource = key(raw.resourceKind, raw.resourceId)
          const rows = (this.grantsByResource.get(resource) ?? []).filter(
            (row) => row.grantee !== raw.grantee || row.verb !== raw.verb,
          )
          this.grantsByResource.set(resource, rows)
          const row = grantFromRow(raw)
          if (change.operation === 'upsert' && row) this.putGrant(row)
          if (this.grantsByResource.get(resource)?.length === 0)
            this.grantsByResource.delete(resource)
        }
        break
      case 'issues':
        for (const raw of change.rows) {
          if (change.operation === 'upsert' && !raw.deletedAt) this.putIssue(raw.id, raw)
          else this.putIssue(raw.id, undefined)
        }
        break
      case 'messages':
        for (const row of change.rows) {
          const previous = this.queuedTargets.get(row.id)
          const next =
            change.operation === 'upsert' && row.status === 'queued'
              ? key(row.toKind, row.toId)
              : undefined
          if (previous === next) continue
          if (previous !== undefined) {
            const remaining = this.pendingByTarget.get(previous)! - 1
            if (remaining === 0) this.pendingByTarget.delete(previous)
            else this.pendingByTarget.set(previous, remaining)
            this.queuedTargets.delete(row.id)
          }
          if (next !== undefined) {
            this.queuedTargets.set(row.id, next)
            this.pendingByTarget.set(next, (this.pendingByTarget.get(next) ?? 0) + 1)
          }
        }
        break
      case 'users':
        for (const raw of change.rows) {
          const row = userFromRow(raw)
          if (change.operation === 'upsert' && row) this.usersById.set(row.id, row)
          else this.usersById.delete(raw.id)
        }
        break
      case 'machines':
        for (const raw of change.rows) {
          if (change.operation === 'upsert')
            this.machineRecords.set(raw.id, machineRecordFromRow(raw))
          else this.machineRecords.delete(raw.id)
        }
        break
    }
  }

  private putGrant(row: GrantRow): void {
    const resource = key(row.resourceKind, row.resourceId)
    const rows = this.grantsByResource.get(resource) ?? []
    rows.push(row)
    rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    this.grantsByResource.set(resource, rows)
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
