// @vitest-environment happy-dom

import type { ShipOrderProjection } from '@podium/model'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeIssue } from '@/lib/test-issue'
import { ShippingPanel } from './ShippingPanel'

const issue = makeIssue({
  id: 'ship-issue',
  seq: 835,
  displayRef: 'POD-835',
  title: 'Shipping sidebar panel',
  repoId: 'repo-a' as never,
})

const order = (over: Partial<ShipOrderProjection> = {}): ShipOrderProjection => ({
  id: 'order-a' as never,
  issueId: issue.id as never,
  repoId: 'repo-a' as never,
  targetBranch: 'main',
  destination: 'origin/main',
  state: 'validating',
  humanState: 'in_progress',
  activity: 'validating',
  queuedAt: '2026-08-13T11:50:00.000Z',
  stateChangedAt: '2026-08-13T11:55:00.000Z',
  ...over,
})

afterEach(cleanup)

describe('ShippingPanel', () => {
  it('uses plain activity language and replaces only the dock body for drill-in', () => {
    render(
      <ShippingPanel
        orders={[order({ state: 'composing', activity: 'composing' })]}
        issues={[issue]}
        repoId="repo-a"
        now={Date.parse('2026-08-13T12:00:00.000Z')}
        onSelectIssue={vi.fn()}
      />,
    )

    const row = screen.getByRole('button', { name: /Shipping sidebar panel/ })
    expect(row.textContent).toContain('Combining related changes')
    expect(row.textContent).not.toContain('composing')
    fireEvent.click(row)
    expect(screen.getByRole('button', { name: 'All shipping' })).toBe(document.activeElement)
    expect(screen.getByText('PROOF SO FAR')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'All shipping' }))
    expect(screen.getByRole('button', { name: /Shipping sidebar panel/ })).toBe(
      document.activeElement,
    )
  })

  it('renders server-ranked waiting work as an ordered list with elapsed time', () => {
    render(
      <ShippingPanel
        orders={[
          order({
            id: 'order-b' as never,
            state: 'queued',
            humanState: 'waiting',
            activity: 'waiting',
            queueRank: 2,
          }),
          order({ state: 'queued', humanState: 'waiting', activity: 'waiting', queueRank: 1 }),
        ]}
        issues={[issue]}
        repoId="repo-a"
        now={Date.parse('2026-08-13T12:00:00.000Z')}
        onSelectIssue={vi.fn()}
      />,
    )

    const list = screen.getByRole('list')
    expect(list.tagName).toBe('OL')
    expect(screen.getAllByText(/waiting 10 min/)).toHaveLength(2)
    expect(screen.queryByText(/ETA/i)).toBeNull()
  })

  it('shows typed hold choices without creating a second live alert', () => {
    render(
      <ShippingPanel
        orders={[
          order({
            state: 'held',
            humanState: 'needs_you',
            activity: 'held',
            hold: {
              id: 'hold-a' as never,
              generation: 2,
              reasonCode: 'landing-conflict',
              headline: 'Podium cannot choose the intended behavior',
              actions: ['retry', 'open-repair', 'return-to-issue'],
            },
          }),
        ]}
        issues={[issue]}
        repoId="repo-a"
        now={Date.parse('2026-08-13T12:00:00.000Z')}
        onSelectIssue={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /Shipping sidebar panel/ }))
    expect(screen.getByText('Retry shipping')).toBeTruthy()
    expect(screen.getByText('Open repair')).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('keeps a shipped row attached to its own receipt identity', () => {
    render(
      <ShippingPanel
        orders={[
          order({
            state: 'shipped',
            humanState: 'shipped',
            activity: 'shipped',
            receiptId: 'receipt-a' as never,
          }),
        ]}
        issues={[issue]}
        repoId="repo-a"
        now={Date.parse('2026-08-13T12:00:00.000Z')}
        onSelectIssue={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /Shipping sidebar panel/ }))
    expect(screen.getByText('DELIVERY RECEIPT')).toBeTruthy()
    expect(screen.getByText('receipt-a')).toBeTruthy()
  })
})
