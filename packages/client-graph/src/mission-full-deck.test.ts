import type { RoutedUiState } from '@podium/client-core/ui-state'
import { autorun } from 'mobx'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FullDeck } from './mission-full-deck'
import { MissionScreen } from './mission-screen'
import { attachMissionTestPreferences } from './mission-screen.test.fixture'
import { settled } from './mission-view'
import { MISSION_VIEW_SUMMARIES } from './mission-view-schema'
import { MobxPool } from './pool'
import { attachPreferenceSource } from './preference-source'
import { LOADING } from './worklist/rollup'

const stamp = '2026-10-15T12:00:00Z',
  later = '2026-10-15T12:05:00Z'
const pools: MobxPool[] = [],
  screens: MissionScreen[] = [],
  mounts: (() => void)[] = []
afterEach(() => {
  for (const stop of mounts.splice(0)) stop()
  for (const screen of screens.splice(0)) screen.close()
  for (const pool of pools.splice(0)) pool.dispose()
  vi.restoreAllMocks()
})

type Row = Record<string, unknown>
const issue = (id: string, seq: number, parentId: string | null, patch: Row = {}): Row => ({
  id,
  seq,
  title: `Task ${id}`,
  stage: 'in_progress',
  audience: 'human',
  parentId,
  deps: [],
  repoPath: '/synthetic',
  createdAt: stamp,
  updatedAt: stamp,
  readAt: stamp,
  ...patch,
})
const session = (sessionId: string, issueId: string, phase: string, patch: Row = {}): Row => ({
  sessionId,
  issueId,
  cwd: '/synthetic',
  title: `Agent ${sessionId}`,
  name: `Agent ${sessionId}`,
  agentKind: 'codex',
  status: 'live',
  archived: false,
  createdAt: stamp,
  lastActiveAt: stamp,
  readAt: stamp,
  unread: false,
  agentState: { phase },
  ...patch,
})

/**
 * A mixed mission (spec 06 board): unphased tasks, two phases, a phase nested
 * in a phase, a graft placed under its starter's task, a blocked chain, an
 * external dependency, done and abandoned work, a decision, and proposals,
 * one of them a proposed parent and one a spin-off.
 */
function mission(): { issues: Row[]; sessions: Row[] } {
  return {
    issues: [
      issue('root', 1, null, { coordinatorSessionId: 'coord', agentProfileId: 'prof-coord' }),
      issue('flaky', 2, 'root', { sortKey: 'a', deps: [{ id: 'privacy', type: 'related' }] }),
      issue('privacy', 3, 'root', { sortKey: 'c', stage: 'backlog' }),
      issue('build', 4, 'root', { sortKey: 'b', type: 'phase', coordinatorSessionId: 'lead' }),
      issue('admin', 5, 'build', {
        sortKey: 'a',
        coordinatorSessionId: 'w-admin',
        agentProfileId: 'prof-build',
      }),
      issue('audit', 6, 'admin', { sortKey: 'a' }),
      issue('usage', 7, 'admin', {
        sortKey: 'b',
        stage: 'backlog',
        blocked: true,
        deps: [{ id: 'audit', type: 'blocked-by' }],
      }),
      issue('csv', 8, 'usage', { stage: 'backlog' }),
      issue('plan', 9, 'usage', { stage: 'backlog' }),
      issue('shipped', 10, 'admin', { sortKey: 'c', stage: 'done', closedAt: stamp }),
      issue('gate', 11, 'build', { sortKey: 'b' }),
      issue('review-phase', 12, 'build', { sortKey: 'c', type: 'phase', stage: 'backlog' }),
      issue('decide', 13, 'review-phase', { type: 'decision', stage: 'backlog' }),
      issue('release', 14, 'root', { sortKey: 'd', type: 'phase' }),
      issue('r1', 15, 'release', { stage: 'done', closedAt: stamp }),
      issue('r2', 16, 'release', { stage: 'done', closedReason: 'cancelled', closedAt: stamp }),
      issue('ext', 17, 'root', {
        sortKey: 'e',
        stage: 'backlog',
        blocked: true,
        deps: [
          { id: 'outside', type: 'blocked-by' },
          { id: 'missing', type: 'blocked-by' },
        ],
      }),
      issue('dropped', 18, 'root', {
        sortKey: 'f',
        stage: 'done',
        closedReason: 'cancelled',
        closedAt: stamp,
      }),
      issue('prop', 19, 'root', { sortKey: 'g', stage: 'proposed', startedBySession: 'coord' }),
      issue('prop-parent', 20, 'root', { sortKey: 'h', stage: 'proposed' }),
      issue('prop-child', 21, 'prop-parent', { stage: 'backlog' }),
      issue('graft', 22, null, { stage: 'backlog', startedBySession: 'w-flaky' }),
      issue('spin', 23, null, {
        stage: 'proposed',
        startedBySession: 'w-flaky',
        deps: [{ id: 'flaky', type: 'discovered-from' }],
      }),
      issue('outside', 30, null),
    ],
    sessions: [
      session('coord', 'root', 'working', { agentProfileId: 'prof-coord' }),
      session('root-help', 'root', 'idle', { createdAt: later }),
      session('w-flaky', 'flaky', 'working'),
      session('lead', 'build', 'idle'),
      session('w-admin', 'admin', 'working', { agentProfileId: 'prof-codex' }),
      session('h-admin', 'admin', 'idle', { createdAt: later }),
      session('w-audit', 'audit', 'working'),
      session('w-gate', 'gate', 'errored'),
    ],
  }
}

