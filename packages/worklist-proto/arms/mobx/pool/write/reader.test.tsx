import { upsertIssue } from '../../../../shared/src/scenarios'
// @vitest-environment happy-dom
/**
 * POD-4743 — one row reader with pending edits (`MobxPool.row`).
 *
 * - AGREEMENT. At every moment of an edit's life — pending, after rejection,
 *   after the echo settles it, after its TTL expires without an echo — the
 *   model's fields, the row view, the reader and the visibility verdict show
 *   one value, for a title and a stage that flips the row's visibility; and
 *   the live snapshot equals the pending-aware rebuild. With nothing pending
 *   the reader hands out the server object itself (identity).
 * - NO PATCHING. The write layer reaches the pool only through the overlay
 *   the pool was constructed with: every function on `pool.inputs` and
 *   `pool.visibleInputs` is the same object before the write layer exists,
 *   while it paints, and after it is disposed.
 */

import { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mountArmForCounts } from '../../../../harness/src/count-harness'
import { openFenceFeeds } from '../../../../harness/src/fence-scenarios'
import { startScenarioEngine, type ScenarioEngine, upsert } from '../../../../shared/src/scenarios'
import type { SliceIssue } from '@podium/client-graph/shared/slice-types'
import type {
  EditableStage,
  KernelCommand,
  TxId,
  WriteEvent,
  WriteTransport,
} from '@podium/client-graph/shared/write-contract'
import { harnessMobxPoolArm, harnessWritableMobxPoolArm, tracked, visibleOrderOf, type HarnessWritableMobxPoolHandle } from '../../../../harness/src/adapters/mobx-pool'
import { installMobxWarnTrap } from '../../../../harness/src/mobx-trap'
import type { MobxPool } from '@podium/client-graph/pool'
import { createMobxWriteApi } from '@podium/client-graph/write/edit'
import { PendingOverlay } from '@podium/client-graph/write/overlay'
import { ECHO_TTL_MS } from '@podium/client-graph/write/pending'
import { rowViewOf } from '@podium/client-graph/models'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const trap = installMobxWarnTrap()

afterEach(() => {
  vi.useRealTimers()
  expect(trap.warnings).toEqual([])
})

interface FakeTransport extends WriteTransport {
  readonly sent: { txId: TxId; command: KernelCommand }[]
  fire(event: WriteEvent): void
}

