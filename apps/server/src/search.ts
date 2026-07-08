import type { IssueWire, SearchResultWire, SessionMeta } from '@podium/protocol'
import type { SessionStore } from './store'

/** The registry surface search needs — kept structural so tests can fake it. */
export interface SearchRegistry {
  listSessions(): SessionMeta[]
  issues: { search(filter: { text?: string }): IssueWire[] }
}

/**
 * Score fusion (docs/spec/search-v1.md §2.4) — deliberately dead simple:
 *
 *   score = typeWeight × sourceScore + recencyBoost
 *
 * - `sourceScore` ∈ 0..1, normalized WITHIN each source: transcript bm25 ranks
 *   scale against the source's best hit; heuristic sources grade by where the
 *   match landed (title/name = 1, body/path = a fixed fraction).
 * - `typeWeight` ranks kinds at equal relevance: session 1.2 > issue 1.1 >
 *   conversation 1.0 > transcript 0.9 > setting 0.8 — actionable things the user
 *   likely wants to jump BACK to beat old transcript prose.
 * - `recencyBoost` is a mild additive nudge (≤ 0.1) that decays linearly to zero
 *   over 30 days; sources without a timestamp get none. It reorders near-ties,
 *   never overrules a clearly better text match.
 */
const TYPE_WEIGHT: Record<SearchResultWire['kind'], number> = {
  session: 1.2,
  issue: 1.1,
  conversation: 1.0,
  transcript: 0.9,
  setting: 0.8,
}

const RECENCY_BOOST_MAX = 0.1
const RECENCY_WINDOW_DAYS = 30

function recencyBoost(ts: string | undefined, now: number): number {
  if (!ts) return 0
  const ageDays = (now - Date.parse(ts)) / 86_400_000
  if (!Number.isFinite(ageDays)) return 0
  return RECENCY_BOOST_MAX * Math.max(0, 1 - ageDays / RECENCY_WINDOW_DAYS)
}

function fuse(
  kind: SearchResultWire['kind'],
  sourceScore: number,
  ts: string | undefined,
  now: number,
): number {
  return TYPE_WEIGHT[kind] * sourceScore + recencyBoost(ts, now)
}

/** One-line excerpt around the first case-insensitive match of `q` in `body`. */
function excerptAround(body: string, q: string, radius = 60): string {
  const at = body.toLowerCase().indexOf(q.toLowerCase())
  if (at < 0) return body.slice(0, radius * 2)
  const start = Math.max(0, at - radius)
  const end = Math.min(body.length, at + q.length + radius)
  return `${start > 0 ? '…' : ''}${body.slice(start, end)}${end < body.length ? '…' : ''}`
}

/** Static settings catalog — mirrors SETTINGS_TABS in apps/web/src/SettingsView.tsx
 *  (the deep-link keys the settings screen already honors). A hardcoded list is
 *  fine: tabs change with the UI, and a stale entry just deep-links to the default
 *  tab. Keep in sync when SettingsView gains a tab. */
const SETTINGS_CATALOG: { key: string; label: string }[] = [
  { key: 'appearance', label: 'Appearance' },
  { key: 'sessions', label: 'New sessions' },
  { key: 'superagent', label: 'Superagent' },
  { key: 'workllm', label: 'Background LLM' },
  { key: 'keys', label: 'API keys' },
  { key: 'hibernation', label: 'Hibernation' },
  { key: 'notifications', label: 'Notifications' },
  { key: 'workflow', label: 'Workflow' },
  { key: 'integrations', label: 'Integrations' },
  { key: 'machines', label: 'Machines' },
  { key: 'security', label: 'Security' },
  { key: 'updates', label: 'Updates' },
]

/**
 * Omni-search (docs/spec/search-v1.md §2.4): one ranked, typed result list across
 * transcripts (FTS5), issues + comments, conversations, sessions and settings.
 * Read-only over the store + registry; per-source failures degrade to an absent
 * source (e.g. no FTS5 → no transcript hits), never a thrown search.
 */
