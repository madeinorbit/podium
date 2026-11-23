/**
 * The side-state guard (POD-7454). The test setup installs it in `throw`
 * mode for every client file and fails a test that recorded a violation;
 * each case here that provokes one takes the record itself.
 */
import type { ReplicaAddressedBatch, ReplicaKind } from '@podium/client-core/replica'
import { asUserId, layoutRowId } from '@podium/model'
import { SideMap, SideSet, signalledRead } from '@podium/sync/side-state'
import { autorun, computed, runInAction, untracked } from 'mobx'
import { afterEach, describe, expect, it } from 'vitest'
import { EMPTY_PENDING } from '../../../tests/worklist/shared/src/row-source'
import { createWorklistPool } from './create'
import { isGone } from './lookup'
import { fixedLocals } from './shared/locals-source'
import { createRowSource, type RowSourceReplica } from './shared/row-source'
import {
  installSideStateGuard,
  isSideStateReadError,
  takeSideStateViolations,
} from './side-state-guard'

// MobX reports a reaction's error and carries on; keep that report out of the log.
const quiet = console.error
afterEach(() => {
  console.error = quiet
})
function silenceReactionErrors(): void {
  console.error = () => {}
}

const collections = () => takeSideStateViolations().map((violation) => violation.collection)

describe('the guard', () => {
  it('passes reads outside a derivation, in an action and inside untracked', () => {
    const map = new SideMap<string, number>('test.map', [['a', 1]])
    expect(map.get('a')).toBe(1)
    runInAction(() => expect(map.has('a')).toBe(true))
    const stop = autorun(() => {
      untracked(() => map.get('a'))
    })
    stop()
    expect(collections()).toEqual([])
  })

  it('throws at a derivation read and records it once per site', () => {
    const map = new SideMap<string, number>('test.map', [['a', 1]])
    const set = new SideSet<string>('test.set', ['x'])
    const caught: unknown[] = []
    const stop = autorun(() => {
      for (const read of [() => map.get('a'), () => map.size, () => [...set], () => set.has('x')]) {
        try {
          read()
        } catch (error) {
          caught.push(error)
        }
      }
    })
    stop()
    expect(caught).toHaveLength(4)
    expect(caught.every(isSideStateReadError)).toBe(true)
    const recorded = takeSideStateViolations()
    expect(recorded.map((violation) => violation.collection).sort()).toEqual([
      'test.map',
      'test.map',
      'test.set',
      'test.set',
    ])
    expect(recorded.every((violation) => violation.site.includes('side-state-guard.test'))).toBe(
      true,
    )
  })

  it('covers a signalled read for its own derivation only, not a computed inside it', () => {
    const map = new SideMap<string, number>('test.map', [['a', 1]])
    const inner = computed(() => map.get('a'))
    const seen: unknown[] = []
    silenceReactionErrors()
    const covered = autorun(() => {
      seen.push(signalledRead(() => map.get('a')))
    })
    covered()
    expect(seen).toEqual([1])
    expect(collections()).toEqual([])
    const nested = autorun(() => {
      signalledRead(() => inner.get())
    })
    nested()
    expect(collections()).toEqual(['test.map'])
  })

  it('warns in development and records without throwing', () => {
    const uninstall = installSideStateGuard('warn')
    try {
      const map = new SideMap<string, number>('test.warned', [['a', 1]])
      const seen: unknown[] = []
      const stop = autorun(() => {
        seen.push(map.get('a'))
      })
      stop()
      expect(seen).toEqual([1])
      expect(collections()).toEqual(['test.warned'])
    } finally {
      uninstall()
    }
  })
})

