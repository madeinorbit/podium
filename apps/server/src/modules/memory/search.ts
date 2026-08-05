import { asIssueId, machineScopedKey } from '@podium/model'
import type { SearchResultWire } from '@podium/protocol'
import type { SessionStore } from '../../store'
import type { MemoryReader } from './types'
import type { MemoryVisibilityPolicy } from './visibility'

const TYPE_WEIGHT: Record<SearchResultWire['kind'], number> = {
  session: 1.2,
  issue: 1.1,
  conversation: 1,
  transcript: 0.9,
  setting: 0.8,
}
const RECENCY_WINDOW_MS = 30 * 86_400_000
const SETTINGS = [
  ['appearance', 'Appearance'],
  ['sessions', 'New sessions'],
  ['superagent', 'Superagent'],
  ['workllm', 'Background LLM'],
  ['keys', 'API keys'],
  ['hibernation', 'Hibernation'],
  ['notifications', 'Notifications'],
  ['workflow', 'Workflow'],
  ['integrations', 'Integrations'],
  ['machines', 'Machines'],
  ['security', 'Security'],
  ['updates', 'Updates'],
] as const

const boost = (ts: string | undefined, now: number): number => {
  if (!ts) return 0
  const age = now - Date.parse(ts)
  return Number.isFinite(age) ? 0.1 * Math.max(0, 1 - age / RECENCY_WINDOW_MS) : 0
}
const score = (
  kind: SearchResultWire['kind'],
  source: number,
  ts: string | undefined,
  now: number,
): number => TYPE_WEIGHT[kind] * source + boost(ts, now)

const excerpt = (body: string, query: string, radius = 60): string => {
  const at = body.toLowerCase().indexOf(query.toLowerCase())
  if (at < 0) return body.slice(0, radius * 2)
  const start = Math.max(0, at - radius)
  const end = Math.min(body.length, at + query.length + radius)
  return `${start > 0 ? '…' : ''}${body.slice(start, end)}${end < body.length ? '…' : ''}`
}

/**
 * FTS5 omni-search. Visibility is applied here, before score normalization,
 * de-duplication and limiting; callers cannot supply a pre-filtered id set.
 */
export class MemorySearchService {
  constructor(
    private readonly store: SessionStore,
    private readonly visibility: MemoryVisibilityPolicy,
  ) {}

  searchConversations(
    reader: MemoryReader,
    opts: { query?: string; projectPath?: string; limit?: number },
    visibility?: MemoryVisibilityPolicy,
  ) {
    const limit = Math.min(200, Math.max(1, opts.limit ?? 50))
    const scopedVisibility =
      visibility ??
      this.visibility.forRequest(this.store.sessions.loadSessions(), {
        // The native conversation-list RPC can return one row per distinct
        // issue. Prime those owner rows as one request-local batch; the omni
        // search caller passes its own visibility context and keeps its
        // existing memoized path unchanged.
        batchIssueOwners: true,
      })
    return this.store.conversations.index
      .searchCandidates(opts)
      .filter(
        (row) =>
          // POD-318: every stored row carries its reporting machine, and there is
          // no placeholder left to substitute — a machine-less row is unreadable
          // rather than readable-as-local.
          row.machineId !== undefined &&
          scopedVisibility.mayRead(reader, {
            class: 'conversation',
            machineId: row.machineId,
            nativeId: row.id,
          }),
      )
      .slice(0, limit)
  }

