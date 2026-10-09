import { createKernelReplica, createSideCache, memoryStorage } from '@podium/client-core/replica'
import { type SessionView, sessionViews } from '@podium/client-core/session-values'
import type { RoutedUiState } from '@podium/client-core/ui-state'
import { FLIGHT_DECK_FOLDS_KEY, FLIGHT_DECK_MODE_KEY } from '@podium/client-core/ui-state'
import {
  deckSessions,
  type FlightDeckMode,
  machineViewsFromWire,
  missionRootFor,
  reposToViews,
  writeFlightDeckFolds,
} from '@podium/client-core/values'
import { autorun } from 'mobx'
import { expect, it } from 'vitest'
import { dedupeSessions } from '../../../tests/worklist/diagnostics/reference-state'
import { allIssueViewModels } from '../../../tests/worklist/diagnostics/reference/issue-view-models'
import { buildCorpus } from '../../../tests/worklist/harness/src/fixture/corpus'
import { seedCacheFromCorpus } from '../../../tests/worklist/shared/src/scenarios'
import { expectPoolOutput } from '../../../tests/worklist/harness/src/oracle/pool-output'
import { headerView } from './header-views'
import { attachMobileScreens } from './mobile-screens'
import { MissionScreen, missionRootId } from './mission-screen'
import { requireLoaded } from './mission-view'
import { MobxPool } from './pool'
import { attachPreferenceSource } from './preference-source'
import { MISSION_VIEW_SUMMARIES } from './mission-view-schema'
import { LOADING } from './worklist/rollup'

/**
 * The opened mission's view model against the pane bundle it replaced. The
 * bundle and the list rules the deck components applied to it are deleted;
 * the answers they gave, case by case, are the fingerprints frozen when both
 * ran side by side (each case compared field by field before the deletion).
 * Every moved fact is covered: views, folds, search, archive, cold crews and
 * the phone's crew, header issue and deck lists.
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
const continuationFacts = (value: MissionScreen['continuation']) =>
  value ? { kind: value.kind, short: value.short, full: value.full, line: value.line, target: value.target?.id ?? null } : null
const departureFacts = (values: MissionScreen['departures']) =>
  values.map(value => ({ id: value.issue.id, originId: value.originId, state: value.state }))

/** Keep one case's answer for the frozen fingerprint of the bundle's answers. */
function same(answers: unknown[], label: string, current: { next: unknown } | undefined) {
  expect(current?.next, label).not.toBe(LOADING)
  answers.push([label, current?.next])
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
        let current: { next: ReturnType<typeof newDeck> | typeof LOADING } | undefined
        const stop = autorun(() => {
          current = { next: screen.ready && screen.view === view ? newDeck(screen) : LOADING }
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
        let current: { next: unknown } | undefined
        const screen = typeof rootId === 'string' ? new MissionScreen(pool, rootId, { setPreference: (key, raw) => ui.set(key, raw) }) : undefined
        screen?.open()
        const stop = autorun(() => {
          const next = !screen ? { root: undefined, crew: [], header: [], progress: { total: 0, done: 0, run: 0, review: 0, stall: 0, block: 0, wait: 0 }, deck: null }
            : !screen.ready ? LOADING : {
              root: screen.rootId,
              crew: screen.crew.map(s => s.sessionId),
              header: screen.crew.map(s => (s.issueId && screen.members.has(s.issueId) ? s.issueId : screen.rootId)),
              progress: screen.progress,
              deck: newPhoneDeck(screen),
            }
          current = { next }
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
