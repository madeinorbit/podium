import { requireHere } from '@podium/client-graph/lookup'
// @vitest-environment happy-dom
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { SessionView } from '@podium/client-core/session-values'
import { compareStructural } from 'mobx'
import { describe, expect, it } from 'vitest'
import { IssueModel, SessionModel, WorktreeModel } from '@podium/client-graph/models'
import { worklistView } from '@podium/client-graph/worklist/view-model'
import { sidebarView } from '@podium/client-graph/worklist/sidebar'
import { mobileWorkView } from '@podium/client-graph/worklist/mobile'
import { LOADING } from '@podium/client-graph/worklist/rollup'
import { headerModel } from '@podium/client-graph/header-companion'
import { headerWorkingSession, headerHostSession, headerDockSession } from '@podium/client-graph/header-session'
import { plainRowView } from '../../shared/src/row-snapshots'
import { harnessMobxPoolArm, tracked, snapshotPool } from './adapters/mobx-pool'
import { startScenarioEngine } from '../../shared/src/scenarios'
import { referenceState } from '../../diagnostics/reference-state'
import { openFenceFeeds, engineLocals } from './fence-scenarios'
import { projectRowViews, projectSnapshot, legacyDerivationFromStore, visibleIssueRows } from './oracle'
import { legacySidebarRow, sidebarComparable } from './oracle/sidebar'
import { poolScreenCellsAt } from './pool-screen-work'
import { screenWorkKey, screenWorkVerdicts } from './screen-work-ratios'
import baseline from './worklist-census-before.json'

const evidence = resolve(import.meta.dirname, '../../../../.evidence/worklist-view-model')
function save(name: string, value: unknown) {
  mkdirSync(evidence, { recursive: true })
  writeFileSync(resolve(evidence, name), JSON.stringify(value, null, 2) + '\n')
}

