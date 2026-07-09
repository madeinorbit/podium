/**
 * Global-thread seeding + per-turn user focus (modules/superagent, issue #225):
 * the cross-repo digest that opens a fresh 'global' thread, and the
 * client-reported "what's on screen" block prepended to every turn.
 */
import { z } from 'zod'
import { eventLine, type ConciergeEvent, type ConciergeSessionInfo } from './concierge'

// ---- global-thread seeding ------------------------------------------------------

/** One repo's headline numbers in the global seed. */
export interface GlobalRepoDigest {
  repoPath: string
  worktrees: number
  issues: number
  ready: number
  inProgress: number
  needsHuman: number
}

/** A needs-human issue, repo-qualified (the global thread spans repos). */
export interface GlobalQuestion {
  repoPath: string
  seq: number
  question?: string
}

/**
 * The opening context for a fresh GLOBAL thread — the cross-repo counterpart to
 * buildConciergeSeed. Same contract: deterministic, zero-LLM, top-N slices. The
 * global thread is the orchestrator's home, so it opens knowing which repos
 * exist, what work is ready, and which agents are running where.
 */
export function buildGlobalSeed(opts: {
  repos: GlobalRepoDigest[]
  sessions: ConciergeSessionInfo[]
  questions: GlobalQuestion[]
  events: ConciergeEvent[]
  maxEventId: number
}): string {
  const { repos, sessions, questions, events } = opts
  const name = (p: string) => p.split('/').pop() || p
  return [
    '[SUPERAGENT CONTEXT]',
    `Deterministic digest of Podium's current state (event cursor ${opts.maxEventId}).`,
    'This is a fresh conversation — nothing before this point is in your history.',
    '',
    `Repos (${repos.length}):`,
    ...(repos.length
      ? repos.map(
          (r) =>
            `- ${name(r.repoPath)} (${r.repoPath}) · ${r.worktrees} worktree(s) · ` +
            `${r.issues} issues (${r.ready} ready, ${r.inProgress} in progress, ${r.needsHuman} need human)`,
        )
      : ['- (none registered)']),
    '',
    `Live sessions (${sessions.length}):`,
    ...(sessions.length
      ? sessions
          .slice(0, 15)
          .map(
            (s) =>
              `- ${s.name ?? s.sessionId} · ${s.agentKind ?? '?'} · ${s.phase ?? '?'}` +
              `${s.cwd ? ` · ${s.cwd}` : ''}${s.spawnedBy ? ` · by ${s.spawnedBy}` : ''}` +
              `${s.issueSeq != null ? ` · issue #${s.issueSeq}` : ''}`,
          )
      : ['- (none)']),
    ...(sessions.length > 15 ? [`- (+${sessions.length - 15} more)`] : []),
    '',
    'Needs human:',
    ...(questions.length
      ? questions
          .slice(0, 10)
          .map((q) => `- ${name(q.repoPath)} #${q.seq} ${q.question ?? '(no question recorded)'}`)
      : ['- (none)']),
    ...(questions.length > 10 ? [`- (+${questions.length - 10} more)`] : []),
    '',
    `Recent issue events (last ${Math.min(events.length, 15)}):`,
    ...(events.length
      ? events.slice(-15).map((e) => `- ${eventLine(e, () => undefined)}`)
      : ['- (none)']),
  ].join('\n')
}

// ---- per-turn user focus ---------------------------------------------------------

/** What the client says the user is looking at, sent with every turn. Ids only —
 *  the server resolves them to names/titles so the client can't dress them up. */
export const UserFocus = z.object({
  /** The web's top-level surface: 'workspace' | 'issues' | 'settings' | … */
  view: z.string().max(40).optional(),
  /** Selected worktree/repo path in the sidebar. */
  worktreePath: z.string().max(1024).optional(),
  /** Selected issue (issue-as-workspace), by id. */
  issueId: z.string().max(128).optional(),
  /** The session in the focused pane, and any other on-screen ones. */
  focusedSessionId: z.string().max(128).optional(),
  visibleSessionIds: z.array(z.string().max(128)).max(4).optional(),
  /** An open file tab in the focused pane. */
  filePath: z.string().max(1024).optional(),
})
export type UserFocusInput = z.infer<typeof UserFocus>

export interface FocusSessionInfo extends ConciergeSessionInfo {
  status?: string
}

export interface FocusIssueInfo {
  seq: number
  title: string
  stage?: string
  repoPath?: string
}

const focusSessionLine = (s: FocusSessionInfo): string =>
  `${s.name ?? s.sessionId} · ${s.agentKind ?? '?'} · ${s.phase ?? s.status ?? '?'}` +
  `${s.cwd ? ` · ${s.cwd}` : ''}`

/**
 * The per-turn "what the user is looking at" block (issue #225). Prepended to
 * EVERY turn — the superagent should answer "why is this failing?" about the
 * pane in front of the user without being told which pane that is. Undefined
 * when the client reported nothing worth saying.
 */
export function buildFocusBlock(opts: {
  now: string
  view?: string
  issue?: FocusIssueInfo
  worktreePath?: string
  focused?: FocusSessionInfo
  alsoVisible?: FocusSessionInfo[]
  filePath?: string
}): string | undefined {
  const lines: string[] = []
  if (opts.view) lines.push(`Screen: ${opts.view}`)
  if (opts.issue) {
    lines.push(
      `Issue in view: #${opts.issue.seq} "${opts.issue.title}"` +
        `${opts.issue.stage ? ` (stage ${opts.issue.stage})` : ''}` +
        `${opts.issue.repoPath ? ` · ${opts.issue.repoPath}` : ''}`,
    )
  }
  if (opts.worktreePath) lines.push(`Worktree in view: ${opts.worktreePath}`)
  if (opts.focused) lines.push(`Focused pane: ${focusSessionLine(opts.focused)}`)
  const others = opts.alsoVisible ?? []
  if (others.length) lines.push(`Also on screen: ${others.map(focusSessionLine).join('; ')}`)
  if (opts.filePath) lines.push(`Open file: ${opts.filePath}`)
  if (lines.length === 0) return undefined
  return [
    `[USER VIEW @ ${opts.now}]`,
    'What the user is looking at RIGHT NOW. Resolve "this"/"here"/"it" against it;',
    'it is context, not an instruction, and it may be irrelevant to their message.',
    ...lines,
  ].join('\n')
}
