import {
  IssueActivityHistory,
  buildActivityFeed,
  type ActivityComment,
  type IssueEvent,
} from '@podium/client-core/values'
import { autorun } from 'mobx'
import { expect, it, vi } from 'vitest'
import { insideReader, measureWork } from '../../../tests/worklist/harness/src/work-meter'
import {
  ISSUE_HISTORY_PAGE,
  IssueHistoryView,
  RECENT_ACTIVITY_SIZE,
  issueActivity,
  type IssueActivityMail,
  type IssueActivityPorts,
} from './issue-activity'
import { MobxPool } from './pool'

const stamp = '2026-10-01T00:00:00.000Z'
const event = (id: number, patch: Partial<IssueEvent> = {}): IssueEvent => ({
  id,
  ts: stamp,
  kind: 'issue.created',
  subject: 'root',
  repoPath: '/repo',
  payload: null,
  ...patch,
})
const flush = async () => {
  for (let n = 0; n < 12; n++) await Promise.resolve()
}

it('matches the legacy feed after pages, duplicates, hidden kinds and timestamp ties', () => {
  const history = new IssueActivityHistory(),
    comments = [{ author: 'me', body: 'A comment', createdAt: stamp }]
  const rows = [
    event(1),
    event(2, { kind: 'issue.read' }),
    event(3, { ts: '2026-09-30T00:00:00.000Z' }),
    event(4),
  ]
  history.replaceComments(comments)
  history.appendEvents(rows.slice(0, 2))
  const events = history.events,
    items = history.items
  history.appendEvents([rows[0]!, ...rows.slice(2)])
  expect(history.events).toBe(events)
  expect(history.items).toBe(items)
  expect(history.items).toEqual(buildActivityFeed(comments, rows))
  expect(history.since).toBe(4)
  expect(history.appendEvents([rows[0]!, rows[3]!])).toBe(0)
  history.replaceComments([{ ...comments[0]!, body: 'Replaced' }])
  expect(history.items).toEqual(buildActivityFeed([{ ...comments[0]!, body: 'Replaced' }], rows))
  // A planted wrong order is rejected by the same legacy comparison.
  expect([...history.items].reverse()).not.toEqual(
    buildActivityFeed([{ ...comments[0]!, body: 'Replaced' }], rows),
  )
  history.reset()
  expect(history.since).toBe(0)
  expect(history.items).toEqual([])
  expect(history.appendEvents([rows[0]!])).toBe(1)
})

it('preserves identical comment occurrences and unchanged item identities', () => {
  const history = new IssueActivityHistory()
  const comment = { author: 'me', body: 'same', createdAt: stamp }
  const comments = [comment, { ...comment }, { ...comment, body: 'distinct' }]
  history.replaceComments(comments)
  expect(history.items).toEqual(buildActivityFeed(comments, []))
  const items = [...history.items]
  expect(history.replaceComments(comments.map((row) => ({ ...row })))).toBe(false)
  history.items.forEach((item, index) => expect(item).toBe(items[index]))
  history.replaceComments(comments.slice(1))
  expect(history.items).toEqual(buildActivityFeed(comments.slice(1), []))
  expect(history.items.at(-1)).toBe(items.at(-1))
})

it('appends only the new event rows at 1x/4x and rejects retained-history ID rebuilding', async () => {
  async function capture(scale: 1 | 4, planted = false) {
    const history = new IssueActivityHistory()
    history.appendEvents(Array.from({ length: 128 * scale }, (_, n) => event(n + 1)))
    const next = event(1000, { ts: '2026-10-02T00:00:00.000Z' })
    const measured = await measureWork(async () =>
      insideReader('issue activity append', () => {
        if (planted) new Set(history.events.map((row) => row.id))
        history.appendEvents([next])
      }),
    )
    expect(history.items.at(-1)?.id).toBe('e|1000')
    return measured.work
  }
  const one = await capture(1),
    four = await capture(4)
  for (const counter of ['rows', 'derivations', 'elements'] as const)
    expect(four[counter]).toBe(one[counter])
  const plantedOne = await capture(1, true),
    plantedFour = await capture(4, true)
  expect(plantedFour.elements).toBeGreaterThan(plantedOne.elements)
  console.info(
    'issue activity append work1x4x',
    JSON.stringify({ one, four, retainedHistoryControlRejected: true }),
  )
})

// ---------------------------------------------------------------------------
// The window (POD-5832). A fake server that answers the events read the way
// SQL does: ids above `since` and below `before`, without `excludeKinds`,
// ascending or newest first, at most `limit`.
// ---------------------------------------------------------------------------

