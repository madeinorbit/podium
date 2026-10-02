// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { autorun, runInAction } from 'mobx'
import { asIssueId } from '@podium/model/browser'
import { storeStats } from '@podium/client-core/perf'
import { createRuntimeWorklistPool } from './runtime-pool'
import { attachCommandLaunchSource } from './command-launch-source'
import { COMMAND_SUMMARIES } from './command-launch-schema'
import { commandLaunchViews } from './command-launch-views'
import { checkCommandLaunch, compareCommandLaunchSnapshots, legacyCommandLaunchSnapshot, poolCommandLaunchSnapshot } from '../diagnostics/command-launch-check'
import { LOADING } from './worklist/rollup'
import { startScenarioEngine, writeHeartbeat, writePhaseChange, writeSelectionClick, writeTitleRename, writeStageMove,
  writeNewIssue, writeArchiveIssue, writeEvictIssue, writeParentReassignment, writeClockTick, writeBurst50,
  writeRescopeGrow, writeRescopeBack, upsert } from '../../worklist-proto/shared/src/scenarios'

afterEach(() => { vi.useRealTimers(); storeStats.enable(false); storeStats.reset() })
async function fixture() {
  const ctx = await startScenarioEngine(1)
  const handle = createRuntimeWorklistPool(ctx.engine, { summaries: COMMAND_SUMMARIES })
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
      const expected = legacyCommandLaunchSnapshot(ctx.engine.getSnapshot()), actual = runInAction(() => poolCommandLaunchSnapshot(handle.pool))
      expect(actual.sections[result.first.sectionIndex], label).toEqual(expected.sections[result.first.sectionIndex])
    }
    expect(result, label).toMatchObject({ differences: 0, pending: 0, first: null })
  }
  return { ctx, ...handle, source, settle, parity, close() { handle.dispose(); ctx.engine.destroy() } }
}

describe('declared command and launch targets', () => {
  it('matches the synthetic corpus through addressed writes, eviction, selection and rescope', async () => {
    const f = await fixture(), stop = autorun(() => poolCommandLaunchSnapshot(f.pool))
    try {
      f.parity()
      const actions = f.ctx.engine.getSnapshot()
      actions.setPaletteOpen(true)
      actions.openFileInWorktree({ root: f.ctx.corpus.repos[0]!.path, path: 'README.md' })
      await Promise.resolve(); f.parity('palette and recent-file locals')
      for (const write of [writeHeartbeat, writePhaseChange, writeSelectionClick, writeTitleRename, writeStageMove,
        writeNewIssue, writeArchiveIssue, writeEvictIssue, writeParentReassignment, writeClockTick, writeBurst50, writeRescopeGrow, writeRescopeBack]) {
        await write(f.ctx); await Promise.resolve(); f.parity(write.name)
      }
    } finally { stop(); f.close() }
  }, 180_000)

  it('browses cold summaries without warming history and batches selected contextual detail', async () => {
    const f = await fixture()
    try {
      const cold = f.pool.residency!.ids('issue', true), resident = f.pool.tables.issue.size
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
      f.settle(); f.parity('selected cold context')
    } finally { f.close() }
  }, 120_000)

  it('keeps resident relation indexes current without rebuilding repo or window rows on session activity', async () => {
    const f = await fixture()
    try {
      const before = { ...f.source.counts }
      const window = f.pool.row('commandWindow', 'window')
      await writeHeartbeat(f.ctx); await Promise.resolve()
      expect(f.source.counts.repoChanges).toBe(before.repoChanges)
      expect(f.source.counts.windowChanges).toBe(before.windowChanges)
      expect(f.source.counts.sessionChanges).toBeGreaterThan(before.sessionChanges)
      expect(f.pool.row('commandWindow', 'window')).toBe(window)
      f.parity('heartbeat relations')
      const id = f.ctx.targets.phaseSessionId, row = f.ctx.cache.read('session', id)!.value as { issueId: string }
      expect(f.pool.resident('session', id)).toBe(true)
      expect(f.pool.sources.related('commandIssue', row.issueId, 'sessions')).toContain(id)
      const nextIssueId = 'command-relation-next'
      upsert(f.ctx, 'session', id, { ...row, issueId: nextIssueId })
      await new Promise(resolve => setTimeout(resolve, f.ctx.settleMs))
      expect(f.pool.sources.related('commandIssue', row.issueId, 'sessions')).not.toContain(id)
      expect(f.pool.sources.related('commandIssue', nextIssueId, 'sessions')).toContain(id)
      f.parity('addressed session relation move')
    } finally { f.close() }
  }, 120_000)

  it('reports planted value, ordering and membership faults even with pending detail', async () => {
    const f = await fixture()
    try {
      f.parity()
      const expected = legacyCommandLaunchSnapshot(f.ctx.engine.getSnapshot()), actual = runInAction(() => poolCommandLaunchSnapshot(f.pool))
      for (const fault of ['value', 'order', 'membership'] as const) {
        const damaged = { ...structuredClone(actual), pending: 1 }
        const section = damaged.sections.find(section => section.key === 'machines')!
        if (fault === 'value') (section.fields as Record<string, unknown>).fault = true
        if (fault === 'order') (section.rows as unknown[]).reverse()
        if (fault === 'membership') (section.rows as unknown[]).pop()
        const result = compareCommandLaunchSnapshots(expected, damaged)
        expect(result.differences, fault).toBeGreaterThan(0)
        expect(result.first?.section, fault).toBe('machines')
      }
    } finally { f.close() }
  }, 120_000)
})
