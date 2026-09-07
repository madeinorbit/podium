/**
 * STORE-FIDELITY PROBES, run against EVERY instantiation (POD-1130 work item 3).
 *
 * `outbox/test-doubles.test.ts` probes the in-memory doubles hard, and it can only
 * ever certify the in-memory doubles. The risk this file closes is the other
 * direction: **any behaviour the fake PERMITS that a real transaction FORBIDS is a
 * false green for the whole conformance suite**, because the fake is the
 * instantiation CI runs on every commit and the real adapters are the ones users
 * run. A probe that passes in memory and was never pointed at IndexedDB or SQLite
 * is a claim about a Map.
 *
 * So each probe here is an obligation `outbox/ports.ts` states in prose, asserted
 * through nothing but the ports — `OutboxStorePort.apply`, `read`, and a span from
 * `SyncUnitOfWork.transact`. Nothing below knows what a Map, an IndexedDB
 * transaction or a SQLite row is, which is what lets the same text run against all
 * three.
 *
 * DELIBERATELY NOT HERE: the N-concurrently-open-spans probes from
 * `outbox/test-doubles.test.ts`. A real adapter's unit of work SERIALIZES
 * `transact`, so a probe that parks one span open and opens a second would deadlock
 * against IndexedDB and SQLite rather than fail — and a hang is the one result that
 * teaches nothing. The concurrency those probes assert reaches a durable adapter as
 * SEPARATE physical connections (two tabs, two principal-bound instances), which is
 * POD-373's `viewFor` axis and not a span axis. What survives the port here is
 * everything a SINGLE span can be adversarial about, plus the span-less writer racing
 * it.
 *
 * This is a separate entry point from `describeSyncConformance` on purpose: that
 * suite is POD-373's and its parameterization rule says a hop changes nothing in it.
 * These probes are a hop-independent addition alongside it, wired the same
 * three-line way.
 */

import { describe, expect, it } from 'vitest'
import { actorUser, asUserId, type MutationId } from '@podium/model'
import type { OutboxStoreMutation, OutboxStorePort } from '../outbox/ports'
import { SyncCommitConflict } from '../outbox/ports'
import type { OutboxAttribution, OutboxCommand, OutboxRecord } from '../outbox/records'
import type { OutboxState } from '../outbox/states'
import type { SyncSpan } from '../span'
import type { SyncInstantiation } from './instantiation'

const PRINCIPAL = 'u-ada'
const CLOSE: OutboxCommand = { name: 'issues.close', version: 1, delivery: 'offline-eligible' }
const ADA: OutboxAttribution = {
  actor: actorUser(asUserId(PRINCIPAL)),
  onBehalfOf: asUserId(PRINCIPAL),
}

const id = (s: string): MutationId => s as MutationId

const rec = (name: string, state: OutboxState = 'queued', mark = 'a'): OutboxRecord => ({
  mutationId: id(name),
  command: CLOSE,
  input: { name, mark },
  partitionKey: `p-${name}`,
  attribution: ADA,
  state,
  queuedAt: 1_700_000_000_000,
  attempts: 0,
})

const putting = (record: OutboxRecord, expect: OutboxState | 'absent'): OutboxStoreMutation => ({
  put: [record],
  expect: [{ mutationId: record.mutationId, expect }],
})

const removing = (name: string, expect: OutboxState | 'absent'): OutboxStoreMutation => ({
  remove: [id(name)],
  expect: [{ mutationId: id(name), expect }],
})

const ids = (records: readonly OutboxRecord[]): string[] => records.map((r) => String(r.mutationId))

/**
 * The comparable shape of the queue.
 *
 * NOT `JSON.stringify(records)`: a durable adapter is entitled to round-trip an
 * absent optional key differently from the fake, and a byte comparison of the whole
 * record would fail on that rather than on the thing under test. What every adapter
 * DOES owe identically is which records are present, in which order, in which state
 * — including whose write won, which is what `mark` carries. So the projection is
 * explicit and per key, by hand.
 */
