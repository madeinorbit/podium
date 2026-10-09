import { createKernelReplica, createSideCache, memoryStorage } from '@podium/client-core/replica'
import { type SessionView, sessionViews } from '@podium/client-core/session-values'
import type { RoutedUiState } from '@podium/client-core/ui-state'
import { FLIGHT_DECK_FOLDS_KEY, FLIGHT_DECK_MODE_KEY } from '@podium/client-core/ui-state'
import {
  deckSessions,
  type FlightDeckFoldMap,
  flightDeckRowHasPayload,
  flightDeckRowIsFolded,
  type FlightDeckMode,
  issueOwnContentUnread,
  machineViewsFromWire,
  missionRootFor,
  reposToViews,
  subtreeUnread,
  writeFlightDeckFolds,
} from '@podium/client-core/values'
import { issueDisplayRef } from '@podium/protocol'
import { autorun } from 'mobx'
import { expect, it } from 'vitest'
import { dedupeSessions } from '../../../tests/worklist/diagnostics/reference-state'
import { allIssueViewModels } from '../../../tests/worklist/diagnostics/reference/issue-view-models'
import { buildCorpus } from '../../../tests/worklist/harness/src/fixture/corpus'
import { seedCacheFromCorpus } from '../../../tests/worklist/shared/src/scenarios'
import { expectPoolOutput } from '../../../tests/worklist/harness/src/oracle/pool-output'
import { headerView } from './header-views'
import { attachMobileScreens } from './mobile-screens'
import { MissionScreen, type MissionScreenView, missionRootId } from './mission-screen'
import { type MissionDeckIssueModel, type MissionViewValues, missionView, readMissionView, requireLoaded } from './mission-view'
import { MobxPool } from './pool'
import { attachPreferenceSource } from './preference-source'
import { MISSION_VIEW_SUMMARIES } from './mission-view-schema'
import { LOADING } from './worklist/rollup'

/**
 * The opened mission's view model against the pane bundle it replaces. The
 * OLD side is the shared reader's `MissionViewValues` plus the list rules the
 * deck component applied to it (proposals, folds, search, foldable branches);
 * the NEW side is one {@link MissionScreen} per opening. Every moved fact is
 * compared on the same corpus, archived, folded and searched crews included.
 */

const name = (session: SessionView) => session.name?.trim() || session.title || ''

