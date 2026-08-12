import type { IssueEventWire } from '@podium/model'
import { issueEventRowId } from '@podium/model'
import type { EntityChangeSpec } from '@podium/sync'
import { describe, expect, it } from 'vitest'
import { IssueEventFeedPublisher } from './feed'

/**
 * The publisher's three claims (POD-1772):
 *   1. only the curated vocabulary reaches the feed,
 *   2. the window is BOUNDED, and an eviction travels with the arrival that
 *      caused it (one capture — a replica can never see the top without the
 *      bottom), and
 *   3. an issue's carried rows are answerable for the rescope anchor.
 */

function harness(windowSize?: number) {
  const captures: EntityChangeSpec[][] = []
  const publisher = new IssueEventFeedPublisher({
    ledger: {
      capture: (specs) => {
        captures.push(specs)
        return []
      },
    },
    seed: () => [],
    ...(windowSize === undefined ? {} : { windowSize }),
  })
  return { captures, publisher }
}

const event = (over: Partial<{ kind: string; subject: string }> = {}) => ({
  ts: '2026-08-11T00:00:00.000Z',
  kind: 'issue.closed',
  subject: 'POD-13',
  repoPath: null,
  payload: {},
  ...over,
})

describe('IssueEventFeedPublisher', () => {
  it('publishes a curated event as an upsert keyed on the composite row id', () => {
    const { captures, publisher } = harness()
    publisher.publish(9, event())
    expect(captures).toHaveLength(1)
    expect(captures[0]).toEqual([
      {
        entity: 'issueEvent',
        id: issueEventRowId(9, 'POD-13'),
        op: 'upsert',
        value: {
          id: issueEventRowId(9, 'POD-13'),
          eventId: 9,
          ts: '2026-08-11T00:00:00.000Z',
          kind: 'issue.closed',
          subject: 'POD-13',
          repoPath: null,
          payload: {},
        } satisfies IssueEventWire,
      },
    ])
  })

  it('ignores an event kind the feed does not carry', () => {
    const { captures, publisher } = harness()
    publisher.publish(1, event({ kind: 'issue.mailSent' }))
    publisher.publish(2, event({ kind: 'session.exited' }))
    expect(captures).toEqual([])
  })

  it('ignores a subjectless event, which has no issue to be scoped by', () => {
    const { captures, publisher } = harness()
    publisher.publish(1, event({ subject: '' }))
    expect(captures).toEqual([])
  })

  it('evicts by delete in the SAME capture as the arrival that overflowed it', () => {
    const { captures, publisher } = harness(2)
    publisher.publish(1, event())
    publisher.publish(2, event())
    publisher.publish(3, event())
    expect(captures).toHaveLength(3)
    // The third arrival carries the first row's eviction with it.
    expect(captures[2]).toEqual([
      expect.objectContaining({ op: 'upsert', id: issueEventRowId(3, 'POD-13') }),
      { entity: 'issueEvent', id: issueEventRowId(1, 'POD-13'), op: 'delete' },
    ])
  })

  it('keeps the window bounded across many events', () => {
    const { publisher } = harness(3)
    for (let id = 1; id <= 20; id++) publisher.publish(id, event())
    expect(publisher.subjectsFor('POD-13')).toEqual([
      { entity: 'issueEvent', entityId: issueEventRowId(18, 'POD-13') },
      { entity: 'issueEvent', entityId: issueEventRowId(19, 'POD-13') },
      { entity: 'issueEvent', entityId: issueEventRowId(20, 'POD-13') },
    ])
  })

  it('answers the rescope anchor per subject, not for the whole window', () => {
    const { publisher } = harness()
    publisher.publish(1, event({ subject: 'POD-13' }))
    publisher.publish(2, event({ subject: 'POD-14' }))
    publisher.publish(3, event({ subject: 'POD-13' }))
    expect(publisher.subjectsFor('POD-14')).toEqual([
      { entity: 'issueEvent', entityId: issueEventRowId(2, 'POD-14') },
    ])
    expect(publisher.subjectsFor('POD-99')).toEqual([])
  })

  it('resumes its window from what the Authority already holds', () => {
    const captures: EntityChangeSpec[][] = []
    const row = (eventId: number): IssueEventWire => ({
      id: issueEventRowId(eventId, 'POD-13'),
      eventId,
      ts: '2026-08-11T00:00:00.000Z',
      kind: 'issue.closed',
      subject: 'POD-13',
      repoPath: null,
      payload: {},
    })
    const publisher = new IssueEventFeedPublisher({
      ledger: {
        capture: (specs) => {
          captures.push(specs)
          return []
        },
      },
      // Out of order on purpose: a snapshot is a set, and the window's order is
      // the durable event id, never the order the Authority enumerated.
      seed: () => [row(5), row(4)],
      windowSize: 2,
    })
    publisher.publish(6, event())
    // Seeded with 4 and 5, so the arrival of 6 evicts 4 — not 5.
    expect(captures[0]?.[1]).toEqual({
      entity: 'issueEvent',
      id: issueEventRowId(4, 'POD-13'),
      op: 'delete',
    })
  })

  it('never throws into the append path', () => {
    const publisher = new IssueEventFeedPublisher({
      ledger: {
        capture: () => {
          throw new Error('the ledger is unavailable')
        },
      },
      seed: () => [],
    })
    expect(() => publisher.publish(1, event())).not.toThrow()
  })
})
