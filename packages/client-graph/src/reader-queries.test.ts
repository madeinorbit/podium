// @vitest-environment happy-dom

import { withKeyedInputs } from '@podium/client-core/engine'
import { autorun, runInAction } from 'mobx'
import { describe, expect, it, vi } from 'vitest'
import { compareSidebarSnapshots, type SidebarSnapshot } from '../diagnostics/sidebar-check'
import { automationViews } from './automation-views'
import { chatMentionIssues, chatReferenceSessions } from './chat-context'
import { CHAT_CONTEXT_SUMMARIES } from './chat-context-schema'
import { COMMAND_SUMMARIES } from './command-launch-schema'
import { attachCommandLaunchSource } from './command-launch-source'
import { knownIds } from './enumerate'
import { ISSUE_BOARD_SUMMARIES } from './issue-board-schema'
import { createIssueBoardSource } from './issue-board-source'
import { issuePages } from './issue-page'
import { ISSUE_PAGE_SUMMARIES } from './issue-page-schema'
import { missionView, readMissionActionInputs } from './mission-view'
import { MISSION_VIEW_SUMMARIES } from './mission-view-schema'
import { MOBILE_INBOX_SUMMARIES } from './mobile-inbox-schema'
import { MobileInboxSource } from './mobile-inbox-source'
import { createMobileInboxViews } from './mobile-inbox-views'
import { createMobileSessionReader } from './mobile-session-context'
import { MobxPool } from './pool'
import { paneHasSessions } from './session-pane'
import { createColdIndex } from './shared/cold-index'
import { questionEntity } from './shared/reader-questions'
import { SCHEMA } from './shared/schema'
import type { RowRecord } from './shared/source'
import { SHELL_SUMMARIES } from './shell-schema'
import { shellViews } from './shell-views'
import { mergePoolSummaries } from './source-registry'
import { LOADING } from './worklist/rollup'

const now = Date.parse('2026-10-03T12:00:00Z'),
  old = '2020-01-01T00:00:00Z'