const shape = (records: readonly OutboxRecord[]): string =>
  JSON.stringify(
    records.map((r) => [
      String(r.mutationId),
      r.state,
      (r.input as { mark?: string } | null)?.mark ?? null,
    ]),
  )

const ABORTED = new Error('store-fidelity probe abort')

/**
 * Run `body` inside one span and then abort it, returning the abort error.
 *
 * Written as a body that throws rather than a parked span: a real adapter's
 * transaction cannot be held open across an unrelated await (ADR 2 D10 — an
 * IndexedDB transaction auto-closes), so the portable way to be adversarial inside a
 * span is to do the work and then fail.
 */
const abortingSpan = async (
  unitOfWork: { transact: <T>(body: (span: SyncSpan) => Promise<T>) => Promise<T> },
  body: (span: SyncSpan) => Promise<void>,
): Promise<unknown> =>
  await unitOfWork.transact(async (span) => {
    await body(span)
    throw ABORTED
  }).then(
    () => undefined,
    (error: unknown) => error,
  )

export function describeStoreFidelity(instantiation: SyncInstantiation): void {
  describe(`store fidelity — ${instantiation.name}`, () => {
    const openStore = async (): Promise<{
      outbox: OutboxStorePort
      unitOfWork: { transact: <T>(body: (span: SyncSpan) => Promise<T>) => Promise<T> }
    }> => {
      const storage = await instantiation.open()
      return { outbox: storage.viewFor(PRINCIPAL).outbox, unitOfWork: storage.unitOfWork }
    }

    it('leaves the queue untouched — ORDER included — when a span aborts', async () => {
      const { outbox, unitOfWork } = await openStore()
      for (const name of ['m1', 'm2', 'm3']) {
        expect(await outbox.apply(putting(rec(name), 'absent'))).toEqual({ ok: true })
      }
      const before = shape(await outbox.read())

      const error = await abortingSpan(unitOfWork, async (span) => {
        await outbox.apply(removing('m2', 'queued'), span)
        await outbox.apply(putting(rec('m4'), 'absent'), span)
        await outbox.apply(putting(rec('m1', 'sending'), 'queued'), span)
      })

      expect(error).toBe(ABORTED)
      expect(shape(await outbox.read())).toBe(before)
      expect(ids(await outbox.read())).toEqual(['m1', 'm2', 'm3'])
    })

    it('does not publish a span’s staged write before the span commits', async () => {
      const { outbox, unitOfWork } = await openStore()
      let midSpan: string | undefined
      await unitOfWork.transact(async (span) => {
        await outbox.apply(putting(rec('m1'), 'absent'), span)
        // Read back through the SAME port a concurrent reader would use. A dirty
        // read here is the defect; a real transaction forbids it and the fake must.
        midSpan = shape(await outbox.read())
      })
      expect(midSpan).toBe('[]')
      expect(ids(await outbox.read())).toEqual(['m1'])
    })

    it('keeps a replacing put in its position rather than moving it to the end', async () => {
      // ADR 3 D12's FIFO is expressed as record ORDER, so this is a durability
      // obligation and not a nicety: an adapter that re-appends silently reorders
      // the queue. A set comparison cannot see it.
      const { outbox } = await openStore()
      for (const name of ['m1', 'm2', 'm3']) {
        await outbox.apply(putting(rec(name), 'absent'))
      }
      expect(await outbox.apply(putting(rec('m1', 'sending'), 'queued'))).toEqual({ ok: true })
      expect(ids(await outbox.read())).toEqual(['m1', 'm2', 'm3'])
      expect((await outbox.read())[0]?.state).toBe('sending')
    })

    it('returns a stale precondition as a conflict VALUE and writes nothing', async () => {
      const { outbox } = await openStore()
      await outbox.apply(putting(rec('m1', 'queued'), 'absent'))
      await outbox.apply(putting(rec('m1', 'accepted'), 'queued'))
      const before = shape(await outbox.read())

      // A conflict is an ordinary concurrent-writer outcome the kernel resolves by
      // re-staging; a storage failure is a throw. Every adapter owes that split.
      expect(await outbox.apply(putting(rec('m1', 'sending'), 'queued'))).toEqual({
        ok: false,
        conflicts: [id('m1')],
      })
      expect(shape(await outbox.read())).toBe(before)
    })

    it('refuses a precondition that went stale while the span was open', async () => {
      const { outbox, unitOfWork } = await openStore()
      await outbox.apply(putting(rec('m1', 'queued'), 'absent'))

      // The span stages against `queued`; a span-less writer moves it underneath.
      // Whether the adapter catches this at stage time or at commit time is its
      // choice; that it never publishes the stale write is not.
      const error = await unitOfWork
        .transact(async (span) => {
          const staged = await outbox.apply(putting(rec('m1', 'sending'), 'queued'), span)
          await outbox.apply(putting(rec('m1', 'accepted'), 'queued'))
          return staged
        })
        .then(
          (staged) => (staged.ok ? undefined : staged),
          (thrown: unknown) => thrown,
        )

      if (error !== undefined) {
        const named =
          error instanceof SyncCommitConflict
            ? error.conflicts.map(String)
            : (error as { conflicts?: readonly MutationId[] }).conflicts?.map(String)
        expect(named, 'a refusal must NAME the record, so the kernel can re-stage').toEqual(['m1'])
      }
      // Either way: `sending` is the stale write and must not be what survived.
      expect((await outbox.read())[0]?.state).toBe('accepted')
    })

    it('publishes nothing when ONE of a span’s several writes cannot land', async () => {
      // Atomicity across enrolled writes. An adapter that applies them in sequence
      // and cannot undo one already applied is not a unit of work.
      const { outbox, unitOfWork } = await openStore()
      await outbox.apply(putting(rec('m2', 'queued'), 'absent'))
      const before = shape(await outbox.read())

      const error = await abortingSpan(unitOfWork, async (span) => {
        await outbox.apply(putting(rec('m1'), 'absent'), span)
        await outbox.apply(putting(rec('m2', 'sending'), 'queued'), span)
        await outbox.apply(putting(rec('m3'), 'absent'), span)
      })

      expect(error).toBe(ABORTED)
      expect(shape(await outbox.read())).toBe(before)
    })

    it('never absorbs a span-less write into an open span', async () => {
      // The ambient-current-span defect, at the port. A write made with NO span is
      // its own transaction: durable immediately, and it survives the open span's
      // abort.
      const { outbox, unitOfWork } = await openStore()
      const error = await abortingSpan(unitOfWork, async (span) => {
        await outbox.apply(putting(rec('inside'), 'absent'), span)
        expect(await outbox.apply(putting(rec('outside'), 'absent'))).toEqual({ ok: true })
        expect(ids(await outbox.read())).toEqual(['outside'])
      })

      expect(error).toBe(ABORTED)
      expect(ids(await outbox.read())).toEqual(['outside'])
    })

    it('drops an aborted span’s staging, so the id is claimable again', async () => {
      const { outbox, unitOfWork } = await openStore()
      expect(
        await abortingSpan(unitOfWork, async (span) => {
          await outbox.apply(putting(rec('m1', 'queued', 'first'), 'absent'), span)
        }),
      ).toBe(ABORTED)

      await unitOfWork.transact(async (span) => {
        expect(await outbox.apply(putting(rec('m1', 'queued', 'second'), 'absent'), span)).toEqual({
          ok: true,
        })
      })
      expect(((await outbox.read())[0]?.input as { mark: string }).mark).toBe('second')
    })

    it('refuses a mutation that touches a record with no precondition', async () => {
      // ports.ts: `expect` must cover every key in `put` and `remove`, or a caller
      // could reintroduce an unconditional apply through a well-typed mutation.
      const { outbox } = await openStore()
      await expect(outbox.apply({ put: [rec('m1')], expect: [] })).rejects.toThrow()
      expect(await outbox.read()).toEqual([])
    })
  })
}
