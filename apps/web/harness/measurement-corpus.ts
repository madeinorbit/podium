/** Synthetic operator-sized workspace. No operator records or machine inventory. */
import { buildCorpusCell } from '../../../tests/worklist/harness/src/fixture/index'

export function operatorCorpus(seed: number) {
  const corpus = buildCorpusCell({ history: 3, active: 1 }, seed)
  corpus.issues = corpus.issues.slice(0, 8_687)
  const ids = new Set(corpus.issues.map((issue) => issue.id))
  for (const issue of corpus.issues)
    if (issue.parentId && !ids.has(issue.parentId)) issue.parentId = undefined
  corpus.sessions = corpus.sessions.slice(0, 6_941)
  for (const session of corpus.sessions)
    if (session.issueId && !ids.has(session.issueId)) session.issueId = undefined
  corpus.issueDeps = corpus.issueDeps.filter((dep) => ids.has(dep.fromId) && ids.has(dep.toId))
  // Reuse existing records so the stated population stays exact. Both trees
  // are separate, flat trees; their long-closed children are outside Recent.
  const selected = corpus.issues.slice(0, 982)
  const selectedIds = new Set(selected.map((issue) => issue.id))
  for (const issue of corpus.issues)
    if (issue.parentId && selectedIds.has(issue.parentId)) issue.parentId = undefined
  const old = new Date(corpus.fixedNow - 400 * 86_400_000).toISOString()
  const trees = [
    { size: 12, closed: 9, offset: 0 },
    { size: 970, closed: 922, offset: 12 },
  ].map((spec) => {
    const members = selected.slice(spec.offset, spec.offset + spec.size)
    const root = members[0]
    if (!root) throw new Error('Missing synthetic tree root')
    for (const [index, issue] of members.entries()) {
      const closed = index >= spec.size - spec.closed
      Object.assign(issue, {
        parentId: index === 0 ? null : root.id,
        repoId: root.repoId,
        repoPath: root.repoPath,
        stage: closed ? 'done' : 'in_progress',
        closedReason: closed ? 'completed' : null,
        closedAt: closed ? old : null,
        archived: false,
        deletedAt: null,
        isDraftVessel: false,
        audience: 'human',
        tuckedAt: null,
        deferUntil: null,
        updatedAt: closed ? old : new Date(corpus.fixedNow).toISOString(),
        sortKey: String(index).padStart(38, '0'),
        title: `Measurement tree ${spec.size} issue ${index + 1}`,
      })
    }
    return {
      root: root.id,
      title: root.title,
      size: spec.size,
      closed: spec.closed,
      ids: members.map((issue) => issue.id),
    }
  })
  // These fixture trees have no sessions, so their closed members can only
  // arrive through the tree fetch, never as a live session's companion.
  for (const session of corpus.sessions)
    if (session.issueId && selectedIds.has(session.issueId)) session.issueId = undefined
  const projections = new Map(corpus.issueProjections.map((row) => [row.id, row]))
  corpus.issueProjections = corpus.issues.map((issue) => ({
    ...projections.get(issue.id),
    ...issue,
  })) as typeof corpus.issueProjections
  return { ...corpus, measurementTrees: trees }
}