describe('worklist view model migration', () => {
  it('keeps fixture answers and one companion identity on desktop and phone', async () => {
    // Use the same normalized feed as the existing sidebar oracle. A replay
    // of only issue/session/worktree rows omits canonical repository joins.
    const ctx = await startScenarioEngine(1)
    const feeds = openFenceFeeds(ctx, 'pooled')
    const locals = engineLocals(ctx)
    const legacy = legacyDerivationFromStore(referenceState(ctx.engine), locals.coarseNow)
    const expected = projectRowViews(legacy, locals)
    const handle = harnessMobxPoolArm.create(feeds.rows.source, feeds.locals.source)
    const view = worklistView(handle.pool)
    let issues = 0, sessions = 0
    try {
      for (let window = 0; window < 64; window++) {
        snapshotPool(handle.pool)
        tracked(() => { for (const id of Object.keys(expected)) {
          const row = view.knownRow(id)
          void row?.ready
        } })
        if (handle.pool.hydrate() === 0) break
      }
      expect(snapshotPool(handle.pool)).toEqual(projectSnapshot(legacy, locals))
      tracked(() => {
        expect(view).toBe(worklistView(handle.pool))
        expect(view.desktop).toBe(sidebarView(handle.pool))
        expect(view).toBe(mobileWorkView(handle.pool))
        expect(view.selectedId).toBe(locals.selectedIssueId)
        for (const [id, answer] of Object.entries(expected)) {
          const issue = requireHere(handle.pool.model('issue', id))!, row = view.row(issue)
          expect(plainRowView(row), `row ${id}`).toEqual(answer)
          expect(() => expect({ ...plainRowView(row), title: 'wrong title' }).toEqual(answer)).toThrow()
          expect(view.row(issue)).toBe(row)
          expect(row.issue).toBe(issue)
          expect(sidebarView(handle.pool).row(id)).toBe(row.ready === 'ready' ? row : row.ready)
          expect(mobileWorkView(handle.pool).mobileRow({ kind: 'issue', id })).toBe(row.ready === 'ready' ? row : row.ready)
          expect(row.ready).not.toBe(LOADING)
          issues++
        }
        for (const legacyRow of visibleIssueRows(legacy, locals)) {
          const row = sidebarView(handle.pool).row(legacyRow.issue.id)
          expect(row).not.toBe(LOADING)
          if (row && row !== LOADING) {
            expect(sidebarComparable(row), legacyRow.issue.id).toEqual(legacySidebarRow(legacyRow, legacy, locals.coarseNow))
          }
        }
        for (const id of handle.pool.tables.session.keys()) {
          const session = handle.pool.sessionObject(id), row = headerModel(handle.pool).session(session)
          const raw = session.row as SessionView
          expect(compareStructural(row.headerWorking, headerWorkingSession(raw, handle.pool.inputs.passed)), `${id}.working`).toBe(true)
          expect(compareStructural(row.headerHost, headerHostSession(raw)), `${id}.host`).toBe(true)
          expect(compareStructural(row.headerDock, headerDockSession(raw)), `${id}.dock`).toBe(true)
          expect(row.session).toBe(session)
          expect(view.session(session).session).toBe(session)
          sessions++
        }
      })
      expect(issues).toBeGreaterThan(100)
      expect(sessions).toBeGreaterThan(100)
      save('fixture-after.json', { issues, sessions, equal: true })
    } finally { handle.dispose(); feeds.dispose(); ctx.engine.destroy() }
  })

  it('keeps worklist and header rules off the shared record prototypes', () => {
    for (const field of ['nestParent', 'nestBelow', 'nested', 'flat', 'keeps', 'present', 'placed',
      'rank', 'band', 'foldAt', 'selected', 'retainedSeatIds', 'rosterIds', 'openOwn',
      'ownAttention', 'aggregate', 'unitOwn', 'unitsBelow', 'tip', 'rollup', 'rowRollup']) {
      expect(field in IssueModel.prototype, `IssueModel.${field}`).toBe(false)
    }
    for (const field of ['headerWorking', 'headerHost', 'headerDock', 'retention', 'verdict']) {
      expect(field in SessionModel.prototype, `SessionModel.${field}`).toBe(false)
    }
    expect('roster' in WorktreeModel.prototype).toBe(false)
    // Entity text normalization is shared; no worklist/header schema override returns.
    expect([...IssueModel.answers]).toEqual(['description', 'notes'])
  })

  it('keeps the sidebar, phone Work and header census flat or better at 1x and 4x', async () => {
    const readers = new Set(['sidebar.row', 'mobile-work.sections', 'mobile-work.search', 'mobile-work.row',
      'header.folded', 'header.shipping', 'header.fleet'])
    const at1x = await poolScreenCellsAt(1, undefined, readers)
    const at4x = await poolScreenCellsAt(4, undefined, readers)
    const verdicts = screenWorkVerdicts(at1x.cells, at4x.cells)
    // Preserve each existing reader's measured bound; no new reader gets a
    // growth allowance.
    const before = new Map(baseline.growing.map(value => [screenWorkKey(value), value]))
    const growing = verdicts.filter(value => !value.passed)
    save('census-after.json', { at1x, at4x, verdicts, growing })
    expect(at1x.readers.map(reader => reader.name).sort()).toEqual([...readers].sort())
    expect(at4x.corpus.issues).toBeGreaterThan(at1x.corpus.issues * 3)
    for (const value of growing) {
      const old = before.get(screenWorkKey(value))
      expect(old, `new scaling regression ${screenWorkKey(value)}: ${value.at1x} → ${value.at4x}`).toBeDefined()
      expect(value.at4x * old!.at1x, screenWorkKey(value)).toBeLessThanOrEqual(old!.at4x * value.at1x)
    }
    expect(growing.length).toBeLessThanOrEqual(baseline.growing.length)
    console.info('[worklist census]', JSON.stringify({ readers: at1x.readers.length,
      counters: verdicts.length, growingBefore: baseline.growing.length, growingAfter: growing.length }))
  }, 300_000)
})
