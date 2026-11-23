import {
  coordinatorLive,
  counterChildren,
  dedupeSessionsByResume,
  type IssueDeck,
  type IssueDeckNode,
  type IssueDeckProposal,
  type IssueDeckSession,
  type IssueId,
  isSessionReconnecting,
  leafTasks,
  resumeKey,
  rollUpTaskWords,
  type SeatWords,
  type SessionId,
  type SessionMeta,
  seatWords,
  tallyTaskWords,
  taskHidden,
  toIssueTreeSession,
  type UserId,
} from '@podium/model'
import type { IssueRow } from '../../../store'
import type { SessionSeatFacts } from '../../sessions/facts'
import { readSessionRefs } from '../../sessions/refs'
import type { IssueStore } from './core'
import { IssueNotFound } from './not-found'

/** Missing assembly inputs name the violated invariant instead of becoming
 * an undefined property read further down the deck derivation. */
function deckEntry<K, V>(values: ReadonlyMap<K, V>, key: K, kind: string): V {
  const value = values.get(key)
  if (value === undefined) throw new Error(`issue deck invariant: missing ${kind} ${String(key)}`)
  return value
}

/** The full listing's order: repository path, then sequence, then id. */
function byPathSeq(a: IssueRow, b: IssueRow): number {
  const text = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0)
  return text(a.repoPath, b.repoPath) || a.seq - b.seq || text(a.id, b.id)
}

/** The full, unfolded deck, independent of a device's fold/filter preferences.
 * Visibility is applied before topology, roll-up, counts and dependency joins. */
