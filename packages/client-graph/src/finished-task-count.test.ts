import { autorun } from 'mobx'
import { afterEach, expect, it, vi } from 'vitest'
import { LOADING } from './loading'
import { MobxPool } from './pool'
import type { CollectionLoaderPort } from './shared/source'

const stops: (() => void)[] = []
afterEach(() => {
  for (const stop of stops.splice(0).reverse()) stop()
})

function fixture(initial: Record<string, unknown>[] = [], complete = true) {
  const pool = new MobxPool({ selectedIssueId: null })
  stops.push(() => pool.dispose())
  let rows = initial.map((stub, i) => ({ id: String(i), stub }))
  let notify: (change: 'markers' | 'stubs') => void = () => {}
  const request = vi.fn()
  const port: CollectionLoaderPort = {
    online: true,
    firstDownload: false,
    request,
    show: () => () => {},
    status: () => (complete ? 'complete' : 'loading'),
    isComplete: () => (complete ? {} : undefined),
    wasRefused: () => false,
    stubRows: () => rows,
    stubOf: (_kind, id) => rows.find((row) => row.id === id)?.stub,
    stubsByParent: () => [],
    subscribe: (listener) => {
      notify = listener
      return () => {}
    },
  }
  pool.collections.attach(() => port)
  return {
    pool,
    request,
    async publish(next: Record<string, unknown>[], ready = true) {
      rows = next.map((stub, i) => ({ id: String(i), stub }))
      complete = ready
      notify('stubs')
      notify('markers')
      await Promise.resolve()
    },
  }
}

const done = (fields: Record<string, unknown> = {}) => ({
  type: 'task',
  stage: 'done',
  closedReason: 'done',
  parentId: null,
  ...fields,
})

it('counts successful top-level history without loading task bodies', () => {
  const f = fixture([
    done(),
    done({ closedReason: null }),
    done({ closedReason: 'completed', archived: true }),
    done({ closedReason: 'cancelled' }),
    done({ closedReason: 'duplicate' }),
    done({ closedReason: 'superseded' }),
    done({ parentId: 'parent' }),
    done({ deletedAt: '2026-01-01' }),
    done({ isDraftVessel: true }),
    done({ type: 'phase' }),
    done({ type: 'milestone' }),
    done({ stage: 'review' }),
  ])
  expect(f.pool.finishedTaskCount).toBe(3)
  expect(f.pool.tables.issue.size).toBe(0)
  expect(f.request).not.toHaveBeenCalled()
})

it('waits for complete history and follows closures, reopening and parent changes', async () => {
  const f = fixture([done(), done()], false)
  const seen: unknown[] = []
  stops.push(
    autorun(() => {
      seen.push(f.pool.finishedTaskCount)
    }),
  )
  expect(seen).toEqual([LOADING])
  await f.publish([done(), done()])
  expect(seen.at(-1)).toBe(2)
  await f.publish([done(), done(), done()])
  expect(seen.at(-1)).toBe(3)
  await f.publish([done(), done(), done({ stage: 'in_progress' })])
  expect(seen.at(-1)).toBe(2)
  await f.publish([done(), done({ parentId: 'parent' }), done({ type: 'phase' })])
  expect(seen.at(-1)).toBe(1)
})

it('waits for old stubs to gain task type instead of counting unknown phases', async () => {
  const f = fixture([
    done({ type: undefined }),
    done({ type: undefined }),
    done({ type: undefined }),
  ])
  expect(f.pool.finishedTaskCount).toBe(LOADING)
  await f.publish([done(), done(), done({ type: 'phase' })])
  expect(f.pool.finishedTaskCount).toBe(2)
  expect(f.request).not.toHaveBeenCalled()
})
