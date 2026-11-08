/**
 * LAYOUT ON THE SYNC WRITE ENTRY POINT (POD-6350, ADR 12 D2).
 *
 * The two defects this family carried into the plan, and which the path fixes:
 * the row and its change entry were written in TWO transactions, and neither
 * `layout.set` nor `layout.clear` deduplicated a retry.
 */

import { firstAdminMemberId, layoutRowId, readPositionRowId } from '@podium/model'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionStore } from '../../store'
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
    // The append itself fails: the row is written in the same commit, so it
    // goes with it.
    const capture = vi
      .spyOn(o.store.sync, 'appendChanges')
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

describe('layout and read marks are written only inside their commit (ADR 12 D9)', () => {
  // A read mark is a generic edit of my `userReadPosition` record (POD-6673).
  const readMark = readPositionRowId(ME, 'issueEvents')

  it('a store writer without the commit scope does not typecheck', () => {
    const typeOnly = async (store: SessionStore) => {
      // @ts-expect-error a layout row is written with its commit's scope
      await store.layout.setMany(ME, { dockTab: 'files' }, 'now')
      // @ts-expect-error a cleared key too
      await store.layout.clearMany(ME, ['dockTab'])
      // @ts-expect-error a read mark too
      await store.readPositions.advance(ME, 'issueEvents', { lastEventId: 1, seenAt: null }, 'now')
    }
    void typeOnly
  })

  it('a read mark on sync.submit carries the command on its row', async () => {
    const o = await makeOracle()
    const { rows } = await expectAppliedOnPath(
      o,
      envelope(
        'records.userReadPosition.edit',
        { id: readMark, patch: { lastEventId: 1, seenAt: null } },
        'm-read',
      ),
      { writes: true },
    )
    expect(rows.map((row) => [row.entity, row.mutationId])).toEqual([
      ['userReadPosition', 'm-read'],
    ])
  })

  it('a read mark at or behind the stored one appends nothing', async () => {
    const o = await makeOracle()
    appliedReply(
      await submit(
        o,
        envelope(
          'records.userReadPosition.edit',
          { id: readMark, patch: { lastEventId: 2, seenAt: null } },
          'm-r1',
        ),
      ),
    )
    const before = (await changeRows(o)).length
    appliedReply(
      await submit(
        o,
        envelope(
          'records.userReadPosition.edit',
          { id: readMark, patch: { lastEventId: 1, seenAt: null } },
          'm-r2',
        ),
      ),
    )
    expect((await changeRows(o)).length).toBe(before)
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
