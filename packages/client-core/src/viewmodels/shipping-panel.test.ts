import { shipLaneId } from '@podium/model'
import type { ShipLaneProjection, ShipOrderProjection } from '@podium/model'
import { describe, expect, it } from 'vitest'
import {
  formatShippingElapsed,
  shippingActivityLabel,
  shippingElapsed,
  shippingPanelModel,
} from './shipping-panel'

const order = (id: string, over: Partial<ShipOrderProjection> = {}): ShipOrderProjection => ({
  id: id as ShipOrderProjection['id'],
  issueId: `issue-${id}` as ShipOrderProjection['issueId'],
  repoId: 'repo-a' as ShipOrderProjection['repoId'],
  targetBranch: 'main',
  destination: 'origin/main',
  state: 'queued',
  humanState: 'waiting',
  activity: 'waiting',
  queuedAt: '2026-08-13T10:00:00.000Z',
  stateChangedAt: '2026-08-13T10:00:00.000Z',
  ...over,
})

const issue = (id: string) => ({ id: `issue-${id}`, seq: Number(id) || 1, title: `Issue ${id}` })

const lane = (
  destination: string,
  trains: string[][],
  over: Partial<ShipLaneProjection> = {},
): ShipLaneProjection => ({
  id: shipLaneId(order('1').repoId, destination),
  repoId: order('1').repoId,
  destination,
  trains: trains.map((ids) => ({ orderIds: ids as ShipLaneProjection['blockedOrderIds'] })),
  blockedOrderIds: [],
  ...over,
})

