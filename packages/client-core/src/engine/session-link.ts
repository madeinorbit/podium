/**
 * What a desktop session link says when the server cannot open it (POD-4637).
 * One sentence shape for the `?pane=` link and the jump-to-session action, so
 * the two entry points never describe the same answer differently.
 */
import type { IssueId, SessionMeta } from '@podium/model'
import type { SessionIdentifierResolution } from '@podium/protocol'
import { reposToViews } from '../viewmodels'
import type { EngineState } from './state'

export function sessionLinkProblem(
  identifier: string,
  answer: Exclude<SessionIdentifierResolution, { kind: 'session' }>,
): string {
  const detail = answer.kind === 'ambiguous' ? answer.message : `no session matches '${identifier}'`
  return `Couldn't open session link — ${detail}`
}

/**
 * The issue and worktree a jump to this session lands in (POD-4642). One rule
 * for the jump-to-session action and the `?pane=` link, so a link opens the
 * session exactly as clicking it would.
 *
 * The worktree is the deepest registered worktree holding the session; failing
 * that, the linked or selected worktree when it holds the session; failing that,
 * the session's own directory. No selection at all stays none (that workspace
 * holds every session). Never an unrelated worktree: the session is not a
 * member of that workspace, so its tab would be pruned out of it and the link
 * would show whatever that workspace had active instead.
 */
export function sessionLinkSelection(
  st: Pick<EngineState, 'repos' | 'selectedWorktree'>,
  session: Pick<SessionMeta, 'cwd' | 'issueId'>,
  linkedWorktree?: string | null,
): { selectedIssueId?: IssueId; selectedWorktree?: string } {
  const holds = (path: string | null | undefined): path is string =>
    !!path && (session.cwd === path || session.cwd.startsWith(`${path}/`))
  const registered = reposToViews(st.repos)
    .flatMap((repo) => repo.worktrees)
    .map((candidate) => candidate.path)
    .filter(holds)
    .sort((a, b) => b.length - a.length)[0]
  const selectedWorktree =
    registered ??
    (holds(linkedWorktree)
      ? linkedWorktree
      : !st.selectedWorktree || holds(st.selectedWorktree)
        ? st.selectedWorktree
        : session.cwd)
  return {
    ...(session.issueId ? { selectedIssueId: session.issueId as IssueId } : {}),
    ...(selectedWorktree ? { selectedWorktree } : {}),
  }
}
