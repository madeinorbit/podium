/** History questions, answered by the row source. Results contain identities,
 * never rows or a map. The same questions can later be answered from storage. */
import { issueStatusOf, machinePathAncestors, machinePathKey, machinePathSeparator } from '@podium/model/browser'
import { parseSessionRef } from '@podium/protocol'
import { createIssueMentionIndex, type IssueMentionQuestion } from './issue-mention-question'
import { isFinished } from './predicates'
import { referenceKey, sessionReferenceKey } from './session-reference'
import type { RowSourceEvent } from './source'

export type ReaderQuestion =
  | IssueMentionQuestion
  | {
      kind:
        | 'residentIssues'
        | 'commandIssues'
        | 'mentionIssues'
        | 'pageIssues'
        | 'shellIssues'
        | 'missionIssues'
        | 'boardCatalog'
        | 'boardCounts'
        | 'proposedIssues'
        | 'reclaimIssues'
    }
  | {
      kind:
        | 'commandSessions'
        | 'inboxSessions'
        | 'setupSessions'
        | 'referenceSessions'
        | 'explorerSessions'
        | 'shellSessions'
        | 'headerSessions'
        | 'headerOccupancy'
    }
  | { kind: 'headerRecentSession'; excluded?: readonly string[] | Pick<ReadonlySet<string>, 'has'> }
  | { kind: 'sessionReference'; ref: string }
  | { kind: 'commandIssueSessions'; issueId: string; archived?: boolean; includeShells?: boolean }
  | { kind: 'containingIssues'; cwd: string }
  | { kind: 'spawnIssues'; repoPath: string; repoId?: string }
  | {
      kind: 'mobileIssueTargets'
      repoPath: string
      excludeId: string
      query: string
      limit: number
      prefixes: Readonly<Record<string, string | undefined>>
    }
  | {
      kind: 'boardIssues'
      priority?: number
      stage?: string
      status?: string
      projectPaths?: readonly string[]
      archived?: boolean
      deleted?: boolean
      explorerTab?: string
      searching?: boolean
    }

export const questionEntity = (question: ReaderQuestion): 'issue' | 'session' =>
  question.kind.endsWith('Sessions') ||
  question.kind.startsWith('header') ||
  question.kind === 'sessionReference'
    ? 'session'
    : 'issue'

type Row = Readonly<Record<string, unknown>>
/** The fields that decide ancestor visibility, independent of row presentation. */
export interface IssueScopeFacts {
  readonly draft: boolean
  readonly deleted: boolean
  readonly archived: boolean
  readonly agent: boolean
}
const byId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
const commandIssueKey = (question: Extract<ReaderQuestion, { kind: 'commandIssueSessions' }>) =>
  `session:commandIssue${question.archived === false ? 'Live' : ''}${question.includeShells ? 'WithShells' : ''}:${question.issueId}`
/** Feed-maintained short strings are already lowercase; refs are alphanumerics
 * only so POD-123, pod 123, #123 and 123 share one needle (POD-5561). */
export const normalizeIssueRef = (text: string) =>
  text.toLocaleLowerCase().replace(/[^a-z0-9]/g, '')
const referenceText = normalizeIssueRef

/** One shared title/ref predicate (POD-5561). Title is a case-insensitive
 * substring; refs match only when the needle carries a digit, so "pod" alone
 * never matches every issue in a POD repo. Descriptions are never read here. */
export function matchIssueTitleRef(
  titleLower: string,
  fullRefLower: string,
  needleLower: string,
  refNeedle: string,
): boolean {
  if (!needleLower) return true
  if (titleLower.includes(needleLower)) return true
  return /\d/.test(refNeedle) && fullRefLower.includes(refNeedle)
}

/** Incremental source identity/facet indexes. No row or summary is retained.
 * The phone target question answers its declared order/text predicate here;
 * other questions narrow the reader's scalar and ancestor checks. */