describe('shippingPanelModel', () => {
  it('groups by canonical lane instead of raw destination, including without lane rows', () => {
    const orders = [
      order('1', { destination: 'main', queueRank: 2 }),
      order('2', { destination: 'refs/heads/main', queueRank: 1 }),
      order('3', { destination: 'local:main', queueRank: 3 }),
      order('4', { destination: 'remote:origin/main', queueRank: 2 }),
      order('5', { destination: 'git:origin/main', targetBranch: 'release', queueRank: 1 }),
      // The same raw spelling can be local for one target and opaque for another.
      order('6', { destination: 'main', targetBranch: 'release', queueRank: 1 }),
      order('other-repo', { repoId: 'repo-b' as never, destination: 'main' }),
    ]
    const lanes = [
      lane('local:main', [['2'], ['1'], ['3']]),
      lane('git:origin/main', [['5'], ['4']]),
    ]
    for (const records of [[], lanes]) {
      const model = shippingPanelModel(orders, [], 'repo-a', records)
      expect(
        model.waiting.map((group) => ({
          destination: group.destination,
          ids: group.rows.map((row) => row.order.id),
        })),
      ).toEqual([
        { destination: 'git:origin/main', ids: ['5', '4'] },
        { destination: 'local:main', ids: ['2', '1', '3'] },
        { destination: 'main', ids: ['6'] },
      ])
      expect(model.unfinishedCount).toBe(6)
    }
  })

  it('takes scheduler train positions from the lane, sharing ranks and retaining hidden turns', () => {
    const orders = [
      order('later', { destination: 'remote:origin/main', queueRank: 1 }),
      order('first-b', { destination: 'git:origin/main', queueRank: 8 }),
      order('first-a', { destination: 'remote:origin/main', queueRank: 9 }),
    ]
    const model = shippingPanelModel(orders, [], 'repo-a', [
      lane('git:origin/main', [['hidden-order'], ['first-a', 'first-b'], ['later']]),
    ])
    expect(model.waiting[0]?.rows.map((row) => [row.order.id, row.queueRank])).toEqual([
      ['first-a', 2],
      ['first-b', 2],
      ['later', 3],
    ])
    // Join the view without changing the authority rows or rendering unseen ids.
    expect(orders.map((row) => row.queueRank)).toEqual([1, 8, 9])
    expect(model.unfinishedCount).toBe(3)
  })

  it('uses legacy ranks only while that canonical lane row is absent', () => {
    const orders = [
      order('blocked', { destination: 'main', queueRank: 1 }),
      order('ranked', { destination: 'local:main', queueRank: 7 }),
      order('not-in-lane', { destination: 'refs/heads/main', queueRank: 2 }),
      order('no-rank', { destination: 'local:main' }),
    ] as const
    const local = lane('local:main', [['ranked']], { blockedOrderIds: [orders[0].id] })
    const ranks = (records: ShipLaneProjection[]) =>
      shippingPanelModel(orders, [], 'repo-a', records).waiting[0]?.rows.map((row) => [
        row.order.id,
        row.queueRank,
      ])
    const legacy = [
      ['blocked', 1],
      ['not-in-lane', 2],
      ['ranked', 7],
      ['no-rank', undefined],
    ]
    expect(ranks([])).toEqual(legacy)
    expect(ranks([local])).toEqual([
      ['ranked', 1],
      ['blocked', undefined],
      ['no-rank', undefined],
      ['not-in-lane', undefined],
    ])
    // A lane disappearing re-enables compatibility; a row from another repo cannot supply rank.
    expect(ranks([])).toEqual(legacy)
    expect(
      ranks([
        lane('local:main', [['ranked']], {
          id: shipLaneId('repo-b' as never, 'local:main'),
          repoId: 'repo-b' as never,
        }),
      ]),
    ).toEqual(legacy)
  })

  it('scopes counts to one repository and excludes retained receipts', () => {
    const model = shippingPanelModel(
      [
        order('1', { queueRank: 2 }),
        order('2', { humanState: 'in_progress', state: 'validating', activity: 'validating' }),
        order('3', {
          humanState: 'needs_you',
          state: 'held',
          activity: 'held',
          hold: {
            id: 'hold-3' as never,
            generation: 1,
            reasonCode: 'landing-conflict',
            headline: 'A decision is required',
            actions: ['retry'],
          },
        }),
        order('4', {
          humanState: 'shipped',
          state: 'shipped',
          activity: 'shipped',
          receiptId: 'receipt-4' as never,
        }),
        order('5', { repoId: 'repo-b' as never }),
      ],
      ['1', '2', '3', '4', '5'].map(issue),
      'repo-a',
    )

    expect(model.unfinishedCount).toBe(3)
    expect(model.decisionCount).toBe(1)
    expect(model.recentlyShipped.map((row) => row.order.id)).toEqual(['4'])
  })

  it('keeps waiting ranks inside authoritative destination lanes and bounds verified history', () => {
    const model = shippingPanelModel(
      [
        order('1', { queueRank: 2 }),
        order('2', { queueRank: 1 }),
        order('3', { destination: 'upstream/release', targetBranch: 'release', queueRank: 1 }),
        order('6', { targetBranch: 'release', queueRank: 3 }),
        order('4', {
          humanState: 'shipped',
          state: 'shipped',
          activity: 'shipped',
          receiptId: 'receipt-4' as never,
          stateChangedAt: '2026-08-13T10:04:00.000Z',
        }),
        order('5', {
          humanState: 'shipped',
          state: 'shipped',
          activity: 'shipped',
          receiptId: 'receipt-5' as never,
          stateChangedAt: '2026-08-13T10:05:00.000Z',
        }),
      ],
      ['1', '2', '3', '4', '5', '6'].map(issue),
      'repo-a',
      [],
      1,
    )

    expect(model.waiting).toHaveLength(2)
    expect(model.waiting[0]?.rows.map((row) => row.order.id)).toEqual(['2', '1', '6'])
    expect(model.waiting[0]?.rows.map((row) => row.order.targetBranch)).toEqual([
      'main',
      'main',
      'release',
    ])
    expect(model.recentlyShipped.map((row) => row.order.id)).toEqual(['5'])
  })
})

describe('shipping display language', () => {
  it('maps engine codes to the one plain-language grammar', () => {
    expect(shippingActivityLabel('checking')).toBe('Checking approved changes')
    expect(shippingActivityLabel('composing')).toBe('Combining related changes')
    expect(shippingActivityLabel('publishing')).toBe('Sending to destination')
  })

  it('formats elapsed waits without claiming an ETA', () => {
    const now = Date.parse('2026-08-13T11:35:00.000Z')
    expect(formatShippingElapsed('2026-08-13T11:30:00.000Z', now)).toBe('5 min')
    expect(formatShippingElapsed('2026-08-13T10:00:00.000Z', now)).toBe('1 hr 35 min')
    expect(shippingElapsed('2026-08-13T11:30:00.000Z', now)).toEqual({
      label: '5 min',
      duration: 'PT5M',
    })
    expect(shippingElapsed('2026-08-13T10:00:00.000Z', now).duration).toBe('PT1H35M')
  })
})
