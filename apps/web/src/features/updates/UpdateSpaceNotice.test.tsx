import type { UpdateSpacePreview } from '@podium/protocol'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Trpc } from '@/app/trpc'
import { UpdatePanel } from './UpdatePanel'
import { UpdateSpaceNotice } from './UpdateSpaceNotice'

afterEach(cleanup)
const GiB = 1024 ** 3

describe('informational disk warning', () => {
  function offer(query: () => Promise<unknown>) {
    const onAction = vi.fn()
    const client = { updates: { checkSpace: { query } } } as unknown as Pick<Trpc, 'updates'>
    const view = {
      state: 'offer' as const,
      title: 'Update available',
      version: 'next',
      steps: [],
      awaitingElsewhere: [],
      indicator: 'idle-dot' as const,
      indicatorLabel: 'Update available',
      primary: { kind: 'start' as const, label: 'Update now', pendingLabel: 'Starting…' },
    }
    const props = {
      view,
      pending: null,
      onAction,
      onHide: vi.fn(),
      spacePreview: <UpdateSpaceNotice client={client} expectedVersion="next" />,
    }
    const result = render(<UpdatePanel {...props} />)
    return { ...result, onAction, props, client }
  }

  it('starts immediately while a preview has not answered', () => {
    const query = vi.fn(() => new Promise<unknown>(() => {}))
    const f = offer(query)
    fireEvent.click(screen.getByRole('button', { name: 'Update now' }))
    expect(f.onAction).toHaveBeenCalledWith('start')
    expect(query).toHaveBeenCalledTimes(1)
  })

  it.each([
    'low',
    'unknown',
  ] as const)('leaves Update enabled for %s, with no check on clicking Update', async (status) => {
    const result: UpdateSpacePreview = {
      machines: [
        {
          machineId: 'build',
          name: 'build-box',
          targetVersion: 'next',
          status,
          checkedAt: 1,
          volumes:
            status === 'low'
              ? [
                  {
                    path: '/var/lib/podium',
                    availableBytes: Math.floor(1.2 * GiB),
                    peakBytes: 2 * GiB,
                    requiredBytes: 3 * GiB,
                    shortfallBytes: Math.floor(1.8 * GiB),
                  },
                ]
              : [],
        },
      ],
    }
    const query = vi.fn().mockResolvedValue(result)
    const f = offer(query)
    await screen.findByText(
      status === 'low' ? /Low disk space on build-box/ : /could not be verified on build-box/,
    )
    const button = screen.getByRole('button', { name: 'Update now' })
    expect(button.hasAttribute('disabled')).toBe(false)
    fireEvent.click(button)
    expect(f.onAction).toHaveBeenCalledWith('start')
    expect(query).toHaveBeenCalledTimes(1)
    if (status === 'low') expect(screen.getByText(/Free at least .* on this volume/)).toBeTruthy()
  })

  it('checks only on presentation and manual refresh, ignoring late answers after replacement', async () => {
    let resolve!: (result: unknown) => void
    const query = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((r) => {
            resolve = r
          }),
      )
      .mockResolvedValue({ machines: [] })
    const f = offer(query)
    f.rerender(
      <UpdatePanel
        {...f.props}
        spacePreview={<UpdateSpaceNotice client={f.client} expectedVersion="different" />}
      />,
    )
    await waitFor(() => expect(query).toHaveBeenCalledTimes(2))
    resolve({
      machines: [
        {
          machineId: 'old',
          name: 'obsolete',
          targetVersion: 'next',
          status: 'unknown',
          checkedAt: 1,
          volumes: [],
        },
      ],
    })
    await waitFor(() => expect(screen.queryByText(/obsolete/)).toBeNull())
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }))
    await waitFor(() => expect(query).toHaveBeenCalledTimes(3))
  })
})