const flush = async () => {
  for (let turn = 0; turn < 5; turn++) await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

/** One opening of the fixture with a writable device preference, settled. */
async function open(fixture = mission()) {
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
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.parse(stamp) })
  pools.push(pool)
  attachPreferenceSource(pool, ui)
  pool.apply({
    type: 'replace',
    rows: [
      ...fixture.issues.map((value) => ({
        kind: 'issue' as const,
        id: value['id'] as string,
        value: value as never,
      })),
      ...fixture.sessions.map((value) => ({
        kind: 'session' as const,
        id: value['sessionId'] as string,
        value: value as never,
      })),
    ],
  })
  const screen = new MissionScreen(pool, 'root', { setPreference: (key, raw) => ui.set(key, raw) })
  screens.push(screen)
  screen.open()
  // The mounted deck keeps its preferences and rows observed, as a pane does.
  mounts.push(
    autorun(() => {
      void settled(() => [screen.ready, screen.full.ready])
    }),
  )
  await flush()
  return { pool, screen, full: screen.full }
}

/** Read inside a reaction, as a component does, settling LOADING. */
function tracked<T>(read: () => T): T | typeof LOADING {
  let value!: T | typeof LOADING
  const stop = autorun(() => {
    value = settled(read)
  })
  stop()
  return value
}
const rows = (full: FullDeck) => tracked(() => full.rowIds)

