/**
 * Concierge intake threads (modules/superagent, issue #64): per-repo thread
 * identity, the repo-scoped system prompt, and the deterministic tracker
 * digest/delta blocks that seed a thread's harness turns.
 */
import type { IssueWire } from '@podium/protocol'

/** Per-repo concierge intake thread (issue #64). One thread per repo path, id
 *  deterministic + reversible: `concierge_<base64url(repoPath)>`. */
export function conciergeThreadId(repoPath: string): string {
  return `concierge_${Buffer.from(repoPath, 'utf8').toString('base64url')}`
}

export function conciergeRepoPath(threadId: string): string | undefined {
  if (!threadId.startsWith('concierge_')) return undefined
  try {
    return Buffer.from(threadId.slice('concierge_'.length), 'base64url').toString('utf8')
  } catch {
    return undefined
  }
}

export function conciergeSystemPrompt(repoPath: string): string {
  return `You are the Podium concierge for ${repoPath}. The user types wishes, questions, and status asks here.

Ground rules:
- SEARCH BEFORE CREATE: run issue_search and issue_find_duplicates first; link to or reuse existing epics/issues instead of creating duplicates.
- PRIOR ART before filing ANY new work: besides issue_search/issue_find_duplicates, run search_all over past conversations and transcripts, and check for existing branches/worktrees on related issues (issue data carries branch and worktreePath). When something relevant exists, PRESENT the prior art to the user — cite issue #s, session titles, and branch names you found — and ask whether to continue the existing thread of work or start fresh. Only file new issues after that check comes up empty or the user chose fresh.
- Structure work as an epic with child issues; add blocks-dependencies (issue_dep_add) for sequencing. Write each issue description as a self-contained work brief — it becomes the working agent's first prompt, so it must stand alone.
- INTERACTIVE-ONLY: NEVER call issue_start (or any session-spawning tool: start_agent, issue_add_session, issue_add_shell) unless the user explicitly confirmed starting in THIS conversation ("start it", "go", "kick it off"). Propose, then wait. Auto-dispatch is deliberately disabled product-wide. When (and only when) the user has explicitly confirmed, pass {"confirmed": true} to the tool.
- Status questions: answer from the issue tools / list_sessions / recent events; summarize in plain sentences, never dump raw lists unless asked. Cite the sessions and issue #s the answer is based on.
- Always end with: what you did (created/linked issue #s), and what awaits the user's word.`
}

// ---- concierge seeding ---------------------------------------------------------

export interface ConciergeEvent {
  ts: string
  kind: string
  subject: string
  payload: unknown
}

export interface ConciergeSessionInfo {
  sessionId: string
  name?: string
  agentKind?: string
  phase?: string
  spawnedBy?: string
  issueSeq?: number
  cwd?: string
}

const issueLine = (i: IssueWire): string => `#${i.seq} ${i.title} P${i.priority}`

export function eventLine(e: ConciergeEvent, seqOf: (id: string) => number | undefined): string {
  const p = (e.payload ?? {}) as Record<string, unknown>
  const seq = typeof p.seq === 'number' ? p.seq : seqOf(e.subject)
  const extra =
    typeof p.title === 'string'
      ? ` "${p.title}"`
      : typeof p.question === 'string'
        ? ` "${p.question}"`
        : typeof p.reason === 'string'
          ? ` (${p.reason})`
          : typeof p.stage === 'string'
            ? ` → ${p.stage}`
            : ''
  return `[${e.ts}] #${seq ?? '?'} ${e.kind.replace(/^issue\./, '')}${extra}`
}

/**
 * The opening context for a new concierge thread: a deterministic, zero-LLM
 * digest of the repo's tracker + sessions. Compact by construction (top-N slices,
 * one-liners) — well under ~2k tokens.
 */
export function buildConciergeSeed(opts: {
  repoPath: string
  ready: IssueWire[]
  blocked: IssueWire[]
  needsHuman: IssueWire[]
  all: IssueWire[]
  sessions: ConciergeSessionInfo[]
  events: ConciergeEvent[]
  maxEventId: number
}): string {
  const { repoPath, ready, blocked, needsHuman, all, sessions, events } = opts
  const seqOf = (id: string) => all.find((i) => i.id === id)?.seq
  const lines: string[] = [
    '[CONCIERGE CONTEXT]',
    `Repo: ${repoPath}. Deterministic tracker digest (event cursor ${opts.maxEventId}).`,
    '',
    `Ready (${ready.length}):`,
    ...(ready.length ? ready.slice(0, 10).map((i) => `- ${issueLine(i)}`) : ['- (none)']),
    ...(ready.length > 10 ? [`- (+${ready.length - 10} more)`] : []),
    '',
    `Blocked: ${blocked.length}`,
    ...blocked.slice(0, 3).map((i) => {
      const by = i.blockedBy.map((id) => `#${seqOf(id) ?? '?'}`).join(', ')
      return `- ${issueLine(i)} — blocked by ${by || i.dependencyNote || '?'}`
    }),
    '',
    'Needs human:',
    ...(needsHuman.length
      ? needsHuman
          .slice(0, 10)
          .map((i) => `- #${i.seq} ${i.humanQuestion ?? '(no question recorded)'}`)
      : ['- (none)']),
    ...(needsHuman.length > 10 ? [`- (+${needsHuman.length - 10} more)`] : []),
    '',
    'Live sessions:',
    ...(sessions.length
      ? sessions
          .slice(0, 10)
          .map(
            (s) =>
              `- ${s.name ?? s.sessionId} · ${s.agentKind ?? '?'} · ${s.phase ?? '?'}` +
              `${s.spawnedBy ? ` · by ${s.spawnedBy}` : ''}${s.issueSeq != null ? ` · issue #${s.issueSeq}` : ''}`,
          )
      : ['- (none)']),
    ...(sessions.length > 10 ? [`- (+${sessions.length - 10} more)`] : []),
    '',
    `Recent issue events (last ${Math.min(events.length, 15)}):`,
    ...(events.length ? events.slice(-15).map((e) => `- ${eventLine(e, seqOf)}`) : ['- (none)']),
  ]
  return lines.join('\n')
}

/** A re-open update: issue events since the concierge last looked. */
export function buildConciergeDelta(opts: {
  prevEventId: number
  events: ConciergeEvent[]
  maxEventId: number
  now: string
  seqOf?: (id: string) => number | undefined
}): string {
  const seqOf = opts.seqOf ?? (() => undefined)
  return (
    `[CONCIERGE UPDATE @ ${opts.now}]\n` +
    `Since you last looked (event ${opts.prevEventId}), ${opts.events.length} issue events:\n` +
    opts.events.map((e) => `- ${eventLine(e, seqOf)}`).join('\n') +
    `\nNow caught up to event ${opts.maxEventId}.`
  )
}
