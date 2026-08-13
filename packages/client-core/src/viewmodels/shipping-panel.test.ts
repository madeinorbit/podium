import type { ShipOrderProjection } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { formatShippingElapsed, shippingActivityLabel, shippingPanelModel } from './shipping-panel'

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

describe('shippingPanelModel', () => {
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

  it('keeps waiting ranks inside destination lanes and bounds verified history', () => {
    const model = shippingPanelModel(
      [
        order('1', { queueRank: 2 }),
        order('2', { queueRank: 1 }),
        order('3', { destination: 'upstream/release', targetBranch: 'release', queueRank: 1 }),
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
      ['1', '2', '3', '4', '5'].map(issue),
      'repo-a',
      1,
    )

    expect(model.waiting).toHaveLength(2)
    expect(model.waiting[0]?.rows.map((row) => row.order.id)).toEqual(['2', '1'])
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
  })
})