function fixture(scale = 1, bootOnly = false) {
  let rows: RowRecord[] = []
  const issue = (id: string, extra: object = {}) =>
    ({
      kind: 'issue',
      id,
      value: {
        id,
        seq: rows.length + 1,
        title: id,
        description: '',
        stage: 'done',
        closedAt: old,
        createdAt: old,
        updatedAt: old,
        archived: true,
        repoId: 'query-repo',
        repoPath: '/query',
        worktreePath: '/query/cold',
        audience: 'human',
        priority: 2,
        labels: [],
        deps: [],
        ...extra,
      },
    }) as RowRecord
  const session = (id: string, extra: object = {}) =>
    ({
      kind: 'session',
      id,
      value: {
        sessionId: id,
        title: id,
        agentKind: 'codex',
        cwd: '/query/other',
        status: 'exited',
        stoppedAt: old,
        lastActiveAt: old,
        createdAt: old,
        displayRef: `Q-${id}`,
        ...extra,
      },
    }) as RowRecord
  for (let n = 0; n < 128 * scale; n++) {
    rows.push(issue(`cold-issue-${n}`))
    rows.push(session(`cold-session-${n}`))
  }
  rows.push(issue('proposal', { stage: 'proposed', archived: false, worktreePath: '/query/hot' }))
  rows.push(issue('child-proposal', { stage: 'proposed', archived: false, parentId: 'proposal' }))
  rows.push(
    session('host', {
      status: 'live',
      issueId: 'cold-issue-0',
      machineId: 'query-host',
      lastActiveAt: '2026-10-02T12:00:00Z',
      agentState: { phase: 'working', since: '2026-10-03T12:00:00Z' },
    }),
  )
  rows.push(session('a-twin', { resume: { kind: 'codex-thread', value: 'query-twin' } }))
  rows.push(
    session('z-twin', {
      status: 'hibernated',
      resume: { kind: 'codex-thread', value: 'query-twin' },
      lastActiveAt: '2020-01-02T00:00:00Z',
    }),
  )
  rows.push({
    kind: 'worktree',
    id: '/query',
    value: {
      path: '/query',
      repoId: 'query-repo',
      repoPath: '/query',
      repoName: 'Query',
      prefix: 'Q',
    },
  })
  if (bootOnly) rows = rows.filter((row) => row.kind !== 'session' && !row.id.includes('proposal'))
  const values = new Map(rows.map((row) => [`${row.kind}:${row.id}`, row.value]))
  const index = createColdIndex(SCHEMA)
  index.apply({ type: 'replace', rows })
  const load = vi.fn((entity: string, id: string) => values.get(`${entity}:${id}`))
  const summaries = mergePoolSummaries(
    COMMAND_SUMMARIES,
    MOBILE_INBOX_SUMMARIES,
    CHAT_CONTEXT_SUMMARIES,
    ISSUE_PAGE_SUMMARIES,
    ISSUE_BOARD_SUMMARIES,
    MISSION_VIEW_SUMMARIES,
    SHELL_SUMMARIES,
  )
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: now }, undefined, {
    load,
    cold: () => index,
    header: true,
    settings: true,
    summaries,
    schedule: () => () => {},
  })
  pool.apply({ type: 'replace', rows })
  pool.header.apply([
    { kind: 'hostMetric', id: 'metric', value: { machineId: 'query-host' } } as never,
  ])
  const mobile = new MobileInboxSource(
    { replica: { getCursor: () => 1, subscribeCursor: () => () => {} } } as never,
    pool,
  )
  pool.sources.register(['mobileInboxState', 'mobileReferencePrefixes'], mobile)
  pool.sources.register(['chatIssueOrder', 'chatSessionOrder'], {
    read: (entity: string) => ({
      ids: (bootOnly ? [] : rows)
        .filter((row) => row.kind === (entity === 'chatIssueOrder' ? 'issue' : 'session'))
        .map((row) => row.id),
    }),
    dispose() {},
  } as never)
  if (bootOnly)
    pool.sources.register(['mobileSessionWindow'], {
      read: () => ({ cursor: null, pendingSpawnPrompts: new Map() }),
      dispose() {},
    })
  attachCommandLaunchSource(pool, withKeyedInputs({
    getSnapshot: () => ({ repos: [], machines: [] }),
    subscribe: () => () => {},
  }) as never)
  return { pool, index, load, rows, values }
}

/** Comparison rows are the actual ordered values consumed by the screens.
 * Independent legacy-vs-pool render comparisons live in the reader suites. */
function snapshot(name: string, value: unknown): SidebarSnapshot {
  return { pending: 0, sections: [{ key: name, fields: { value }, rows: [] }] }
}
const readers: { name: string; bootOnly?: boolean; read(pool: MobxPool): unknown }[] = [
  { name: 'phone launcher', read: (pool) => pool.row('commandCatalog', 'catalog') },
  {
    name: 'phone inbox',
    read: (pool) => {
      const view = createMobileInboxViews(pool)
      try {
        return {
          inbox: view.inbox(),
          screening: view.screening(),
          session: view.session('Q-z-twin'),
        }
      } finally {
        view.dispose()
      }
    },
  },
  { name: 'phone prefixes', read: (pool) => pool.row('mobileReferencePrefixes', 'prefixes') },
  {
    name: 'settings',
    read: (pool) => ({
      setup: pool.settingsViews.setup(),
      sessions: pool.settingsViews.sessions(),
    }),
  },
  { name: 'automation sessions', read: (pool) => automationViews(pool).session('cold-session-0') },
  { name: 'session pane', read: paneHasSessions },
  {
    name: 'phone session boot',
    bootOnly: true,
    read: (pool) => createMobileSessionReader(pool).booting(),
  },
  {
    name: 'chat mentions',
    read: (pool) => ({ issues: chatMentionIssues(pool), sessions: chatReferenceSessions(pool) }),
  },
  {
    name: 'web header',
    read: (pool) => ({
      working: pool.headerViews.working(),
      occupancy: pool.headerViews.occupancyKey(),
      shipping: pool.headerViews.shipping(),
      reclaim: pool.headerViews.reclaimCounts(1),
    }),
  },
  {
    name: 'issue page',
    read: (pool) => ({
      issues: issuePages(pool).issues(),
      explorer: issuePages(pool).explorer(),
      panel: issuePages(pool).panel({ cwd: '/query/cold/file' }),
    }),
  },
  {
    name: 'shell',
    read: (pool) => ({ issues: shellViews(pool).issues(), sessions: shellViews(pool).sessions() }),
  },
  { name: 'mission catalog', read: (pool) => readMissionActionInputs(missionView(pool), []) },
  {
    name: 'board',
    read: (pool) => {
      const source = createIssueBoardSource(pool)
      try {
        return {
          ids: source.queryIds({ kind: 'board', filter: { stage: 'done', archived: true } }),
          catalog: source.catalog(false),
          explorer: source.explorer({ tab: 'proposed', query: '', windowed: true }),
        }
      } finally {
        source.dispose()
      }
    },
  },
]