  search(
    reader: MemoryReader,
    opts: { text: string; limit?: number; now?: () => number },
  ): SearchResultWire[] {
    const text = opts.text.trim()
    if (!text) return []
    const limit = Math.min(100, Math.max(1, opts.limit ?? 30))
    const now = (opts.now ?? Date.now)()
    const lower = text.toLowerCase()
    const out: SearchResultWire[] = []
    const sessions = this.store.sessions.loadSessions()
    const visibility = this.visibility.forRequest(sessions)

    for (const row of sessions) {
      if (!visibility.mayRead(reader, { class: 'session', id: row.id })) continue
      const nameHit = (row.name ?? '').toLowerCase().includes(lower)
      const titleHit = row.title.toLowerCase().includes(lower)
      const cwdHit = row.cwd.toLowerCase().includes(lower)
      if (!nameHit && !titleHit && !cwdHit) continue
      out.push({
        kind: 'session',
        id: row.id,
        title: row.name ?? row.title,
        snippet: cwdHit && !nameHit && !titleHit ? row.cwd : undefined,
        score: score('session', nameHit || titleHit ? 1 : 0.7, row.lastActiveAt, now),
        ts: row.lastActiveAt,
        sessionId: row.id,
        ...(row.machineId ? { machineId: row.machineId } : {}),
      })
    }

    const visibleIssues = new Map(
      this.store.issues
        .listIssueRows()
        .filter(
          (row) => !row.deletedAt && visibility.mayRead(reader, { class: 'issue', id: row.id }),
        )
        .map((row) => [row.id, row]),
    )
    const issueHits = new Set<string>()
    for (const row of visibleIssues.values()) {
      const hay = `${row.title} ${row.description} ${row.notes ?? ''}`.toLowerCase()
      if (!hay.includes(lower)) continue
      const titleHit = row.title.toLowerCase().includes(lower)
      out.push({
        kind: 'issue',
        id: row.id,
        title: row.title,
        snippet: titleHit ? undefined : excerpt(`${row.description} ${row.notes ?? ''}`, text),
        score: score('issue', titleHit ? 1 : 0.7, row.updatedAt, now),
        ts: row.updatedAt,
        repoPath: row.repoPath,
      })
      issueHits.add(row.id)
    }
    for (const comment of this.store.issues.searchIssueComments(text, null)) {
      const issue = visibleIssues.get(asIssueId(comment.issueId))
      if (!issue || issueHits.has(issue.id)) continue
      out.push({
        kind: 'issue',
        id: issue.id,
        title: issue.title,
        snippet: excerpt(comment.body, text),
        score: score('issue', 0.6, comment.createdAt, now),
        ts: comment.createdAt,
        repoPath: issue.repoPath,
      })
      issueHits.add(issue.id)
    }

    for (const row of this.searchConversations(reader, { query: text, limit: 200 }, visibility)) {
      out.push({
        kind: 'conversation',
        id: row.id,
        title: row.name ?? row.title ?? row.projectPath ?? row.id,
        snippet: row.summary,
        score: score('conversation', 1, row.updatedAt, now),
        ts: row.updatedAt,
        nativeId: row.id,
        ...(row.machineId ? { machineId: row.machineId } : {}),
      })
    }

    // Superagent threads are conversations too, but owner-filtered before message reads.
    if (reader.kind !== 'system') {
      const owner = reader.kind === 'user' ? reader.id : reader.onBehalfOf
      for (const thread of this.store.superagent.listSuperagentThreads(owner)) {
        if (
          !visibility.mayRead(reader, {
            class: 'superagent-thread',
            id: thread.id,
            ownerUserId: thread.ownerUserId,
          })
        )
          continue
        const messages = this.store.superagent.loadSuperagentMessages(thread.id)
        const matching = messages.find((message) => message.content.toLowerCase().includes(lower))
        const titleHit = (thread.title ?? '').toLowerCase().includes(lower)
        if (!titleHit && !matching) continue
        out.push({
          kind: 'conversation',
          id: `superagent:${thread.id}`,
          title: thread.title ?? 'Superagent',
          snippet: matching ? excerpt(matching.content, text) : undefined,
          score: score('conversation', titleHit ? 1 : 0.7, thread.updatedAt, now),
          ts: thread.updatedAt,
          nativeId: thread.id,
        })
      }
    }

    const visibleTranscriptRows = this.store.conversations.transcriptIndex
      .searchCandidates(text)
      .filter((row) =>
        visibility.mayRead(reader, {
          class: 'transcript',
          machineId: row.machineId,
          nativeId: row.nativeId,
        }),
      )
    const bestRank = visibleTranscriptRows[0]?.rank
    const seen = new Set<string>()
    for (const row of visibleTranscriptRows) {
      const key = machineScopedKey(row.machineId, row.nativeId)
      if (seen.has(key)) continue
      seen.add(key)
      const normalized = bestRank !== undefined && bestRank < 0 ? row.rank / bestRank : 1
      const session = sessions.find(
        (candidate) =>
          candidate.machineId === row.machineId &&
          candidate.resumeValue === row.nativeId &&
          visibility.mayRead(reader, { class: 'session', id: candidate.id }),
      )
      out.push({
        kind: 'transcript',
        id: row.itemUuid ?? `${row.nativeId}:${row.ts ?? ''}`,
        title: row.title ?? session?.name ?? session?.title ?? 'Transcript',
        snippet: row.snippet,
        score: score('transcript', normalized, row.ts ?? row.updatedAt, now),
        ...(row.ts ? { ts: row.ts } : {}),
        machineId: row.machineId,
        nativeId: row.nativeId,
        ...(row.podiumId ? { podiumId: row.podiumId } : {}),
        ...(session ? { sessionId: session.id } : {}),
      })
    }

    for (const [key, label] of SETTINGS) {
      if (!visibility.mayRead(reader, { class: 'setting', id: key })) continue
      if (!label.toLowerCase().includes(lower) && !key.includes(lower)) continue
      out.push({
        kind: 'setting',
        id: key,
        title: `Settings › ${label}`,
        score: score('setting', 1, undefined, now),
        settingKey: key,
      })
    }

    return out.sort((a, b) => b.score - a.score).slice(0, limit)
  }
}
