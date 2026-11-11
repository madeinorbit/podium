/**
 * THE ISSUE-EVENT FEED, AGAINST THE REAL EVENTS TABLE AND LEDGER (POD-1772,
 * POD-6766). The publisher's claims:
 *   1. only the curated vocabulary with a subject reaches the feed,
 *   2. the window is BOUNDED, and an eviction travels with the arrival that
 *      caused it (one commit: a replica never sees the top without the
 *      bottom),
 *   3. the window is a query on the events table: what the feed carries is
 *      exactly `issueEventWindow`, after appends, after retention, and after
 *      a boot that finds the feed out of step with the table.
 */

import { type IssueEventWire, issueEventRowId } from '@podium/model'
import { Ledger } from '@podium/sync'
import { testLedgerWriter } from '@podium/sync/testing'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionStore } from '../../store'
import { afterCommit, applyAfterCommit, spanOpen } from '../../store/executor/executor'
import { openTestStore } from '../../test-support/open-test-store'
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
    await publisher.resolve()
    return publisher
  }
  let publisher = await boot()
  /** Append an event and publish it, as the append listener does. */
  const append = async (over: { kind?: string; subject?: string } = {}): Promise<number> => {
    const event = { ts: TS, kind: 'issue.closed', subject: 'POD-13', repoPath: null, payload: {} }
    Object.assign(event, over)
    const id = await store.events.appendEvent(event, { announce: false })
    await publisher.publish(id, event)
    return id
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
    const { append, carried, window } = await harness({ windowSize: 3 })
    for (let n = 0; n < 20; n++) {
      await append({ kind: n % 2 === 0 ? 'issue.closed' : 'issue.created' })
      await append({ kind: 'issue.mailSent' })
    }
    expect((await carried()).length).toBe(3)
    expect(await carried()).toEqual(await window())
  })

  it('carries what the table holds when two publishes overtake each other', async () => {
    const { store, append, carried, window, publisher } = await harness({ windowSize: 2 })
    await append()
    await append()
    // Two events land before either is published; the later one publishes first.
    const event = { ts: TS, kind: 'issue.closed', subject: 'POD-13', repoPath: null, payload: {} }
    const a = await store.events.appendEvent(event, { announce: false })
    const b = await store.events.appendEvent(event, { announce: false })
    await publisher().publish(b, event)
    await publisher().publish(a, event)
    expect(await carried()).toEqual(await window())
    expect(await window()).toEqual([a, b])
  })

  it('takes the events retention deleted off the feed, and carries the window that is left', async () => {
    const { store, append, carried, window } = await harness({ windowSize: 3 })
    for (let n = 0; n < 5; n++) await append()
    const newest = await carried()
    expect(newest.length).toBe(3)
    // Retention by row cap: keep the newest two events of the log.
    const plan = await store.events.planEventPrune({ maxAgeDays: 3650, maxRows: 2 })
    await store.events.pruneEventBatch(plan)
    await vi.waitFor(async () => expect(await carried()).toEqual(await window()))
    expect((await carried()).length).toBe(2)
  })

  it('reconciles the feed from the table at boot: pruned rows leave, missing rows arrive', async () => {
    const { store, append, carried, window, reboot } = await harness({ windowSize: 3 })
    const kept = await append()
    // An event the feed never heard of (a publish lost to a crash) ...
    await store.events.appendEvent(
      { ts: TS, kind: 'issue.created', subject: 'POD-14' },
      { announce: false },
    )
    // ... and a feed row whose event is gone (retention while it was down).
    await store.sync.appendChanges(
      [
        {
          entity: 'issueEvent',
          entityId: issueEventRowId(9_999, 'POD-13'),
          op: 'upsert',
          payload: JSON.stringify({ id: issueEventRowId(9_999, 'POD-13'), eventId: 9_999 }),
        },
      ],
      Date.now(),
    )
    expect(await carried()).not.toEqual(await window())
    await reboot()
    expect(await carried()).toEqual(await window())
    expect(await carried()).toContain(kept)
    expect(await carried()).not.toContain(9_999)
  })

  it('never throws into the append path', async () => {
    const store = await openTestStore(':memory:')
    stores.push(store)
    const publisher = new IssueEventFeedPublisher({
      ledger: {
        commit: () => {
          throw new Error('the ledger is unavailable')
        },
        reconcile: async () => [],
      },
      events: store.events,
      transact: async (fn) => await store.transact(fn),
    })
    const event = { ts: TS, kind: 'issue.closed', subject: 'POD-13', repoPath: null, payload: {} }
    const id = await store.events.appendEvent(event, { announce: false })
    await expect(publisher.publish(id, event)).resolves.toBeUndefined()
    await expect(publisher.pruned([{ id, subject: 'POD-13' }])).resolves.toBeUndefined()
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
