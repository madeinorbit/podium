import { withKeyedInputs } from '@podium/client-core/test-support/keyed-inputs'
// @vitest-environment happy-dom

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
import { MISSION_VIEW_SUMMARIES } from './mission-view-schema'
import { MOBILE_INBOX_SUMMARIES } from './mobile-inbox-schema'
import { MobileInboxSource } from './mobile-inbox-source'
import { createMobileInboxViews } from './mobile-inbox-views'
import { createMobileSessionReader } from './mobile-session-context'
import { MobxPool } from './pool'
import { paneHasSessions } from './session-pane'
import { type ColdIndex, createColdIndex, type HeldSummaries } from './shared/cold-index'
import { createReaderIndex, questionEntity, type ReaderQuestion } from './shared/reader-questions'
import { SCHEMA } from './shared/schema'
import type { RowRecord } from './shared/source'
import { SHELL_SUMMARIES } from './shell-schema'
import { shellViews } from './shell-views'
import { mergePoolSummaries } from './source-registry'
import { LOADING } from './worklist/rollup'

const now = Date.parse('2026-10-03T12:00:00Z'),
  old = '2020-01-01T00:00:00Z'

it('addresses ancestor scope independently of presentation, resident overlays and source replacement', () => {
  const issue = (patch: object = {}): RowRecord =>
    ({
      kind: 'issue',
      id: 'scope-parent',
      value: {
        id: 'scope-parent',
        title: 'Parent',
        stage: 'in_progress',
        audience: 'human',
        createdAt: old,
        updatedAt: old,
        repoPath: '/scope',
        seq: 1,
        priority: 2,
        labels: [],
        deps: [],
        description: '',
        ...patch,
      },
    }) as RowRecord
  let source = createColdIndex(SCHEMA)
  source.apply({ type: 'replace', rows: [issue()] })
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: now }, undefined, {
    cold: () => source,
    load: () => undefined,
    schedule: () => () => {},
  })
  pool.apply({ type: 'replace', rows: [issue()] })
  const seen: unknown[] = []
  const stop = autorun(() => {
    seen.push(pool.queries.issueScope('scope-parent'))
  })
  const publish = (record: RowRecord) => {
    const event = { type: 'update' as const, rows: [record] }
    source.apply(event)
    pool.apply(event)
  }
  try {
    expect(seen).toEqual([{ draft: false, deleted: false, archived: false, agent: false }])
    publish(issue({ title: 'Renamed' }))
    expect(seen).toHaveLength(1)
    // A local table overlay wins even while the source is already ahead.
    source.apply({ type: 'update', rows: [issue({ audience: 'agent' })] })
    runInAction(() =>
      pool.tables.issue.set('scope-parent', issue({ isDraftVessel: true }).value as never),
    )
    expect(seen.at(-1)).toEqual({ draft: true, deleted: false, archived: false, agent: false })
    runInAction(() => pool.tables.issue.delete('scope-parent'))
    expect(seen.at(-1)).toEqual({ draft: false, deleted: false, archived: false, agent: true })
    publish(issue({ archived: true, deletedAt: old }))
    expect(seen.at(-1)).toEqual({ draft: false, deleted: true, archived: true, agent: false })
    publish({ kind: 'issue', id: 'scope-parent', value: undefined })
    expect(seen.at(-1)).toBeUndefined()
    // A new source may reuse every numeric revision from the previous one.
    source = createColdIndex(SCHEMA)
    source.apply({ type: 'replace', rows: [issue({ audience: 'agent', isDraftVessel: true })] })
    pool.apply({ type: 'replace', rows: [] })
    expect(seen.at(-1)).toEqual({ draft: true, deleted: false, archived: false, agent: true })
  } finally {
    stop()
    pool.dispose()
  }
})