describe('a guard error swallowed on its way out still fails the test', () => {
  it('through a defensive catch and through MobX reaction error handling', () => {
    const map = new SideMap<string, number>('test.swallowed', [['a', 1]])
    silenceReactionErrors()
    const defensive = autorun(() => {
      try {
        map.get('a')
      } catch {
        // A reader that turns a failed read into "absent".
      }
    })
    defensive()
    const unguarded = autorun(() => {
      map.get('a')
    })
    unguarded()
    // What the setup's afterEach reads to fail the test: both sites.
    expect(collections()).toEqual(['test.swallowed', 'test.swallowed'])
  })

  it('through the row source, whose row read turns a failure into "absent"', () => {
    const rows = new SideMap<string, Record<string, unknown>>('test.replicaRows', [
      ['s-1', { sessionId: 's-1', title: 'One', status: 'running' }],
    ])
    const replica: RowSourceReplica = {
      row: (kind, id) => (kind === 'sessions' ? rows.get(id) : undefined),
      rows: (kind) => (kind === 'sessions' ? [...rows.values()] : []),
      subscribeAddressedBatch: () => () => {},
    }
    const source = createRowSource({ principal: { userId: 'u-1' } }, replica, {
      pending: EMPTY_PENDING,
    })
    const caught: unknown[] = []
    try {
      const stop = autorun(() => {
        try {
          source.source.row?.('session', 's-1')
        } catch (error) {
          caught.push(error)
        }
      })
      stop()
    } finally {
      source.dispose()
    }
    // The row source rethrows the guard's error instead of answering "absent".
    expect(caught.some(isSideStateReadError)).toBe(true)
    expect(collections()).toContain('test.replicaRows')
  })
})

describe('the POD-7422 shape', () => {
  const USER = 'u-1'
  const ROW = layoutRowId(asUserId(USER), 'sidebar.section.project-repo')

  /** A pool over the real feed, its replica keeping exits as the kernel does (a SideMap). */
  function pool(exitRead: 'current' | 'before POD-7422') {
    const layouts = new Map<string, Record<string, unknown>>([
      [ROW, { userId: USER, key: 'sidebar.section.project-repo', value: true }],
    ])
    const exits = new SideMap<string, 'removed' | 'evicted'>('replica.exits')
    let addressed: (batch: ReplicaAddressedBatch) => void = () => {}
    const replica: RowSourceReplica = {
      row: (kind, id) => (kind === 'userLayouts' ? layouts.get(id) : undefined),
      rows: (kind: ReplicaKind) => (kind === 'userLayouts' ? [...layouts.values()] : []),
      exitKind: (entity, id) => exits.get(`${entity}:${id}`),
      subscribeAddressedBatch(listener) {
        addressed = listener
        return () => {
          addressed = () => {}
        }
      },
    }
    const rows = createRowSource({ principal: { userId: USER } }, replica, {
      pending: EMPTY_PENDING,
    })
    const source =
      exitRead === 'current'
        ? rows.source
        : {
            ...rows.source,
            subscribe: rows.source.subscribe.bind(rows.source),
            // The read as it was before POD-7422: the replica's exit map, untracked.
            exitKind: (kind: string, id: string) =>
              replica.exitKind?.(kind === 'issue' ? 'issueProjection' : kind, id),
          }
    const handle = createWorklistPool(
      source,
      fixedLocals({ selectedIssueId: null, coarseNow: 0 }).source,
    )
    return {
      handle,
      /** The feed removes the row: the kernel records its exit and addresses it. */
      remove() {
        layouts.delete(ROW)
        exits.set(`userLayout:${ROW}`, 'removed')
        addressed({ type: 'update', rows: [{ kind: 'userLayouts', id: ROW }] })
      },
      dispose() {
        handle.dispose()
        rows.dispose()
      },
    }
  }

  const settled = () => new Promise((resolve) => setTimeout(resolve, 0))

  it.each([
    'before POD-7422',
    'current',
  ] as const)('a header reading its fold after the removal: %s', async (exitRead) => {
    const fixture = pool(exitRead)
    silenceReactionErrors()
    const seen: unknown[] = []
    const stop = autorun(() => {
      seen.push(fixture.handle.pool.row('userLayout', ROW))
    })
    try {
      await settled()
      fixture.remove()
      await settled()
      // The old read takes the exit from a map nothing observes, before the
      // row's table slot: the guard names it at the header's first read.
      expect([...new Set(collections())]).toEqual(exitRead === 'current' ? [] : ['replica.exits'])
      // The current read consulted the exit, behind its signal: the header reads the removal.
      if (exitRead === 'current') expect(isGone(seen.at(-1))).toBe(true)
    } finally {
      stop()
      fixture.dispose()
    }
  })
})
