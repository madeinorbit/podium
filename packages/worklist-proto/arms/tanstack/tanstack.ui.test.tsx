// @vitest-environment happy-dom
/**
 * POD-4448 — TanStack arm UI bindings: keyed subscriptions (the default)
 * against per-row useLiveQuery(findOne) (the round-one shape). Same commits
 * required; the instance count decides (one live query per mounted row vs
 * zero). Plus the UI click path: setSelection A→B commits exactly the two
 * selected flags with zero derivations.
 */

import { act } from 'react'
import { createElement, memo, useMemo } from 'react'
import { describe, expect, it } from 'vitest'
import { createLiveQueryCollection, eq } from '@tanstack/db'
import { useLiveQuery } from '@tanstack/react-db'
import { RowShell, createCommitLog, withCommitLog } from '../../shared/src/row-shell'
import { GC_TIME_MS } from './collections'
import type { RowsRow } from './queries'
import { testWorld, workedExample, row, issue, NOW } from './tanstack.test'
import { useTanStackKey } from './react/list'

const iso = (ms: number): string => new Date(ms).toISOString()

describe('tanstack arm: UI click path', () => {
  it('setSelection A→B commits exactly two rows, zero derivations', async () => {
    const world = testWorld(workedExample())
    const log = createCommitLog()
    const { createRoot } = await import('react-dom/client')
    const { CommitLogContext } = await import('../../shared/src/row-shell')
    const { TanStackList } = await import('./react/list')
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    await withCommitLog(log, async () => {
      await act(async () => {
        root.render(
          createElement(CommitLogContext.Provider, {
            value: log,
            children: createElement(TanStackList, { store: world.store }),
          }),
        )
      })
    })
    log.reset()
    world.store.stats.reset()
    await withCommitLog(log, async () => {
      await act(async () => {
        world.store.setSelection('A')
      })
    })
    log.reset()
    world.store.stats.reset()
    await withCommitLog(log, async () => {
      await act(async () => {
        world.store.setSelection('B')
      })
    })
    // A→B: exactly the two selected flags commit; no data re-derives.
    expect(log.total()).toBe(2)
    expect(world.store.stats.rowsDerived).toBe(0)
    expect(world.store.stats.rollupsDerived).toBe(0)
    act(() => {
      root.unmount()
    })
    container.remove()
    world.store.dispose()
  })
})

describe('tanstack arm: bindings (keyed vs findOne)', () => {
  it('per-row findOne commits identically to keyed subscriptions', async () => {
    const world = testWorld(workedExample())
    const store = world.store
    const ids = Object.keys(store.snapshot().rowsById).sort()

    const KeyedRow = memo(function KeyedRow({ id }: { id: string }) {
      const found = useTanStackKey<RowsRow | null>(
        store,
        // rowsQ rows are not in the commit layer; read the committed row.
        id,
      )
      void found
      const rowValue = useTanStackKey<{ title: string } | null>(store, id)
      return createElement(
        RowShell,
        { id, children: `keyed:${id}:${rowValue?.title ?? 'gone'}` },
      )
    })

    const FindOneRow = memo(function FindOneRow({ id }: { id: string }) {
      const query = useMemo(
        () =>
          createLiveQueryCollection({
            gcTime: GC_TIME_MS,
            query: (q) =>
              q
                .from({ r: store.top.rowsQ })
                .where(({ r }) => eq(r.id, id))
                .select(({ r }) => ({ id: r.id, title: r.title })),
          }),
        [id],
      )
      const { data } = useLiveQuery(query)
      const current = Array.isArray(data) ? data[0] : data
      return createElement(
        RowShell,
        { id, children: `findone:${id}:${(current as { title?: string } | undefined)?.title ?? 'gone'}` },
      )
    })

    const { createRoot } = await import('react-dom/client')
    const { CommitLogContext } = await import('../../shared/src/row-shell')
    const logKeyed = createCommitLog()
    const c1 = document.createElement('div')
    document.body.appendChild(c1)
    const r1 = createRoot(c1)
    await withCommitLog(logKeyed, async () => {
      await act(async () => {
        r1.render(
          createElement(CommitLogContext.Provider, {
            value: logKeyed,
            children: createElement('div', {
              children: ids.map((id) => createElement(KeyedRow, { key: id, id })),
            }),
          }),
        )
      })
    })
    logKeyed.reset()
    const t0 = performance.now()
    await withCommitLog(logKeyed, async () => {
      await act(async () => {
        const a = store.entities.issues.collection.get('A') as Parameters<typeof issue>[0]
        world.push({
          type: 'update',
          rows: [row('issue', 'A', issue({ ...a, id: 'A', title: 'Alpha2' }))],
        })
      })
    })
    const keyedMs = performance.now() - t0
    const keyedCommits = logKeyed.total()

    const logOne = createCommitLog()
    const c2 = document.createElement('div')
    document.body.appendChild(c2)
    const r2 = createRoot(c2)
    const { CommitLogContext: Ctx2 } = await import('../../shared/src/row-shell')
    await withCommitLog(logOne, async () => {
      await act(async () => {
        r2.render(
          createElement(Ctx2.Provider, {
            value: logOne,
            children: createElement('div', {
              children: ids.map((id) => createElement(FindOneRow, { key: id, id })),
            }),
          }),
        )
      })
    })
    logOne.reset()
    const t1 = performance.now()
    await withCommitLog(logOne, async () => {
      await act(async () => {
        const a = store.entities.issues.collection.get('A') as Parameters<typeof issue>[0]
        world.push({
          type: 'update',
          rows: [row('issue', 'A', issue({ ...a, id: 'A', title: `Alpha${iso(NOW)}` }))],
        })
      })
    })
    const oneMs = performance.now() - t1
    const oneCommits = logOne.total()
    console.info(
      `[tanstack-ui] keyed commits=${keyedCommits} ms=${keyedMs.toFixed(2)} | ` +
        `findOne commits=${oneCommits} ms=${oneMs.toFixed(2)} rows=${ids.length}`,
    )
    // Identical commits: A only. findOne costs a live query instance per
    // mounted row; keyed costs none — keyed stays the default.
    expect(oneCommits).toBe(keyedCommits)
    expect(keyedCommits).toBe(1)
    act(() => {
      r1.unmount()
      r2.unmount()
    })
    c1.remove()
    c2.remove()
    world.store.dispose()
  })
})
