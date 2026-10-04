/** History questions, answered by the row source. Results contain identities,
 * never rows or a map. The same questions can later be answered from storage. */
import { issueStatusOf } from '@podium/model/browser'
import type { RowSourceEvent } from './source'

export type ReaderQuestion =
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
  | { kind: 'headerRecentSession'; excluded?: readonly string[] }
  | { kind: 'sessionReference'; ref: string }
  | { kind: 'commandIssueSessions'; issueId: string; archived?: boolean; includeShells?: boolean }
  | { kind: 'containingIssues'; cwd: string }
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
const byId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
const commandIssueKey = (question: Extract<ReaderQuestion, { kind: 'commandIssueSessions' }>) =>
  `session:commandIssue${question.archived === false ? 'Live' : ''}${question.includeShells ? 'WithShells' : ''}:${question.issueId}`
const targetTitle = 'issue:targetTitle:'
const targetGram = (field: 'title' | 'ref', text: string, path: string) =>
  `issue:targetGram:${field}:${JSON.stringify([path, text])}`
const targetSequenceStart = (text: string, path: string) =>
  `issue:targetSequenceStart:${JSON.stringify([path, text])}`
function grams(text: string, length: number): Set<string> {
  const out = new Set<string>()
  if (length === 0) return out
  for (let at = 0; at <= text.length - length; at++) out.add(text.slice(at, at + length))
  return out
}

/** Incremental source identity/facet indexes. No row or summary is retained.
 * The phone target question answers its declared order/text predicate here;
 * other questions narrow the reader's scalar and ancestor checks. */
