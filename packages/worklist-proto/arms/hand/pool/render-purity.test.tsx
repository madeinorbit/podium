// @vitest-environment happy-dom
/**
 * POD-4707 send-back (coordinator ruling) — `HandPool.view()` is React's
 * getSnapshot (`useSyncExternalStore(subscribe, () => pool.view(id))` in
 * `pool/react/list.tsx` and `pool/native/list.tsx`) and must stay a pure
 * read. Filing a subtree there flushes the graph, settles the filings and
 * the worklist in the middle of a React render; and when a view runs while
 * a flush is draining, `cells.ts` `flush()` returns early through the
 * draining guard and the view can come back unfiled.
 *
 * The test renders the H3 seed-1 hidden parents (i1093/i1182/i1691/i2141,
 * plus i4615) as subscribed row slots on the seed-1 snapshot, with
 * `console.error` trapped to throw and a counter on the pool's listener
 * calls across the render. A pure read notifies nothing and files nothing:
 * filings and member cells are unchanged by the render (only the rows'
 * own view cells are created, lazily, as designed). Against the read-path
 * version (f0cc6d268) the first render files five formal subtrees, so the
 * filings/members assertions fail there.
 *
 * POD-5033 (cold rule): i2141 is archived, so the shared rule keeps it cold
 * (hidden, no view). It still draws through the same pure path (missing,
 * correctly cold) and still files nothing. Resident hidden parents draw
 * their composed progress.
 */

import { act, type ReactElement, useCallback, useSyncExternalStore } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it } from 'vitest'
import { createEngineLocals } from '../../../harness/src/engine-locals'
import { startGenRun } from '../../../shared/src/gen/run'
import { harnessHandPoolArm, type HarnessHandPoolHandle } from '../../../harness/src/adapters/hand-pool'
import type { HandPool } from './pool'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const ROWS = ['i1093', 'i1182', 'i1691', 'i2141', 'i4615'] as const

function HiddenRow({ pool, id }: { pool: HandPool; id: string }): ReactElement {
  const subscribe = useCallback((listener: () => void) => pool.subscribe(id, listener), [pool, id])
  const view = useSyncExternalStore(subscribe, () => pool.view(id))
  return (
    <div data-hidden-row={id}>
      {view === undefined ? 'missing' : `${view.progressDone}/${view.progressTotal}`}
    </div>
  )
}

function HiddenRows({ pool }: { pool: HandPool }): ReactElement {
  return (
    <div data-hidden-rows>
      {ROWS.map((id) => (
        <HiddenRow key={id} pool={pool} id={id} />
      ))}
    </div>
  )
}

describe('first render of hidden rows notifies and files nothing', () => {
  it('seed-1 snapshot: no listener call, no filing, no console.error while rendering', async () => {
    const run = await startGenRun({ feedMode: 'pooled' })
    const feed = run.feed()
    const locals = createEngineLocals(run.ctx.engine)
    locals.flush()
    const handle = harnessHandPoolArm.create(feed.source, locals.source) as HarnessHandPoolHandle
    const { pool } = handle
    const el = document.createElement('div')
    document.body.appendChild(el)
    const root = createRoot(el)
    const errors: string[] = []
    const originalError = console.error
    console.error = (...args: unknown[]) => {
      errors.push(args.map((arg) => String(arg)).join(' '))
    }
    try {
      const filingsBefore = pool.rollup.held()
      const membersBefore = pool.worklist.held('member')
      const listenerCallsBefore = pool.stats.counters.listenerCalls
      await act(async () => {
        root.render(<HiddenRows pool={pool} />)
      })
      expect(errors, `console.error during render: ${errors.join(' | ')}`).toEqual([])
      expect(
        pool.stats.counters.listenerCalls - listenerCallsBefore,
        'listener calls made while rendering',
      ).toBe(0)
      // A pure getSnapshot files nothing: the change path (bootstrap formal
      // closure) already filed these subtrees. The read-path version files
      // five formal subtrees here and fails both lines below.
      expect(pool.rollup.held() - filingsBefore, 'filings created while rendering').toBe(0)
      expect(
        pool.worklist.held('member') - membersBefore,
        'member cells created while rendering',
      ).toBe(0)
      // The rows draw through the pure path: resident hidden parents draw
      // their composed progress; correctly cold i2141 (archived, hidden, no
      // view) draws missing. Both file nothing (checked above).
      for (const id of ROWS) {
        const text = el.querySelector(`[data-hidden-row="${id}"]`)?.textContent
        if (id === 'i2141') {
          expect(text, `${id} correctly cold draws missing`).toBe('missing')
        } else {
          expect(text, `${id} draws composed progress`).toMatch(/^\d+\/\d+$/)
        }
      }
    } finally {
      console.error = originalError
      act(() => root.unmount())
      el.remove()
      handle.dispose()
      locals.dispose()
      run.dispose()
    }
  }, 300_000)
})