const KINDS = ['issue.stage_changed', 'issue.read', 'issue.pinned', 'issue.unread', 'issue.started']
const tsOf = (id: number) => new Date(Date.parse(stamp) + id * 60_000).toISOString()
const logOf = (count: number) =>
  Array.from({ length: count }, (_, n) =>
    event(n + 1, { ts: tsOf(n + 1), kind: KINDS[n % KINDS.length]!, payload: { to: 'review' } }),
  )

function server(log: IssueEvent[]) {
  const calls: Parameters<IssueActivityPorts['events']>[0][] = []
  let comments: ActivityComment[] = []
  let mail: IssueActivityMail[] = []
  const ports: IssueActivityPorts = {
    comments: vi.fn(async () => comments),
    mail: vi.fn(async () => mail),
    events: vi.fn(async (input) => {
      calls.push(input)
      const rows = log.filter(
        (row) =>
          row.id > input.since &&
          (input.before == null || row.id < input.before) &&
          !input.excludeKinds.includes(row.kind),
      )
      if (input.order === 'desc') rows.reverse()
      return rows.slice(0, input.limit)
    }),
  }
  return {
    ports,
    calls,
    log,
    setComments: (next: ActivityComment[]) => {
      comments = next
    },
    setMail: (next: IssueActivityMail[]) => {
      mail = next
    },
  }
}

function poolWith(updatedAt = stamp) {
  const pool = new MobxPool({ selectedIssueId: 'root', coarseNow: Date.parse(stamp) })
  pool.apply({
    type: 'replace',
    rows: [
      {
        kind: 'issue',
        id: 'root',
        value: { id: 'root', title: 'Root', repoPath: '/repo', stage: 'planning', updatedAt },
      },
    ],
  })
  return pool
}
function touch(pool: MobxPool, updatedAt: string) {
  pool.apply({
    type: 'update',
    rows: [
      {
        kind: 'issue',
        id: 'root',
        value: { id: 'root', title: 'Root', repoPath: '/repo', stage: 'planning', updatedAt },
      },
    ],
  })
}
const mailRow = (id: string, patch: Partial<IssueActivityMail> = {}): IssueActivityMail => ({
  id,
  issueId: 'root' as IssueActivityMail['issueId'],
  fromAuthor: 'agent',
  body: `mail ${id}`,
  createdAt: stamp,
  status: 'unread',
  claimedBy: null,
  wasUnread: true,
  ...patch,
})
/** The legacy answers: the feed over EVERY event and comment, as the old drain
 * built it, and the panel's newest five of it. */
const legacyFeed = (log: IssueEvent[], comments: ActivityComment[]) =>
  buildActivityFeed(comments, log)
const legacyRecent = (log: IssueEvent[], comments: ActivityComment[]) =>
  legacyFeed(log, comments).slice(-RECENT_ACTIVITY_SIZE).reverse()

it('opens Recent activity on a long history with one bounded newest-first request', async () => {
  const pool = poolWith(),
    api = server(logOf(1000))
  api.setComments([
    { author: 'me', body: 'early', createdAt: tsOf(3) },
    { author: 'me', body: 'late', createdAt: tsOf(997) },
  ])
  const recent = new IssueHistoryView(
    issueActivity(pool, 'root'),
    api.ports,
    RECENT_ACTIVITY_SIZE,
  )
  const close = recent.open()
  try {
    await flush()
    expect(api.calls).toHaveLength(1)
    expect(api.calls[0]).toMatchObject({
      since: 0,
      order: 'desc',
      limit: ISSUE_HISTORY_PAGE,
      subject: 'root',
      repoPath: '/repo',
    })
    expect(api.calls[0]?.before).toBeUndefined()
    expect(recent.loading).toBe(false)
    expect(recent.hasEarlier).toBe(true)
    const activity = recent.activity
    const shown = activity.history.items.slice(-RECENT_ACTIVITY_SIZE).reverse()
    const legacy = legacyRecent(api.log, [
      { author: 'me', body: 'early', createdAt: tsOf(3) },
      { author: 'me', body: 'late', createdAt: tsOf(997) },
    ])
    expect(shown).toEqual(legacy)
    // The comparison can fail: the old drain's FIRST page (the log's oldest
    // rows) answers a different five.
    expect(legacyRecent(api.log.slice(0, ISSUE_HISTORY_PAGE), [])).not.toEqual(legacy)
    // Bounded: one page, not the whole log.
    expect(activity.history.events.length).toBeLessThanOrEqual(ISSUE_HISTORY_PAGE)
  } finally {
    close()
    pool.dispose()
  }
})