describe('the accepted tree', () => {
  it('orders tasks before phases at every level, by sort_key, and keeps grafts and nested phases', async () => {
    const { full } = await open()
    expect(tracked(() => full.ready)).toBe(true)
    expect(tracked(() => full.root.childIds)).toEqual([
      'flaky',
      'privacy',
      'ext',
      'dropped',
      'build',
      'release',
    ])
    expect(tracked(() => full.task('build').childIds)).toEqual(['admin', 'gate', 'review-phase'])
    expect(tracked(() => full.task('flaky').childIds)).toEqual(['graft'])
    expect(tracked(() => full.task('graft').parentId)).toBe('flaky')
    expect(tracked(() => full.phaseIds)).toEqual(['build', 'review-phase', 'release'])
  })

  it('names each row its nearest phase and its depth below the root', async () => {
    const { full } = await open()
    const facts = (id: string) =>
      tracked(() => ({
        phase: full.task(id).phaseId,
        depth: full.task(id).depth,
        kind: full.task(id).kind,
      }))
    expect(facts('flaky')).toEqual({ phase: null, depth: 0, kind: 'task' })
    expect(facts('graft')).toEqual({ phase: null, depth: 1, kind: 'task' })
    expect(facts('build')).toEqual({ phase: null, depth: 0, kind: 'phase' })
    expect(facts('audit')).toEqual({ phase: 'build', depth: 2, kind: 'task' })
    expect(facts('csv')).toEqual({ phase: 'build', depth: 3, kind: 'task' })
    expect(facts('review-phase')).toEqual({ phase: 'build', depth: 1, kind: 'phase' })
    expect(facts('decide')).toEqual({ phase: 'review-phase', depth: 2, kind: 'decision' })
  })

  it('keeps proposals and their subtrees outside the accepted work', async () => {
    const { full } = await open()
    expect(tracked(() => full.proposalIds)).toEqual(['spin', 'prop', 'prop-parent'])
    expect(tracked(() => full.leafIds)).not.toContain('prop-child')
    expect(tracked(() => full.rowIds)).not.toContain('prop-parent')
    expect(tracked(() => full.task('prop').placement)).toBe('mission')
    expect(tracked(() => full.task('spin').placement)).toBe('own')
    // A proposed parent keeps its own counter for the proposal row.
    expect(tracked(() => full.task('prop-parent').counter)).toEqual({ done: 0, total: 1 })
  })
})

describe('counting', () => {
  it('totals leaves for the gauge and the tabs, and direct children for row counters', async () => {
    const { full } = await open()
    expect(tracked(() => full.leafIds)).toEqual(
      expect.arrayContaining([
        'graft',
        'privacy',
        'ext',
        'dropped',
        'audit',
        'csv',
        'plan',
        'shipped',
        'gate',
        'decide',
        'r1',
        'r2',
      ]),
    )
    expect(tracked(() => full.tally)).toEqual({
      error: 1,
      'needs-you': 1,
      working: 1,
      idle: 0,
      blocked: 1,
      'not-started': 4,
      done: 4,
      total: 12,
    })
    expect(tracked(() => full.counts)).toEqual({
      all: 12,
      'needs-you': 2,
      active: 3,
      'up-next': 5,
      done: 4,
    })
    expect(tracked(() => full.task('admin').counter)).toEqual({ done: 1, total: 3 })
    expect(tracked(() => full.task('usage').counter)).toEqual({ done: 0, total: 2 })
    // A phase counts through a nested phase to its tasks (D1).
    expect(tracked(() => full.task('build').counter)).toEqual({ done: 0, total: 3 })
    expect(tracked(() => full.root.counter)).toEqual({ done: 3, total: 9 })
  })

  it('reads decision urgency: Error makes Needs you red, a decision alone keeps it amber', async () => {
    const { pool, full } = await open()
    expect(tracked(() => full.task('decide').word)).toBe('needs-you')
    expect(tracked(() => full.task('gate').word)).toBe('error')
    expect(tracked(() => full.task('build').word)).toBe('error')
    expect(tracked(() => full.needsYouTone)).toBe('error')
    pool.apply({
      type: 'update',
      rows: [
        { kind: 'session', id: 'w-gate', value: session('w-gate', 'gate', 'working') as never },
      ],
    })
    expect(tracked(() => full.needsYouTone)).toBe('needs-you')
    expect(tracked(() => full.counts)).toEqual({
      all: 12,
      'needs-you': 1,
      active: 3,
      'up-next': 5,
      done: 4,
    })
  })

  it('completes a phase from its work without closing the phase issue', async () => {
    const { pool, full } = await open()
    const release = full.task('release')
    expect(tracked(() => ({ complete: release.workComplete, closed: release.closed }))).toEqual({
      complete: true,
      closed: false,
    })
    expect(tracked(() => full.task('build').workComplete)).toBe(false)
    expect(tracked(() => full.doneLine)).toEqual({ phases: 1, tasks: 4 })
    void tracked(() => full.rowIds)
    expect(pool.issueObject('release').stage).toBe('in_progress')
  })

  it('does not move totals with folds, search or Show done', async () => {
    const { screen, full } = await open()
    const before = tracked(() => full.counts)
    screen.fold('admin', true)
    await flush()
    screen.setQuery('csv')
    full.setShowDone(true)
    full.setFilter('up-next')
    expect(tracked(() => full.counts)).toEqual(before)
  })
})

