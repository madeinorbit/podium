import {
  counterChildren,
  dedupeSessionsByResume,
  type IssueDeck,
  type IssueDeckNode,
  type IssueDeckProposal,
  type IssueDeckSession,
  type IssueId,
  leafTasks,
  rollUpTaskWords,
  type SessionId,
  type SessionMeta,
  sessionWord,
  tallyTaskWords,
  taskHidden,
  taskWord,
  toIssueTreeSession,
} from '@podium/model'
import type { IssueRow } from '../../../store'
import type { IssueStore } from './core'
import { IssueNotFound } from './not-found'

/** The full, unfolded deck, independent of a device's fold/filter preferences.
 * Visibility is applied before topology, roll-up, counts and dependency joins. */
export async function readDeck(
  store: IssueStore,
  ref: string,
  mayRead: (id: string) => boolean | Promise<boolean>,
  niceRef: (row: IssueRow) => Promise<string>,
): Promise<IssueDeck> {
  const root = await store.rowOrThrow(await store.resolveRef(ref))
  if (!(await mayRead(root.id))) throw new IssueNotFound(ref)
  const rows = new Map<IssueId, IssueRow>()
  for (const row of store.rows.values()) {
    if (row.deletedAt || row.archived || row.draft || !(await mayRead(row.id))) continue
    rows.set(row.id, row)
  }
  rows.set(root.id, root)
  const deps = await store.deps.store.issues.listAllIssueDeps()
  const formal = new Map<IssueId, IssueId[]>()
  for (const row of rows.values()) {
    if (!row.parentId) continue
    const children = formal.get(row.parentId) ?? []
    children.push(row.id)
    formal.set(row.parentId, children)
  }
  const admitted = new Set<IssueId>()
  const children = new Map<IssueId, IssueId[]>()
  const addTree = (id: IssueId): void => {
    if (admitted.has(id)) return
    admitted.add(id)
    const kids = (formal.get(id) ?? []).filter((child) => !admitted.has(child))
    children.set(id, kids)
    for (const child of kids) addTree(child)
  }
  addTree(root.id)

  // Mission membership uses explicit issueId (including historical senders),
  // not cwd containment. Project only candidates; unreadable sessions can
  // neither appear in a seat nor supply a provenance graft.
  const facts = store.deps.sessionFacts()
  const projected = new Map<SessionId, SessionMeta>()
  const requested = new Set<SessionId>()
  const departed = new Set(deps.filter((dep) => dep.type === 'discovered-from').map((dep) => dep.fromId))
  let grew = true
  while (grew) {
    const ids = facts.filter((s) => s.issueId && admitted.has(s.issueId) && !requested.has(s.sessionId))
      .map((s) => s.sessionId)
    for (const id of ids) requested.add(id)
    for (const session of await store.deps.sessionsById(ids)) projected.set(session.sessionId, session)
    const senders = new Map(dedupeSessionsByResume([...projected.values()]).map((s) => [s.sessionId, s]))
    grew = false
    for (const row of rows.values()) {
      if (admitted.has(row.id) || !row.startedBySession) continue
      if (departed.has(row.id) && row.stage !== 'proposed' && row.stage !== 'backlog') continue
      const author = senders.get(row.startedBySession)
      if (!author?.issueId || !admitted.has(author.issueId)) continue
      const siblings = children.get(author.issueId) ?? []
      siblings.push(row.id)
      children.set(author.issueId, siblings)
      addTree(row.id)
      grew = true
    }
  }
  for (const kids of children.values()) kids.sort((left, right) => {
    const a = rows.get(left)!, b = rows.get(right)!
    return a.sortKey && b.sortKey && a.sortKey !== b.sortKey
      ? a.sortKey.localeCompare(b.sortKey) : a.seq - b.seq || left.localeCompare(right)
  })

  const proposalIds = new Set([...admitted].filter((id) =>
    id !== root.id && rows.get(id)?.stage === 'proposed' && !(children.get(id)?.length)))
  const workChildren = (id: IssueId) => (children.get(id) ?? []).filter((child) => !proposalIds.has(child))
  const refs = new Map<IssueId, string>()
  const refOf = async (row: IssueRow): Promise<string> => {
    const known = refs.get(row.id)
    if (known) return known
    const value = await niceRef(row)
    refs.set(row.id, value)
    return value
  }
  for (const id of admitted) await refOf(rows.get(id)!)
  const blockers = new Map<IssueId, IssueDeckNode['blockers']>()
  for (const dep of deps) {
    if (dep.type !== 'blocked-by' || !admitted.has(dep.fromId)) continue
    const target = store.rows.get(dep.toId)
    if (!target || target.deletedAt || store.isClosed(target) || !(await mayRead(target.id))) continue
    const list = blockers.get(dep.fromId) ?? []
    list.push({ id: target.id, displayRef: await refOf(target), title: target.title, external: !admitted.has(target.id) })
    blockers.set(dep.fromId, list)
  }
  const pending = new Map<SessionId, number>()
  for (const ask of await store.deps.store.interactions.listOpen()) {
    if (projected.has(ask.sessionId)) pending.set(ask.sessionId, (pending.get(ask.sessionId) ?? 0) + 1)
  }
  const seats = new Map<IssueId, IssueDeckSession[]>()
  for (const s of dedupeSessionsByResume([...projected.values()])) {
    if (!s.issueId || s.archived || s.headless || s.agentKind === 'shell') continue
    const row = rows.get(s.issueId)
    if (!row) continue
    const coordinator = row.coordinatorSessionId === s.sessionId
    const session: IssueDeckSession = {
      ...toIssueTreeSession({ ...s, model: s.observedModel ?? s.model, effort: s.observedEffort ?? s.effort, coordinator }),
      seat: !coordinator ? 'helper' : row.id === root.id ? 'coordinator' : row.type === 'phase' ? 'phase-lead' : 'worker',
      word: sessionWord(s, { issueClosed: store.isClosed(row), pendingInteractions: pending.get(s.sessionId) ?? 0 }),
    }
    const list = seats.get(row.id) ?? []
    list.push(session)
    seats.set(row.id, list)
  }
  for (const list of seats.values()) list.sort((a, b) =>
    Number(b.coordinator === true) - Number(a.coordinator === true) ||
    projected.get(a.sessionId)!.createdAt.localeCompare(projected.get(b.sessionId)!.createdAt) || a.sessionId.localeCompare(b.sessionId))
  const tree = {
    task: (id: IssueId) => {
      const row = rows.get(id)
      return row ? { ...row, blocked: (blockers.get(id)?.length ?? 0) > 0 } : undefined
    },
    children: workChildren,
    sessions: (id: IssueId) => (seats.get(id) ?? []).map((s) => s.word),
  }
  const words = rollUpTaskWords(root.id, tree)
  for (const id of proposalIds) words.set(id, taskWord(tree.task(id)!, { sessions: tree.sessions(id) }))
  const wordOf = (id: IssueId) => words.get(id) ?? 'not-started'
  const build = (id: IssueId): IssueDeckNode => {
    const row = rows.get(id)!
    const tally = tallyTaskWords(counterChildren(id, tree), wordOf)
    return {
      id, displayRef: refs.get(id)!, title: row.title, type: row.type, stage: row.stage,
      word: wordOf(id), hidden: taskHidden(row), counter: { done: tally.done, total: tally.total },
      sessions: seats.get(id) ?? [], blockers: blockers.get(id) ?? [],
      children: workChildren(id).map(build),
    }
  }
  const proposals: IssueDeckProposal[] = [...proposalIds].map((id) => {
    const row = rows.get(id)!, author = row.startedBySession ? projected.get(row.startedBySession) : undefined
    return {
      ...build(id),
      proposedBy: author ? { sessionId: author.sessionId, ...(author.displayRef ? { displayRef: author.displayRef } : {}) } : null,
      placement: row.parentId && admitted.has(row.parentId) ? 'here' : 'own-issue',
    }
  })
  return { root: build(root.id), counts: tallyTaskWords(leafTasks(root.id, tree), wordOf), proposals }
}
