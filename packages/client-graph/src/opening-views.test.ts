import { autorun } from 'mobx'
import { expect, it } from 'vitest'
import { createIssuePageViews } from './issue-page'
import { createSettingsViews } from './settings-views'
import { createAutomationViews } from './automation-views'
import {
  beforeIssuePages,
  beforeSettingsView,
  beforeAutomationViews,
} from './opening-views.before.test.fixture'
import { MobxPool } from './pool'
import type { RowRecord } from './shared/source'
import { LOADING } from './loading'

const stamp = '2026-10-01T00:00:00Z'
function fixture() {
  const pool = new MobxPool({ coarseNow: Date.parse(stamp) })
  pool.apply({
    type: 'replace',
    rows: Array.from(
      { length: 50 },
      (_, n) =>
        ({
          kind: 'issue',
          id: `issue-${n}`,
          value: {
            id: `issue-${n}`,
            seq: n + 1,
            title: `Task ${n}`,
            repoPath: '/repo',
            stage: 'planning',
            description: '',
            createdAt: stamp,
            updatedAt: stamp,
            labels: [],
            deps: [],
            archived: false,
            deletedAt: null,
          },
        }) as RowRecord,
    ),
  })
  pool.sources.register(
    ['automationCatalog', 'automation', 'settingsCatalog', 'settingsRepository'],
    {
      read(kind, id) {
        if (kind === 'automationCatalog') return { automations: ['scheduled'] }
        if (kind === 'settingsCatalog') return { machines: [], repositories: [] }
        if (kind === 'automation') return { id, name: 'Scheduled', enabled: true } as never
        return undefined
      },
      dispose() {},
    },
  )
  return pool
}

it('keeps the old and opening-owned answers identical on the same fixtures', () => {
  const pool = fixture()
  const oldIssue = beforeIssuePages(pool),
    nextIssue = createIssuePageViews(pool)
  const oldSettings = beforeSettingsView(pool),
    nextSettings = createSettingsViews(pool)
  const oldAutomations = beforeAutomationViews(pool),
    nextAutomations = createAutomationViews(pool)
  try {
    const read = (view: ReturnType<typeof createIssuePageViews>, n: number) => ({
      id: view.issue(`issue-${n}`) instanceof Object ? view.row(`issue-${n}`).issue.id : undefined,
      title: view.row(`issue-${n}`).title,
      children: view.row(`issue-${n}`).children,
      members: view.row(`issue-${n}`).activeSessions,
      close: view.closeFacts(`issue-${n}`),
    })
    for (let n = 0; n < 50; n++) {
      const next = read(nextIssue, n)
      // Deliberate wrong-answer control, run separately and required to fail.
      if (process.env.PODIUM_OPENING_WRONG === '1') next.title = 'wrong opening'
      expect(next).toEqual(read(oldIssue, n))
      expect(next.title).toBe(`Task ${n}`)
    }
    expect(nextSettings.setup()).toEqual(oldSettings.setup())
    expect(nextSettings.sessions()).toEqual(oldSettings.sessions())
    expect(nextSettings.sessionCount()).toEqual(oldSettings.sessionCount())
    expect(nextAutomations.list()).toEqual(oldAutomations.list())
    expect(nextAutomations.repositories()).toEqual(oldAutomations.repositories())
    expect(nextAutomations.targets(null)).toEqual(oldAutomations.targets(null))
    expect(nextIssue.issue('missing')).toEqual(oldIssue.issue('missing'))
  } finally {
    nextIssue.dispose()
    nextSettings.clear()
    nextAutomations.dispose()
    pool.dispose()
  }
})

it('collects opening models and companions after fifty closes while their pool stays alive', async () => {
  const pool = fixture()
  const refs: { kind: string; ref: WeakRef<object> }[] = []
  function opening(n: number) {
    const issue = createIssuePageViews(pool),
      settings = createSettingsViews(pool),
      automation = createAutomationViews(pool)
    const row = issue.row(`issue-${n}`)
    const stop = autorun(() => {
      void row.children
      void row.activeSessions
      issue.issues()
      issue.explorer()
      settings.setup()
      automation.list()
    })
    for (const [kind, value] of [
      ['issue', issue],
      ['companion', row],
      ['settings', settings],
      ['automation', automation],
    ] as const)
      refs.push({ kind, ref: new WeakRef(value) })
    stop()
    issue.dispose()
    settings.dispose()
    automation.dispose()
  }
  for (let n = 0; n < 50; n++) opening(n)
  const gc = (globalThis as unknown as { Bun: { gc(force: boolean): void } }).Bun.gc
  for (let turn = 0; turn < 3; turn++) {
    await new Promise((resolve) => setTimeout(resolve, 0))
    gc(true)
  }
  const reachable = refs.filter(({ ref }) => ref.deref() !== undefined).map(({ kind }) => kind)
  console.info(
    'opening reachability',
    JSON.stringify({ openings: 50, models: 150, companions: 50, reachable }),
  )
  expect(reachable).toEqual([])
  expect(pool.issueObject('issue-49').authoredTitle).toBe('Task 49')
  for (const key of ['issue-page', 'settings.views', 'automations'])
    expect(pool.sources.peekView(key)).toBeUndefined()
  pool.dispose()
})

it('drops companions even if a late handler still holds the closed view', async () => {
  const pool = fixture(), view = createIssuePageViews(pool)
  function showAndClose() {
    const row = view.row('issue-0')
    const stop = autorun(() => { void row.children; void row.activeSessions })
    stop()
    const ref = new WeakRef(row)
    view.dispose()
    return ref
  }
  const ref = showAndClose()
  for (let turn = 0; turn < 3; turn++) {
    await new Promise((resolve) => setTimeout(resolve, 0))
    ;(globalThis as unknown as { Bun: { gc(force: boolean): void } }).Bun.gc(true)
  }
  expect(ref.deref()).toBeUndefined()
  expect(view.issue('issue-0')).toBe(LOADING)
  expect(pool.issueObject('issue-0').authoredTitle).toBe('Task 0')
  pool.dispose()
})