function fakeTransport(): FakeTransport {
  const sent: { txId: TxId; command: KernelCommand }[] = []
  const listeners = new Set<(event: WriteEvent) => void>()
  return {
    sent,
    send(txId, command) {
      sent.push({ txId, command })
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    pending() {
      return []
    },
    fire(event) {
      for (const listener of [...listeners]) listener(event)
    },
  }
}

/** The pool never auto-hydrates in these tests. */
const NEVER_AUTO = { schedule: () => () => {} } as const

/** Server truth for one issue's editable fields, through the replica facade (an echo). */
function serverWrite(ctx: ScenarioEngine, id: string, patch: { title?: string; stage?: string }): void {
  const wire = ctx.cache.read('issueProjection', id)?.value as Record<string, unknown> | undefined
  if (!wire) throw new Error(`issue ${id} missing from the server cache`)
  const projection = (ctx.cache.read('issueProjection', id)?.value ?? {}) as Record<string, unknown>
  ctx.replica.batch(() => {
    upsertIssue(ctx, id, { ...wire, ...patch })
  })
}

/**
 * A visible, non-draft human issue kept only by its active stage (sessionless
 * `keep`, nothing retained, nothing kept below): moving it to `backlog`
 * hides it, so the stage edit flips the visibility verdict.
 */
function stageKeptIssue(pool: MobxPool): string {
  const id = tracked(() =>
    visibleOrderOf(pool).find((candidate) => {
      const node = pool.knownIssue(candidate)
      const row = pool.row('issue', candidate, 'peek') as SliceIssue | undefined
      return (
        node !== undefined &&
        row?.isDraftVessel !== true &&
        node.standing?.sessionless === 'keep' &&
        !node.retained &&
        !node.keptBelow
      )
    }),
  )
  if (id === undefined) throw new Error('no visible issue kept by its stage alone')
  return id
}

interface Shown {
  readonly modelTitle: unknown
  readonly modelStage: unknown
  readonly readerTitle: unknown
  readonly readerStage: unknown
  readonly viewTitle: unknown
  readonly visible: unknown
}

/** What every reader of issue `id` shows, read in one tracked pass. */
function shownOf(pool: MobxPool, id: string): Shown {
  return tracked(() => {
    const model = pool.issue(id)
    const row = pool.row('issue', id) as SliceIssue | undefined
    return {
      modelTitle: model?.title,
      modelStage: model?.stage,
      readerTitle: row?.title,
      readerStage: row?.stage,
      viewTitle: rowViewOf(model)?.title,
      visible: pool.knownIssue(id)?.visible,
    }
  })
}

/**
 * Every reader agrees on `want`, and the live list equals the pending-aware
 * rebuild (the oracle derives from the feed's server rows with the pending
 * display laid over them, independent of the pool's reader). `settled`: with
 * nothing pending the reader hands out the server object itself.
 */
function expectAgreement(
  handle: HarnessWritableMobxPoolHandle,
  id: string,
  want: { title: string; stage: string; visible: boolean },
  moment: string,
  settled: boolean,
): void {
  const { pool } = handle
  expect(shownOf(pool, id), moment).toEqual({
    modelTitle: want.title,
    modelStage: want.stage,
    readerTitle: want.title,
    readerStage: want.stage,
    viewTitle: want.title,
    visible: want.visible,
  })
  const rebuilt = handle.rebuildFromScratch()
  expect(id in rebuilt.rowsById, `${moment}: rebuild visibility`).toBe(want.visible)
  expect(handle.snapshot(), `${moment}: live list vs pending-aware rebuild`).toEqual(rebuilt)
  if (settled) {
    expect(handle.write.log.pendingFor('issue', id), moment).toHaveLength(0)
    expect(
      tracked(() => pool.row('issue', id) === pool.tables.issue.get(id)),
      `${moment}: nothing pending, the reader returns the server object itself`,
    ).toBe(true)
  }
}

async function withArm(
  run: (ctx: ScenarioEngine, handle: HarnessWritableMobxPoolHandle, transport: FakeTransport) => Promise<void>,
): Promise<void> {
  const ctx = await startScenarioEngine(1)
  const feeds = openFenceFeeds(ctx, 'truth')
  const transport = fakeTransport()
  const mounted = mountArmForCounts(harnessWritableMobxPoolArm(transport, NEVER_AUTO), feeds.rows.source, feeds.locals)
  try {
    await run(ctx, mounted.handle as HarnessWritableMobxPoolHandle, transport)
  } finally {
    mounted.unmount()
    feeds.dispose()
    ctx.engine.destroy()
  }
}

describe('POD-4743 one row reader with pending edits', () => {
  it('model, row view, reader and visibility agree: pending, rejected, echoed, expired', async () => {
    // The pending log reads the clock it was built with: a Date that follows
    // real time until the TTL step jumps it.
    vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true })
    await withArm(async (ctx, handle, transport) => {
      const { pool, write } = handle
      const id = stageKeptIssue(pool)
      const server = tracked(() => pool.row('issue', id) as SliceIssue)
      const serverTitle = server.title
      const serverStage = server.stage
      const shownServer = { title: serverTitle, stage: serverStage, visible: true }
      expectAgreement(handle, id, shownServer, 'before', true)
      const pendingStage: EditableStage = 'backlog'

      // 1. Pending, then rejected.
      let tx = '' as TxId
      await act(async () => {
        tx = write.edit('issue', id, { title: 'Pending rename', stage: pendingStage })
      })
      expectAgreement(handle, id, { title: 'Pending rename', stage: pendingStage, visible: false }, 'pending', false)
      await act(async () => {
        transport.fire({ type: 'rejected', txId: tx, error: { message: 'refused', parked: false } })
      })
      expectAgreement(handle, id, shownServer, 'after rejection', true)

      // 2. Pending, receipted, then the echo carries the pending values.
      await act(async () => {
        tx = write.edit('issue', id, { title: 'Echoed rename', stage: pendingStage })
      })
      expectAgreement(handle, id, { title: 'Echoed rename', stage: pendingStage, visible: false }, 'pending (echo)', false)
      await act(async () => {
        transport.fire({ type: 'accepted', txId: tx })
      })
      expectAgreement(handle, id, { title: 'Echoed rename', stage: pendingStage, visible: false }, 'receipted', false)
      await act(async () => {
        serverWrite(ctx, id, { title: 'Echoed rename', stage: pendingStage })
      })
      expectAgreement(handle, id, { title: 'Echoed rename', stage: pendingStage, visible: false }, 'after echo', true)

      // Back to the original server values (a server change, nothing pending).
      await act(async () => {
        serverWrite(ctx, id, { title: serverTitle, stage: serverStage })
      })
      expectAgreement(handle, id, shownServer, 'server restored', true)

      // 3. Pending, receipted, and no echo within the TTL: it expires to server truth.
      await act(async () => {
        tx = write.edit('issue', id, { title: 'Expiring rename', stage: pendingStage })
      })
      await act(async () => {
        transport.fire({ type: 'accepted', txId: tx })
      })
      expectAgreement(handle, id, { title: 'Expiring rename', stage: pendingStage, visible: false }, 'receipted (ttl)', false)
      vi.setSystemTime(vi.getMockedSystemTime()!.getTime() + ECHO_TTL_MS + 1)
      await act(async () => {
        write.expire()
      })
      expectAgreement(handle, id, shownServer, 'after TTL expiry', true)
    })
  }, 180_000)

  it('the write layer never replaces a reader: every input function keeps its identity', async () => {
    const ctx = await startScenarioEngine(1)
    const feeds = openFenceFeeds(ctx, 'truth')
    const overlay = new PendingOverlay()
    const handle = harnessMobxPoolArm.create(feeds.rows.source, feeds.locals.source, undefined, NEVER_AUTO, overlay)
    const { pool } = handle
    const members = (): Map<string, unknown> =>
      new Map([
        ...Object.entries(pool.inputs).map(([key, value]): [string, unknown] => [`inputs.${key}`, value]),
        ...Object.entries(pool.visibleInputs).map(([key, value]): [string, unknown] => [
          `visibleInputs.${key}`,
          value,
        ]),
      ])
    const expectSame = (moment: string, before: Map<string, unknown>): void => {
      const now = members()
      expect([...now.keys()], moment).toEqual([...before.keys()])
      for (const [key, value] of before) expect(now.get(key) === value, `${moment}: ${key}`).toBe(true)
    }
    try {
      const before = members()
      expect(before.size).toBeGreaterThan(20)
      const transport = fakeTransport()
      const write = createMobxWriteApi(pool, overlay, transport)
      expectSame('after creating the write layer', before)
      const id = ctx.targets.visibleRootId
      const serverTitle = tracked(() => pool.issue(id)?.title)
      const tx = write.edit('issue', id, { title: 'Painted without patching' })
      expect(tracked(() => pool.issue(id)?.title)).toBe('Painted without patching')
      expect(tracked(() => rowViewOf(pool.issue(id))?.title)).toBe('Painted without patching')
      expectSame('while an edit is pending', before)
      write.reject({ txId: tx, error: { message: 'refused', parked: false } })
      write.edit('issue', id, { title: 'Pending at dispose' })
      write.dispose()
      expectSame('after disposing the write layer', before)
      // Disposed: the pool shows server truth again.
      expect(tracked(() => pool.issue(id)?.title)).toBe(serverTitle)
      // An overlay the pool was not constructed with is refused.
      expect(() => createMobxWriteApi(pool, new PendingOverlay(), transport)).toThrow(
        /not constructed with this write overlay/,
      )
    } finally {
      handle.dispose()
      feeds.dispose()
      ctx.engine.destroy()
    }
  }, 120_000)
})