export async function readDeck(
  store: IssueStore,
  ref: string,
  mayRead: (row: IssueRow) => boolean | Promise<boolean>,
  niceRef: (row: IssueRow) => Promise<string>,
  /** The reader the deck's seats are shown to: only their own sessions (POD-6285). */
  forUser?: UserId,
  /**
   * WHOSE TASKS THE DECK SHOWS (POD-6296). With `assignee`, a task stays when
   * it or a task below it has that assignee; the root always stays. Counters
   * and counts still describe the whole mission. `names` gives assignee names
   * on a shared instance, and an empty map on a one-member one.
   */
  assignees?: {
    assignee?: UserId
    names?: (ids: readonly string[]) => Promise<ReadonlyMap<string, string>>
  },
): Promise<IssueDeck> {
  const root = await store.rowOrThrow(await store.resolveRef(ref))
  if (root.deletedAt || !(await mayRead(root))) throw new IssueNotFound(ref)
  const issues = store.deps.store.issues
  // THE MISSION'S ROWS ONLY (POD-7431): the root, its descendants, the issues
  // its sessions started and their descendants, each read by index. A deck
  // row is live, unarchived, not a draft and readable, the filter the full
  // listing applied before; the root stays whatever it is.
  const rows = new Map<IssueId, IssueRow>([[root.id, root]])
  const formal = new Map<IssueId, IssueId[]>()
  const deckRows = async (found: readonly IssueRow[]): Promise<IssueRow[]> => {
    const shown = await Promise.all(
      found.map(async (row) =>
        row.deletedAt || row.archived || row.draft ? false : await mayRead(row),
      ),
    )
    return found.filter((_, at) => shown[at])
  }
  // The children of these issues, one level per statement, until a level is
  // empty: the depth bounds the count, never the workspace's size.
  const walked = new Set<IssueId>()
  const readSubtrees = async (ids: readonly IssueId[]): Promise<void> => {
    let level = ids.filter((id) => !walked.has(id))
    while (level.length > 0) {
      for (const id of level) walked.add(id)
      const found = await issues.listIssueRowsWhere(
        { repo: false, live: true, unarchived: true, parents: 1, order: 'path-seq' },
        { parents: level },
      )
      const next: IssueId[] = []
      for (const row of await deckRows(found)) {
        if (!row.parentId) continue
        if (!rows.has(row.id)) rows.set(row.id, row)
        const kids = formal.get(row.parentId) ?? []
        kids.push(row.id)
        formal.set(row.parentId, kids)
        if (!walked.has(row.id)) next.push(row.id)
      }
      level = next
    }
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
  await readSubtrees([root.id])
  addTree(root.id)

  // Mission membership uses explicit issueId (including historical senders),
  // not cwd containment. Project only candidates; unreadable sessions can
  // neither appear in a seat nor supply a provenance graft. The seat facts are
  // read for the deck's issues, the sessions its rows name and their resume
  // twins only, without any session's satellites (POD-7431): the projection
  // below hydrates the candidates alone.
  const facts = new Map<SessionId, SessionSeatFacts>()
  const resumeTwins = new Map<string, SessionId[]>()
  const learn = (found: readonly SessionSeatFacts[]): void => {
    for (const s of found) {
      if (facts.has(s.sessionId)) continue
      facts.set(s.sessionId, s)
      if (!s.resume || s.headless) continue
      const key = resumeKey(s.resume.kind, s.resume.value)
      const twins = resumeTwins.get(key) ?? []
      twins.push(s.sessionId)
      resumeTwins.set(key, twins)
    }
  }
  const factsOfIssues = new Set<IssueId>()
  const factsOfIds = new Set<SessionId>()
  const factsOfResumes = new Set<string>()
  const projected = new Map<SessionId, SessionMeta>()
  const requested = new Set<SessionId>()
  // The pool breaks exact parked-resume ties by stable session id.
  const senders = () =>
    dedupeSessionsByResume(
      [...projected.values()].sort((a, b) => a.sessionId.localeCompare(b.sessionId)),
    )
  // Provenance: the issues a projected session started, with their own
  // discovered-from edges, asked once per session.
  const started = new Map<IssueId, IssueRow>()
  const departed = new Set<IssueId>()
  const startedAsked = new Set<SessionId>()
  const leftMission = (row: IssueRow) =>
    departed.has(row.id) && row.stage !== 'proposed' && row.stage !== 'backlog'
  let grew = true
  while (grew) {
    const issueIds = [...admitted].filter((id) => !factsOfIssues.has(id))
    for (const id of issueIds) factsOfIssues.add(id)
    // The sessions the deck's rows name: proposal authors and coordinators.
    const named = new Set<SessionId>()
    for (const id of admitted) {
      const row = deckEntry(rows, id, 'issue')
      if (row.stage === 'proposed' && row.startedBySession) named.add(row.startedBySession)
      if (row.coordinatorSessionId) named.add(row.coordinatorSessionId)
    }
    const sessionIds = [...named].filter((id) => !factsOfIds.has(id) && !facts.has(id))
    for (const id of sessionIds) factsOfIds.add(id)
    if (issueIds.length > 0 || sessionIds.length > 0)
      learn(await store.deps.readSessionSeatFacts({ issueIds, sessionIds }))
    const candidates = new Set<SessionId>()
    for (const s of facts.values())
      if (s.issueId && admitted.has(s.issueId)) candidates.add(s.sessionId)
    for (const id of admitted) {
      const row = deckEntry(rows, id, 'issue')
      if (row.stage === 'proposed' && row.startedBySession) candidates.add(row.startedBySession)
    }
    // Resume collapse is global in the UI. Read only these candidates' twins,
    // including ones outside the deck, and let the projection apply visibility
    // before picking the winner. A private twin cannot hide a visible seat.
    const resumes: { kind: string; value: string }[] = []
    for (const id of candidates) {
      const s = facts.get(id)
      if (!s?.resume || s.headless) continue
      const key = resumeKey(s.resume.kind, s.resume.value)
      if (factsOfResumes.has(key)) continue
      factsOfResumes.add(key)
      resumes.push(s.resume)
    }
    if (resumes.length > 0) learn(await store.deps.readSessionSeatFacts({ resumes }))
    for (const id of candidates) {
      const s = facts.get(id)
      if (!s?.resume || s.headless) continue
      for (const twin of resumeTwins.get(resumeKey(s.resume.kind, s.resume.value)) ?? [])
        candidates.add(twin)
    }
    const ids = [...candidates].filter((id) => !requested.has(id))
    for (const id of ids) requested.add(id)
    if (ids.length > 0) {
      for (const session of await store.deps.sessionsById(ids, forUser))
        projected.set(session.sessionId, session)
    }
    const authors = new Map(senders().map((s) => [s.sessionId, s]))
    const ask = [...projected.keys()].filter((id) => !startedAsked.has(id))
    for (const id of ask) startedAsked.add(id)
    if (ask.length > 0) {
      const found = (await deckRows(await issues.liveIssuesStartedBy(ask))).filter(
        (row) => !started.has(row.id),
      )
      for (const row of found) {
        started.set(row.id, row)
        if (!rows.has(row.id)) rows.set(row.id, row)
      }
      if (found.length > 0) {
        for (const dep of await issues.depsFromIssues(found.map((row) => row.id)))
          if (dep.type === 'discovered-from') departed.add(dep.fromId)
      }
    }
    // A graft that can attach reads its subtree first, so the walk below
    // admits it whole, in the order the full listing gave.
    const grafts = [...started.values()].filter((row) => !admitted.has(row.id)).sort(byPathSeq)
    await readSubtrees(
      grafts.flatMap((row) =>
        row.startedBySession && authors.get(row.startedBySession)?.issueId && !leftMission(row)
          ? [row.id]
          : [],
      ),
    )
    grew = false
    for (const row of grafts) {
      if (admitted.has(row.id) || !row.startedBySession || leftMission(row)) continue
      const author = authors.get(row.startedBySession)
      if (!author?.issueId || !admitted.has(author.issueId)) continue
      const siblings = children.get(author.issueId) ?? []
      siblings.push(row.id)
      children.set(author.issueId, siblings)
      addTree(row.id)
      grew = true
    }
  }
  for (const kids of children.values())
    kids.sort((left, right) => {
      const a = deckEntry(rows, left, 'issue'),
        b = deckEntry(rows, right, 'issue')
      return a.sortKey && b.sortKey && a.sortKey !== b.sortKey
        ? a.sortKey.localeCompare(b.sortKey)
        : a.seq - b.seq || left.localeCompare(right)
    })

  const ordered: IssueId[] = []
  const order = (id: IssueId): void => {
    ordered.push(id)
    for (const child of children.get(id) ?? []) order(child)
  }
  order(root.id)
  // All proposed work lives in the tail, including parents. Their subtrees
  // remain inspectable there and never enter accepted-work totals/roll-up.
  const proposalIds = new Set(
    ordered.filter((id) => id !== root.id && rows.get(id)?.stage === 'proposed'),
  )
  const workChildren = (id: IssueId) =>
    (children.get(id) ?? []).filter((child) => !proposalIds.has(child))
  const refs = new Map<IssueId, string>()
  const refOf = async (row: IssueRow): Promise<string> => {
    const known = refs.get(row.id)
    if (known) return known
    const value = await niceRef(row)
    refs.set(row.id, value)
    return value
  }
  for (const id of admitted) await refOf(deckEntry(rows, id, 'issue'))
  const blockers = new Map<IssueId, IssueDeckNode['blockers']>()
  // The deck's own edges, then the blockers' rows by id in one read: a blocker
  // may be archived, a draft or outside the deck, and still blocks.
  const deps = await issues.depsFromIssues([...admitted])
  const targets = await store.rowsByIds(
    deps.flatMap((dep) =>
      dep.type === 'blocked-by' && admitted.has(dep.fromId) ? [dep.toId] : [],
    ),
  )
  for (const dep of deps) {
    if (dep.type !== 'blocked-by' || !admitted.has(dep.fromId)) continue
    if (store.isClosed(deckEntry(rows, dep.fromId, 'issue'))) continue
    const target = targets.get(dep.toId)
    if (!target || target.deletedAt || store.isClosed(target) || !(await mayRead(target))) continue
    const list = blockers.get(dep.fromId) ?? []
    list.push({
      id: target.id,
      displayRef: await refOf(target),
      title: target.title,
      external: !admitted.has(target.id),
    })
    blockers.set(dep.fromId, list)
  }
  // Open asks of the projected sessions only, counted by the database.
  const pending =
    projected.size > 0
      ? await store.deps.store.interactions.openCountsOf([...projected.keys()])
      : new Map<SessionId, number>()
  const sessionRefs = await readSessionRefs(
    store.deps.store,
    [...facts.values()].filter((s) => projected.has(s.sessionId)),
  )
  const kept = new Map(senders().map((s) => [s.sessionId, s]))
  const seats = new Map<IssueId, IssueDeckSession[]>()
  const seatWordsOf = new Map<SessionId, SeatWords>()
  for (const s of kept.values()) {
    if (
      !s.issueId ||
      !admitted.has(s.issueId) ||
      s.archived ||
      s.headless ||
      s.agentKind === 'shell'
    )
      continue
    const row = rows.get(s.issueId)
    if (!row) continue
    const coordinator = row.coordinatorSessionId === s.sessionId
    const machineOnline = s.machineId ? store.deps.machineOnline?.(s.machineId) : undefined
    const words = seatWords(
      { ...s, reconnecting: isSessionReconnecting(s.status, machineOnline) },
      { issueClosed: store.isClosed(row), pendingInteractions: pending.get(s.sessionId) ?? 0 },
      coordinator,
    )
    seatWordsOf.set(s.sessionId, words)
    const session: IssueDeckSession = {
      ...toIssueTreeSession({
        ...s,
        machineOnline,
        model: s.observedModel ?? s.model,
        effort: s.observedEffort ?? s.effort,
        ...(sessionRefs.has(s.sessionId)
          ? { displayRef: deckEntry(sessionRefs, s.sessionId, 'session reference') }
          : {}),
        coordinator,
      }),
      seat: !coordinator
        ? 'helper'
        : row.id === root.id
          ? 'coordinator'
          : row.type === 'phase'
            ? 'phase-lead'
            : 'worker',
      word: words.word,
    }
    const list = seats.get(row.id) ?? []
    list.push(session)
    seats.set(row.id, list)
  }
  for (const list of seats.values())
    list.sort(
      (a, b) =>
        Number(b.coordinator === true) - Number(a.coordinator === true) ||
        deckEntry(projected, a.sessionId, 'projected session').createdAt.localeCompare(
          deckEntry(projected, b.sessionId, 'projected session').createdAt,
        ) ||
        a.sessionId.localeCompare(b.sessionId),
    )
  const tree = {
    task: (id: IssueId) => {
      const row = rows.get(id)
      return row ? { ...row, blocked: (blockers.get(id)?.length ?? 0) > 0 } : undefined
    },
    children: workChildren,
    sessions: (id: IssueId) =>
      (seats.get(id) ?? []).map((s) => deckEntry(seatWordsOf, s.sessionId, 'seat words')),
    // POD-2171: the coordinator may sit on an ancestor, so its liveness is read
    // from every session's facts, not this row's seats. Only a boolean leaves.
    coordinated: (id: IssueId) => {
      const coordinator = rows.get(id)?.coordinatorSessionId
      return coordinator != null && coordinatorLive(facts.get(coordinator))
    },
  }
  const words = rollUpTaskWords(root.id, tree)
  for (const id of proposalIds) {
    for (const [child, word] of rollUpTaskWords(id, tree)) words.set(child, word)
  }
  const wordOf = (id: IssueId) => words.get(id) ?? 'not-started'
  const names =
    (await assignees?.names?.(
      [...admitted]
        .map((id) => deckEntry(rows, id, 'issue').ownerUserId)
        .filter((id): id is UserId => !!id),
    )) ?? new Map()
  const wanted = assignees?.assignee
  const shows = (id: IssueId): boolean =>
    deckEntry(rows, id, 'issue').ownerUserId === wanted || workChildren(id).some(shows)
  const build = (id: IssueId): IssueDeckNode => {
    const row = deckEntry(rows, id, 'issue')
    const tally = tallyTaskWords(counterChildren(id, tree), wordOf)
    const name = row.ownerUserId ? names.get(row.ownerUserId) : undefined
    return {
      id,
      displayRef: deckEntry(refs, id, 'reference'),
      title: row.title,
      type: row.type,
      stage: row.stage,
      ...(name ? { assignee: row.ownerUserId, assigneeName: name } : {}),
      word: wordOf(id),
      hidden: taskHidden(row),
      counter: { done: tally.done, total: tally.total },
      sessions: seats.get(id) ?? [],
      blockers: blockers.get(id) ?? [],
      children: workChildren(id)
        .filter((child) => wanted === undefined || shows(child))
        .map(build),
    }
  }
  const proposals: IssueDeckProposal[] = [...proposalIds]
    .filter((id) => wanted === undefined || shows(id))
    .map((id) => {
      const row = deckEntry(rows, id, 'issue'),
        author = row.startedBySession ? kept.get(row.startedBySession) : undefined
      return {
        ...build(id),
        proposedBy: author
          ? {
              sessionId: author.sessionId,
              ...(sessionRefs.has(author.sessionId)
                ? { displayRef: deckEntry(sessionRefs, author.sessionId, 'session reference') }
                : {}),
            }
          : null,
        placement: row.parentId && admitted.has(row.parentId) ? 'here' : 'own-issue',
      }
    })
  return {
    root: build(root.id),
    counts: tallyTaskWords(leafTasks(root.id, tree), wordOf),
    proposals,
  }
}