export function searchAll(
  store: SessionStore,
  registry: SearchRegistry,
  opts: { text: string; limit?: number; now?: () => number },
): SearchResultWire[] {
  const text = opts.text.trim()
  if (!text) return []
  const limit = Math.min(100, Math.max(1, opts.limit ?? 30))
  const now = (opts.now ?? Date.now)()
  const lower = text.toLowerCase()
  const out: SearchResultWire[] = []

  // ---- sessions: name/title/cwd substring over the live registry ----
  for (const s of registry.listSessions()) {
    const nameHit = (s.name ?? '').toLowerCase().includes(lower)
    const titleHit = s.title.toLowerCase().includes(lower)
    const cwdHit = s.cwd.toLowerCase().includes(lower)
    if (!nameHit && !titleHit && !cwdHit) continue
    out.push({
      kind: 'session',
      id: s.sessionId,
      title: s.name ?? s.title,
      snippet: cwdHit && !nameHit && !titleHit ? s.cwd : undefined,
      score: fuse('session', nameHit || titleHit ? 1 : 0.7, s.lastActiveAt, now),
      ts: s.lastActiveAt,
      sessionId: s.sessionId,
      ...(s.machineId !== undefined ? { machineId: s.machineId } : {}),
    })
  }

  // ---- issues (existing in-memory search) + comment bodies (LIKE) ----
  const issueHits = new Map<string, SearchResultWire>()
  for (const w of registry.issues.search({ text })) {
    const inTitle = w.title.toLowerCase().includes(lower)
    issueHits.set(w.id, {
      kind: 'issue',
      id: w.id,
      title: w.title,
      snippet: inTitle ? undefined : excerptAround(`${w.description} ${w.notes ?? ''}`, text),
      score: fuse('issue', inTitle ? 1 : 0.7, w.updatedAt, now),
      ts: w.updatedAt,
      repoPath: w.repoPath,
    })
  }
  let allIssues: IssueWire[] | undefined // lazy: only comment hits need the full list
  for (const c of store.issues.searchIssueComments(text, limit)) {
    if (issueHits.has(c.issueId)) continue // the issue already matched on its own text
    allIssues ??= registry.issues.search({})
    const issue = allIssues.find((w) => w.id === c.issueId)
    if (!issue) continue // comment on a deleted/unloaded issue
    issueHits.set(c.issueId, {
      kind: 'issue',
      id: c.issueId,
      title: issue.title,
      snippet: excerptAround(c.body, text),
      score: fuse('issue', 0.6, c.createdAt, now),
      ts: c.createdAt,
      repoPath: issue.repoPath,
    })
  }
  out.push(...issueHits.values())

  // ---- conversations: the existing index search (FTS5/LIKE inside the store).
  // It returns recency-ordered matches without a per-row score, so every hit
  // grades 1.0 and the recency boost differentiates within the source. ----
  for (const c of store.conversations.searchConversations({ query: text, limit })) {
    out.push({
      kind: 'conversation',
      id: c.id,
      title: c.name ?? c.title ?? c.projectPath ?? c.id,
      snippet: c.summary,
      score: fuse('conversation', 1, c.updatedAt, now),
      ts: c.updatedAt,
      nativeId: c.id,
      ...(c.machineId !== undefined ? { machineId: c.machineId } : {}),
    })
  }

  // ---- transcripts: FTS5 bm25 + snippet(), best hit per conversation segment.
  // bm25 is smaller-is-better (negative); normalize against the batch's best so
  // the top hit grades 1.0. A live session whose resume value is the segment's
  // native id gets a sessionId ref so the client can open the chat directly. ----
  const transcriptRows = store.conversations.searchTranscripts(text, limit)
  const bestRank = transcriptRows[0]?.rank
  const seenSegments = new Set<string>()
  const sessions = registry.listSessions()
  for (const t of transcriptRows) {
    const segKey = `${t.machineId}\n${t.nativeId}`
    if (seenSegments.has(segKey)) continue // one result per conversation, best rank first
    seenSegments.add(segKey)
    const norm = bestRank !== undefined && bestRank < 0 ? t.rank / bestRank : 1
    const session = sessions.find(
      (s) => s.machineId === t.machineId && s.resume?.value === t.nativeId,
    )
    out.push({
      kind: 'transcript',
      id: t.itemUuid ?? `${t.nativeId}:${t.ts ?? ''}`,
      title: t.title ?? session?.name ?? session?.title ?? 'Transcript',
      snippet: t.snippet,
      score: fuse('transcript', norm, t.ts ?? t.updatedAt, now),
      ...(t.ts !== undefined ? { ts: t.ts } : {}),
      machineId: t.machineId,
      nativeId: t.nativeId,
      ...(t.podiumId !== undefined ? { podiumId: t.podiumId } : {}),
      ...(session ? { sessionId: session.sessionId } : {}),
    })
  }

  // ---- settings: static key catalog, label/key substring ----
  for (const s of SETTINGS_CATALOG) {
    if (!s.label.toLowerCase().includes(lower) && !s.key.includes(lower)) continue
    out.push({
      kind: 'setting',
      id: s.key,
      title: `Settings › ${s.label}`,
      score: fuse('setting', 1, undefined, now),
      settingKey: s.key,
    })
  }

  return out.sort((a, b) => b.score - a.score).slice(0, limit)
}
