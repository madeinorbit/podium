import { parseAnyRef } from '@podium/protocol'
import type { EntityRecord } from '@podium/sync/replica'

/** Replica-wide identities, including archived, deleted and closed issues.
 * Only identity fields are retained; pool residency never changes this table. */
export class IssueRefIndex {
  private readonly ids = new Map<string, Set<string>>()
  private readonly keys = new Map<string, string>()
  private readonly repos = new Map<string, string>()
  private readonly issues = new Map<string, { repoId: string | undefined; seq: number }>()
  private readonly byRepo = new Map<string, Set<string>>()

  constructor(records: readonly EntityRecord[]) {
    for (const record of records) {
      if (record.entity === 'repo') this.repo(record.entityId, record.value)
    }
    for (const record of records) {
      if (record.entity === 'issueProjection') this.issue(record.entityId, record.value)
    }
  }

  id(token: string): string | undefined {
    const ref = token.trim()
    const parsed = parseAnyRef(ref)
    const key = /^#\d+$/.test(ref) ? `#${Number(ref.slice(1))}`
      : parsed?.kind === 'issue' ? `${parsed.prefix}-${parsed.seq}` : undefined
    const candidates = key === undefined ? undefined : this.ids.get(key)
    // Prefix-less fallbacks can collide while repo rows are still arriving.
    return candidates?.size === 1 ? candidates.values().next().value : undefined
  }

  /** Same identity index, in the order Replica.rows() presents its issues.
   * A caller choosing a first display alias can do so without changing id()'s
   * ambiguity contract or retaining another index over cold rows. */
  candidates(token: string): readonly string[] {
    return [...(this.claimants(token) ?? [])].sort((a, b) => a < b ? -1 : a > b ? 1 : 0)
  }

  private claimants(token: string): Set<string> | undefined {
    const ref = token.trim()
    const parsed = parseAnyRef(ref)
    const key = /^#\d+$/.test(ref) ? `#${Number(ref.slice(1))}`
      : parsed?.kind === 'issue' ? `${parsed.prefix}-${parsed.seq}` : undefined
    return key === undefined ? undefined : this.ids.get(key)
  }

  issue(id: string, value: unknown): void {
    const previous = this.issues.get(id)
    if (previous?.repoId !== undefined) {
      const members = this.byRepo.get(previous.repoId)
      members?.delete(id)
      if (members?.size === 0) this.byRepo.delete(previous.repoId)
    }
    this.issues.delete(id)
    this.unkey(id)
    if (value === null || typeof value !== 'object') return
    const row = value as { seq?: unknown; repoId?: unknown }
    if (typeof row.seq !== 'number' || !Number.isSafeInteger(row.seq) || row.seq < 1) return
    const repoId = typeof row.repoId === 'string' ? row.repoId : undefined
    this.issues.set(id, { repoId, seq: row.seq })
    if (repoId !== undefined) {
      let members = this.byRepo.get(repoId)
      if (!members) this.byRepo.set(repoId, members = new Set())
      members.add(id)
    }
    this.key(id)
  }

  repo(id: string, value: unknown): void {
    const prefix = value !== null && typeof value === 'object'
      ? (value as { prefix?: unknown }).prefix : undefined
    const next = typeof prefix === 'string' && prefix.length > 0 ? prefix : undefined
    if (next === this.repos.get(id)) return
    if (next === undefined) this.repos.delete(id)
    else this.repos.set(id, next)
    // A repo change visits only its own issues, never the whole replica.
    for (const issueId of this.byRepo.get(id) ?? []) {
      this.unkey(issueId)
      this.key(issueId)
    }
  }

  private unkey(id: string): void {
    const key = this.keys.get(id)
    if (key !== undefined) {
      const candidates = this.ids.get(key)
      candidates?.delete(id)
      if (candidates?.size === 0) this.ids.delete(key)
    }
    this.keys.delete(id)
  }

  private key(id: string): void {
    const issue = this.issues.get(id)!
    const prefix = issue.repoId === undefined ? undefined : this.repos.get(issue.repoId)
    const key = prefix ? `${prefix}-${issue.seq}` : `#${issue.seq}`
    this.keys.set(id, key)
    let candidates = this.ids.get(key)
    if (!candidates) this.ids.set(key, candidates = new Set())
    candidates.add(id)
  }
}
