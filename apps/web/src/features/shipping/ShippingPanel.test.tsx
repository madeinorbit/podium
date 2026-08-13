// @vitest-environment happy-dom

import type { ShipOrderProjection } from '@podium/model'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeIssue } from '@/lib/test-issue'
import { ShippingPanel, type ShippingPanelCommands } from './ShippingPanel'

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

const commands = (over: Partial<ShippingPanelCommands> = {}): ShippingPanelCommands => ({
  resolveHold: vi.fn(async () => ({})),
  cancelOrder: vi.fn(async () => ({ state: 'cancelled' })),
  getReceipt: vi.fn(async () => null),
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
        commands={commands()}
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
        commands={commands()}
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

  it('submits typed hold actions with the projection generation fence', async () => {
    const resolveHold = vi.fn(async () => ({}))
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
        commands={commands({ resolveHold })}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /Shipping sidebar panel/ }))
    expect(screen.getByText('DECISION REQUIRED')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Let Podium retry' }))
    expect(resolveHold).toHaveBeenCalledWith({
      orderId: 'order-a',
      action: 'retry',
      expectedGeneration: 2,
    })
    expect(
      await screen.findByText('Decision received. Shipping is updating this order.'),
    ).toBeTruthy()
    expect(
      (screen.getByRole('button', { name: 'Open repair' }) as HTMLButtonElement).disabled,
    ).toBe(true)
    expect(
      (screen.getByRole('button', { name: 'Return to issue' }) as HTMLButtonElement).disabled,
    ).toBe(true)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('reports a refused hold decision once and leaves the typed actions available', async () => {
    const resolveHold = vi.fn(async () => {
      throw new Error('Shipping hold generation changed')
    })
    render(
      <ShippingPanel
        orders={[
          order({
            state: 'held',
            humanState: 'needs_you',
            activity: 'held',
            hold: {
              id: 'hold-a' as never,
              generation: 3,
              reasonCode: 'landing-conflict',
              headline: 'Podium cannot choose the intended behavior',
              actions: ['retry', 'return-to-issue'],
            },
          }),
        ]}
        issues={[issue]}
        repoId="repo-a"
        now={Date.parse('2026-08-13T12:00:00.000Z')}
        commands={commands({ resolveHold })}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /Shipping sidebar panel/ }))
    expect(screen.queryByRole('alert')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Return to issue' }))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe('Shipping hold generation changed')
    expect(screen.getAllByRole('alert')).toHaveLength(1)
    expect(
      (screen.getByRole('button', { name: 'Let Podium retry' }) as HTMLButtonElement).disabled,
    ).toBe(false)
  })

  it('cancels a live order through the order-scoped command', async () => {
    const cancelOrder = vi.fn(async () => ({ state: 'cancelled' as const }))
    render(
      <ShippingPanel
        orders={[order()]}
        issues={[issue]}
        repoId="repo-a"
        now={Date.parse('2026-08-13T12:00:00.000Z')}
        commands={commands({ cancelOrder })}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /Shipping sidebar panel/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel shipping' }))

    expect(cancelOrder).toHaveBeenCalledWith({ orderId: 'order-a' })
    expect(
      await screen.findByText(
        'Cancellation request received. Waiting for Shipping to update this order.',
      ),
    ).toBeTruthy()
  })

  it('keeps cancellation available when a successful command returns a held order', async () => {
    const cancelOrder = vi.fn(async () => ({ state: 'held' as const }))
    render(
      <ShippingPanel
        orders={[order()]}
        issues={[issue]}
        repoId="repo-a"
        now={Date.parse('2026-08-13T12:00:00.000Z')}
        commands={commands({ cancelOrder })}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /Shipping sidebar panel/ }))
    const cancel = screen.getByRole('button', { name: 'Cancel shipping' }) as HTMLButtonElement
    fireEvent.click(cancel)

    expect(
      await screen.findByText(
        'Cancellation request was processed, but Shipping still needs attention. Waiting for the latest order state.',
      ),
    ).toBeTruthy()
    expect(cancel.disabled).toBe(false)
    expect(screen.getByText('Running checks')).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('loads and renders the completed order’s typed delivery receipt', async () => {
    const getReceipt = vi.fn(async () => ({
      id: 'receipt-a' as never,
      orderId: 'order-a' as never,
      approvedBaseSha: 'base-123456789',
      approvedHeadSha: 'head-123456789',
      testedIntegrationSha: 'tested-123456789',
      landedRefSha: 'landed-123456789',
      destinationSha: 'destination-123456789',
      validationProfileId: 'repository-profile',
      validationResult: 'passed' as const,
      destination: 'origin/main',
      completedAt: '2026-08-13T12:00:00.000Z',
    }))
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
        commands={commands({ getReceipt })}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /Shipping sidebar panel/ }))
    expect(await screen.findByText('base-123456789')).toBeTruthy()
    expect(screen.getByText('DELIVERY RECEIPT')).toBeTruthy()
    expect(getReceipt).toHaveBeenCalledWith({ orderId: 'order-a' })
    expect(screen.getByText('receipt-a')).toBeTruthy()
    expect(screen.getByText('order-a')).toBeTruthy()
    expect(screen.getByText('head-123456789')).toBeTruthy()
    expect(screen.getByText('tested-123456789')).toBeTruthy()
    expect(screen.getByText('landed-123456789')).toBeTruthy()
    expect(screen.getByText('destination-123456789')).toBeTruthy()
    expect(screen.getByText('repository-profile · passed')).toBeTruthy()
    expect(screen.queryByText(/details are not loaded/i)).toBeNull()
    expect(screen.getByRole('button', { name: 'All shipping' })).toBe(document.activeElement)
  })
})