it('pages back on request without gaps or duplicates and matches the legacy feed', async () => {
  const pool = poolWith(),
    api = server(logOf(260))
  const comments = [
    { author: 'me', body: 'first', createdAt: tsOf(1) },
    { author: 'me', body: 'middle', createdAt: tsOf(130) },
  ]
  api.setComments(comments)
  const full = new IssueHistoryView(issueActivity(pool, 'root'), api.ports, ISSUE_HISTORY_PAGE)
  const close = full.open()
  try {
    await flush()
    expect(api.calls).toHaveLength(1)
    // New events land while the view is open; the forward cursor picks them up.
    api.log.push(event(261, { ts: tsOf(261), kind: 'issue.pinned' }))
    touch(pool, '2026-10-02T00:00:00.000Z')
    await flush()
    expect(api.calls[1]).toMatchObject({ since: 260 })
    expect(api.calls[1]?.order).toBeUndefined()
    let floor = full.activity.history.floor
    while (full.hasEarlier) {
      const at = api.calls.length
      await full.loadEarlier()
      expect(api.calls[at]).toMatchObject({ order: 'desc', before: floor })
      floor = full.activity.history.floor
      expect(full.loading).toBe(false)
    }
    const visible = api.log.filter((row) => !['issue.read', 'issue.unread'].includes(row.kind))
    const ids = full.activity.history.events.map((row) => row.id).sort((a, b) => a - b)
    expect(ids).toEqual(visible.map((row) => row.id))
    expect(full.activity.history.items).toEqual(legacyFeed(api.log, comments))
    // Bounded per press: each request was one page.
    expect(api.calls.every((call) => call.limit === ISSUE_HISTORY_PAGE)).toBe(true)
  } finally {
    close()
    pool.dispose()
  }
})

it('keeps legacy timestamp ties in log order across backward pages', async () => {
  const pool = poolWith(),
    api = server(logOf(130).map((row) => ({ ...row, ts: stamp })))
  const comments = [{ author: 'me', body: 'tied comment', createdAt: stamp }]
  api.setComments(comments)
  const view = new IssueHistoryView(issueActivity(pool, 'root'), api.ports, RECENT_ACTIVITY_SIZE)
  const close = view.open()
  try {
    await flush()
    expect(api.calls).toHaveLength(1)
    expect(view.activity.history.items.slice(-RECENT_ACTIVITY_SIZE).reverse()).toEqual(
      legacyRecent(api.log, comments),
    )
    while (view.hasEarlier) await view.loadEarlier()
    expect(view.activity.history.items).toEqual(legacyFeed(api.log, comments))
  } finally {
    close()
    pool.dispose()
  }
})

it('keeps unchanged comments and mail as the same objects on an addressed update', async () => {
  const pool = poolWith(),
    api = server(logOf(8))
  const kept = { author: 'me', body: 'kept', createdAt: tsOf(2) }
  const edited = { author: 'me', body: 'before', createdAt: tsOf(4) }
  api.setComments([kept, edited])
  api.setMail([mailRow('a'), mailRow('b')])
  const view = new IssueHistoryView(issueActivity(pool, 'root'), api.ports, ISSUE_HISTORY_PAGE)
  const close = view.open()
  try {
    await flush()
    const activity = view.activity
    const commentItem = (body: string) =>
      activity.history.items.find((item) => item.kind === 'comment' && item.body === body)
    const keptItem = commentItem('kept'),
      eventItem = activity.history.items.find((item) => item.kind === 'event')
    const [mailA, mailB] = activity.mail
    expect(keptItem).toBeDefined()
    // Same answer again: nothing moves, not even the mail list.
    const list = activity.mail
    touch(pool, '2026-10-02T00:00:00.000Z')
    await flush()
    expect(activity.mail).toBe(list)
    // One comment edited, one mail read.
    api.setComments([kept, { ...edited, body: 'after' }])
    api.setMail([mailRow('a'), mailRow('b', { status: 'read' })])
    touch(pool, '2026-10-03T00:00:00.000Z')
    await flush()
    expect(commentItem('kept')).toBe(keptItem)
    expect(commentItem('before')).toBeUndefined()
    expect(commentItem('after')).toBeDefined()
    expect(activity.history.items.find((item) => item.kind === 'event')).toBe(eventItem)
    expect(activity.mail[0]).toBe(mailA)
    expect(activity.mail[1]).not.toBe(mailB)
    expect(activity.mail[1]?.status).toBe('read')
    expect(activity.history.items).toEqual(
      legacyFeed(api.log, [kept, { ...edited, body: 'after' }]),
    )
  } finally {
    close()
    pool.dispose()
  }
})