it('keeps spawn placement in its declared source subset across reassignment, readmission and rescope', () => {
  const issue = (id: string, patch: object = {}): RowRecord =>
    ({
      kind: 'issue',
      id,
      value: {
        id,
        title: id,
        seq: 1,
        stage: 'planning',
        createdAt: old,
        updatedAt: old,
        repoId: 'wanted',
        repoPath: '/wanted',
        archived: false,
        deletedAt: null,
        ...patch,
      },
    }) as RowRecord
  const archived = issue('archived-repo', { archived: true, repoPath: '/other' })
  const unassigned = issue('unassigned-path', { repoId: null })
  const deleted = issue('deleted-repo', { deletedAt: old })
  const rows = [
    archived,
    unassigned,
    deleted,
    issue('foreign-repo', { repoId: 'other' }),
    issue('unassigned-other-path', { repoId: null, repoPath: '/other' }),
  ]
  const source = createColdIndex(SCHEMA)
  source.apply({ type: 'replace', rows })
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: now }, undefined, {
    cold: () => source,
    load: () => undefined,
    schedule: () => () => {},
  })
  pool.apply({ type: 'replace', rows: [...rows, issue('resident-only')] })
  const query = { kind: 'spawnIssues', repoId: 'wanted', repoPath: '/wanted' } as const
  let seen: string[] = []
  const stop = autorun(() => {
    seen = pool.queries.ids(query).sort()
  })
  const publish = (event: Parameters<ColdIndex['apply']>[0]) => {
    source.apply(event)
    pool.apply(event)
  }
  try {
    expect(pool.queries.indexed(query).sort()).toEqual(['archived-repo', 'unassigned-path'])
    expect(seen).toEqual(['archived-repo', 'unassigned-path'])
    publish({ type: 'update', rows: [issue('unassigned-path', { repoId: 'other' })] })
    expect(seen).toEqual(['archived-repo'])
    publish({ type: 'update', rows: [issue('deleted-repo')] })
    expect(seen).toEqual(['archived-repo', 'deleted-repo'])
    publish({ type: 'update', rows: [{ kind: 'issue', id: 'deleted-repo', value: undefined }] })
    expect(seen).toEqual(['archived-repo'])
    publish({ type: 'update', rows: [issue('deleted-repo')] })
    expect(seen).toEqual(['archived-repo', 'deleted-repo'])
    publish({ type: 'replace', rows: [archived] })
    expect(seen).toEqual(['archived-repo'])
  } finally {
    stop()
    pool.dispose()
  }
})

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
  const sessionSequences = new Map<string, number>()
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
        refRepoId: 'query-repo',
        refSeq: id === 'z-twin' ? 1 : sessionSequences.get(id) ?? (sessionSequences.set(id, sessionSequences.size + 2), sessionSequences.size + 1),
        refLetter: 'A',
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
      prefix: 'QUERY',
    },
  })
  if (bootOnly) rows = rows.filter((row) => row.kind !== 'session' && !row.id.includes('proposal'))
  const values = new Map(rows.map((row) => [`${row.kind}:${row.id}`, row.value]))
  // The feed's cold index, as `RowSource.cold(summaries)` builds it: holding
  // the declared summary fields the pool names (POD-5407).
  let built: ColdIndex | undefined
  const cold = (held: HeldSummaries): ColdIndex => {
    if (built === undefined || !built.holds(held)) {
      built = createColdIndex(SCHEMA, held)
      built.apply({ type: 'replace', rows })
    }
    return built
  }
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
    cold,
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
  pool.sources.register(['mobileInboxState'], mobile)
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
      read: () => ({ cursor: null }),
      dispose() {},
    })
  attachCommandLaunchSource(
    pool,
    withKeyedInputs({
      getSnapshot: () => ({ repos: [], machines: [] }),
      subscribe: () => () => {},
    }) as never,
  )
  return { pool, index: cold({}), load, rows, values }
}

