import type { RepoId, SessionId } from '@podium/model'
import { formatSessionRef } from '@podium/protocol'
import type { SessionStore } from '../../store'
import { readIssues } from '../world-index/issue-reader'
import type { SessionFacts } from './facts'

/** Durable ref inputs, independent of the reader-scoped session projection. */
export type SessionRefFacts = Pick<
  SessionFacts,
  'sessionId' | 'refIssueId' | 'refLetter' | 'refDraft' | 'cwd' | 'machineId'
>

/**
 * Server tool refs share this source read. Birth refs follow the birth issue's
 * repo identity and current sequence; drafts resolve their repo on their machine.
 * Callers establish visibility before passing the bounded set of candidates.
 * No result survives the read, so prefix renames and ref repairs take effect
 * without waiting for a session projection to be republished.
 */
export async function readSessionRefs(
  store: Pick<SessionStore, 'issues' | 'repos'>,
  sessions: readonly SessionRefFacts[],
): Promise<ReadonlyMap<SessionId, string>> {
  const refs = new Map<SessionId, string>()
  if (sessions.length === 0) return refs
  const issueIds = [...new Set(sessions.flatMap(s =>
    s.refIssueId && s.refLetter ? [s.refIssueId] : [],
  ))]
  const issues = await readIssues(store.issues, issueIds)
  const needsPath = sessions.some(s =>
    s.refIssueId && s.refLetter
      ? !!issues.get(s.refIssueId) && !issues.get(s.refIssueId)?.repoId
      : s.refDraft != null,
  )
  const repoIdForPath = needsPath ? await store.repos.repoIdResolver() : undefined
  const prefixes = new Map<RepoId, string | null>()
  for (const session of sessions) {
    const issue = session.refIssueId && session.refLetter
      ? issues.get(session.refIssueId)
      : undefined
    const repoId = issue
      ? issue.repoId ?? repoIdForPath?.(issue.repoPath, issue.machineId)
      : !(session.refIssueId && session.refLetter) && session.refDraft != null
        ? repoIdForPath?.(session.cwd, session.machineId)
        : undefined
    if (!repoId) continue
    if (!prefixes.has(repoId)) prefixes.set(repoId, await store.repos.prefixForRepoId(repoId))
    const prefix = prefixes.get(repoId)
    if (!prefix) continue
    if (issue && session.refLetter) {
      refs.set(session.sessionId, formatSessionRef({ prefix, seq: issue.seq, letter: session.refLetter }))
    } else if (session.refDraft != null) {
      refs.set(session.sessionId, formatSessionRef({ prefix, draft: session.refDraft }))
    }
  }
  return refs
}