describe('drawing', () => {
  const all = [
    'flaky',
    'graft',
    'privacy',
    'ext',
    'build',
    'admin',
    'audit',
    'usage',
    'csv',
    'plan',
    'gate',
    'review-phase',
    'decide',
  ]

  it('hides done and abandoned work and complete phases by default', async () => {
    const { full } = await open()
    expect(rows(full)).toEqual(all)
  })

  it.each([
    ['needs-you', ['build', 'gate', 'review-phase', 'decide']],
    ['active', ['flaky', 'build', 'admin', 'audit', 'gate', 'review-phase', 'decide']],
    ['up-next', ['flaky', 'graft', 'privacy', 'ext', 'build', 'admin', 'usage', 'csv', 'plan']],
    ['all', all],
  ] as const)('filters to %s and keeps the ancestors of matches for context', async (filter, expected) => {
    const { full } = await open()
    full.setFilter(filter)
    expect(rows(full)).toEqual(expected)
  })

  it('shows done work in place, returns to All, and a filter turns Show done off', async () => {
    const { full } = await open()
    full.setFilter('active')
    full.setShowDone(true)
    expect(full.filter).toBe('all')
    expect(rows(full)).toEqual([
      'flaky',
      'graft',
      'privacy',
      'ext',
      'build',
      'admin',
      'audit',
      'usage',
      'csv',
      'plan',
      'shipped',
      'gate',
      'review-phase',
      'decide',
      'release',
      'r1',
    ])
    expect(tracked(() => full.doneLine)).toBeNull()
    full.setFilter('needs-you')
    expect(full.showDone).toBe(false)
  })

  it('opens parents and attention by default, and an explicit fold wins either way', async () => {
    const { screen, full } = await open()
    const open_ = (id: string) => tracked(() => full.task(id).open)
    expect(['flaky', 'build', 'admin', 'usage', 'gate', 'decide'].map(open_)).toEqual([
      true,
      true,
      true,
      true,
      true,
      true,
    ])
    expect(['privacy', 'audit', 'ext'].map(open_)).toEqual([false, false, false])
    full.toggleFold('admin')
    await flush()
    full.toggleFold('audit')
    await flush()
    screen.fold('gate', true)
    await flush()
    expect(['admin', 'audit', 'gate'].map(open_)).toEqual([false, true, false])
    expect(rows(full)).toEqual([
      'flaky',
      'graft',
      'privacy',
      'ext',
      'build',
      'admin',
      'gate',
      'review-phase',
      'decide',
    ])
    full.foldAll()
    await flush()
    expect(tracked(() => full.allFolded)).toBe(true)
    full.foldAll()
    await flush()
    expect(tracked(() => full.foldableIds.every((id) => full.task(id).open))).toBe(true)
  })

  it('narrows to search matches with their path, under the filter', async () => {
    const { screen, full } = await open()
    screen.setQuery('csv')
    expect(rows(full)).toEqual(['build', 'admin', 'usage', 'csv'])
    full.setFilter('active')
    expect(rows(full)).toEqual([])
    expect(tracked(() => full.proposalIds)).toEqual([])
  })
})

