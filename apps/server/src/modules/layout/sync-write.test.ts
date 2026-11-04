/**
 * LAYOUT ON THE SYNC WRITE ENTRY POINT (POD-6350, ADR 12 D2).
 *
 * The two defects this family carried into the plan, and which the path fixes:
 * the row and its change entry were written in TWO transactions, and neither
 * `layout.set` nor `layout.clear` deduplicated a retry.
 */

import { firstAdminMemberId, layoutRowId } from '@podium/model'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { disposeOracles, makeOracle } from '../sessions/oracle-support'
import {
  appliedReply,
  changeRows,
  envelope,
  expectAppliedOnPath,
  submit,
} from '../sync-write/outbox-test-support'

afterEach(() => disposeOracles())

const ME = firstAdminMemberId()

describe('layout on sync.submit', () => {
  it('layout.set: provenance on its row, the receipt at the head, a replay runs nothing', async () => {
    const o = await makeOracle()

    const { result, rows } = await expectAppliedOnPath(
      o,
      envelope('layout.set', { values: { dockTab: 'files' } }, 'm-layout-set'),
      { writes: true },
    )

    expect(result).toEqual({ dockTab: 'files' })
    expect(rows.map((row) => row.entityId)).toEqual([layoutRowId(ME, 'dockTab')])
    // The replay above carried the same values; a replay carrying different
    // ones still answers the recorded snapshot and writes nothing.
    const replay = appliedReply(
      await submit(o, envelope('layout.set', { values: { dockTab: 'shell' } }, 'm-layout-set')),
    )
    expect(replay.replayed).toBe(true)
    expect(await o.reg.modules.layout.getSnapshot(ME)).toEqual({ dockTab: 'files' })
  })

  it('layout.clear: provenance on its remove row and dedup', async () => {
    const o = await makeOracle()
    appliedReply(await submit(o, envelope('layout.set', { values: { dockTab: 'files' } }, 'm-1')))

    const { result, rows } = await expectAppliedOnPath(
      o,
      envelope('layout.clear', { keys: ['dockTab'] }, 'm-layout-clear'),
      { writes: true },
    )

    expect(result).toEqual({})
    expect(rows.map((row) => row.op)).toEqual(['remove'])
  })

  it('a failed change append leaves neither the row nor the change entry', async () => {
    const o = await makeOracle()
    const capture = vi
      .spyOn(o.reg.changeLedger, 'capture')
      .mockRejectedValueOnce(new Error('append failed'))

    await expect(
      submit(o, envelope('layout.set', { values: { dockTab: 'files' } }, 'm-layout-fail')),
    ).rejects.toThrow()
    capture.mockRestore()

    expect(await o.reg.modules.layout.getSnapshot(ME)).toEqual({})
    expect(
      (await changeRows(o)).filter((row) => row.entityId === layoutRowId(ME, 'dockTab')),
    ).toEqual([])
    // Nothing was recorded either: the outbox's retry runs the write again.
    expect(
      appliedReply(
        await submit(o, envelope('layout.set', { values: { dockTab: 'files' } }, 'm-layout-fail')),
      ).replayed,
    ).toBe(false)
  })
})

describe('the old layout routes are adapters onto sync.submit', () => {
  it('layout.set over its own route now deduplicates by the mutationId it carries', async () => {
    const o = await makeOracle()

    expect(
      await o.call.layout.set({ values: { dockTab: 'files' }, mutationId: 'm-route' }),
    ).toEqual({ dockTab: 'files' })
    // A retry of the same write with a changed body is the same write: the
    // recorded snapshot comes back and nothing is written.
    expect(
      await o.call.layout.set({ values: { dockTab: 'shell' }, mutationId: 'm-route' }),
    ).toEqual({ dockTab: 'files' })
    expect(await o.reg.modules.layout.getSnapshot(ME)).toEqual({ dockTab: 'files' })
    // And its rows carry the id it came with.
    expect(
      (await changeRows(o))
        .filter((row) => row.entityId === layoutRowId(ME, 'dockTab'))
        .map((row) => row.mutationId),
    ).toEqual(['m-route'])
  })

  it('layout.clear over its own route still answers the snapshot', async () => {
    const o = await makeOracle()
    await o.call.layout.set({ values: { dockTab: 'files', superOpen: true } })

    expect(await o.call.layout.clear({ keys: ['superOpen'] })).toEqual({ dockTab: 'files' })
  })
})
