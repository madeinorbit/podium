/**
 * What opening a Podium address MEANS in the web app (POD-1606).
 *
 * The address space (@podium/protocol/links) says what a URL names; this says
 * what this client does about it, and it is pure so the mapping can be tested
 * without a store, a router or a DOM.
 *
 * NOT EVERY TARGET IS A ROUTE. An issue is a view; a session is a navigation; an
 * artifact and a file are neither — they open as tabs, through store actions
 * that already exist (`openArtifact`, `openFileInWorktree`). Inventing routes
 * for those would have meant a second way to open the same thing, so the
 * resolver returns the action instead and the host performs it.
 *
 * A target that cannot be resolved — an issue this replica has not seen, an
 * artifact id that is not in the issue's panel, a file address with no worktree
 * root — returns null. The caller then leaves the anchor alone, which is what
 * makes an unresolvable link degrade to an ordinary navigation rather than to a
 * dead click.
 */

import { parseRoute } from '@podium/client-core/ui-state'
import type { IssueId, MachineId, SessionId } from '@podium/model/browser'
import type { PodiumTarget } from '@podium/protocol'
import { parseIssueRef, resolveSessionIdentifier } from '@podium/protocol'

/** The fields of an issue this module needs; the replica's rows satisfy it. */
export interface LinkIssueLike {
  id: IssueId
  prefix?: string
  seq?: number
  displayRef?: string
  worktreePath?: string | null
  panel?: {
    artifacts?: ReadonlyArray<{ path: string; artifactId?: string; entry?: string }>
  } | null
}

export interface LinkSessionLike {
  sessionId: SessionId
  displayRef?: string
}

export type PodiumOpen =
  | { kind: 'issue'; issueId: IssueId; search?: string; hash?: string }
  | { kind: 'session'; sessionIdOrRef: string; search?: string; hash?: string }
  | {
      kind: 'artifact'
      issueId: IssueId
      artifactId: string
      path: string
      worktreePath?: string
      search?: string
      hash?: string
    }
  | { kind: 'file'; path: string; root: string; machineId?: MachineId; hash?: string }
  | { kind: 'view'; path: string; search: string; hash: string }

/** Last path segment — an artifact whose panel entry is a bare path opens by name. */
function basename(path: string): string {
  const i = path.lastIndexOf('/')
  return i === -1 ? path : path.slice(i + 1)
}

/**
 * An issue by internal id OR by human ref. Both appear in real addresses: an
 * agent writes `POD-1606` because that is what it says everywhere else, and the
 * app's own URLs carry `iss_…`.
 */
export function findLinkedIssue(
  identifier: string,
  issues: readonly LinkIssueLike[],
): LinkIssueLike | undefined {
  const direct = issues.find((issue) => issue.id === identifier)
  if (direct) return direct
  const trimmed = identifier.trim()
  const byDisplay = issues.find((issue) => issue.displayRef === trimmed)
  if (byDisplay) return byDisplay
  const ref = parseIssueRef(trimmed)
  if (!ref) return undefined
  return issues.find((issue) => issue.prefix === ref.prefix && issue.seq === ref.seq)
}

export function resolvePodiumTarget(
  target: PodiumTarget,
  context: { issues: readonly LinkIssueLike[]; sessions: readonly LinkSessionLike[] },
): PodiumOpen | null {
  switch (target.kind) {
    case 'issue': {
      const issue = findLinkedIssue(target.issue, context.issues)
      return issue
        ? {
            kind: 'issue',
            issueId: issue.id,
            ...(target.search ? { search: target.search } : {}),
            ...(target.hash ? { hash: target.hash } : {}),
          }
        : null
    }
    case 'session': {
      // `navigateToSession` is deliberately inert for an unknown row. Resolve
      // with the same shared helper first so the activator reports false when
      // no navigation will happen and the anchor keeps its fallback behavior.
      const session = resolveSessionIdentifier(target.session, context.sessions)
      return session
        ? {
            kind: 'session',
            sessionIdOrRef: session.sessionId,
            ...(target.search ? { search: target.search } : {}),
            ...(target.hash ? { hash: target.hash } : {}),
          }
        : null
    }
    case 'artifact': {
      const issue = findLinkedIssue(target.issue, context.issues)
      if (!issue) return null
      const entry = issue.panel?.artifacts?.find((a) => a.artifactId === target.artifactId)
      if (!entry) return null
      // The address may name the file inside the bundle; otherwise the panel
      // entry says which file is the primary one.
      const path = target.entry ?? entry.entry ?? basename(entry.path)
      return {
        kind: 'artifact',
        issueId: issue.id,
        artifactId: target.artifactId,
        path,
        ...(issue.worktreePath ? { worktreePath: issue.worktreePath } : {}),
        ...(target.search ? { search: target.search } : {}),
        ...(target.hash ? { hash: target.hash } : {}),
      }
    }
    case 'file': {
      // A file tab is scoped to a worktree; without a root there is nothing to
      // open it against, and guessing one would open the wrong checkout.
      if (!target.root) return null
      return {
        kind: 'file',
        path: target.path,
        root: target.root,
        ...(target.machineId ? { machineId: target.machineId as MachineId } : {}),
        ...(target.hash ? { hash: target.hash } : {}),
      }
    }
    default: {
      // The host can losslessly activate only a top-level view. Queries,
      // fragments, settings tabs and workspace selection belong to the router;
      // claiming them through setView would silently discard part of the URL.
      if (target.search || target.hash) return null
      const route = parseRoute(target.path, '')
      if (!route || route.issueId || route.settingsTab || route.worktree || route.pane) return null
      return { kind: 'view', path: target.path, search: '', hash: '' }
    }
  }
}