describe('seats and profiles', () => {
  it('derives coordinator, phase lead, worker and helper from each coordinator marker', async () => {
    const { full } = await open()
    expect(tracked(() => full.coordinatorSessionId)).toBe('coord')
    expect(tracked(() => full.root.helperIds)).toEqual(['root-help'])
    expect(tracked(() => full.root.seat('coord'))).toBe('coordinator')
    expect(tracked(() => full.root.seat('root-help'))).toBe('helper')
    expect(tracked(() => full.task('build').seat('lead'))).toBe('phase-lead')
    expect(tracked(() => full.task('admin').sessionIds)).toEqual(['w-admin', 'h-admin'])
    expect(tracked(() => full.task('admin').seat('w-admin'))).toBe('worker')
    expect(tracked(() => full.task('admin').seat('h-admin'))).toBe('helper')
    // No marker: array position never assigns a worker.
    expect(
      tracked(() => ({
        lead: full.task('audit').leadSessionId,
        explicit: full.task('audit').leadExplicit,
      })),
    ).toEqual({ lead: null, explicit: false })
    expect(tracked(() => full.task('audit').seat('w-audit'))).toBe('helper')
  })

  it('requires a roster member marker for root, phase and task seats', async () => {
    const { pool, full } = await open()
    for (const id of ['root', 'build', 'admin']) {
      const marker = pool.issueObject(id).coordinatorSessionId
      const original = mission().issues.find(row => row['id'] === id)!
      const setMarker = (coordinatorSessionId: string | null | undefined) => pool.apply({
        type: 'update', rows: [{ kind: 'issue', id, value: { ...original, coordinatorSessionId } as never }],
      })
      setMarker(null)
      expect(tracked(() => full.task(id).leadSessionId)).toBeNull()
      expect(tracked(() => full.task(id).helperIds)).toEqual(tracked(() => full.task(id).sessionIds))
      expect(tracked(() => full.task(id).sessionIds.every(session => full.task(id).seat(session) === 'helper'))).toBe(true)
      if (id === 'root') expect(tracked(() => full.coordinatorSessionId)).toBeNull()
      setMarker('missing')
      expect(tracked(() => full.task(id).leadSessionId)).toBeNull()
      setMarker(marker)
      expect(tracked(() => full.task(id).leadSessionId)).toBe(marker)
    }
  })

  it('reads the role profile from the session that runs, else the issue default', async () => {
    const { full } = await open()
    const admin = full.task('admin')
    expect(tracked(() => admin.profileId)).toBe('prof-build')
    expect(tracked(() => admin.sessionProfileId('w-admin'))).toBe('prof-codex')
    expect(tracked(() => admin.sessionProfileId('h-admin'))).toBe('prof-build')
    expect(tracked(() => full.task('gate').sessionProfileId('w-gate'))).toBeNull()
  })

  it('names a proposal by its filing session, through the screen', async () => {
    const { screen, full } = await open()
    const prop = full.task('prop')
    expect(tracked(() => prop.proposalAuthor)).toBe(tracked(() => screen.proposalAuthor(prop.row)))
  })
})

describe('dependencies', () => {
  it('keeps unmet blocked-by edges, inside and outside the mission, dependents and related', async () => {
    const { full } = await open()
    expect(tracked(() => full.task('usage').unmetBlockedByIds)).toEqual(['audit'])
    expect(tracked(() => full.task('usage').externalUnmetIds)).toEqual([])
    expect(tracked(() => full.task('audit').dependentIds)).toEqual(['usage'])
    expect(tracked(() => full.task('ext').blockedByIds)).toEqual(['outside', 'missing'])
    // A gone dependency no longer blocks; an open one outside is counted.
    expect(tracked(() => full.task('ext').unmetBlockedByIds)).toEqual(['outside'])
    expect(tracked(() => full.task('ext').externalUnmetIds)).toEqual(['outside'])
    expect(tracked(() => full.task('flaky').relatedIds)).toEqual(['privacy'])
    expect(tracked(() => full.task('privacy').relatedIds)).toEqual(['flaky'])
  })

  it('meets a dependency when it closes, whatever the close reason', async () => {
    const { pool, full } = await open()
    const fixture = mission()
    const outside = fixture.issues.find((row) => row['id'] === 'outside')!
    pool.apply({
      type: 'update',
      rows: [
        {
          kind: 'issue',
          id: 'outside',
          value: { ...outside, stage: 'done', closedReason: 'cancelled', closedAt: later } as never,
        },
      ],
    })
    expect(tracked(() => full.task('ext').externalUnmetIds)).toEqual([])
  })
})