it('rebuilds observed identities once on replacement without probing every cold member first', () => {
  const f = fixture(4, true)
  let seen: string[] = [],
    publications = 0
  const stop = autorun(() => {
    seen = f.pool.queries.ids({ kind: 'commandIssues' }).sort()
    publications++
  })
  const contains = vi.spyOn(f.index, 'readerContains')
  try {
    expect(seen).toHaveLength(512)
    f.pool.apply({ type: 'replace', rows: f.rows })
    expect(seen).toHaveLength(512)
    expect(publications).toBe(2)
    expect(contains.mock.calls.length).toBeLessThan(16)
    contains.mockClear()
    const rows = f.rows.filter((row) => row.id !== 'cold-issue-0')
    f.index.apply({ type: 'replace', rows })
    f.pool.apply({ type: 'replace', rows })
    expect(seen).toHaveLength(511)
    expect(seen).not.toContain('cold-issue-0')
    expect(publications).toBe(3)
    expect(contains.mock.calls.length).toBeLessThan(16)
  } finally {
    contains.mockRestore()
    stop()
    f.pool.dispose()
  }
})

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
          session: view.session('QUERY-1-A'),
        }
      } finally {
        view.dispose()
      }
    },
  },
  { name: 'phone prefix', read: (pool) => pool.queries.hasIssuePrefix('QUERY', true) },
  {
    name: 'settings',
    read: (pool) => ({
      setup: pool.settingsViews.setup(['/query']),
      count: pool.settingsViews.sessionCount(),
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
  it('keeps publication path reads constant while indexing target text', () => {
    for (const title of ['Target', `Target ${'alphabet '.repeat(32)}`]) {
      const index = createReaderIndex()
      let pathReads = 0
      const value = new Proxy(
        {
          id: 'target',
          seq: 42,
          title,
          repoId: 'repo',
          repoPath: '/query',
          stage: 'backlog',
          archived: false,
        },
        {
          get(row, key, receiver) {
            if (key === 'repoPath') pathReads++
            return Reflect.get(row, key, receiver)
          },
        },
      )
      index.apply({ type: 'replace', rows: [{ kind: 'issue', id: 'target', value } as never] })
      // Assert the real declared query before its input-work budget: a plant
      // that rereads the path for every gram must fail despite identical IDs.
      expect(
        index.ids({
          kind: 'mobileIssueTargets',
          repoPath: '/query',
          excludeId: '',
          query: 'target',
          limit: 14,
          prefixes: { repo: 'Q-' },
        }),
      ).toEqual(['target'])
      expect(pathReads).toBe(1)
    }
  })
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
        const addressed =
          reader.name === 'phone prefix'
            ? vi.spyOn(pool.queries, 'hasIssuePrefix').mockReturnValue(false)
            : reader.name === 'settings'
              ? vi.spyOn(pool.queries, 'setupSessionCount').mockReturnValue(0)
              : reader.name === 'automation sessions'
                ? vi.spyOn(pool.queries, 'setupSessionPresent').mockReturnValue(false)
                : undefined
        const damaged = snapshot(
          reader.name,
          runInAction(() => reader.read(pool)),
        )
        expect(compareSidebarSnapshots(expected, damaged).differences).toBeGreaterThan(0)
        membership.mockRestore()
        repos.mockRestore()
        count.mockRestore()
        addressed?.mockRestore()
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
        const originalRepos = pool.queries.repoIds.bind(pool.queries)
        vi.spyOn(pool.queries, 'repoIds').mockImplementation((path) => {
          pool.residency!.ids('issue')
          return originalRepos(path)
        })
        if (reader.name === 'phone prefix') {
          const originalPrefix = pool.queries.hasIssuePrefix.bind(pool.queries)
          vi.spyOn(pool.queries, 'hasIssuePrefix').mockImplementation((...args) => {
            pool.residency!.ids('issue')
            return originalPrefix(...args)
          })
        } else if (reader.name === 'settings') {
          const originalSetupCount = pool.queries.setupSessionCount.bind(pool.queries)
          vi.spyOn(pool.queries, 'setupSessionCount').mockImplementation(() => {
            pool.residency!.ids('session')
            return originalSetupCount()
          })
        } else if (reader.name === 'automation sessions') {
          const originalPresent = pool.queries.setupSessionPresent.bind(pool.queries)
          vi.spyOn(pool.queries, 'setupSessionPresent').mockImplementation((id) => {
            pool.residency!.ids('session')
            return originalPresent(id)
          })
        }
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
      expect(f.index.readerIds({ kind: 'sessionReference', ref: 'QUERY-1-A' })).toEqual(['z-twin'])
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
    let observedCount = 0
    const stop = autorun(() => {
      observedCount = pool.queries.count('session')
    })
    try {
      expect(pool.queries.count('session')).toBe(2)
      expect(census).not.toHaveBeenCalled()
      const adopted = {
        kind: 'session',
        id: 'resident',
        value: { sessionId: 'resident', cwd: '/resident', status: 'live', lastActiveAt: old },
      } as RowRecord
      runInAction(() => {
        index.apply({ type: 'update', rows: [adopted] })
        pool.apply({ type: 'update', rows: [adopted] })
      })
      expect(observedCount).toBe(2)
      runInAction(() => {
        pool.tables.session.set('local', { ...adopted.value, sessionId: 'local' })
      })
      expect(observedCount).toBe(3)
      runInAction(() => pool.tables.session.delete('local'))
      expect(observedCount).toBe(2)
      runInAction(() => {
        index.apply({ type: 'replace', rows: [] })
        pool.apply({ type: 'replace', rows: [] })
      })
      expect(observedCount).toBe(0)
    } finally {
      stop()
      census.mockRestore()
      pool.dispose()
    }
  })

  it.each([1, 4])('reads maintained counts without resident enumeration at %ix', (scale) => {
    const f = fixture(scale)
    const keys = vi.spyOn(f.pool.tables.session, 'keys')
    const known = vi.spyOn(f.index, 'known')
    try {
      for (let click = 0; click < 8; click++)
        expect(f.pool.queries.count('session')).toBe(
          f.rows.filter((row) => row.kind === 'session').length,
        )
      expect(keys).not.toHaveBeenCalled()
      expect(known).not.toHaveBeenCalled()
    } finally {
      keys.mockRestore()
      known.mockRestore()
      f.pool.dispose()
    }
  })

  it('maintains identity membership by changed key without rebuilding the declared answer', () => {
    const f = fixture()
    const query = { kind: 'proposedIssues' } as const
    const ids = vi.spyOn(f.index, 'readerIds')
    const stop = autorun(() => f.pool.queries.ids(query))
    try {
      ids.mockClear()
      const record = f.rows.find((row) => row.id === 'cold-issue-1')!
      const event = {
        type: 'update' as const,
        rows: [
          {
            ...record,
            value: {
              ...(record.value as object),
              stage: 'proposed',
              archived: false,
            },
          } as RowRecord,
        ],
      }
      f.index.apply(event)
      f.pool.apply(event)
      expect(f.pool.queries.ids(query)).toContain(record.id)
      expect(ids).not.toHaveBeenCalled()
    } finally {
      stop()
      ids.mockRestore()
      f.pool.dispose()
    }
  })

  it('answers per-key membership exactly like each declared question', () => {
    const f = fixture()
    const questions: ReaderQuestion[] = [
      { kind: 'residentIssues' },
      { kind: 'commandIssues' },
      { kind: 'commandSessions' },
      { kind: 'proposedIssues' },
      { kind: 'reclaimIssues' },
      { kind: 'inboxSessions' },
      { kind: 'headerSessions' },
      { kind: 'headerOccupancy' },
      { kind: 'boardCounts' },
      { kind: 'sessionReference', ref: 'QUERY-1-A' },
      { kind: 'commandIssueSessions', issueId: 'cold-issue-0', archived: false },
      { kind: 'containingIssues', cwd: '/query/hot/file' },
      { kind: 'boardIssues', priority: 2, stage: 'proposed', projectPaths: ['/query'] },
      { kind: 'boardIssues', status: 'closed', archived: true, deleted: true },
      { kind: 'boardIssues', explorerTab: 'cancelled' },
      { kind: 'boardIssues', explorerTab: 'needs' },
      { kind: 'boardIssues', explorerTab: 'proposed', searching: true },
    ]
    try {
      for (const question of questions) {
        const expected = new Set(f.index.readerIds(question))
        for (const row of f.rows.filter((row) => row.kind === questionEntity(question)))
          expect(f.index.readerContains(question, row.id), JSON.stringify([question, row.id])).toBe(
            expected.has(row.id),
          )
        expect(f.index.readerContains(question, 'missing')).toBe(false)
      }
    } finally {
      f.pool.dispose()
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
      expect(pool.queries.ids({ kind: 'headerRecentSession' })).toEqual(['history'])
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

  it('answers repository activity without enumerating or rereading resident sessions', () => {
    const f = fixture()
    f.pool.apply({
      type: 'update',
      rows: Array.from({ length: 256 }, (_, n) => ({
        kind: 'session',
        id: `activity-${n}`,
        value: {
          sessionId: `activity-${n}`,
          cwd: `/activity-${n}/worktree`,
          status: 'live',
          lastActiveAt: '2027-01-01T00:00:00Z',
        },
      })) as RowRecord[],
    })
    const reads = vi.spyOn(f.pool, 'row')
    const residents = vi.spyOn(f.pool.tables.session, 'keys')
    try {
      for (let n = 0; n < 500; n++)
        expect(
          f.pool.queries.activity({ kind: 'commandRootActivity', roots: [`/activity-${n}`] }),
        ).toBe(n < 256 ? Date.parse('2027-01-01T00:00:00Z') : 0)
      expect(reads).not.toHaveBeenCalled()
      expect(residents).not.toHaveBeenCalled()
    } finally {
      reads.mockRestore()
      residents.mockRestore()
      f.pool.dispose()
    }
  })

  it('tracks activity by root across resident moves, exclusions, eviction and replacement', () => {
    const f = fixture()
    const question = { kind: 'commandRootActivity', roots: ['/query'] } as const
    const values: number[] = []
    const stop = autorun(() => values.push(f.pool.queries.activity(question)))
    const update = (id: string, cwd: string, at: string) =>
      f.pool.apply({
        type: 'update',
        rows: [
          {
            kind: 'session',
            id,
            value: { sessionId: id, cwd, status: 'live', lastActiveAt: at },
          } as RowRecord,
        ],
      })
    try {
      const before = values.length
      update('elsewhere', '/elsewhere', '2028-01-01T00:00:00Z')
      expect(values).toHaveLength(before)
      update('moving', '/query/worktree', '2027-01-01T00:00:00Z')
      expect(values.at(-1)).toBe(Date.parse('2027-01-01T00:00:00Z'))
      expect(f.pool.queries.activity({ ...question, excluded: ['moving'] })).toBe(values[0])
      expect(f.pool.queries.activity({ ...question, match: 'exact' })).toBe(0)
      update('moving', '/elsewhere', '2029-01-01T00:00:00Z')
      expect(values.at(-1)).toBe(values[0])
      update('moving', '/query', '2030-01-01T00:00:00Z')
      expect(f.pool.queries.activity({ ...question, match: 'exact' })).toBe(
        Date.parse('2030-01-01T00:00:00Z'),
      )
      f.pool.apply({ type: 'update', rows: [{ kind: 'session', id: 'moving', value: undefined }] })
      expect(values.at(-1)).toBe(values[0])
      f.pool.apply({ type: 'replace', rows: f.rows })
      expect(values.at(-1)).toBe(values[0])
    } finally {
      stop()
      f.pool.dispose()
    }
  })
})
