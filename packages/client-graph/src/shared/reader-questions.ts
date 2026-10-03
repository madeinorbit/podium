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
  | { kind: 'commandIssueSessions'; issueId: string }
  | { kind: 'containingIssues'; cwd: string }
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

/** Incremental identity/facet indexes. No payload or summary is retained. Text
 * matching and ancestor eligibility stay with the reader and its single row
 * read; scalar filters narrow that demand before any cold summary is read. */
export function createReaderIndex() {
  const buckets = new Map<string, Set<string>>()
  const repos = new Set<string>()
  const filed = new Map<string, Set<string>>()
  const recent: { id: string; at: string }[] = []
  const positions = new Map<string, number>()
  const revisions = new Map<string, number>()
  let replacement = 0
  let repoRevision = 0
  let version = 0
  const touch = (key: string) => revisions.set(key, ++version)
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
      out.add(`issue:repo:${row.repoId ?? ''}`)
      out.add(`issue:path:${row.repoPath ?? ''}`)
      out.add(`issue:priority:${row.priority}`)
      out.add(
        `issue:status:${issueStatusOf({ stage: row.stage, closedReason: row.closedReason } as Parameters<typeof issueStatusOf>[0])}`,
      )
      out.add(row.stage === 'done' || row.closedReason != null ? 'issue:closed' : 'issue:open')
      if (row.blocked) out.add('issue:blocked')
      if (!row.archived && !row.deletedAt) out.add('issue:live')
      if (!row.archived || row.deletedAt) out.add('issue:unarchived')
      if (!row.deletedAt) out.add('issue:undeleted')
      if (row.stage === 'proposed') out.add('issue:proposed')
      if (typeof row.worktreePath === 'string' && row.worktreePath) {
        out.add(`issue:root:${row.worktreePath}`)
        if (!row.deletedAt && (row.stage === 'done' || row.closedReason)) out.add('issue:reclaim')
      }
    } else if (kind === 'session') {
      if (!row.archived) out.add('session:unarchived')
      if (!row.archived && !row.headless && row.agentKind !== 'shell') out.add('session:inbox')
      if (['live', 'starting', 'reconnecting'].includes(row.status as string))
        out.add('session:host')
      if (typeof row.displayRef === 'string') out.add(`session:ref:${row.displayRef}`)
      if (typeof row.issueId === 'string' && row.agentKind !== 'shell')
        out.add(`session:commandIssue:${row.issueId}`)
    }
    return out
  }
  function set(kind: string, id: string, row: Row | undefined) {
    const address = `${kind}:${id}`,
      before = filed.get(address) ?? new Set<string>()
    const after = row ? keys(kind, row) : new Set<string>()
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
    get version() {
      return version
    },
    get repoRevision() {
      return repoRevision
    },
    revision(question: ReaderQuestion): number {
      const keys = [`${questionEntity(question)}:all`]
      switch (question.kind) {
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
          keys.push(`session:commandIssue:${question.issueId}`)
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
        replacement = ++version
        repoRevision++
      }
      for (const record of event.rows)
        if (record.kind !== 'worktree') set(record.kind, record.id, record.value as Row | undefined)
    },
    repoIds(): string[] {
      return [...repos].sort(byId)
    },
    ids(question: ReaderQuestion): string[] {
      switch (question.kind) {
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
          return [...bucket(`session:commandIssue:${question.issueId}`)]
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