describe('loading', () => {
  it('stays unready while a cold row loads, then settles', async () => {
    const fixture = mission()
    const input = new Map<string, object>([
      ...fixture.issues.map((row) => [`issue:${row['id'] as string}`, row] as const),
      ...fixture.sessions.map((row) => [`session:${row['sessionId'] as string}`, row] as const),
    ])
    const load = vi.fn((entity: string, id: string) => input.get(`${entity}:${id}`))
    const pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.parse(stamp) }, undefined, {
      load,
      summaries: MISSION_VIEW_SUMMARIES,
      schedule: () => () => {},
    })
    pools.push(pool)
    attachMissionTestPreferences(pool)
    // Closed rows arrive as declared summaries only, as a long mission's history does.
    pool.apply({
      type: 'replace',
      rows: [
        ...fixture.issues.map((value) => ({
          kind: 'issue' as const,
          id: value['id'] as string,
          value: value as never,
        })),
        ...fixture.sessions.map((value) => ({
          kind: 'session' as const,
          id: value['sessionId'] as string,
          value: value as never,
        })),
      ],
    })
    const screen = new MissionScreen(pool, 'root')
    screens.push(screen)
    const full = screen.full
    expect(tracked(() => full.ready)).toBe(false)
    let rounds = 0
    while (!tracked(() => full.ready) && rounds++ < 10) pool.hydrate()
    expect(tracked(() => full.ready)).toBe(true)
    expect(tracked(() => full.counts)).toEqual({
      all: 12,
      'needs-you': 2,
      active: 3,
      'up-next': 5,
      done: 4,
    })
  })
})

describe('legacy modes', () => {
  /** What Waterfall, Timeline and the phone read from the same opening. */
  const legacy = (screen: MissionScreen) =>
    tracked(() => ({
      ready: screen.ready,
      rows: screen.rows.map((row) => row.key),
      visible: screen.visibleRows.map((row) => row.id),
      proposed: screen.proposedRows.map((row) => row.id),
      folded: screen.rows.map((row) => row.folded(screen.folds)),
      progress: screen.progress,
      counts: [screen.liveCount, screen.workingCount, screen.needsCount, screen.waitingCount],
      words: screen.rows.map((row) => row.word),
    }))

  it('answers the same whether or not the Full view is read or changed', async () => {
    const untouched = await open(),
      used = await open()
    const before = legacy(used.screen)
    expect(before).not.toBe(LOADING)
    void tracked(() => [
      used.full.rowIds,
      used.full.counts,
      used.full.proposalIds,
      used.full.doneLine,
    ])
    used.full.setFilter('needs-you')
    used.full.setShowDone(true)
    expect(legacy(used.screen)).toEqual(before)
    expect(legacy(used.screen)).toEqual(legacy(untouched.screen))
  })

  it('keeps its own proposal and fold rules beside the Full ones', async () => {
    const { screen, full } = await open()
    const old = legacy(screen)
    if (old === LOADING) throw new Error('legacy deck did not settle')
    // A proposed parent stays in the legacy tree; the Full view lists it as a proposal.
    expect(old.proposed).toEqual(['spin', 'prop'])
    expect(old.visible).toContain('prop-parent')
    expect(tracked(() => full.proposalIds)).toContain('prop-parent')
    // The legacy default folds a lone-crew leaf; the Full view opens Error.
    const gate = screen.rows.find((row) => row.id === 'gate')!
    expect(gate.folded(screen.folds)).toBe(true)
    expect(tracked(() => full.task('gate').open)).toBe(true)
  })
})