describe('readers behind declared cold questions', () => {
  it.each([
    1, 4,
  ])('keeps the filtered command issue roster exact with %ix archived history', (scale) => {
    const f = fixture(scale)
    const base = f.rows.find((row) => row.kind === 'session')!
    const session = (id: string, extra: object = {}): RowRecord => ({
      kind: 'session',
      id,
      value: { ...base.value, sessionId: id, issueId: 'proposal', ...extra } as RowRecord['value'],
    })
    const history = Array.from({ length: 32 * scale }, (_, at) =>
      session(`archived-sender-${at}`, { archived: true }),
    )
    const rows = [
      ...history,
      session('menu-agent'),
      session('menu-headless', { headless: true }),
      session('menu-shell', { agentKind: 'shell' }),
      session('menu-a-twin', { resume: { kind: 'codex-thread', value: 'menu-thread' } }),
      session('menu-z-twin', {
        resume: { kind: 'codex-thread', value: 'menu-thread' },
        lastActiveAt: '2020-01-02T00:00:00Z',
      }),
    ]
    const publish = (changed: RowRecord[]) => {
      for (const row of changed) f.values.set(`${row.kind}:${row.id}`, row.value)
      f.index.apply({ type: 'update', rows: changed })
      f.pool.apply({ type: 'update', rows: changed })
    }
    const question = {
      kind: 'commandIssueSessions' as const,
      issueId: 'proposal',
      archived: false,
      includeShells: true,
    }
    try {
      publish(rows)
      // An unrelated resident must not be unioned into the requested roster.
      f.pool.row('session', 'host', 'summary')
      f.pool.hydrate()
      const roster = () => f.pool.queries.ids(question).sort()
      expect(roster()).toEqual([
        'menu-a-twin',
        'menu-agent',
        'menu-headless',
        'menu-shell',
        'menu-z-twin',
      ])
      expect(f.pool.queries.collapsed('menu-a-twin')).toBe(true)
      expect(f.pool.queries.collapsed('menu-z-twin')).toBe(false)
      expect(f.index.readerIds({ ...question, includeShells: false }).sort()).toEqual([
        'menu-a-twin',
        'menu-agent',
        'menu-headless',
        'menu-z-twin',
      ])
      expect(
        f.index.readerIds({ kind: 'commandIssueSessions', issueId: 'proposal' }).sort(),
      ).toEqual(
        [
          ...history.map((row) => row.id),
          'menu-a-twin',
          'menu-agent',
          'menu-headless',
          'menu-z-twin',
        ].sort(),
      )
      expect(f.pool.graph.size('issue', 'proposal', 'pageSessions')).toBe(history.length + 4)
      expect(f.load.mock.calls.some(([, id]) => String(id).startsWith('archived-sender-'))).toBe(
        false,
      )
      publish([
        session('menu-agent', { archived: true }),
        session('menu-headless', { issueId: 'elsewhere' }),
      ])
      expect(roster()).toEqual(['menu-a-twin', 'menu-shell', 'menu-z-twin'])
      expect(f.pool.graph.size('issue', 'proposal', 'pageSessions')).toBe(history.length + 3)
    } finally {
      f.pool.dispose()
    }
  })
  for (const reader of readers)
    it(`${reader.name}: preserves output, rejects a plant, and never enumerates the cold registry`, async () => {
      const f = fixture(1, reader.bootOnly),
        pool = f.pool
      let scans = 0
      const ids = pool.residency!.ids.bind(pool.residency)
      const census = vi.spyOn(pool.residency!, 'ids').mockImplementation((...args) => {
        scans++
        return ids(...args)
      })
      try {
        // Drain demanded values before comparing, without a browser or a second
        // runtime. Each reader starts with its own cold history fixture.
        for (let turn = 0; turn < 8; turn++) {
          scans = 0
          runInAction(() => reader.read(pool))
          expect(scans).toBe(0)
          await Promise.resolve()
          if (!pool.hydrate()) break
        }
        const actual = snapshot(
          reader.name,
          runInAction(() => reader.read(pool)),
        )
        const original = pool.queries.ids.bind(pool.queries)
        const legacy = vi
          .spyOn(pool.queries, 'ids')
          .mockImplementation((question) => knownIds(pool, questionEntity(question)))
        const legacyCount = vi
          .spyOn(pool.queries, 'count')
          .mockImplementation((entity) => knownIds(pool, entity).length)
        const expected = snapshot(
          reader.name,
          runInAction(() => reader.read(pool)),
        )
        legacy.mockRestore()
        legacyCount.mockRestore()
        expect(compareSidebarSnapshots(expected, actual)).toMatchObject({
          differences: 0,
          pending: 0,
        })
        const membership = vi.spyOn(pool.queries, 'ids').mockReturnValue([])
        const repos = vi.spyOn(pool.queries, 'repoIds').mockReturnValue([])
        const count = vi.spyOn(pool.queries, 'count').mockReturnValue(0)
        const damaged = snapshot(
          reader.name,
          runInAction(() => reader.read(pool)),
        )
        expect(compareSidebarSnapshots(expected, damaged).differences).toBeGreaterThan(0)
        membership.mockRestore()
        repos.mockRestore()
        count.mockRestore()
        // A real registry walk is the scan counter, including walks hidden in
        // a helper. It is measured only during the reader, not test hydration.
        scans = 0
        runInAction(() => reader.read(pool))
        expect(scans).toBe(0)
        // The counter rejects an actual planted old enumeration, not a mock
        // number. Keep the output identical so this proves the cost assertion.
        vi.spyOn(pool.queries, 'ids').mockImplementation((question) => {
          pool.residency!.ids(questionEntity(question))
          return original(question)
        })
        const originalCount = pool.queries.count.bind(pool.queries)
        vi.spyOn(pool.queries, 'count').mockImplementation((entity) => {
          pool.residency!.ids(entity)
          return originalCount(entity)
        })
        runInAction(() => reader.read(pool))
        expect(scans).toBeGreaterThan(0)
        census.mockRestore()
      } finally {
        vi.restoreAllMocks()
        pool.dispose()
      }
    })

  it.each([
    1, 4,
  ])('narrows phone/header/board questions independently of %ix history, follows updates and replacement', (scale) => {
    const f = fixture(scale)
    try {
      expect(f.index.readerIds({ kind: 'proposedIssues' }).sort()).toEqual([
        'child-proposal',
        'proposal',
      ])
      expect(f.index.readerIds({ kind: 'headerOccupancy' })).toEqual(['host'])
      expect(f.index.readerIds({ kind: 'headerRecentSession' })).toEqual(['host'])
      expect(f.index.readerIds({ kind: 'sessionReference', ref: 'Q-z-twin' })).toEqual(['z-twin'])
      expect(f.index.issueRepoIds()).toEqual(['query-repo'])
      expect(f.index.sessionCollapsed('a-twin')).toBe(true)
      expect(f.index.sessionOrderKey('z-twin')).toBe('a-twin')
      expect(f.index.readerIds({ kind: 'boardIssues', stage: 'proposed' }).sort()).toEqual([
        'child-proposal',
        'proposal',
      ])
      const cold = f.rows.find((row) => row.id === 'cold-issue-1')!
      const changed = {
        ...cold,
        value: {
          ...(cold.value as object),
          stage: 'proposed',
          archived: false,
          worktreePath: '/query/moved',
          repoId: 'moved-repo',
        },
      } as RowRecord
      f.index.apply({ type: 'update', rows: [changed] })
      f.pool.apply({ type: 'update', rows: [changed] })
      expect(f.index.readerIds({ kind: 'proposedIssues' })).toContain(cold.id)
      expect(f.index.readerIds({ kind: 'containingIssues', cwd: '/query/moved/file' })).toEqual([
        cold.id,
      ])
      expect(f.index.readerIds({ kind: 'containingIssues', cwd: '/query/moved-sibling' })).toEqual(
        [],
      )
      expect(f.index.issueRepoIds()).toEqual(['moved-repo', 'query-repo'])
      f.index.apply({ type: 'replace', rows: [] })
      f.pool.apply({ type: 'replace', rows: [] })
      expect(paneHasSessions(f.pool)).toBe(false)
      expect(f.index.issueRepoIds()).toEqual([])
      expect(f.index.readerIds({ kind: 'boardCatalog' })).toEqual([])
    } finally {
      f.pool.dispose()
    }
  })

  it('keeps declared memberships reactive without re-running catalogs for a heartbeat', () => {
    const f = fixture()
    const reads = vi.fn(() => f.pool.queries.ids({ kind: 'commandIssues' }))
    const stop = autorun(reads)
    try {
      const session = f.rows.find((row) => row.id === 'host')!
      const unchangedMembership = {
        ...session,
        value: { ...(session.value as object), agentState: { phase: 'idle' } },
      } as RowRecord
      f.index.apply({ type: 'update', rows: [unchangedMembership] })
      f.pool.apply({ type: 'update', rows: [unchangedMembership] })
      expect(reads).toHaveBeenCalledTimes(1)
      const removed = { kind: 'issue', id: 'cold-issue-1', value: undefined } as RowRecord
      f.index.apply({ type: 'update', rows: [removed] })
      f.pool.apply({ type: 'update', rows: [removed] })
      expect(reads).toHaveBeenCalledTimes(2)
      expect(reads.mock.results[1]!.value).not.toContain(removed.id)
    } finally {
      stop()
      f.pool.dispose()
    }
  })

  it('queues a missing selected cold summary once through the single batched reader', () => {
    const f = fixture()
    const missing = vi.spyOn(f.pool.residency!, 'summary').mockReturnValue(undefined)
    try {
      expect(f.pool.row('session', 'cold-session-0', 'summary')).toBe(LOADING)
      expect(f.pool.row('session', 'cold-session-0', 'summary')).toBe(LOADING)
      expect(f.load).not.toHaveBeenCalled()
      expect(f.pool.hydrate()).toBeGreaterThan(0)
      expect(f.load.mock.calls.filter(([, id]) => id === 'cold-session-0')).toHaveLength(1)
    } finally {
      missing.mockRestore()
      f.pool.dispose()
    }
  })

  it('counts source history and an independently resident row without enumerating history', () => {
    const index = createColdIndex(SCHEMA)
    index.apply({
      type: 'replace',
      rows: [
        {
          kind: 'session',
          id: 'history',
          value: {
            sessionId: 'history',
            cwd: '/history',
            lastActiveAt: old,
            status: 'exited',
            stoppedAt: old,
          },
        },
      ],
    })
    const pool = new MobxPool({ selectedIssueId: null, coarseNow: now }, undefined, {
      cold: () => index,
      load: () => undefined,
      schedule: () => () => {},
    })
    pool.apply({
      type: 'replace',
      rows: [
        {
          kind: 'session',
          id: 'resident',
          value: { sessionId: 'resident', cwd: '/resident', status: 'live', lastActiveAt: old },
        },
      ],
    })
    const census = vi.spyOn(pool.residency!, 'ids')
    try {
      expect(pool.queries.count('session')).toBe(2)
      expect(census).not.toHaveBeenCalled()
    } finally {
      census.mockRestore()
      pool.dispose()
    }
  })

  it('keeps the most recent cold candidate when a resident timestamp changes ahead of the feed', () => {
    const rows: RowRecord[] = [
      {
        kind: 'session',
        id: 'resident',
        value: {
          sessionId: 'resident',
          cwd: '/resident',
          status: 'live',
          lastActiveAt: '2026-10-03T12:00:00Z',
        },
      },
      {
        kind: 'session',
        id: 'history',
        value: {
          sessionId: 'history',
          cwd: '/history',
          status: 'exited',
          stoppedAt: old,
          lastActiveAt: '2026-10-02T12:00:00Z',
        },
      },
    ]
    const index = createColdIndex(SCHEMA)
    index.apply({ type: 'replace', rows })
    const pool = new MobxPool({ selectedIssueId: null, coarseNow: now }, undefined, {
      cold: () => index,
      load: () => undefined,
      schedule: () => () => {},
    })
    pool.apply({ type: 'replace', rows })
    pool.apply({
      type: 'update',
      rows: [
        {
          kind: 'session',
          id: 'resident',
          value: { sessionId: 'resident', cwd: '/resident', status: 'live', lastActiveAt: old },
        },
      ],
    })
    const census = vi.spyOn(pool.residency!, 'ids')
    try {
      expect(pool.queries.ids({ kind: 'headerRecentSession' })).toEqual(['history', 'resident'])
      expect(census).not.toHaveBeenCalled()
    } finally {
      census.mockRestore()
      pool.dispose()
    }
  })

  it('combines indexed root maxima with current resident activity without a cold scan', () => {
    const f = fixture()
    const question = { kind: 'commandRootActivity', roots: ['/query'] } as const
    const host = {
      ...(f.values.get('session:host') as object),
      issueId: undefined,
      stoppedAt: undefined,
    }
    f.pool.apply({
      type: 'update',
      rows: [{ kind: 'session', id: 'host', value: host } as RowRecord],
    })
    const census = vi.spyOn(f.pool.residency!, 'ids')
    try {
      expect(f.pool.tables.session.has('host')).toBe(true)
      expect(f.pool.queries.activity(question)).toBe(Date.parse('2026-10-02T12:00:00Z'))
      // Resident edits are ahead of the row source. Excluding the stale source
      // copy must reveal the cold runner-up, rather than returning zero.
      f.pool.apply({
        type: 'update',
        rows: [{ kind: 'session', id: 'host', value: { ...host, lastActiveAt: old } } as RowRecord],
      })
      const before = f.index.readerActivityVisits
      expect(f.pool.queries.activity(question)).toBe(Date.parse('2020-01-02T00:00:00Z'))
      expect(f.index.readerActivityVisits - before).toBeLessThanOrEqual(
        f.pool.tables.session.size + 1,
      )
      f.pool.apply({
        type: 'update',
        rows: [
          {
            kind: 'session',
            id: 'host',
            value: { ...host, lastActiveAt: '2027-01-01T00:00:00Z' },
          } as RowRecord,
        ],
      })
      expect(f.pool.queries.activity(question)).toBe(Date.parse('2027-01-01T00:00:00Z'))
      expect(census).not.toHaveBeenCalled()
    } finally {
      census.mockRestore()
      f.pool.dispose()
    }
  })
})
