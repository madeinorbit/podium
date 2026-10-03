/** History questions, answered by the row source. Results contain identities,
 * never rows or a map. The same questions can later be answered from storage. */
import { issueStatusOf } from '@podium/model/browser'
import type { RowSourceEvent } from './source'

export type ReaderQuestion =
  | { kind: 'residentIssues' | 'commandIssues' | 'mentionIssues' | 'pageIssues' | 'shellIssues' | 'missionIssues' | 'boardCatalog' | 'boardCounts' | 'proposedIssues' | 'reclaimIssues' }
  | { kind: 'commandSessions' | 'inboxSessions' | 'setupSessions' | 'referenceSessions' | 'explorerSessions' | 'shellSessions' | 'headerSessions' | 'headerOccupancy' | 'headerRecentSession' }
  | { kind: 'sessionReference'; ref: string }
  | { kind: 'containingIssues'; cwd: string }
  | { kind: 'boardIssues'; priority?: number; stage?: string; status?: string; projectPaths?: readonly string[]; archived?: boolean; deleted?: boolean; explorerTab?: string; searching?: boolean }

export const questionEntity = (question: ReaderQuestion): 'issue' | 'session' =>
  question.kind.endsWith('Sessions') || question.kind.startsWith('header') || question.kind === 'sessionReference' ? 'session' : 'issue'

type Row = Readonly<Record<string, unknown>>
const byId = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0

/** Incremental identity/facet indexes. No payload or summary is retained. Text
 * matching and ancestor eligibility stay with the reader and its single row
 * read; scalar filters narrow that demand before any cold summary is read. */
export function createReaderIndex() {
  const buckets = new Map<string, Set<string>>()
  const repos = new Set<string>()
  const filed = new Map<string, Set<string>>()
  const recent: { id: string; at: string }[] = []
  const activity = new Map<string, string>()
  let version = 0
  function bucket(key: string): ReadonlySet<string> { return buckets.get(key) ?? new Set<string>() }
  function keys(kind: string, row: Row): Set<string> {
    const out = new Set<string>([`${kind}:all`])
    if (kind === 'issue') {
      out.add(`issue:repo:${row.repoId ?? ''}`)
      out.add(`issue:path:${row.repoPath ?? ''}`)
      out.add(`issue:priority:${row.priority}`)
      out.add(`issue:status:${issueStatusOf(row as Parameters<typeof issueStatusOf>[0])}`)
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
      if (['live', 'starting', 'reconnecting'].includes(row.status as string)) out.add('session:host')
      if (typeof row.displayRef === 'string') out.add(`session:ref:${row.displayRef}`)
    }
    return out
  }
  function set(kind: string, id: string, row: Row | undefined) {
    const address = `${kind}:${id}`, before = filed.get(address) ?? new Set<string>()
    const after = row ? keys(kind, row) : new Set<string>()
    let changed = false
    for (const key of before) if (!after.has(key)) {
      const ids = buckets.get(key)
      ids?.delete(id)
      if (ids?.size === 0) { buckets.delete(key); if (key.startsWith('issue:repo:')) repos.delete(key.slice('issue:repo:'.length)) }
      changed = true
    }
    for (const key of after) if (!before.has(key)) {
      let ids = buckets.get(key)
      if (!ids) { ids = new Set(); buckets.set(key, ids); if (key.startsWith('issue:repo:') && key !== 'issue:repo:') repos.add(key.slice('issue:repo:'.length)) }
      ids.add(id)
      changed = true
    }
    if (after.size) filed.set(address, after)
    else filed.delete(address)
    if (kind === 'session') {
      const at = row && !row.archived ? String(row.lastActiveAt ?? '') : undefined
      const previous = activity.get(id)
      if (at !== previous) {
        if (previous !== undefined) {
          const index = recent.findIndex(entry => entry.id === id)
          if (index !== -1) recent.splice(index, 1)
          activity.delete(id)
        }
        if (at !== undefined) {
          let lo = 0, hi = recent.length
          while (lo < hi) {
            const mid = (lo + hi) >>> 1, item = recent[mid]!
            if (item.at > at || (item.at === at && byId(item.id, id) < 0)) lo = mid + 1
            else hi = mid
          }
          recent.splice(lo, 0, { id, at }); activity.set(id, at)
        }
        changed = true
      }
    }
    if (changed) version++
  }
  function intersection(sets: ReadonlySet<string>[]): string[] {
    sets.sort((a, b) => a.size - b.size)
    return [...(sets[0] ?? [])].filter(id => sets.every(set => set.has(id)))
  }
  return {
    get version() { return version },
    apply(event: RowSourceEvent) {
      if (event.type === 'replace') { buckets.clear(); repos.clear(); filed.clear(); recent.length = 0; activity.clear(); version++ }
      for (const record of event.rows) if (record.kind !== 'worktree') set(record.kind, record.id, record.value as Row | undefined)
    },
    repoIds(): string[] {
      return [...repos].sort(byId)
    },
    ids(question: ReaderQuestion): string[] {
      switch (question.kind) {
        case 'residentIssues': return []
        case 'proposedIssues': return [...bucket('issue:proposed')]
        case 'reclaimIssues': return [...bucket('issue:reclaim')]
        case 'inboxSessions': return [...bucket('session:inbox')]
        case 'headerSessions': case 'headerOccupancy': return [...bucket('session:host')]
        case 'headerRecentSession': return recent[0] ? [recent[0].id] : []
        case 'sessionReference': return [...bucket(`session:ref:${question.ref}`)]
        case 'containingIssues': {
          const ids = new Set<string>()
          const add = (path: string) => { for (const id of bucket(`issue:root:${path}`)) ids.add(id) }
          add(question.cwd)
          for (let at = question.cwd.indexOf('/'); at >= 0; at = question.cwd.indexOf('/', at + 1)) {
            add(question.cwd.slice(0, at)); add(question.cwd.slice(0, at + 1))
          }
          return [...ids]
        }
        case 'boardCounts': return [...bucket('issue:live')]
        case 'boardIssues': {
          const sets: ReadonlySet<string>[] = [bucket('issue:all')]
          if (question.priority != null) sets.push(bucket(`issue:priority:${question.priority}`))
          if (question.stage) sets.push(bucket(`issue:status:${question.stage}`))
          if (question.status === 'open' || question.status === 'closed' || question.status === 'blocked') sets.push(bucket(`issue:${question.status}`))
          if (question.projectPaths?.length) sets.push(new Set(question.projectPaths.flatMap(path => [...bucket(`issue:path:${path}`)])))
          // Text searches also admit an archived exact reference. The reader
          // resolves that exception through its declared summary, on demand.
          if (question.explorerTab !== undefined && !question.searching) {
            sets.push(bucket('issue:live'))
            if (question.explorerTab === 'needs') sets.push(bucket('issue:open'))
            else if (question.explorerTab === 'cancelled') sets.push(new Set(['cancelled', 'duplicate', 'superseded'].flatMap(tab => [...bucket(`issue:status:${tab}`)])))
            else sets.push(bucket(`issue:status:${question.explorerTab}`))
          } else if (question.explorerTab === undefined) {
            if (!question.archived) sets.push(bucket('issue:unarchived'))
            if (!question.deleted) sets.push(bucket('issue:undeleted'))
          }
          return intersection(sets)
        }
        default: return [...bucket(`${questionEntity(question)}:all`)]
      }
    },
  }
}