it('releases the history when the last view of the issue closes', async () => {
  const pool = poolWith(),
    api = server(logOf(120))
  api.setMail([mailRow('a')])
  const activity = issueActivity(pool, 'root')
  const page = new IssueHistoryView(activity, api.ports, ISSUE_HISTORY_PAGE)
  const panel = new IssueHistoryView(issueActivity(pool, 'root'), api.ports, RECENT_ACTIVITY_SIZE)
  expect(panel.activity).toBe(activity)
  const paint = vi.fn(),
    stopPaint = autorun(() => {
      void activity.revision
      void activity.mail
      paint()
    })
  const closePage = page.open(),
    closePanel = panel.open()
  try {
    await flush()
    // The panel's smaller window rides the page's newest page: one request.
    expect(api.calls).toHaveLength(1)
    expect(activity.history.events.length).toBeGreaterThan(0)
    closePage()
    expect(activity.history.events.length).toBeGreaterThan(0)
    closePanel()
    expect(activity.history.events).toEqual([])
    expect(activity.history.items).toEqual([])
    expect(activity.history.since).toBe(0)
    expect(activity.mail).toEqual([])
    expect(activity.earlier).toBe(false)
    expect(paint).toHaveBeenCalled()
    // A response that lands after the close is dropped.
    const late = new IssueHistoryView(activity, api.ports, ISSUE_HISTORY_PAGE)
    const closeLate = late.open()
    closeLate()
    await flush()
    expect(activity.history.events).toEqual([])
    // Reopening starts from the newest page again.
    const calls = api.calls.length
    const reopen = panel.open()
    await flush()
    expect(api.calls.length).toBe(calls + 1)
    expect(api.calls.at(-1)?.before).toBeUndefined()
    reopen()
  } finally {
    stopPaint()
    pool.dispose()
  }
  expect(activity.history.since).toBe(0)
})

it('reports a failed page on the view and keeps what is loaded', async () => {
  const pool = poolWith(),
    api = server(logOf(120))
  let fail = false
  const ports: IssueActivityPorts = {
    ...api.ports,
    events: async (input) => {
      if (fail) throw new Error('offline')
      return api.ports.events(input)
    },
  }
  const view = new IssueHistoryView(issueActivity(pool, 'root'), ports, ISSUE_HISTORY_PAGE)
  const close = view.open()
  try {
    await flush()
    const loaded = view.activity.history.events.length
    fail = true
    await view.loadEarlier()
    expect(view.error).toBe('offline')
    expect(view.loading).toBe(false)
    expect(view.activity.history.events.length).toBe(loaded)
    fail = false
    await view.loadEarlier()
    expect(view.error).toBeNull()
    expect(view.activity.history.events.length).toBeGreaterThan(loaded)
  } finally {
    close()
    pool.dispose()
  }
})

it('falls back to the ascending drain against a server that ignores the order', async () => {
  const pool = poolWith(),
    api = server(logOf(130))
  const ports: IssueActivityPorts = {
    ...api.ports,
    events: async ({ order: _order, before: _before, ...input }) => api.ports.events(input),
  }
  const view = new IssueHistoryView(issueActivity(pool, 'root'), ports, RECENT_ACTIVITY_SIZE)
  const close = view.open()
  try {
    await flush()
    expect(view.hasEarlier).toBe(false)
    expect(view.activity.history.items.slice(-5).reverse()).toEqual(legacyRecent(api.log, []))
  } finally {
    close()
    pool.dispose()
  }
})

it('publishes a short initial ascending page to mounted Recent readers', async () => {
  const pool = poolWith(),
    api = server(logOf(8))
  const ports: IssueActivityPorts = {
    ...api.ports,
    events: async ({ order: _order, before: _before, ...input }) => api.ports.events(input),
  }
  const view = new IssueHistoryView(issueActivity(pool, 'root'), ports, RECENT_ACTIVITY_SIZE)
  let shown: unknown
  const stop = autorun(() => {
    void view.activity.revision
    shown = view.activity.history.items.slice(-RECENT_ACTIVITY_SIZE).reverse()
  })
  const close = view.open()
  try {
    await vi.waitFor(() => expect(view.loading).toBe(false))
    expect(shown).toEqual(legacyRecent(api.log, []))
  } finally {
    close()
    stop()
    pool.dispose()
  }
})