export function createReaderIndex() {
  const buckets = new Map<string, Set<string>>()
  const repos = new Set<string>()
  const filed = new Map<string, Set<string>>()
  const recent: { id: string; at: string }[] = []
  const positions = new Map<string, number>()
  const revisions = new Map<string, number>()
  // Source identity/facet postings, never pool objects or cached row payloads.
  // Sorted at publication time so an open reads only its requested window.
  const targetOrder = new Map<string, number>()
  const targetPostings = new Map<string, string[]>()
  const targetRepos = new Map<string, Map<string, number>>()
  const targetCounts = { visits: 0 }
  let replacement = 0
  let repoRevision = 0
  let version = 0
  const touch = (key: string) => {
    const revision = ++version
    // Text postings invalidate through mobileTargets:issue:path. Keep the
    // publication clock advancing without retaining their unread revisions.
    if (!key.startsWith('issue:targetGram:') && !key.startsWith('issue:targetSequenceStart:'))
      revisions.set(key, revision)
  }
  const compareTargets = (a: string, b: string) =>
    (targetOrder.get(b) ?? 0) - (targetOrder.get(a) ?? 0) || byId(a, b)
  const orderedTargetKey = (key: string) =>
    key.startsWith('issue:path:') ||
    key.startsWith('issue:targetGram:') ||
    key.startsWith('issue:targetSequenceStart:')
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
    if (!ids) targetPostings.set(key, (ids = []))
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
      // Publication reads each scalar once. In particular, a path must not be
      // read again for every text gram; the source may be a counted row proxy.
      const { repoId, repoPath, seq, priority, stage, closedReason, blocked, archived,
        deletedAt, worktreePath } = row
      const path = String(repoPath ?? ''),
        title = String(row.title ?? '').toLocaleLowerCase(),
        ref = String(seq ?? '')
      out.add(`issue:repo:${repoId ?? ''}`)
      out.add(`issue:path:${path}`)
      for (let length = 1; length <= ref.length; length++)
        out.add(targetSequenceStart(ref.slice(0, length), path))
      out.add(`${targetTitle}${title}`)
      for (const [field, text] of [
        ['title', title],
        ['ref', ref],
      ] as const)
        for (let length = 1; length <= Math.min(3, text.length); length++)
          for (const gram of grams(text, length))
            out.add(targetGram(field, gram, path))
      out.add(`issue:priority:${priority}`)
      out.add(
        `issue:status:${issueStatusOf({ stage, closedReason } as Parameters<typeof issueStatusOf>[0])}`,
      )
      out.add(stage === 'done' || closedReason != null ? 'issue:closed' : 'issue:open')
      if (blocked) out.add('issue:blocked')
      if (!archived && !deletedAt) out.add('issue:live')
      if (!archived || deletedAt) out.add('issue:unarchived')
      if (!deletedAt) out.add('issue:undeleted')
      if (stage === 'proposed') out.add('issue:proposed')
      if (typeof worktreePath === 'string' && worktreePath) {
        out.add(`issue:root:${worktreePath}`)
        if (!deletedAt && (stage === 'done' || closedReason)) out.add('issue:reclaim')
      }
    } else if (kind === 'session') {
      const { archived, headless, agentKind, status, displayRef, issueId } = row
      if (!archived) out.add('session:unarchived')
      if (!archived && !headless && agentKind !== 'shell') out.add('session:inbox')
      if (['live', 'starting', 'reconnecting'].includes(status as string))
        out.add('session:host')
      if (typeof displayRef === 'string') out.add(`session:ref:${displayRef}`)
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
          else repos?.delete(oldRepo)
          if (!repos?.size) targetRepos.delete(oldPath)
        }
        if (nextPath !== undefined && nextRepo !== undefined) {
          let repos = targetRepos.get(nextPath)
          if (!repos) targetRepos.set(nextPath, (repos = new Map()))
          repos.set(nextRepo, (repos.get(nextRepo) ?? 0) + 1)
        }
      }
      const seq = row ? Number(row.seq ?? 0) : undefined
      const moved = targetOrder.get(id) !== seq
      for (const key of before)
        if (beforeEligible && orderedTargetKey(key) && (!afterEligible || moved || !after.has(key)))
          removeTarget(key, id)
      if (seq === undefined) targetOrder.delete(id)
      else targetOrder.set(id, seq)
      for (const key of after)
        if (
          afterEligible &&
          orderedTargetKey(key) &&
          (!beforeEligible || moved || !before.has(key))
        )
          addTarget(key, id)
      if (moved || before.size !== after.size || [...before].some((key) => !after.has(key)))
        for (const key of new Set([...before, ...after]))
          if (key.startsWith('issue:path:')) touch(`mobileTargets:${key}`)
    }
    // Full titles are verification facets, not membership keys. Keep them in
    // filed (and in the change comparison above), without buckets or revisions.
    for (const key of before)
      if (!key.startsWith(targetTitle) && !after.has(key)) {
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
      if (!key.startsWith(targetTitle) && !before.has(key)) {
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
    if (kind === 'session') {
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
    revision(question: ReaderQuestion): number {
      const keys = [`${questionEntity(question)}:all`]
      switch (question.kind) {
        case 'mobileIssueTargets':
          return Math.max(
            replacement,
            revisions.get(`mobileTargets:issue:path:${question.repoPath}`) ?? 0,
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
          keys.push(`session:ref:${question.ref}`)
          break
        case 'commandIssueSessions':
          keys.push(commandIssueKey(question))
          break
        case 'containingIssues':
          keys.push(`issue:root:${question.cwd}`)
          for (let at = question.cwd.indexOf('/'); at >= 0; at = question.cwd.indexOf('/', at + 1))
            keys.push(
              `issue:root:${question.cwd.slice(0, at)}`,
              `issue:root:${question.cwd.slice(0, at + 1)}`,
            )
          break
        case 'boardCounts':
          keys.push('issue:live')
          break
        case 'boardIssues':
          if (question.priority != null) keys.push(`issue:priority:${question.priority}`)
          if (question.stage) keys.push(`issue:status:${question.stage}`)
          if (question.status) keys.push(`issue:${question.status}`)
          for (const path of question.projectPaths ?? []) keys.push(`issue:path:${path}`)
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
        buckets.clear()
        repos.clear()
        filed.clear()
        recent.length = 0
        positions.clear()
        revisions.clear()
        targetOrder.clear()
        targetPostings.clear()
        targetRepos.clear()
        replacement = ++version
        repoRevision++
      }
      for (const record of event.rows)
        if (record.kind !== 'worktree') set(record.kind, record.id, record.value as Row | undefined)
    },
    repoIds(path?: string): string[] {
      return [...(path === undefined ? repos : (targetRepos.get(path)?.keys() ?? []))].sort(byId)
    },
    ids(question: ReaderQuestion): string[] {
      switch (question.kind) {
        case 'mobileIssueTargets': {
          const path = `issue:path:${question.repoPath}`
          const repo = bucket(path),
            undeleted = bucket('issue:undeleted')
          const needle = question.query.trim().toLocaleLowerCase()
          const refNeedle = needle.replace(/[^a-z0-9]/g, '')
          const prefixes = new Set([
            '',
            ...Object.values(question.prefixes).map((prefix) =>
              (prefix ?? '').toLocaleLowerCase().replace(/[^a-z0-9]/g, ''),
            ),
          ])
          const sequences = new Map<string, { text: string; starts: boolean }>()
          if (/\d/.test(refNeedle))
            for (const prefix of prefixes) {
              if (prefix.includes(refNeedle)) sequences.set('any:', { text: '', starts: false })
              for (let cut = 0; cut < refNeedle.length; cut++) {
                const tail = refNeedle.slice(cut)
                if (prefix.endsWith(refNeedle.slice(0, cut)) && /^\d+$/.test(tail))
                  sequences.set(`${cut > 0 ? 'start' : 'any'}:${tail}`, {
                    text: tail,
                    starts: cut > 0,
                  })
              }
            }
          const candidates = (field: 'title' | 'ref', text: string, starts = false) => {
            const lists = [targetPostings.get(path) ?? []]
            const sets: ReadonlySet<string>[] = [repo, undeleted]
            if (starts) {
              const key = targetSequenceStart(text, question.repoPath)
              lists.push(targetPostings.get(key) ?? [])
              sets.push(bucket(key))
            }
            for (const gram of grams(text, Math.min(3, text.length))) {
              const key = targetGram(field, gram, question.repoPath)
              lists.push(targetPostings.get(key) ?? [])
              sets.push(bucket(key))
            }
            lists.sort((a, b) => a.length - b.length)
            return { ids: lists[0]!, sets, field, text }
          }
          const lanes = needle
            ? [
                candidates('title', needle),
                ...[...sequences.values()].map(({ text, starts }) =>
                  candidates('ref', text, starts),
                ),
              ]
            : [candidates('title', '')]
          const positions = lanes.map(() => 0),
            out: string[] = []
          const limit = Math.max(0, Math.trunc(question.limit))
          while (out.length < limit) {
            let lane = -1,
              id: string | undefined
            for (let at = 0; at < lanes.length; at++) {
              const next = lanes[at]!.ids[positions[at]!]
              if (next !== undefined && (id === undefined || compareTargets(next, id) < 0)) {
                lane = at
                id = next
              }
            }
            if (id === undefined) break
            positions[lane]!++
            targetCounts.visits++
            const input = lanes[lane]!
            if (id === question.excludeId || !input.sets.every((set) => set.has(id))) continue
            const facets = filed.get(`issue:${id}`) ?? new Set<string>()
            if (input.field === 'title') {
              if (
                input.text &&
                ![...facets].some(
                  (key) =>
                    key.startsWith(targetTitle) &&
                    key.slice(targetTitle.length).includes(input.text),
                )
              )
                continue
            } else {
              const repoId =
                [...facets]
                  .find((key) => key.startsWith('issue:repo:'))
                  ?.slice('issue:repo:'.length) ?? ''
              const ref = `${question.prefixes[repoId] ?? ''}${targetOrder.get(id)}`
                .toLocaleLowerCase()
                .replace(/[^a-z0-9]/g, '')
              if (!ref.includes(refNeedle)) continue
            }
            if (out[out.length - 1] !== id) out.push(id)
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
          const excluded = new Set(question.excluded),
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
          return [...bucket(`session:ref:${question.ref}`)]
        case 'commandIssueSessions':
          return [...bucket(commandIssueKey(question))]
        case 'containingIssues': {
          const ids = new Set<string>()
          const add = (path: string) => {
            for (const id of bucket(`issue:root:${path}`)) ids.add(id)
          }
          add(question.cwd)
          for (
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
              new Set(question.projectPaths.flatMap((path) => [...bucket(`issue:path:${path}`)])),
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
