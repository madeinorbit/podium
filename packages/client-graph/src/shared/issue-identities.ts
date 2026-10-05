import { parseIssueRef } from '@podium/protocol'
import { createKeyedAnswer, type KeyedAnswer } from '../query-result'
import { ingestWorktreeRecord } from './repo-from-lane'
import type { RowSourceEvent } from './source'

type Row = Readonly<Record<string, unknown>>
export interface IssueIdentityFact { repoId?: string; seq: string; deleted?: boolean }
interface Lane { path?: string; repoId?: string; prefix?: string; repoPath?: string; repoName?: string }
interface Bucket { answer: KeyedAnswer<string> }
interface Seed {
  facts: KeyedAnswer<IssueIdentityFact>
  repos: KeyedAnswer<string>
  prefixes: KeyedAnswer<Bucket>
  pairs: KeyedAnswer<Bucket>
  bare: KeyedAnswer<Bucket>
  byRepo: KeyedAnswer<Bucket>
  liveByRepo: KeyedAnswer<Bucket>
  lanes: KeyedAnswer<Lane>
  holders: KeyedAnswer<Lane>
}
export interface IssueIdentities {
  fork(): IssueIdentities
  clear(): void
  apply(event: RowSourceEvent): ReadonlySet<string>
  set(id: string, row: Row | undefined): void
  setFact(id: string, fact: IssueIdentityFact | undefined): void
  fact(id: string): IssueIdentityFact | undefined
  repoPrefix(id: string): string | undefined
  setRepo(id: string, prefix: string | undefined): ReadonlySet<string>
  resolve(identifier: string): string | undefined
  referenceId(token: string): string | undefined
  hasPrefix(prefix: string): boolean
  aliasKeys(identifier: string): readonly string[]
  factAlias(fact: IssueIdentityFact | undefined): string | undefined
}
const pair = (prefix: string, seq: string) => JSON.stringify([prefix, seq])
const bareKey = (seq: string) => `#${seq}`

/** Source-owned identity questions. The two-level prefix/repo join means a
 * prefix rename moves one repo key, not every issue in its history. Only a
 * prefix presence change moves that repo's compact bare-alias contributions.
 * Persistent roots let resident writes shadow source facts by address. */
