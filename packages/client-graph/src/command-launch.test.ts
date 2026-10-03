// @vitest-environment happy-dom

import { storeStats } from '@podium/client-core/perf'
import { repoUsageAt } from '@podium/client-core/viewmodels'
import { sessionUserStateRowId } from '@podium/model'
import { asIssueId, asSessionId, asUserId } from '@podium/model/browser'
import { autorun, runInAction } from 'mobx'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  startScenarioEngine,
  upsert,
  writeArchiveIssue,
  writeBurst50,
  writeClockTick,
  writeEvictIssue,
  writeHeartbeat,
  writeNewIssue,
  writeParentReassignment,
  writePhaseChange,
  writeRescopeBack,
  writeRescopeGrow,
  writeSelectionClick,
  writeStageMove,
  writeTitleRename,
} from '../../worklist-proto/shared/src/scenarios'
import {
  checkCommandLaunch,
  compareCommandLaunchSnapshots,
  legacyCommandLaunchSnapshot,
  poolCommandLaunchSnapshot,
} from '../diagnostics/command-launch-check'
import { COMMAND_SUMMARIES } from './command-launch-schema'
import { attachCommandLaunchSource } from './command-launch-source'
import { commandLaunchViews, createCommandLaunchViews } from './command-launch-views'
import { createRuntimeWorklistPool } from './runtime-pool'
import { LOADING } from './worklist/rollup'

afterEach(() => {
  vi.useRealTimers()
  storeStats.enable(false)
  storeStats.reset()
})
async function fixture() {
  const ctx = await startScenarioEngine(1)
  const handle = createRuntimeWorklistPool(ctx.engine, { summaries: COMMAND_SUMMARIES })
  // Isolate menu demand from the existing pool's bootstrap requests.
  for (let turn = 0; turn < 32 && handle.pool.hydrate(); turn++) {
    /* baseline boot */
  }
  const source = attachCommandLaunchSource(handle.pool, ctx.engine)
  function settle() {
    for (let turn = 0; turn < 32; turn++) {
      runInAction(() => poolCommandLaunchSnapshot(handle.pool))
      if (!handle.pool.hydrate()) return
    }
    throw new Error('Selected command detail failed to settle')
  }
  function parity(label = 'initial') {
    settle()
    const result = runInAction(() => checkCommandLaunch(handle.pool, ctx.engine.getSnapshot()))
    if (result.first) {
      const expected = legacyCommandLaunchSnapshot(ctx.engine.getSnapshot()),
        actual = runInAction(() => poolCommandLaunchSnapshot(handle.pool))
      expect(actual.sections[result.first.sectionIndex], label).toEqual(
        expected.sections[result.first.sectionIndex],
      )
    }
    expect(result, label).toMatchObject({ differences: 0, pending: 0, first: null })
  }
  return {
    ctx,
    ...handle,
    source,
    settle,
    parity,
    close() {
      handle.dispose()
      ctx.engine.destroy()
    },
  }
}

