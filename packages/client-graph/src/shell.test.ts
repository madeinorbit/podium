import { autorun } from 'mobx'
import { asSessionId } from '@podium/model/browser'
import { describe, expect, it, vi } from 'vitest'
import { checkShell, compareShellSnapshots, legacyShellSnapshot, poolShellSnapshot } from '../diagnostics/shell-check'
import { shellFixture } from '../diagnostics/shell-fixture'
import { shellViews } from './shell-views'
import { SHELL_ENTITIES, SHELL_SOURCE_KEY } from './shell-schema'
import { ShellSource } from './shell-source'
import { LOADING } from './worklist/rollup'

function settled(f: ReturnType<typeof shellFixture>, issues = f.issues) {
  let report = checkShell(f.pool, f.state(), issues)
  for (let batch = 0; report.pending && batch < 8; batch++) { f.pool.hydrate(); report = checkShell(f.pool, f.state(), issues) }
  return report
}
describe('shell pool', () => {
  it('matches window, approval, file, close, chrome, dock, shipping, machine and link inputs', () => {
    const f = shellFixture()
    try { expect(settled(f)).toMatchObject({ differences: 0, pending: 0, first: null }); expect(settled(f).positions).toBeGreaterThan(90) }
    finally { f.pool.dispose() }
  })
  it('preserves approval queue order and prompt/palette/super-open changes without session derivation', () => {
    const f = shellFixture()
    try {
      settled(f)
      f.change({ approvals: [...f.approvals].reverse(), autoContinuePromptSessionId: null, paletteOpen: false, superOpen: false })
      expect(shellViews(f.pool).approvals()).toEqual([...f.approvals].reverse())
      expect(shellViews(f.pool).window()).toMatchObject({ autoContinuePromptSessionId: null, paletteOpen: false, superOpen: false })
      expect(settled(f).differences).toBe(0)
      expect(f.source.counts.laneCollections).toBe(1)
    } finally { f.pool.dispose() }
  })
  it('uses file scope and focused workspace after selection, including utility views and absent layouts', () => {
    const f = shellFixture()
    try {
      settled(f); f.change({ paneA: asSessionId(f.fileTabs[0]!.id), view: 'settings' })
      const value = shellViews(f.pool).dock()
      expect(value && value !== LOADING ? value.active : null).toMatchObject({ cwd: f.fileTabs[0]!.worktreePath, issueId: f.issues[1]!.id, machineId: 'shell-machine' })
      expect(settled(f).differences).toBe(0)
      f.change({ selectedIssueId: null, selectedWorktree: '/synthetic/empty' })
      expect(shellViews(f.pool).close()).toMatchObject({ workspaceKey: 'wt:/synthetic/empty', layout: undefined })
      expect(settled(f)).toMatchObject({ differences: 0, pending: 0, first: null })
    } finally { f.pool.dispose() }
  })
  it('resolves recency ties, nested paths, explicit attachments and discovery-lag repository fallback', () => {
    const f = shellFixture()
    try {
      settled(f); f.change({ paneA: null })
      const tied = shellViews(f.pool).dock()
      expect(tied && tied !== LOADING ? tied.active?.sessionId : null).toBe(f.sessions[0]!.sessionId)
      f.change({ repos: [] })
      expect(settled(f).differences).toBe(0)
      const lag = shellViews(f.pool).dock()
      expect(lag && lag !== LOADING ? lag.scope : null).toEqual({ repoId: 'shell-repo', repoPath: '/synthetic/project' })
      f.change({ paneA: asSessionId(f.fileTabs[0]!.id) })
      expect(settled(f).differences).toBe(0)
    } finally { f.pool.dispose() }
  })
  it('reuses the landed mission reader across root, child, archived and empty draft selection', () => {
    const f = shellFixture()
    try {
      for (const selectedIssueId of [f.issues[0]!.id, f.issues[1]!.id, f.issues[25]!.id, null]) {
        f.change({ selectedIssueId }); expect(settled(f)).toMatchObject({ differences: 0, pending: 0 })
      }
      const draft = { ...f.issues[2]!, isDraftVessel: true, worktreePath: null }
      const issues = f.issues.map(issue => issue.id === draft.id ? draft : issue)
      f.pool.apply({ type: 'update', rows: [{ kind: 'issue', id: draft.id, value: draft }] as never })
      const archived = { ...f.sessions[2]!, archived: true }
      f.pool.apply({ type: 'update', rows: [{ kind: 'session', id: archived.sessionId, value: archived }] as never })
      f.change({ selectedIssueId: draft.id, sessions: f.sessions.map(session => session.sessionId === archived.sessionId ? archived : session) })
      expect(f.pool.row('issue', draft.id)).toMatchObject({ isDraftVessel: true, worktreePath: null })
      expect(f.pool.row('session', f.sessions[2]!.sessionId, 'summary')).toMatchObject({ archived: true })
      expect(shellViews(f.pool).chrome()).toHaveProperty('missionRoot', undefined)
      expect(settled(f, issues)).toMatchObject({ differences: 0, pending: 0, first: null })
    } finally { f.pool.dispose() }
  })
  it('reads authoritative lane trains, maintains resident relations, and handles deletion without collection rescans', () => {
    const f = shellFixture()
    try {
      settled(f)
      const id = f.shipLanes[0]!.id
      expect(f.pool.sources.related('shellShipLane', 'shell-repo', 'shipLanes')).toEqual([id])
      f.lane({ ...f.shipLanes[0]!, trains: [], blockedOrderIds: [f.shipOrders[0]!.id] })
      expect(settled(f).differences).toBe(0)
      expect(f.source.counts).toMatchObject({ laneCollections: 1, laneRows: 1 })
      f.lane(undefined)
      expect(f.pool.sources.related('shellShipLane', 'shell-repo', 'shipLanes')).toEqual([])
      expect(settled(f).differences).toBe(0)
    } finally { f.pool.dispose() }
  })
  it('keeps cold manifests out of summaries and batches repeated artifact demand through the one reader', () => {
    const f = shellFixture()
    try {
      const id = f.issues[30]!.id
      expect(f.pool.tables.issue.has(id)).toBe(false)
      expect(f.pool.row('issue', id, 'summary')).not.toHaveProperty('panel')
      expect(shellViews(f.pool).issue(id, true)).toBe(LOADING)
      expect(shellViews(f.pool).issue(id, true)).toBe(LOADING)
      expect(f.loads).toEqual([])
      expect(f.pool.hydrate()).toBe(1)
      expect(f.loads).toEqual([`issue:${id}`])
      expect(shellViews(f.pool).issue(id, true)).toHaveProperty('panel.artifacts.0.artifactId', 'synthetic-artifact')
    } finally { f.pool.dispose() }
  })
  it('never borrows derived session/issue/shipping arrays while updating local controls', () => {
    const f = shellFixture()
    try {
      const state = f.state()
      for (const key of ['sessions', 'issueProjections', 'shipOrders', 'shipLanes']) Object.defineProperty(state, key, { get() { throw new Error('legacy collection read') } })
      // The replica remains the authoritative lane read seam.
      f.source.dispose()
      const runtime = { getSnapshot: () => state, subscribe: () => () => {}, replica: { rows: () => f.shipLanes, row: () => undefined, subscribeAddressedBatch: () => () => {} } }
      const source = new ShellSource(runtime as never)
      expect(source.read('shellWindow', 'window')).toMatchObject({ paletteOpen: true })
      source.dispose()
    } finally { f.pool.dispose() }
  })
  it('isolates unchanged chrome, shipping and approval observers and disposes every source subscription', () => {
    const f = shellFixture()
    settled(f)
    const read = vi.fn(() => shellViews(f.pool).approvals()), stop = autorun(read)
    const chrome = vi.fn(() => shellViews(f.pool).chrome()), stopChrome = autorun(chrome)
    const shipping = vi.fn(() => shellViews(f.pool).shipping()), stopShipping = autorun(shipping)
    try {
      const previous = chrome.mock.results[0]!.value
      const previousShipping = shipping.mock.results[0]!.value
      expect(previous).not.toBe(LOADING)
      f.change({ paneA: f.sessions[1]!.sessionId, coarseNow: f.state().coarseNow + 1000, selectedWorktree: '/synthetic/other' })
      expect(chrome).toHaveBeenCalledTimes(1); expect(shellViews(f.pool).chrome()).toBe(previous)
      expect(shipping).toHaveBeenCalledTimes(1); expect(shellViews(f.pool).shipping()).toBe(previousShipping)
      f.change({ paletteOpen: false }); expect(read).toHaveBeenCalledTimes(1)
      expect(chrome).toHaveBeenCalledTimes(2)
      f.change({ approvals: f.approvals.slice(1) }); expect(read).toHaveBeenCalledTimes(2)
      f.pool.dispose(); expect(f.listeners.size).toBe(0); expect(f.addressed.size).toBe(0)
      expect(f.source.read('shellWindow', 'window')).toBe(LOADING)
    } finally { stop(); stopChrome(); stopShipping(); f.pool.dispose() }
  })
  it('rejects a planted fault in each ordered comparison section without leaking values', () => {
    const f = shellFixture()
    try {
      expect(settled(f).differences).toBe(0)
      const expected = legacyShellSnapshot(f.state(), f.issues), actual = poolShellSnapshot(f.pool)
      actual.sections.forEach((_section, index) => {
        const changed = { ...actual, sections: actual.sections.map((section, position) => position === index ? { ...section, fields: { ...section.fields, planted: 'private-content-must-not-leak' } } : section) }
        const result = compareShellSnapshots(expected, changed)
        expect(result.differences).toBe(1); expect(result.first?.sectionIndex).toBe(index)
        expect(JSON.stringify(result)).not.toContain('private-content-must-not-leak')
      })
      const changed = { ...actual, sections: actual.sections.map(section => section.key === 'approvals' ? { ...section, rows: [...section.rows].reverse() } : section) }
      expect(compareShellSnapshots(expected, changed).differences).toBe(2)
    } finally { f.pool.dispose() }
  })
  it('shares source ownership across attachments', () => {
    const f = shellFixture()
    try {
      // This source's fixed entity set is already registered by the fixture.
      expect(() => f.pool.sources.ensure(SHELL_SOURCE_KEY, SHELL_ENTITIES, () => new ShellSource({} as never))).toThrow('conflicts')
    } finally { f.pool.dispose() }
  })
})