function memoryUi() {
  const values = new Map<string, string>()
  const listeners = new Set<(keys: ReadonlySet<string>) => void>()
  const ui: RoutedUiState = {
    get: (key) => values.get(key) ?? null,
    set: (key, value) => {
      if (value === null) values.delete(key)
      else values.set(key, value)
      for (const listener of listeners) listener(new Set([key]))
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
  return ui
}

/** What the deck draws of a continuation and a departure: ids, words, state. */
const continuationFacts = (value: MissionViewValues['continuation']) =>
  value ? { kind: value.kind, short: value.short, full: value.full, line: value.line, target: value.target?.id ?? null } : null
const departureFacts = (values: MissionViewValues['departures']) =>
  values.map(value => ({ id: value.issue.id, originId: value.originId, state: value.state }))

/** Compare one case, and keep its answer for the frozen fingerprint: once the
 * bundle is deleted, the fingerprint is the old answer this test still holds. */
function same(answers: unknown[], label: string, current: { old: unknown; next: unknown } | undefined) {
  expect(current?.next, label).not.toBe(LOADING)
  expect(current?.next, label).toEqual(current?.old)
  answers.push([label, current?.next])
}

function oldUnread(row: MissionDeckIssueModel, collapsed: boolean): boolean {
  if (row.workingAgentCount > 0) return false
  if (!collapsed) return issueOwnContentUnread(row.issue)
  return subtreeUnread({ readAt: row.issue.readAt, updatedAt: row.issue.updatedAt,
    descendantUpdatedAts: [row.updatedBelow], sessions: row.collapsedSummary.crew })
}

/** The list rules the deck component applied to the bundle, verbatim. */
function oldDeck(values: MissionViewValues, view: MissionScreenView, mode: FlightDeckMode, folds: FlightDeckFoldMap, query: string) {
  const deck = values.deck!
  requireLoaded(deck.rowIds(mode))
  const rows = deck.rows()
  const proposalIds = new Set(view === 'waterfall' ? [] : rows.filter(row => row.depth > 0 && row.stage === 'proposed' && requireLoaded(row.deckChildren).length === 0).map(row => row.id))
  const tree = rows.filter(row => !proposalIds.has(row.id))
  const unfoldedIds = new Set(requireLoaded(deck.rowIds(mode, folds)))
  const unfolded = tree.filter(row => row.depth > 0 && unfoldedIds.has(row.id))
  const needle = view === 'handoff' ? '' : query.trim().toLowerCase()
  const matches = (row: MissionDeckIssueModel) => {
    const issue = requireLoaded(row.view.catalogIssue(row.id))!
    return issue.title.toLowerCase().includes(needle) || issueDisplayRef(issue).toLowerCase().includes(needle) ||
      row.crewIds.some(id => { const session = row.view.rawSession(id); return session && typeof session !== 'symbol' && name(session).toLowerCase().includes(needle) })
  }
  const keep = new Set<string>(), trail: MissionDeckIssueModel[] = []
  if (needle) for (const row of unfolded) {
    trail.length = row.depth; trail[row.depth] = row
    if (matches(row)) for (const ancestor of trail) if (ancestor) keep.add(ancestor.id)
  }
  const visibleRows = needle ? unfolded.filter(row => keep.has(row.id)) : unfolded
  const proposedRows = rows.filter(row => proposalIds.has(row.id) && (!needle || matches(row)))
  const foldable = rows.filter(row => row.depth > 0 && !proposalIds.has(row.id) && row.hasPayload)
  const rootRow = rows[0]
  const continuationTargetId = values.continuation?.target?.id
  return {
    rows: rows.map(row => row.key),
    visibleRows: visibleRows.map(row => row.key),
    proposedRows: proposedRows.map(row => row.key),
    foldable: foldable.map(row => row.key),
    anyFoldable: foldable.length > 0,
    allFolded: foldable.length > 0 && foldable.every(row => row.folded(folds)),
    crewIds: rows.flatMap(row => row.crewIds),
    rootSessionIds: rootRow?.sessionIds(mode) ?? [],
    members: [...values.members].sort(),
    liveCount: rows[0]?.liveAgentCount ?? 0,
    workingCount: rows[0]?.workingAgentCount ?? 0,
    waitingCount: rootRow?.waitingAgentCount ?? 0,
    progress: values.progress,
    archivedCount: values.archivedCount,
    note: values.note,
    presence: values.presence,
    continuation: continuationFacts(values.continuation),
    departures: departureFacts(values.departures.filter(departure => departure.issue.id !== continuationTargetId)),
    continuationState: values.departures.find(departure => departure.issue.id === continuationTargetId)?.state ?? null,
    rootTitle: rootRow?.title ?? '',
    rootRef: issueDisplayRef(values.root!),
    rootStage: values.root!.stage,
    rootStatus: { stage: values.root!.stage, closedReason: values.root!.closedReason },
    rootLead: rootRow?.crewIds[0],
    rootDraft: Boolean(values.root!.isDraftVessel),
    rootBrief: values.root!.description?.trim() || values.root!.activityNotes?.trim() || '',
    // Per drawn row: what the strips print.
    strips: rows.map(row => ({
      key: row.key,
      title: values.titles.get(row.id),
      ref: issueDisplayRef(requireLoaded(row.view.catalogIssue(row.id))!),
      presentation: values.rowPresentation.get(row.id),
      unread: [oldUnread(row, false), oldUnread(row, true)],
      draws: (['full', 'working', 'needs-you'] as const).map(m => deckSessions(row, m).length > 0),
      stage: row.facts.stage,
    })),
  }
}

function newDeck(screen: MissionScreen) {
  const rows = screen.rows
  return {
    rows: rows.map(row => row.key),
    visibleRows: screen.visibleRows.map(row => row.key),
    proposedRows: screen.proposedRows.map(row => row.key),
    foldable: screen.foldable.map(row => row.key),
    anyFoldable: screen.anyFoldable,
    allFolded: screen.allFolded,
    crewIds: [...screen.crewIds],
    rootSessionIds: [...screen.rootSessionIds],
    members: [...screen.members].sort(),
    liveCount: screen.liveCount,
    workingCount: screen.workingCount,
    waitingCount: screen.waitingCount,
    progress: screen.progress,
    archivedCount: screen.archivedCount,
    note: screen.note,
    presence: screen.presence,
    continuation: continuationFacts(screen.continuation),
    departures: departureFacts(screen.otherDepartures),
    continuationState: screen.continuationState,
    rootTitle: screen.rootTitle,
    rootRef: screen.rootRef,
    rootStage: screen.rootStage,
    rootStatus: screen.rootStatus,
    rootLead: screen.rootLeadSessionId,
    rootDraft: screen.rootDraftVessel,
    rootBrief: screen.rootAuthoredBrief,
    strips: rows.map(row => ({
      key: row.key,
      title: row.title,
      ref: row.displayRef,
      presentation: row.presentation,
      unread: [row.unread(false), row.unread(true)],
      draws: (['full', 'working', 'needs-you'] as const).map(m => row.drawsSessions(m)),
      stage: row.stage,
    })),
  }
}

/** Let the preference rows and any cold rows arrive. */
async function settle(pool: MobxPool) {
  for (let turn = 0; turn < 8; turn++) {
    await new Promise<void>(resolve => setTimeout(resolve, 0))
    while (pool.hydrate() > 0) await Promise.resolve()
  }
}

/** The corpus in a pool. `cold` keeps only declared summaries in memory and
 * loads full issue and session rows when a reader asks, as the runtime does. */
function corpusPool(scale: 1 | 4, cold = false) {
  const corpus = buildCorpus(scale)
  const replica = createKernelReplica({ cache: seedCacheFromCorpus(corpus),
    side: createSideCache({ storage: memoryStorage(), enumerateKeys: () => [] }) })
  const issues = allIssueViewModels(replica)
  const repos = [...replica.rows('repos')], machines = [...replica.rows('machines')]
  const rawSessions = sessionViews([...replica.rows('sessions')], {
    userId: 'operator', userStates: [...replica.rows('sessionUserStates')], machines, repos,
  })
  const sessions = dedupeSessions(rawSessions)
  const input = new Map<string, object>([
    ...issues.map(row => [`issue:${row.id}`, row] as const),
    ...rawSessions.map(row => [`session:${row.sessionId}`, row] as const),
  ])
  const pool = cold
    ? new MobxPool({ selectedIssueId: null, coarseNow: corpus.fixedNow }, undefined, {
      load: (entity: string, id: string) => input.get(`${entity}:${id}`),
      summaries: MISSION_VIEW_SUMMARIES, schedule: () => () => {},
    })
    : new MobxPool({ selectedIssueId: null, coarseNow: corpus.fixedNow })
  const ui = memoryUi()
  attachPreferenceSource(pool, ui)
  pool.apply({ type: 'replace', rows: [
    ...issues.map(value => ({ kind: 'issue' as const, id: value.id, value })),
    ...rawSessions.map(value => ({ kind: 'session' as const, id: value.sessionId, value })),
    ...repos.map(value => ({ kind: 'repo' as const, id: value.id, value })),
    ...machines.map(value => ({ kind: 'machine' as const, id: value.id, value })),
  ] })
  return { pool, ui, issues, sessions }
}

/** Roots with sub-tasks, proposals, archived crews and folded one-agent leaves. */
function interestingRoots(issues: ReturnType<typeof allIssueViewModels>, sessions: readonly SessionView[], scale: 1 | 4) {
  const roots = new Set<string>()
  const pick = (test: (issue: (typeof issues)[number]) => boolean, limit: number) => {
    for (const issue of issues) {
      if (roots.size >= 40 || limit <= 0) return
      if (issue.archived || issue.deletedAt || issue.parentId || !test(issue)) continue
      const root = missionRootFor(issues, issue.id)?.id
      if (root && !roots.has(root)) { roots.add(root); limit-- }
    }
  }
  for (const id of scale === 1 ? ['i0', 'i292', 'i2696'] : ['i0', 'i11616', 'i11834']) {
    const root = missionRootFor(issues, id as never)?.id
    if (root) roots.add(root)
  }
  pick(issue => issue.childCount >= 2 && issue.childCount < 12, 6)
  pick(issue => sessions.some(session => session.issueId === issue.id && session.archived && !session.headless && session.agentKind !== 'shell'), 6)
  pick(issue => issues.some(child => child.parentId === issue.id && child.stage === 'proposed'), 4)
  pick(issue => issue.isDraftVessel === true, 2)
  return [...roots]
}

const cases = [
  { label: '1x', scale: 1 as const, cold: false },
  { label: '4x', scale: 4 as const, cold: false },
  { label: '1x with cold crews', scale: 1 as const, cold: true },
]
for (const { label, scale, cold } of cases) it(`opens corpus missions with the bundle's answers at ${label}: views, folds, search, archive`, async () => {
  const { pool, ui, issues, sessions } = corpusPool(scale, cold)
  const reader = missionView(pool)
  try {
    const roots = interestingRoots(issues, sessions, scale).slice(0, cold ? 8 : 40)
    expect(roots.length).toBeGreaterThan(5)
    let compared = 0, archived = 0, folded = 0, searched = 0
    const answers: unknown[] = []
    for (const rootId of roots) {
      let resolved: unknown
      const stopRoot = autorun(() => { resolved = missionRootId(pool, rootId) })
      await settle(pool); stopRoot()
      if (resolved !== rootId) continue
      for (const view of ['full', 'working', 'needs-you', 'waterfall', 'handoff'] as const) {
        const mode: FlightDeckMode = view === 'waterfall' || view === 'handoff' ? 'full' : view
        ui.set(FLIGHT_DECK_MODE_KEY, view === 'full' ? null : view)
        ui.set(FLIGHT_DECK_FOLDS_KEY, null)
        const screen = new MissionScreen(pool, rootId, { development: true, sessionName: name, setPreference: (key, raw) => ui.set(key, raw) })
        screen.open()
        let current: { old: ReturnType<typeof oldDeck> | typeof LOADING; next: ReturnType<typeof newDeck> | typeof LOADING } | undefined
        const stop = autorun(() => {
          const values = readMissionView(reader, rootId, mode)
          const ready = screen.ready && screen.view === view
          current = {
            old: values === LOADING ? LOADING : oldDeck(values, view, mode, screen.folds, screen.query),
            next: ready ? newDeck(screen) : LOADING,
          }
        })
        try {
          await settle(pool)
          same(answers, `${rootId} ${view}`, current)
          compared++
          if (screen.archivedCount > 0) archived++
          // Folds: close every branch, open them all, then a mixed map that
          // also names the one-agent leaves the default rule folds.
          const foldable = screen.foldable.map(row => row.id)
          const leaves = screen.rows.filter(row => row.depth > 0 && requireLoaded(row.deckChildren).length === 0 && row.crewIds.length === 1).map(row => row.id)
          for (const folds of [
            new Map(foldable.map(id => [id, 'closed' as const])),
            new Map(foldable.map(id => [id, 'open' as const])),
            new Map([...foldable, ...leaves].map((id, index) => [id, index % 2 ? 'open' as const : 'closed' as const])),
          ]) {
            ui.set(FLIGHT_DECK_FOLDS_KEY, writeFlightDeckFolds(folds))
            await settle(pool)
            same(answers, `${rootId} ${view} folds ${folds.size}`, current)
            if (folds.size) folded++
          }
          screen.foldAll()
          await settle(pool)
          same(answers, `${rootId} ${view} fold all`, current)
          // Search by a title fragment, a crew name, a reference and a miss.
          const sample = screen.rows.at(-1)
          const crew = screen.crewIds.at(-1)
          const crewName = crew ? name(pool.sessionObject(crew) as unknown as SessionView) : ''
          for (const query of [sample?.title.slice(1, 5) ?? '', crewName.slice(0, 4), sample?.displayRef ?? '', ' zz-no-match ']) {
            screen.setQuery(query)
            await settle(pool)
            same(answers, `${rootId} ${view} search ${JSON.stringify(query)}`, current)
            if (query.trim()) searched++
          }
        } finally { stop(); screen.close() }
      }
    }
    expectPoolOutput(answers, `mission screen answers at ${label}`)
    expect(compared).toBeGreaterThan(cold ? 10 : 20)
    expect(archived).toBeGreaterThan(0)
    expect(folded).toBeGreaterThan(0)
    expect(searched).toBeGreaterThan(0)
  } finally { pool.dispose() }
}, 600_000)

it('answers the agent hosts the pane catalog answered', async () => {
  const { pool, issues, sessions } = corpusPool(1)
  try {
    for (const rootId of interestingRoots(issues, sessions, 1).slice(0, 8)) {
      const screen = new MissionScreen(pool, rootId)
      let pair: unknown[] = []
      const stop = autorun(() => {
        if (!screen.ready) return
        const root = requireLoaded(screen.reader.issue(rootId))!
        const machines = machineViewsFromWire(headerView(pool).machines())
        const scans = headerView(pool).ids('repository').flatMap(id => { const scan = headerView(pool).row('repository', id); return scan ? [scan] : [] })
        const repo = reposToViews(scans).find(view => view.path === root.repoPath)
        const old = machines.length === 0 ? [] : root.machineId ? machines.filter(view => view.machine.id === root.machineId)
          : machines.filter(view => repo?.machines.some(machine => machine.machineId === view.machine.id))
        pair = [old.map(view => view.machine.id), screen.agentHosts.map(view => view.machine.id)]
      })
      await settle(pool); stop()
      expect(pair[1], rootId).toEqual(pair[0])
    }
  } finally { pool.dispose() }
}, 120_000)


/** The phone deck's own list rules over the bundle, verbatim from MissionDeck. */
function oldPhoneDeck(values: MissionViewValues, mode: FlightDeckMode, folds: FlightDeckFoldMap) {
  const rows = values.rows
  const shown: typeof rows = []
  let hideBelow: number | null = null
  for (const row of rows) {
    if (hideBelow !== null && row.depth > hideBelow) continue
    hideBelow = null
    shown.push(row)
    if (flightDeckRowIsFolded(row, folds)) hideBelow = row.depth
  }
  const rootId = values.root!.id
  const proposalIds = new Set(rows.filter(r => r.issue.stage === 'proposed' && r.descendantIds.length === 0).map(r => r.issue.id))
  const spine = shown.filter(r => r.issue.id !== rootId && !proposalIds.has(r.issue.id))
  const rootRow = rows.find(r => r.issue.id === rootId)
  const foldable = rows.filter(row => row.issue.id !== rootId && !proposalIds.has(row.issue.id) && flightDeckRowHasPayload(row))
  const target = values.continuation?.target?.id
  return {
    spine: spine.map(row => [row.issue.id, row.depth, row.issue.title, issueDisplayRef(row.issue), row.issue.stage, values.rowPresentation.get(row.issue.id), flightDeckRowIsFolded(row, folds), deckSessions(row, mode).map(s => s.sessionId)]),
    proposals: rows.filter(r => proposalIds.has(r.issue.id)).map(row => [row.issue.id, row.issue.title, issueDisplayRef(row.issue)]),
    foldable: foldable.map(row => row.issue.id),
    allFolded: foldable.length > 0 && foldable.every(row => flightDeckRowIsFolded(row, folds)),
    rootSessions: rootRow ? deckSessions(rootRow, mode).map(s => s.sessionId) : [],
    led: rows.filter(row => (row as MissionDeckIssueModel).hasLead).map(row => row.issue.id),
    presence: values.presence,
    continuation: continuationFacts(values.continuation),
    departures: departureFacts(values.departures.filter(d => d.issue.id !== target)),
    continuationState: values.departures.find(d => d.issue.id === target)?.state ?? null,
    waiting: rootRow?.waitingAgentCount ?? 0,
  }
}

/** The same answers through the opening's view model, with the phone's root-proposal rule. */
function newPhoneDeck(screen: MissionScreen) {
  const rootRow = screen.rootRow
  const rootProposal = rootRow && rootRow.stage === 'proposed' && rootRow.descendantIds.length === 0 ? [rootRow] : []
  const proposals = [...rootProposal, ...screen.proposedRows]
  return {
    spine: screen.visibleRows.map(row => [row.id, row.depth, row.title, row.displayRef, row.stage, row.presentation, row.folded(screen.folds), deckSessions(row, screen.mode).map(s => s.sessionId)]),
    proposals: proposals.map(row => [row.id, row.title, row.displayRef]),
    foldable: screen.foldable.map(row => row.id),
    allFolded: screen.allFolded,
    rootSessions: rootRow ? deckSessions(rootRow, screen.mode).map(s => s.sessionId) : [],
    led: screen.rows.filter(row => row.hasLead).map(row => row.id),
    presence: screen.presence,
    continuation: continuationFacts(screen.continuation),
    departures: departureFacts(screen.otherDepartures),
    continuationState: screen.continuationState,
    waiting: screen.waitingCount,
  }
}

it('opens phone missions with the phone bundle\'s answers: crew, header issue, progress, deck lists', async () => {
  const { pool, ui, issues, sessions } = corpusPool(1)
  await attachMobileScreens(pool)
  try {
    const reader = pool.row('mobileScreenReader', 'reader')
    if (!reader || typeof reader === 'symbol') throw new Error('Phone reader did not attach')
    // The phone also opens archived roots and children by id.
    const ids = [...interestingRoots(issues, sessions, 1),
      ...issues.filter(issue => issue.archived && !issue.deletedAt).slice(0, 4).map(issue => issue.id),
      ...issues.filter(issue => issue.parentId && !issue.archived).slice(0, 4).map(issue => issue.id)]
    let compared = 0
    const answers: unknown[] = []
    for (const id of ids) {
      for (const mode of ['full', 'working', 'needs-you'] as const) {
        ui.set(FLIGHT_DECK_MODE_KEY, mode === 'full' ? null : mode)
        ui.set(FLIGHT_DECK_FOLDS_KEY, null)
        let rootId: unknown
        const stopRoot = autorun(() => { rootId = missionRootId(pool, id, true) })
        await settle(pool); stopRoot()
        let current: { old: unknown; next: unknown } | undefined
        const screen = typeof rootId === 'string' ? new MissionScreen(pool, rootId, { setPreference: (key, raw) => ui.set(key, raw) }) : undefined
        screen?.open()
        const stop = autorun(() => {
          const mission = reader.mission(id), deck = reader.deck(id, mode)
          const old = mission === LOADING || deck === LOADING ? LOADING : {
            root: mission.root?.id,
            crew: mission.missionSessions.map(s => s.sessionId),
            header: mission.missionSessions.map(s => mission.issues.find(issue => issue.id === s.issueId)?.id ?? mission.root?.id),
            progress: mission.progress,
            deck: deck.root ? oldPhoneDeck(deck, mode, screen?.folds ?? new Map()) : null,
          }
          const next = !screen ? { root: undefined, crew: [], header: [], progress: { total: 0, done: 0, run: 0, review: 0, stall: 0, block: 0, wait: 0 }, deck: null }
            : !screen.ready ? LOADING : {
              root: screen.rootId,
              crew: screen.crew.map(s => s.sessionId),
              header: screen.crew.map(s => (s.issueId && screen.members.has(s.issueId) ? s.issueId : screen.rootId)),
              progress: screen.progress,
              deck: newPhoneDeck(screen),
            }
          current = { old, next }
        })
        try {
          await settle(pool)
          same(answers, `${id} ${mode}`, current)
          if (screen) {
            const foldable = screen.foldable.map(row => row.id)
            for (const folds of [new Map(foldable.map(fid => [fid, 'closed' as const])),
              new Map(foldable.map((fid, index) => [fid, index % 2 ? 'open' as const : 'closed' as const]))]) {
              ui.set(FLIGHT_DECK_FOLDS_KEY, writeFlightDeckFolds(folds))
              await settle(pool)
              same(answers, `${id} ${mode} folds`, current)
            }
          }
          compared++
        } finally { stop(); screen?.close() }
      }
    }
    expectPoolOutput(answers, 'phone mission answers')
    expect(compared).toBeGreaterThan(30)
  } finally { pool.dispose() }
}, 600_000)