describe('declared command and launch targets', () => {
  it('matches the synthetic corpus through addressed writes, eviction, selection and rescope', async () => {
    const f = await fixture(),
      stop = autorun(() => poolCommandLaunchSnapshot(f.pool))
    try {
      f.parity()
      const actions = f.ctx.engine.getSnapshot()
      actions.setPaletteOpen(true)
      actions.openFileInWorktree({ root: f.ctx.corpus.repos[0]!.path, path: 'README.md' })
      await Promise.resolve()
      f.parity('palette and recent-file locals')
      for (const write of [
        writeHeartbeat,
        writePhaseChange,
        writeSelectionClick,
        writeTitleRename,
        writeStageMove,
        writeNewIssue,
        writeArchiveIssue,
        writeEvictIssue,
        writeParentReassignment,
        writeClockTick,
        writeBurst50,
        writeRescopeGrow,
        writeRescopeBack,
      ]) {
        await write(f.ctx)
        await Promise.resolve()
        f.parity(write.name)
      }
    } finally {
      stop()
      f.close()
    }
  }, 180_000)

  it('browses cold summaries without warming history and batches selected contextual detail', async () => {
    const f = await fixture()
    try {
      const cold = f.pool.residency!.ids('issue', true),
        resident = f.pool.tables.issue.size
      expect(cold.length).toBeGreaterThan(0)
      const browsing = runInAction(() => commandLaunchViews(f.pool).palette())
      expect(browsing).not.toBe(LOADING)
      expect(f.pool.hydrate()).toBe(0)
      expect(f.pool.tables.issue.size).toBe(resident)
      expect(f.pool.sources.related('commandIssue', cold[0]!, 'sessions')).toEqual([])
      f.ctx.engine.getSnapshot().setSelectedIssueId(asIssueId(cold[0]!))
      await Promise.resolve()
      const selected = runInAction(() => commandLaunchViews(f.pool).palette())
      expect(selected && selected !== LOADING ? selected.pending : 0).toBeGreaterThan(0)
      expect(f.pool.hydrate()).toBeGreaterThan(0)
      f.settle()
      f.parity('selected cold context')
    } finally {
      f.close()
    }
  }, 120_000)

  it('keeps resident relation indexes current without rebuilding repo or window rows on session activity', async () => {
    const f = await fixture()
    try {
      const before = { ...f.source.counts }
      const window = f.pool.row('commandWindow', 'window')
      await writePhaseChange(f.ctx)
      await Promise.resolve()
      expect(f.source.counts.repoChanges).toBe(before.repoChanges)
      expect(f.source.counts.windowChanges).toBe(before.windowChanges)
      expect(f.source.counts.sessionChanges).toBeGreaterThan(before.sessionChanges)
      expect(f.pool.row('commandWindow', 'window')).toBe(window)
      f.parity('heartbeat relations')
      const id = f.ctx.targets.phaseSessionId,
        row = f.ctx.cache.read('session', id)!.value as { issueId: string }
      expect(f.pool.resident('session', id)).toBe('resident')
      expect(f.pool.sources.related('commandIssue', row.issueId, 'sessions')).toContain(id)
      const nextIssueId = 'command-relation-next'
      upsert(f.ctx, 'session', id, { ...row, issueId: nextIssueId })
      await new Promise((resolve) => setTimeout(resolve, f.ctx.settleMs))
      expect(f.pool.sources.related('commandIssue', row.issueId, 'sessions')).not.toContain(id)
      expect(f.pool.sources.related('commandIssue', nextIssueId, 'sessions')).toContain(id)
      f.parity('addressed session relation move')
    } finally {
      f.close()
    }
  }, 120_000)

  it('keeps parked resume winners in their groups first slot without warming cold twins', async () => {
    const f = await fixture()
    try {
      const template = f.ctx.cache.read('session', f.ctx.targets.phaseSessionId)!.value as object
      for (const [id, status, active, resume] of [
        [
          'command-a-parked',
          'exited',
          '2026-01-01T00:00:00.000Z',
          { kind: 'codex-thread', value: 'command-order-group' },
        ],
        ['command-middle', 'live', '2026-01-01T00:00:00.000Z', undefined],
        [
          'command-z-parked',
          'hibernated',
          '2026-01-02T00:00:00.000Z',
          { kind: 'codex-thread', value: 'command-order-group' },
        ],
      ] as const)
        upsert(f.ctx, 'session', id, {
          ...template,
          sessionId: asSessionId(id),
          status,
          lastActiveAt: active,
          resume,
        })
      await new Promise((resolve) => setTimeout(resolve, f.ctx.settleMs))
      const catalog = f.pool.row('commandCatalog', 'catalog')
      expect(
        catalog && catalog !== LOADING
          ? catalog.sessions.filter((id) => id.startsWith('command-'))
          : [],
      ).toEqual(['command-z-parked', 'command-middle'])
      expect(f.pool.hydrate()).toBe(0)
      f.parity('parked resume first-slot order')
    } finally {
      f.close()
    }
  }, 120_000)

  it('reports planted value, ordering and membership faults even with pending detail', async () => {
    const f = await fixture()
    try {
      f.parity()
      const expected = legacyCommandLaunchSnapshot(f.ctx.engine.getSnapshot()),
        actual = runInAction(() => poolCommandLaunchSnapshot(f.pool))
      for (const fault of ['value', 'order', 'membership'] as const) {
        const damaged = { ...structuredClone(actual), pending: 1 }
        const section = damaged.sections.find((section) => section.key === 'issues')!
        expect(section.rows.length).toBeGreaterThan(1)
        if (fault === 'value') (section.fields as Record<string, unknown>).fault = true
        if (fault === 'order') (section.rows as unknown[]).reverse()
        if (fault === 'membership') (section.rows as unknown[]).pop()
        const result = compareCommandLaunchSnapshots(expected, damaged)
        expect(result.differences, fault).toBeGreaterThan(0)
        expect(result.first?.section, fault).toBe('issues')
      }
    } finally {
      f.close()
    }
  }, 120_000)

  it('keeps global catalogs and field readers stable on mission, small issue and session clicks', async () => {
    const f = await fixture(),
      views = commandLaunchViews(f.pool)
    const fieldRuns = { open: 0, files: 0, sessions: 0 }
    const stops = [
      autorun(() => {
        views.launch()
        views.palette()
      }),
      autorun(() => {
        views.window('paletteOpen')
        fieldRuns.open++
      }),
      autorun(() => {
        views.window('recentFiles')
        fieldRuns.files++
      }),
      autorun(() => {
        views.sessions()
        fieldRuns.sessions++
      }),
    ]
    const census = vi.spyOn(f.pool.residency!, 'ids')
    try {
      f.parity()
      expect(views.counts.coldSessionVisits).toBeGreaterThan(0)
      const globals = () => {
        const { addressedSessionReads: _addressed, ...counts } = views.counts
        return counts
      }
      const before = globals(),
        beforeFields = { ...fieldRuns }
      for (const id of [f.ctx.targets.visibleRootId, f.ctx.targets.stageMoveId]) {
        await writeSelectionClick(f.ctx, id)
        f.parity(`click ${id}`)
        expect(globals()).toEqual(before)
        expect(fieldRuns).toEqual(beforeFields)
      }
      f.ctx.engine.getSnapshot().setPane('A', asSessionId(f.ctx.targets.phaseSessionId))
      await Promise.resolve()
      f.parity('session click')
      expect(globals()).toEqual(before)
      expect(fieldRuns).toEqual(beforeFields)
      expect(census).not.toHaveBeenCalled()
      // The real deck click marks the session read as well as opening its pane.
      // Both the optimistic publication and covering truth change one session
      // value, without repeating catalog or repository-usage work.
      const id = asSessionId(f.ctx.targets.phaseSessionId)
      const addressed = views.counts.addressedSessionReads
      await f.ctx.engine.getSnapshot().markSessionRead(id)
      await new Promise((resolve) => setTimeout(resolve, f.ctx.settleMs))
      f.parity('session mark-read')
      expect(globals()).toEqual(before)
      expect(views.counts.addressedSessionReads).toBeGreaterThan(addressed)
      const marked = f.ctx.engine
        .getSnapshot()
        .sessions.find((session) => session.sessionId === id)!
      expect(typeof marked.readAt).toBe('string')
      const homeId = sessionUserStateRowId(asUserId('u-bench'), id)
      const home = f.ctx.cache.read('sessionUserState', homeId)!.value as object
      const readAt = new Date(Date.parse(marked.readAt!) + 1).toISOString()
      upsert(f.ctx, 'sessionUserState', homeId, { ...home, readAt })
      await new Promise((resolve) => setTimeout(resolve, f.ctx.settleMs))
      f.parity('session read echo')
      expect(globals()).toEqual(before)
      const sessions = views.sessions()
      expect(
        sessions && sessions !== LOADING
          ? sessions.find((session) => session.sessionId === id)?.readAt
          : undefined,
      ).toBe(readAt)
      expect(fieldRuns.open).toBe(beforeFields.open)
      expect(fieldRuns.files).toBe(beforeFields.files)
      expect(fieldRuns.sessions).toBeGreaterThan(beforeFields.sessions)
      await writeClockTick(f.ctx, 1000)
      f.parity('clock without activity')
      expect(globals()).toEqual(before)
      expect(census).not.toHaveBeenCalled()
      // A relevant activity publication arms usage work, without cold scans.
      await writeHeartbeat(f.ctx)
      f.parity('activity publication')
      expect(views.counts.usageQueries).toBeGreaterThan(before.usageQueries)
      expect(views.counts.coldSessionVisits).toBe(before.coldSessionVisits)
    } finally {
      census.mockRestore()
      for (const stop of stops) stop()
      f.close()
    }
  }, 120_000)

  it('matches independent repository activity and rejects a faulty indexed maximum', async () => {
    const f = await fixture()
    try {
      f.parity()
      const state = f.ctx.engine.getSnapshot(),
        views = createCommandLaunchViews(f.pool),
        data = views.launch()
      expect(data && data !== LOADING).toBeTruthy()
      if (!data || data === LOADING) throw new Error('Launcher did not settle')
      const expected = Object.fromEntries(
        state.repos.map((repo) => [
          JSON.stringify([repo.machineId ?? '', repo.path]),
          repoUsageAt(repo, state.sessions),
        ]),
      )
      expect(data.usage).toEqual(expected)
      expect(Object.values(expected).some((at) => at > 0)).toBe(true)
      const fault = vi.spyOn(f.pool.queries, 'activity').mockReturnValue(0)
      try {
        const broken = createCommandLaunchViews(f.pool).launch()
        expect(broken && broken !== LOADING ? broken.usage : undefined).not.toEqual(expected)
      } finally {
        fault.mockRestore()
      }
    } finally {
      f.close()
    }
  }, 120_000)
})