export function createIssueIdentities(
  members: (repoId: string) => Iterable<string>,
  seed?: Seed,
): IssueIdentities {
  let facts = seed?.facts.fork() ?? createKeyedAnswer<IssueIdentityFact>()
  let repos = seed?.repos.fork() ?? createKeyedAnswer<string>()
  let prefixes = seed?.prefixes.fork() ?? createKeyedAnswer<Bucket>()
  let pairs = seed?.pairs.fork() ?? createKeyedAnswer<Bucket>()
  let bare = seed?.bare.fork() ?? createKeyedAnswer<Bucket>()
  let byRepo = seed?.byRepo.fork() ?? createKeyedAnswer<Bucket>()
  let liveByRepo = seed?.liveByRepo.fork() ?? createKeyedAnswer<Bucket>()
  let lanes = seed?.lanes.fork() ?? createKeyedAnswer<Lane>()
  let holders = seed?.holders.fork() ?? createKeyedAnswer<Lane>()
  const prefixOf = (fact: IssueIdentityFact) => fact.repoId ? repos.get(fact.repoId) : undefined
  function file(collection: KeyedAnswer<Bucket>, key: string, id: string, present: boolean) {
    const before = collection.get(key)
    if ((before?.answer.has(id) ?? false) === present) return
    const answer = before?.answer.fork() ?? createKeyedAnswer<string>()
    if (present) answer.set(id, id, id)
    else answer.delete(id)
    if (answer.first() !== undefined) collection.set(key, key, { answer })
    else collection.delete(key)
  }
  function setFact(id: string, next: IssueIdentityFact | undefined) {
    const previous = facts.get(id)
    if (previous === next || (previous && next && previous.repoId === next.repoId && previous.seq === next.seq && !!previous.deleted === !!next.deleted)) return
    const contribution = (value: IssueIdentityFact, present: boolean) => {
      file(pairs, pair(value.repoId ?? '', value.seq), id, present)
      if (value.repoId) file(byRepo, value.repoId, id, present)
      if (value.repoId && !value.deleted) file(liveByRepo, value.repoId, id, present)
      if (!prefixOf(value)) file(bare, value.seq, id, present)
    }
    if (previous) contribution(previous, false)
    if (next) { contribution(next, true); facts.set(id, id, next) }
    else facts.delete(id)
  }
  function setRepo(id: string, prefix: string | undefined): ReadonlySet<string> {
    const before = repos.get(id), next = prefix || undefined
    const changedBare = new Set<string>()
    if (before === next) return changedBare
    if (before) file(prefixes, before, id, false)
    if (next) { repos.set(id, id, next); file(prefixes, next, id, true) }
    else repos.delete(id)
    if (!!before !== !!next) {
      for (const issueId of byRepo.get(id)?.answer.snapshot() ?? []) {
        const fact = facts.get(issueId)
        if (!fact) continue
        file(bare, fact.seq, issueId, !next)
        changedBare.add(bareKey(fact.seq))
      }
    }
    return changedBare
  }
  function prefixed(prefix: string, seq: string): string | undefined {
    let first: string | undefined
    // Prefixes are unique on the server. Keeping a per-prefix bucket also
    // preserves first-ID behavior during malformed/intermediate collisions.
    for (const repoId of prefixes.get(prefix)?.answer.snapshot() ?? []) {
      const id = pairs.get(pair(repoId, seq))?.answer.first()
      if (id !== undefined && (first === undefined || id < first)) first = id
    }
    return first
  }
  function exactAlias(token: string): string | undefined {
    if (token.startsWith('#')) return bare.get(token.slice(1))?.answer.first()
    const at = token.lastIndexOf('-')
    return at > 0 ? prefixed(token.slice(0, at), token.slice(at + 1)) : undefined
  }
  return {
    fork: () => createIssueIdentities(members, { facts, repos, prefixes, pairs, bare, byRepo, liveByRepo, lanes, holders }),
    clear() {
      facts = createKeyedAnswer<IssueIdentityFact>(); repos = createKeyedAnswer<string>()
      prefixes = createKeyedAnswer<Bucket>(); pairs = createKeyedAnswer<Bucket>()
      bare = createKeyedAnswer<Bucket>(); byRepo = createKeyedAnswer<Bucket>()
      liveByRepo = createKeyedAnswer<Bucket>()
      lanes = createKeyedAnswer<Lane>(); holders = createKeyedAnswer<Lane>()
    },
    apply(event) {
      if (event.type === 'replace') this.clear()
      const affected = new Set<string>()
      for (const record of event.rows) if (record.kind === 'worktree') {
        const row = record.value as unknown as Row | undefined
        const value: Lane | undefined = row ? {
          path: typeof row.path === 'string' ? row.path : undefined,
          repoId: typeof row.repoId === 'string' ? row.repoId : undefined,
          prefix: typeof row.prefix === 'string' ? row.prefix : undefined,
          repoPath: typeof row.repoPath === 'string' ? row.repoPath : undefined,
          repoName: typeof row.repoName === 'string' ? row.repoName : undefined,
        } : undefined
        ingestWorktreeRecord({
          getWorktree: id => lanes.get(id), getRepo: id => holders.get(id),
          putWorktree: (id, row) => lanes.set(id, id, row as Lane),
          dropWorktree: id => lanes.delete(id),
          putRepo: (id, row) => { holders.set(id, id, row as Lane); affected.add(id) },
          dropRepo: id => { holders.delete(id); affected.add(id) },
          repoWorktreeMembers: members,
        }, record.id, value)
      }
      // Complete composition before filing aliases, including on replacement.
      for (const id of affected) setRepo(id, holders.get(id)?.prefix)
      for (const record of event.rows) if (record.kind === 'issue') this.set(record.id, record.value as unknown as Row | undefined)
      return affected
    },
    set(id, row) { setFact(id, row ? { repoId: typeof row.repoId === 'string' && row.repoId ? row.repoId : undefined, seq: String(row.seq), ...(row.deletedAt ? { deleted: true } : {}) } : undefined) },
    setFact,
    fact: id => facts.get(id),
    repoPrefix: id => repos.get(id),
    setRepo,
    resolve(identifier) {
      if (facts.has(identifier)) return identifier
      const token = identifier.trim(), exact = exactAlias(token)
      if (exact !== undefined) return exact
      const ref = parseIssueRef(token)
      return ref ? prefixed(ref.prefix, String(ref.seq)) : undefined
    },
    referenceId(token) {
      const ref = parseIssueRef(token.trim())
      return ref ? prefixed(ref.prefix, String(ref.seq)) : undefined
    },
    hasPrefix(prefix) {
      // A prefix can have multiple holders during a rename/collision. This
      // reads only that prefix's repos and their maintained live membership.
      for (const repoId of prefixes.get(prefix)?.answer.snapshot() ?? [])
        if (liveByRepo.get(repoId)?.answer.first() !== undefined) return true
      return false
    },
    aliasKeys(identifier) {
      const token = identifier.trim()
      if (token.startsWith('#')) return [token]
      const at = token.lastIndexOf('-'), ref = parseIssueRef(token)
      const keys = new Set<string>()
      if (at > 0) keys.add(pair(token.slice(0, at), token.slice(at + 1)))
      if (ref) keys.add(pair(ref.prefix, String(ref.seq)))
      return [...keys]
    },
    factAlias(fact) {
      if (!fact) return undefined
      const prefix = prefixOf(fact)
      return prefix ? pair(prefix, fact.seq) : bareKey(fact.seq)
    },
  }
}
