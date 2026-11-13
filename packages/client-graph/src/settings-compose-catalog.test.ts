import { expect, it, vi } from 'vitest'
import { insideReader, measureWork } from '../../../tests/worklist/harness/src/work-meter'
import { MobxPool } from './pool'
import { createPoolProjection } from './runtime-pool'
import { SETUP_SESSION_SUMMARY_FIELDS } from './settings-schema'
import { attachSettingsSource, type SettingsOwner } from './settings-source'
import { createSettingsViews } from './settings-views'
import { createColdIndex } from './shared/cold-index'
import { SCHEMA } from './shared/schema'
import type { RowRecord } from './shared/source'

it('keeps compose catalog setup on shared path queries, flat across unrelated history and cached between keystrokes', async () => {
  const recent = '2026-01-01T00:00:00Z'
  async function measured(scale: 1 | 4) {
    const rows: RowRecord[] = Array.from({ length: 128 * scale + 1 }, (_, index) => ({
      kind: 'session',
      id: `s${index}`,
      value: {
        sessionId: `s${index}`,
        agentKind: 'codex',
        cwd: index ? '/foreign' : '/shown/wt/nested',
        lastActiveAt: recent,
        status: 'exited',
        stoppedAt: recent,
      },
    }))
    const cold = createColdIndex(SCHEMA, { session: SETUP_SESSION_SUMMARY_FIELDS })
    cold.apply({ type: 'replace', rows })
    const pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.parse(recent) }, undefined, {
      settings: true,
      cold: () => cold,
      load: () => undefined,
    })
    pool.apply({ type: 'replace', rows })
    const repositories = new Map([
      ['shown', { kind: 'repository', path: '/shown', worktrees: [{ path: '/shown/wt' }] }],
    ])
    attachSettingsSource(pool, {
      listIds: (name: string) => (name === 'repos' ? [...repositories.keys()] : []),
      listRow: (name: string, id: string) => (name === 'repos' ? repositories.get(id) : undefined),
      readLocal: () => 'sessions',
      onList: () => () => {},
      onLocals: () => () => {},
    } as unknown as SettingsOwner)
    const opening = createSettingsViews(pool)
    const projection = createPoolProjection(pool, () => opening.setupCatalog())
    const paint = vi.fn()
    let stop = () => {}
    const sessionKeys = vi.spyOn(pool.tables.session, 'keys')
    const sessionIds = vi.spyOn(pool.queries, 'ids')
    try {
      const first = await measureWork(
        async () => {
          insideReader('compose setup open', () => {
            projection.getSnapshot()
            stop = projection.subscribe(paint)
          })
          await Promise.resolve()
          await Promise.resolve()
          expect(projection.getSnapshot()).toEqual(opening.setup(['/shown', '/shown/wt']))
          expect(projection.getSnapshot().usage.get('/shown/wt')).toBe(Date.parse(recent))
        },
        { pool },
      )
      const repeated = await measureWork(
        async () => insideReader('compose setup keystroke', () => projection.getSnapshot()),
        { pool },
      )
      expect(sessionKeys).not.toHaveBeenCalled()
      expect(sessionIds).not.toHaveBeenCalled()
      return { first: first.work, repeated: repeated.work }
    } finally {
      stop()
      projection.dispose()
      opening.dispose()
      pool.dispose()
    }
  }
  const one = await measured(1),
    four = await measured(4)
  for (const action of ['first', 'repeated'] as const)
    for (const count of ['rows', 'derivations', 'elements', 'visits'] as const)
      expect(four[action][count], `${action}: ${count} stays flat at 4x`).toBe(one[action][count])
})
