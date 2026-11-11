/**
 * THE ISSUE-EVENT FEED, AGAINST THE REAL EVENTS TABLE AND LEDGER (POD-1772,
 * POD-6766). The publisher's claims:
 *   1. only the curated vocabulary with a subject reaches the feed,
 *   2. the window is BOUNDED, and an eviction travels with the arrival that
 *      caused it (one commit: a replica never sees the top without the
 *      bottom),
 *   3. the window is a query on the events table: what the feed carries is
 *      exactly `issueEventWindow`, after appends, after retention, and after
 *      a restart, without any boot repair.
 */

import { type IssueEventWire, issueEventRowId } from '@podium/model'
import { Ledger } from '@podium/sync'
import { testLedgerWriter } from '@podium/sync/testing'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionStore } from '../../store'
import { afterCommit, applyAfterCommit, spanOpen } from '../../store/executor/executor'
import { openTestStore } from '../../test-support/open-test-store'
import { expectRecordLogParity } from '../../test-support/record-log-parity'
import { testStoreRecords } from '../../test-support/record-writer'
import { IssueEventFeedPublisher, issueEventWindow } from './feed'

const stores: SessionStore[] = []
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close()
})

const TS = '2026-08-11T00:00:00.000Z'

async function harness(opts: { windowSize?: number } = {}) {
  const store = await openTestStore(':memory:')
  stores.push(store)
  const ledger = new Ledger({
    repo: store.sync,
    // The event kind is named after the write and built from the table
    // (POD-6770), with the window this harness runs.
    records: testStoreRecords(
      store,
      opts.windowSize === undefined ? {} : { eventWindow: opts.windowSize },
    ),
    now: Date.now,
    transact: async (fn) => await store.transact(fn),
    postCommit: (step, label) => afterCommit(step, label),
    applyCommit: { spanOpen, onCommit: applyAfterCommit },
  })
  /** A publisher over this table and log, wired as relay.ts wires it. */
  const boot = async (): Promise<IssueEventFeedPublisher> => {
    const publisher = new IssueEventFeedPublisher({
      ledger: testLedgerWriter(ledger),
      events: store.events,
      transact: async (fn) => await store.transact(fn),
      ...(opts.windowSize === undefined ? {} : { windowSize: opts.windowSize }),
    })
    store.events.setPruneFeedCapture(async (deleted) => await publisher.pruned(deleted))
    store.events.setFeedCapture(async (id, event) => await publisher.publish(id, event))
    return publisher
  }
  let publisher = await boot()
  /** Append an event and publish it, as the append listener does. */
  const append = async (over: { kind?: string; subject?: string } = {}): Promise<number> => {
    const event = { ts: TS, kind: 'issue.closed', subject: 'POD-13', repoPath: null, payload: {} }
    Object.assign(event, over)
    return await store.events.appendEvent(event)
  }
  /**
   * What a device that followed the feed from the start holds, by event id:
   * the log's changes folded in order. (A device bootstrapping now is served
   * from the table, which says nothing about what the publisher appended.)
   */
  const carried = async (): Promise<number[]> => {
    const held = new Map<string, IssueEventWire>()
    for (const change of (await ledger.changesSince(0)) ?? []) {
      if (change.entity !== 'issueEvent') continue
      if (change.op === 'upsert') held.set(change.id, change.value as IssueEventWire)
      else held.delete(change.id)
    }
    return [...held.values()].map((row) => row.eventId).sort((a, b) => a - b)
  }
  /** What the query says the window is, by event id. */
  const window = async (): Promise<number[]> =>
    (await issueEventWindow(store.events, opts.windowSize)).map((row) => row.eventId)
  const reboot = async (): Promise<void> => {
    publisher = await boot()
  }
  return { store, ledger, append, carried, window, reboot, publisher: () => publisher }
}

