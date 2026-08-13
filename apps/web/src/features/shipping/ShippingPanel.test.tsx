// @vitest-environment happy-dom

import type { ShipOrderProjection } from '@podium/model'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
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

  it('keeps different target branches in one destination lane with semantic elapsed time', () => {
    const { container } = render(
      <ShippingPanel
        orders={[
          order({
            id: 'order-b' as never,
            state: 'queued',
            humanState: 'waiting',
            activity: 'waiting',
            queueRank: 2,
            targetBranch: 'release',
          }),
          order({ state: 'queued', humanState: 'waiting', activity: 'waiting', queueRank: 1 }),
          order({
            id: 'order-c' as never,
            state: 'queued',
            humanState: 'waiting',
            activity: 'waiting',
            destination: 'upstream/release',
            targetBranch: 'release',
            queueRank: 1,
          }),
        ]}
        issues={[issue]}
        repoId="repo-a"
        now={Date.parse('2026-08-13T12:00:00.000Z')}
      />,
    )

    const headings = screen.getAllByRole('heading', { name: /WAITING ·/ })
    expect(headings.map((heading) => heading.textContent)).toEqual([
      'WAITING · origin/main',
      'WAITING · upstream/release',
    ])
    expect(new Set(headings.map((heading) => heading.id)).size).toBe(headings.length)
    expect(container.querySelectorAll('ol')).toHaveLength(2)
    expect(screen.getAllByText(/waiting 10 min/)).toHaveLength(3)
    expect([...container.querySelectorAll('time')].map((time) => time.dateTime)).toEqual([
      'PT10M',
      'PT10M',
      'PT10M',
    ])
    expect(screen.getByText(/POD-835 · main → origin\/main/)).toBeTruthy()
    expect(screen.getByText(/POD-835 · release → origin\/main/)).toBeTruthy()
    expect(screen.queryByText(/ETA/i)).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /Position 1.*main.*origin\/main/ }))
    expect(screen.getByRole('button', { name: 'All shipping' })).toBe(document.activeElement)
    expect(screen.getByText(/Next/).parentElement?.querySelector('time')?.dateTime).toBe('PT10M')
  })

  it('does not present compact hold actions as inert or misleading controls', () => {
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
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /Shipping sidebar panel/ }))
    expect(screen.getByText('DECISION REQUIRED')).toBeTruthy()
    expect(screen.queryByText('Retry shipping')).toBeNull()
    expect(screen.queryByText('Open repair')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Return to issue' })).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('shows receipt availability and identity without claiming to load its proof body', () => {
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
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /Shipping sidebar panel/ }))
    expect(screen.getByText('RECEIPT AVAILABLE')).toBeTruthy()
    expect(screen.getByText('receipt-a')).toBeTruthy()
    expect(screen.getByText('order-a')).toBeTruthy()
    expect(screen.queryByText('Verified')).toBeNull()
    expect(screen.queryByText('DELIVERY RECEIPT')).toBeNull()
  })
})