export function createReaderIndex(options: { targetSearch?: boolean; recent?: boolean } = {}) {
  const mentions = options.targetSearch === false ? undefined : createIssueMentionIndex()
  const repoPaths = new Map<string, string>()
  const reposAtPath = new Map<string, Set<string>>()
  const pathKeys = (path: string) => [`issue:path:${path}`, ...[...(reposAtPath.get(path) ?? [])].map(id => `issue:repo:${id}`)]
  const targetPathKeys = (path: string) => [`issue:path:${path}`, ...[...(reposAtPath.get(path) ?? [])].map(id => `issue:targetRepo:${id}`)]
  const pathMembers = (path: string) => new Set(pathKeys(path).flatMap(key => [...bucket(key)]))
  const repoPrefixes = new Map<string, string>()
  const prefixRepos = new Map<string, Set<string>>()
  const referenceKeys = (ref: string) => {
    const prefix = parseSessionRef(ref)?.prefix
    return prefix ? [...(prefixRepos.get(prefix) ?? [])].map(id => `session:ref:${referenceKey(id, ref)}`) : []
  }
  const buckets = new Map<string, Set<string>>()
  const repos = new Set<string>()
  const filed = new Map<string, Set<string>>()
  const recent: { id: string; at: string }[] = []
  const positions = new Map<string, number>()
  const revisions = new Map<string, number>()
  const issueScopes = new Map<string, number>()
  // Compact source scalars, never pool objects or cached row payloads. One
  // ordered ID array per path keeps empty-query opens bounded by the window.
  // Text questions scan these scalars instead of retaining every row's grams
  // in facet Sets, membership buckets and duplicate ordered posting arrays.
  const targetDetails = new Map<string, { seq: number; title: string; repoId: string; ref: string }>()
  const targetPostings = new Map<string, string[]>()
  const targetRepos = new Map<string, Map<string, number>>()
  const targetCounts = { visits: 0 }
  let replacement = 0
  let repoRevision = 0
  let version = 0
  const touch = (key: string) => revisions.set(key, ++version)
  const compareTargets = (a: string, b: string) =>
    (targetDetails.get(b)?.seq ?? 0) - (targetDetails.get(a)?.seq ?? 0) || byId(a, b)
  const orderedTargetKey = (key: string) => key.startsWith('issue:path:') || key.startsWith('issue:targetRepo:')
  function removeTarget(key: string, id: string) {
    const ids = targetPostings.get(key)
    if (!ids) return
    let lo = 0,
      hi = ids.length
    while (lo < hi) {
      const at = (lo + hi) >>> 1
      if (compareTargets(ids[at]!, id) < 0) lo = at + 1
      else hi = at
    }
    if (ids[lo] === id) ids.splice(lo, 1)
    if (!ids.length) targetPostings.delete(key)
  }
  function addTarget(key: string, id: string) {
    let ids = targetPostings.get(key)
    if (!ids) {
      ids = []
      targetPostings.set(key, ids)
    }
    let lo = 0,
      hi = ids.length
    while (lo < hi) {
      const at = (lo + hi) >>> 1
      if (compareTargets(ids[at]!, id) < 0) lo = at + 1
      else hi = at
    }
    ids.splice(lo, 0, id)
  }
  const better = (a: { id: string; at: string }, b: { id: string; at: string }) =>
    a.at > b.at || (a.at === b.at && byId(a.id, b.id) < 0)
  function swap(a: number, b: number) {
    const entry = recent[a]!
    recent[a] = recent[b]!
    recent[b] = entry
    positions.set(recent[a]!.id, a)
    positions.set(recent[b]!.id, b)
  }
  function repair(at: number) {
    while (at > 0) {
      const parent = (at - 1) >>> 1
      if (!better(recent[at]!, recent[parent]!)) break
      swap(at, parent)
      at = parent
    }
    for (;;) {
      const left = at * 2 + 1,
        right = left + 1
      let best = at
      if (left < recent.length && better(recent[left]!, recent[best]!)) best = left
      if (right < recent.length && better(recent[right]!, recent[best]!)) best = right
      if (best === at) break
      swap(at, best)
      at = best
    }
  }
  function bucket(key: string): ReadonlySet<string> {
    return buckets.get(key) ?? new Set<string>()
  }
  function keys(kind: string, row: Row): Set<string> {
    const out = new Set<string>([`${kind}:all`])
    if (kind === 'issue') {
      // Read the source scalars once, even when the source is a counted proxy.
      const { repoId, repoPath, priority, stage, closedReason, blocked, archived,
        deletedAt, worktreePath } = row
      const path = machinePathKey(String(repoPath ?? ''))
      out.add(`issue:repo:${repoId ?? ''}`)
      if (repoPath === undefined && typeof repoId === 'string') out.add(`issue:targetRepo:${repoId}`)
      out.add(`issue:path:${path}`)
      out.add(`issue:priority:${priority}`)
      out.add(
        `issue:status:${issueStatusOf({ stage, closedReason } as Parameters<typeof issueStatusOf>[0])}`,
      )
      out.add(isFinished({ stage, closedReason }) ? 'issue:closed' : 'issue:open')
      if (blocked) out.add('issue:blocked')
      if (!archived && !deletedAt) out.add('issue:live')
      if (!archived || deletedAt) out.add('issue:unarchived')
      if (!deletedAt) out.add('issue:undeleted')
      if (stage === 'proposed') out.add('issue:proposed')
      if (typeof worktreePath === 'string' && worktreePath) {
        out.add(`issue:root:${machinePathKey(worktreePath)}`)
        if (!deletedAt && isFinished({ stage, closedReason })) out.add('issue:reclaim')
      }
    } else if (kind === 'session') {
      const { archived, headless, agentKind, status, issueId } = row
      if (!archived) out.add('session:unarchived')
      if (!archived && !headless && agentKind !== 'shell') out.add('session:inbox')
      if (['live', 'starting', 'reconnecting'].includes(status as string))
        out.add('session:host')
      const reference = sessionReferenceKey(row)
      if (reference) out.add(`session:ref:${reference}`)
      if (typeof issueId === 'string') {
        out.add(`session:commandIssueWithShells:${issueId}`)
        if (agentKind !== 'shell') out.add(`session:commandIssue:${issueId}`)
        if (!archived) {
          out.add(`session:commandIssueLiveWithShells:${issueId}`)
          if (agentKind !== 'shell') out.add(`session:commandIssueLive:${issueId}`)
        }
      }
    }
    return out
  }
  function set(kind: string, id: string, row: Row | undefined) {
    const address = `${kind}:${id}`,
      before = filed.get(address) ?? new Set<string>()
    const after = row ? keys(kind, row) : new Set<string>()
    if (kind === 'issue') {
      const beforeMention = mentions?.revision
      mentions?.set(id, row)
      if (beforeMention !== mentions?.revision) touch('issue:mentions')
      const scope = row
        ? Number(Boolean(row.isDraftVessel)) | (Number(Boolean(row.deletedAt)) << 1) |
          (Number(Boolean(row.archived)) << 2) | (Number(row.audience === 'agent') << 3)
        : undefined
      if (issueScopes.get(id) !== scope) {
        if (scope === undefined) issueScopes.delete(id)
        else issueScopes.set(id, scope)
      }
      const beforeEligible = before.has('issue:undeleted'),
        afterEligible = after.has('issue:undeleted')
      const facet = (keys: Set<string>, prefix: string) =>
        [...keys].find((key) => key.startsWith(prefix))?.slice(prefix.length)
      const oldPath = beforeEligible ? facet(before, 'issue:path:') : undefined,
        nextPath = afterEligible ? facet(after, 'issue:path:') : undefined
      const oldRepo = beforeEligible ? facet(before, 'issue:repo:') : undefined,
        nextRepo = afterEligible ? facet(after, 'issue:repo:') : undefined
      if (oldPath !== nextPath || oldRepo !== nextRepo) {
        if (oldPath !== undefined && oldRepo !== undefined) {
          const repos = targetRepos.get(oldPath),
            count = (repos?.get(oldRepo) ?? 1) - 1
          if (count) repos!.set(oldRepo, count)
          else {
            repos?.delete(oldRepo)
            touch(`issueRepoPath:${oldPath}`)
          }
          if (!repos?.size) targetRepos.delete(oldPath)
        }
        if (nextPath !== undefined && nextRepo !== undefined) {
          let repos = targetRepos.get(nextPath)
          if (!repos) {
            repos = new Map()
            targetRepos.set(nextPath, repos)
          }
          const count = repos.get(nextRepo) ?? 0
          repos.set(nextRepo, count + 1)
          if (!count) touch(`issueRepoPath:${nextPath}`)
        }
      }
      if (options.targetSearch !== false) {
        const previous = targetDetails.get(id)
        const seq = row ? Number(row.seq ?? 0) : undefined
        const next = row && afterEligible
          ? {
              seq: seq!,
              title: String(row.title ?? '').toLocaleLowerCase(),
              repoId: nextRepo!,
              ref: referenceText(String(seq)),
            }
          : undefined
        const moved = previous?.seq !== next?.seq
        for (const key of before)
          if (beforeEligible && orderedTargetKey(key) && (!afterEligible || moved || !after.has(key)))
            removeTarget(key, id)
        if (next) targetDetails.set(id, next)
        else targetDetails.delete(id)
        for (const key of after)
          if (
            afterEligible &&
            orderedTargetKey(key) &&
            (!beforeEligible || moved || !before.has(key))
          )
            addTarget(key, id)
        if (
          moved || previous?.title !== next?.title ||
          before.size !== after.size || [...before].some((key) => !after.has(key))
        )
          for (const key of new Set([...before, ...after]))
            if (orderedTargetKey(key)) touch(`mobileTargets:${key}`)
      }
    }
    for (const key of before)
      if (!after.has(key)) {
        const ids = buckets.get(key)
        ids?.delete(id)
        if (ids?.size === 0) {
          buckets.delete(key)
          if (key.startsWith('issue:repo:') && repos.delete(key.slice('issue:repo:'.length)))
            repoRevision++
        }
        touch(key)
      }
    for (const key of after)
      if (!before.has(key)) {
        let ids = buckets.get(key)
        if (!ids) {
          ids = new Set()
          buckets.set(key, ids)
          if (key.startsWith('issue:repo:') && key !== 'issue:repo:') {
            repos.add(key.slice('issue:repo:'.length))
            repoRevision++
          }
        }
        ids.add(id)
        touch(key)
      }
    if (after.size) filed.set(address, after)
    else filed.delete(address)
    if (kind === 'session' && options.recent !== false) {
      const at = row && !row.archived ? String(row.lastActiveAt ?? '') : undefined
      const position = positions.get(id),
        previous = position === undefined ? undefined : recent[position]!.at
      if (at !== previous) {
        if (position !== undefined) {
          const last = recent.pop()!
          positions.delete(id)
          if (position < recent.length) {
            recent[position] = last
            positions.set(last.id, position)
            repair(position)
          }
        }
        if (at !== undefined) {
          const index = recent.length
          recent.push({ id, at })
          positions.set(id, index)
          repair(index)
        }
        touch('session:recent')
      }
    }
  }
  function intersection(sets: ReadonlySet<string>[]): string[] {
    sets.sort((a, b) => a.size - b.size)
    return [...(sets[0] ?? [])].filter((id) => sets.every((set) => set.has(id)))
  }
  return {
    targetCounts,
    get version() {
      return version
    },
    get repoRevision() {
      return repoRevision
    },
    repoPathRevision(path: string): number {
      path = machinePathKey(path)
      return Math.max(replacement, revisions.get(`issueRepoPath:${path}`) ?? 0)
    },
    /** Board/explorer per-keystroke revision: title/seq only, never facets.
     * Derived from the existing per-path text publications, so no extra
     * publication-clock bump beyond the picker's own. */
    localTextRevision(): number {
      let at = replacement
      for (const [key, value] of revisions)
        if (key.startsWith('mobileTargets:') && value > at) at = value
      return at
    },
    /** One shared title/ref scan over the feed-maintained short lowercase
     * strings (POD-5561). One pass, no fact objects, no descriptions. The
     * caller supplies joined prefixes (picker) or the index uses its own
     * maintained repo prefixes (board/explorer via `prefixes` omitted). */
    localTextIds(
      needle: string,
      prefixes?: Readonly<Record<string, string | undefined>>,
    ): Set<string> {
      const needleLower = needle.trim().toLocaleLowerCase()
      if (!needleLower) return new Set(targetDetails.keys())
      const refNeedle = normalizeIssueRef(needleLower)
      const maintained = prefixes === undefined
      const normalizedPrefixes = maintained
        ? undefined
        : new Map<string, string>(
            Object.entries(prefixes!).map(([id, prefix]) => [id, normalizeIssueRef(prefix ?? '')]),
          )
      const out = new Set<string>()
      for (const [id, target] of targetDetails) {
        targetCounts.visits++
        const fullRef = maintained
          ? `${normalizeIssueRef(repoPrefixes.get(target.repoId) ?? '')}${target.ref}`
          : `${normalizedPrefixes!.get(target.repoId) ?? ''}${target.ref}`
        if (matchIssueTitleRef(target.title, fullRef, needleLower, refNeedle)) out.add(id)
      }
      return out
    },
    issueScope(id: string): IssueScopeFacts | undefined {
      const bits = issueScopes.get(id)
      return bits === undefined ? undefined : {
        draft: Boolean(bits & 1), deleted: Boolean(bits & 2),
        archived: Boolean(bits & 4), agent: Boolean(bits & 8),
      }
    },
    revision(question: ReaderQuestion): number {
      if (question.kind === 'issueMentionMatches') return Math.max(replacement, revisions.get('issue:mentions') ?? 0)
      const keys = [`${questionEntity(question)}:all`]
      switch (question.kind) {
        case 'mobileIssueTargets':
          return Math.max(
            replacement,
            revisions.get(`issueRepoPath:${machinePathKey(question.repoPath)}`) ?? 0,
            ...targetPathKeys(question.repoPath).map(key => revisions.get(`mobileTargets:${key}`) ?? 0),
          )
        case 'proposedIssues':
          keys.push('issue:proposed')
          break
        case 'reclaimIssues':
          keys.push('issue:reclaim')
          break
        case 'inboxSessions':
          keys.push('session:inbox')
          break
        case 'headerSessions':
        case 'headerOccupancy':
          keys.push('session:host')
          break
        case 'headerRecentSession':
          keys.push('session:recent')
          break
        case 'sessionReference':
          keys.push(...referenceKeys(question.ref), `session:prefix:${parseSessionRef(question.ref)?.prefix}`)
          break
        case 'commandIssueSessions':
          keys.push(commandIssueKey(question))
          break
        case 'containingIssues':
          keys.push(`issue:root:${machinePathKey(question.cwd)}`)
          if (machinePathSeparator(question.cwd) === '\\') {
            for (const path of machinePathAncestors(question.cwd)) keys.push(`issue:root:${machinePathKey(path)}`)
          } else for (let at = question.cwd.indexOf('/'); at >= 0; at = question.cwd.indexOf('/', at + 1))
            keys.push(
              `issue:root:${question.cwd.slice(0, at)}`,
              `issue:root:${question.cwd.slice(0, at + 1)}`,
            )
          break
        case 'boardCounts':
          keys.push('issue:live')
          break
        case 'spawnIssues':
          keys.push(`issue:repo:${question.repoId ?? ''}`, `issue:path:${machinePathKey(question.repoPath)}`, 'issue:undeleted')
          break
        case 'boardIssues':
          if (question.priority != null) keys.push(`issue:priority:${question.priority}`)
          if (question.stage) keys.push(`issue:status:${question.stage}`)
          if (question.status) keys.push(`issue:${question.status}`)
          for (const path of question.projectPaths ?? []) keys.push(...pathKeys(path), `issueRepoPath:${path}`)
          keys.push('issue:live', 'issue:unarchived', 'issue:undeleted')
          if (question.explorerTab === 'cancelled')
            keys.push('issue:status:cancelled', 'issue:status:duplicate', 'issue:status:superseded')
          else if (question.explorerTab && question.explorerTab !== 'needs')
            keys.push(`issue:status:${question.explorerTab}`)
          break
      }
      return Math.max(replacement, ...keys.map((key) => revisions.get(key) ?? 0))
    },
    apply(event: RowSourceEvent) {
      if (event.type === 'replace') {
        repoPaths.clear()
        reposAtPath.clear()
        repoPrefixes.clear()
        prefixRepos.clear()
        mentions?.clear()
        buckets.clear()
        repos.clear()
        filed.clear()
        recent.length = 0
        positions.clear()
        revisions.clear()
        issueScopes.clear()
        targetDetails.clear()
        targetPostings.clear()
        targetRepos.clear()
        replacement = ++version
        repoRevision++
      }
      for (const record of event.rows) {
        if (record.kind === 'repo' || record.kind === 'worktree') {
          const row = record.value as Row | undefined
          const id = record.kind === 'repo' || typeof row?.path !== 'string' ? record.id : row.repoId
          if (typeof id !== 'string') continue
          const oldPath = repoPaths.get(id), newPath = typeof row?.repoPath === 'string' ? machinePathKey(row.repoPath) : undefined
          if (oldPath !== newPath) {
            if (oldPath !== undefined) { reposAtPath.get(oldPath)?.delete(id); touch(`issueRepoPath:${oldPath}`) }
            if (newPath !== undefined) {
              let ids = reposAtPath.get(newPath)
              if (!ids) reposAtPath.set(newPath, ids = new Set())
              ids.add(id); repoPaths.set(id, newPath); touch(`issueRepoPath:${newPath}`)
            } else repoPaths.delete(id)
          }
          if (record.kind === 'worktree' && row && !Object.hasOwn(row, 'prefix')) continue
          const before = repoPrefixes.get(id), next = typeof row?.prefix === 'string' ? row.prefix : undefined
          if (before !== next) {
            if (before) { prefixRepos.get(before)?.delete(id); touch(`session:prefix:${before}`) }
            if (next) {
              let ids = prefixRepos.get(next)
              if (!ids) prefixRepos.set(next, ids = new Set())
              ids.add(id); repoPrefixes.set(id, next); touch(`session:prefix:${next}`)
            } else repoPrefixes.delete(id)
          }
        } else if (record.kind === 'session' || record.kind === 'issue') set(record.kind, record.id, record.value as Row | undefined)
      }
    },
    repoIds(path?: string): string[] {
      if (path !== undefined) path = machinePathKey(path)
      return [...(path === undefined ? repos : new Set([...(targetRepos.get(path)?.keys() ?? []), ...[...(reposAtPath.get(path) ?? [])].filter(id => bucket(`issue:repo:${id}`).size)]))].sort(byId)
    },
    contains(question: ReaderQuestion, id: string): boolean {
      const has = (key: string) => bucket(key).has(id)
      if (!has(`${questionEntity(question)}:all`)) return false
      switch (question.kind) {
        case 'issueMentionMatches': return mentions?.ids(question).includes(id) ?? false
        case 'residentIssues': return false
        case 'mobileIssueTargets':
        case 'headerRecentSession':
          // Ordered windows are answered by their existing bounded indexes.
          return this.ids(question).includes(id)
        case 'proposedIssues': return has('issue:proposed')
        case 'reclaimIssues': return has('issue:reclaim')
        case 'inboxSessions': return has('session:inbox')
        case 'headerSessions':
        case 'headerOccupancy': return has('session:host')
        case 'sessionReference': return referenceKeys(question.ref).some(has)
        case 'commandIssueSessions': return has(commandIssueKey(question))
        case 'boardCounts': return has('issue:live')
        case 'spawnIssues':
          return has('issue:undeleted') &&
            ((question.repoId !== undefined && has(`issue:repo:${question.repoId}`)) ||
              (has('issue:repo:') && has(`issue:path:${machinePathKey(question.repoPath)}`)))
        case 'containingIssues': {
          if (has(`issue:root:${machinePathKey(question.cwd)}`)) return true
          if (machinePathSeparator(question.cwd) === '\\') return machinePathAncestors(question.cwd).some(path => has(`issue:root:${machinePathKey(path)}`))
          for (let at = question.cwd.indexOf('/'); at >= 0; at = question.cwd.indexOf('/', at + 1))
            if (has(`issue:root:${question.cwd.slice(0, at)}`) ||
              has(`issue:root:${question.cwd.slice(0, at + 1)}`)) return true
          return false
        }
        case 'boardIssues':
          if (question.priority != null && !has(`issue:priority:${question.priority}`)) return false
          if (question.stage && !has(`issue:status:${question.stage}`)) return false
          if (['open', 'closed', 'blocked'].includes(question.status ?? '') && !has(`issue:${question.status}`)) return false
          if (question.projectPaths?.length && !question.projectPaths.some(path => pathKeys(path).some(has))) return false
          if (question.explorerTab !== undefined && !question.searching) {
            if (!has('issue:live')) return false
            if (question.explorerTab === 'needs') return has('issue:open')
            if (question.explorerTab === 'cancelled')
              return ['cancelled', 'duplicate', 'superseded'].some(tab => has(`issue:status:${tab}`))
            return has(`issue:status:${question.explorerTab}`)
          }
          return question.explorerTab !== undefined ||
            ((question.archived || has('issue:unarchived')) &&
              (question.deleted || has('issue:undeleted')))
        default: return true
      }
    },
    ids(question: ReaderQuestion): string[] {
      switch (question.kind) {
        case 'issueMentionMatches': return mentions?.ids(question) ?? []
        case 'mobileIssueTargets': {
          const keys = targetPathKeys(question.repoPath)
          const postings = keys.map(key => targetPostings.get(key) ?? []).filter(ids => ids.length)
          const ids = postings.length <= 1 ? postings[0] ?? [] : [...new Set(postings.flat())].sort(compareTargets)
          const needle = question.query.trim().toLocaleLowerCase()
          const refNeedle = normalizeIssueRef(needle)
          const prefixes = new Map<string, string>()
          if (/\d/.test(refNeedle))
            for (const [id, prefix] of Object.entries(question.prefixes))
              prefixes.set(id, normalizeIssueRef(prefix ?? ''))
          const out: string[] = []
          const limit = Math.max(0, Math.trunc(question.limit))
          if (!(limit > 0)) return out
          // No text work on opens, existence checks or pagination without a
          // query. Nonempty cold questions examine compact source scalars;
          // only the returned window is read/hydrated through the pool.
          for (let at = 0; at < ids.length && out.length < limit; at++) {
            const id = ids[at]!
            targetCounts.visits++
            if (id === question.excludeId) continue
            if (!needle) {
              out.push(id)
              continue
            }
            const target = targetDetails.get(id)!
            if (
              matchIssueTitleRef(
                target.title,
                `${prefixes.get(target.repoId) ?? ''}${target.ref}`,
                needle,
                refNeedle,
              )
            )
              out.push(id)
          }
          return out
        }
        case 'residentIssues':
          return []
        case 'proposedIssues':
          return [...bucket('issue:proposed')]
        case 'reclaimIssues':
          return [...bucket('issue:reclaim')]
        case 'inboxSessions':
          return [...bucket('session:inbox')]
        case 'headerSessions':
        case 'headerOccupancy':
          return [...bucket('session:host')]
        case 'headerRecentSession': {
          const excluded = question.excluded && 'has' in question.excluded
            ? question.excluded : new Set(question.excluded),
            frontier = recent.length ? [0] : []
          while (frontier.length) {
            frontier.sort((a, b) => (better(recent[a]!, recent[b]!) ? -1 : 1))
            const at = frontier.shift()!,
              entry = recent[at]!
            if (!excluded.has(entry.id)) return [entry.id]
            if (at * 2 + 1 < recent.length) frontier.push(at * 2 + 1)
            if (at * 2 + 2 < recent.length) frontier.push(at * 2 + 2)
          }
          return []
        }
        case 'sessionReference':
          return referenceKeys(question.ref).flatMap(key => [...bucket(key)])
        case 'commandIssueSessions':
          return [...bucket(commandIssueKey(question))]
        case 'containingIssues': {
          const ids = new Set<string>()
          const add = (path: string) => {
            for (const id of bucket(`issue:root:${machinePathKey(path)}`)) ids.add(id)
          }
          add(question.cwd)
          if (machinePathSeparator(question.cwd) === '\\') {
            for (const path of machinePathAncestors(question.cwd)) add(path)
          } else for (
            let at = question.cwd.indexOf('/');
            at >= 0;
            at = question.cwd.indexOf('/', at + 1)
          ) {
            add(question.cwd.slice(0, at))
            add(question.cwd.slice(0, at + 1))
          }
          return [...ids]
        }
        case 'boardCounts':
          return [...bucket('issue:live')]
        case 'spawnIssues': {
          const ids = new Set(question.repoId ? bucket(`issue:repo:${question.repoId}`) : [])
          const unassigned = bucket('issue:repo:')
          for (const id of bucket(`issue:path:${machinePathKey(question.repoPath)}`))
            if (unassigned.has(id)) ids.add(id)
          return intersection([ids, bucket('issue:undeleted')])
        }
        case 'boardIssues': {
          const sets: ReadonlySet<string>[] = [bucket('issue:all')]
          if (question.priority != null) sets.push(bucket(`issue:priority:${question.priority}`))
          if (question.stage) sets.push(bucket(`issue:status:${question.stage}`))
          if (
            question.status === 'open' ||
            question.status === 'closed' ||
            question.status === 'blocked'
          )
            sets.push(bucket(`issue:${question.status}`))
          if (question.projectPaths?.length)
            sets.push(
              new Set(question.projectPaths.flatMap((path) => [...pathMembers(path)])),
            )
          // Text searches also admit an archived exact reference. The reader
          // resolves that exception through its declared summary, on demand.
          if (question.explorerTab !== undefined && !question.searching) {
            sets.push(bucket('issue:live'))
            if (question.explorerTab === 'needs') sets.push(bucket('issue:open'))
            else if (question.explorerTab === 'cancelled')
              sets.push(
                new Set(
                  ['cancelled', 'duplicate', 'superseded'].flatMap((tab) => [
                    ...bucket(`issue:status:${tab}`),
                  ]),
                ),
              )
            else sets.push(bucket(`issue:status:${question.explorerTab}`))
          } else if (question.explorerTab === undefined) {
            if (!question.archived) sets.push(bucket('issue:unarchived'))
            if (!question.deleted) sets.push(bucket('issue:undeleted'))
          }
          return intersection(sets)
        }
        default:
          return [...bucket(`${questionEntity(question)}:all`)]
      }
    },
  }
}