describe('IssueEventFeedPublisher', () => {
  it('publishes a curated event as an upsert keyed on the composite row id', async () => {
    const { ledger, append } = await harness()
    const cursor = await ledger.cursor()
    const id = await append()
    const changes = (await ledger.changesSince(cursor)) ?? []
    expect(changes.map((c) => [c.op, c.id])).toEqual([['upsert', issueEventRowId(id, 'POD-13')]])
    expect(await ledger.authority.snapshot('issueEvent')).toEqual([
      {
        id: issueEventRowId(id, 'POD-13'),
        eventId: id,
        ts: TS,
        kind: 'issue.closed',
        subject: 'POD-13',
        repoPath: null,
        payload: {},
      } satisfies IssueEventWire,
    ])
  })

  it('ignores an event kind the feed does not carry, and a subjectless event', async () => {
    const { append, carried, window } = await harness()
    await append({ kind: 'issue.mailSent' })
    await append({ kind: 'session.exited' })
    await append({ subject: '' })
    expect(await carried()).toEqual([])
    expect(await window()).toEqual([])
  })

  it('evicts by removal in the SAME change batch as the arrival that overflowed it', async () => {
    const { ledger, append, carried } = await harness({ windowSize: 2 })
    const first = await append()
    const second = await append()
    const cursor = await ledger.cursor()
    const third = await append()
    const changes = (await ledger.changesSince(cursor)) ?? []
    expect(changes.map((c) => [c.op, c.id])).toEqual([
      ['upsert', issueEventRowId(third, 'POD-13')],
      ['remove', issueEventRowId(first, 'POD-13')],
    ])
    expect(await carried()).toEqual([second, third])
  })

  it('keeps the window bounded, and equal to the query, across many events and kinds', async () => {
    const { store, ledger, append, carried, window } = await harness({ windowSize: 3 })
    for (let n = 0; n < 20; n++) {
      await append({ kind: n % 2 === 0 ? 'issue.closed' : 'issue.created' })
      await append({ kind: 'issue.mailSent' })
    }
    expect((await carried()).length).toBe(3)
    expect(await carried()).toEqual(await window())
    await expectRecordLogParity(store, ledger, 'issueEvent', { eventWindow: 3 })
  })

  it('serializes simultaneous appends with their window changes', async () => {
    const { append, carried, window } = await harness({ windowSize: 2 })
    await append()
    await append()
    const ids = await Promise.all([append(), append()])
    expect(await carried()).toEqual(await window())
    expect(await window()).toEqual(ids.sort((a, b) => a - b))
  })

  it('takes the events retention deleted off the feed, and carries the window that is left', async () => {
    const { store, ledger, append, carried, window } = await harness({ windowSize: 3 })
    for (let n = 0; n < 5; n++) await append()
    const newest = await carried()
    expect(newest.length).toBe(3)
    // Retention by row cap: keep the newest two events of the log.
    const plan = await store.events.planEventPrune({ maxAgeDays: 3650, maxRows: 2 })
    await store.events.pruneEventBatch(plan)
    await vi.waitFor(async () => expect(await carried()).toEqual(await window()))
    expect((await carried()).length).toBe(2)
    await expectRecordLogParity(store, ledger, 'issueEvent', { eventWindow: 3 })
  })

  it('restarts without reading or rebuilding the window', async () => {
    const { store, append, carried, window, reboot, ledger } = await harness({ windowSize: 3 })
    for (let n = 0; n < 5; n++) await append()
    const before = await carried()
    const cursor = await ledger.cursor()
    const reads = vi.spyOn(store.events, 'feedWindow')
    const ids = vi.spyOn(store.events, 'feedWindowIds')
    await reboot()
    expect(reads).not.toHaveBeenCalled()
    expect(ids).not.toHaveBeenCalled()
    expect(await ledger.cursor()).toBe(cursor)
    expect(await carried()).toEqual(before)
    await append()
    expect(await carried()).toEqual(await window())
  })

  it('rolls the event insert back when its log append fails, even with announcements suppressed', async () => {
    const { store, ledger, append, carried } = await harness({ windowSize: 2 })
    await append()
    const before = await carried()
    const cursor = await ledger.cursor()
    const failed = vi
      .spyOn(store.sync, 'appendChanges')
      .mockRejectedValueOnce(new Error('log unavailable'))
    await expect(
      store.events.appendEvent(
        { ts: TS, kind: 'issue.closed', subject: 'POD-13' },
        { announce: false },
      ),
    ).rejects.toThrow('log unavailable')
    failed.mockRestore()
    expect(await ledger.cursor()).toBe(cursor)
    expect(await store.events.maxEventId()).toBe(before.at(-1))
    expect(await carried()).toEqual(before)
  })

  it('rolls the event and log back with an enclosing transaction', async () => {
    const { store, ledger, append, carried, window } = await harness({ windowSize: 2 })
    await append()
    await append()
    const before = await carried()
    const cursor = await ledger.cursor()
    await expect(
      store.transact(async () => {
        await append()
        expect(await carried()).toEqual(await window())
        throw new Error('source rollback')
      }),
    ).rejects.toThrow('source rollback')
    expect(await ledger.cursor()).toBe(cursor)
    expect(await carried()).toEqual(before)
    expect(await window()).toEqual(before)
  })

  it('logs nothing when retention leaves the carried window unchanged', async () => {
    const { store, ledger, append, carried } = await harness({ windowSize: 2 })
    for (let n = 0; n < 4; n++) await append()
    const before = await carried()
    const cursor = await ledger.cursor()
    const plan = await store.events.planEventPrune({ maxAgeDays: 3650, maxRows: 3 })
    expect(await store.events.pruneEventBatch(plan)).toBe(1)
    expect(await ledger.cursor()).toBe(cursor)
    expect(await carried()).toEqual(before)
    expect(await store.events.pruneEventBatch(plan)).toBe(0)
    expect(await ledger.cursor()).toBe(cursor)
  })

  it('rolls retention and its window removals back together', async () => {
    const { store, ledger, append, carried, window } = await harness({ windowSize: 2 })
    await append()
    await append()
    const before = await carried()
    const cursor = await ledger.cursor()
    const plan = await store.events.planEventPrune({ maxAgeDays: 3650, maxRows: 1 })
    await expect(
      store.transact(async () => {
        await store.events.pruneEventBatch(plan)
        expect(await carried()).toEqual(await window())
        throw new Error('the retention write failed')
      }),
    ).rejects.toThrow('the retention write failed')
    expect(await carried()).toEqual(before)
    expect(await ledger.cursor()).toBe(cursor)
    expect((await store.events.feedWindow({ limit: 2 })).length).toBe(2)
  })
})
