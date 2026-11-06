// @vitest-environment jsdom
import type { UpdateSpacePreview } from '@podium/protocol'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Trpc } from '@/app/trpc'
import type { UpdatePanelView } from './operation-view'
import { UpdatePanel } from './UpdatePanel'
import { UpdateSpaceNotice } from './UpdateSpaceNotice'

afterEach(cleanup)
beforeEach(() => {
  window.matchMedia = vi
    .fn()
    .mockReturnValue({ matches: false, addEventListener() {}, removeEventListener() {} })
})
const GiB = 1024 ** 3

describe('informational disk warning', () => {
  function offer(query: () => Promise<unknown>, patch: Partial<UpdatePanelView> = {}) {
    const onAction = vi.fn()
    const client = { updates: { checkSpace: { query } } } as unknown as Pick<Trpc, 'updates'>
    const view: UpdatePanelView = {
      state: 'offer' as const,
      title: 'Update available',
      version: 'next',
      steps: [],
      awaitingElsewhere: [],
      indicator: 'idle-dot' as const,
      indicatorLabel: 'Update available',
      primary: { kind: 'start' as const, label: 'Update now', pendingLabel: 'Starting…' },
      ...patch,
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
    'enough',
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
            status !== 'unknown'
              ? [
                  {
                    path: '/var/lib/podium',
                    availableBytes: status === 'low' ? Math.floor(1.2 * GiB) : 20 * GiB,
                    peakBytes: 2 * GiB,
                    requiredBytes: 3 * GiB,
                    shortfallBytes: status === 'low' ? Math.floor(1.8 * GiB) : 0,
                  },
                ]
              : [],
        },
      ],
    }
    const query = vi.fn().mockResolvedValue(result)
    const f = offer(query)
    const notice = screen.getByTestId('update-space-notice')
    await screen.findByText(
      status === 'low'
        ? /Low disk space on build-box/
        : status === 'enough'
          ? 'Disk space looks sufficient'
          : 'Disk space could not be verified.',
    )
    const button = screen.getByRole('button', { name: 'Update now' })
    expect(button.hasAttribute('disabled')).toBe(false)
    fireEvent.click(button)
    expect(f.onAction).toHaveBeenCalledWith('start')
    expect(query).toHaveBeenCalledTimes(1)
    expect(notice.querySelector('details')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Check again' })).toBeNull()
  })

  it.each([
    'stable',
    'dev',
  ] as const)('preserves the %s release content and places the warning above the original footer', async (channel) => {
    const query = vi.fn().mockResolvedValue({
      machines: [
        {
          machineId: 'build',
          name: 'build-box',
          targetVersion: 'next',
          status: 'low',
          checkedAt: 1,
          volumes: [
            {
              path: '/var/lib/podium',
              availableBytes: GiB,
              peakBytes: 2 * GiB,
              requiredBytes: 3 * GiB,
              shortfallBytes: 2 * GiB,
            },
          ],
        },
      ],
    })
    offer(query, {
      channel,
      notes: {
        summary:
          '**Calmer updates.**\n\n### What’s new\n\n- **Sessions.** Your work keeps running.',
        url: 'https://example.test/release',
      },
      commits: [{ sha: 'abcdef0', summary: 'Polish update cards' }],
      commitCount: 25,
      dismiss: { label: 'Later' },
    })
    await screen.findByText(/Low disk space on build-box/)
    const notice = screen.getByTestId('update-space-notice')
    const panel = screen.getByTestId('update-panel')
    const footer = panel.querySelector('footer')
    if (!footer) throw new Error('Missing update actions')
    expect(panel.className).toBe('update-card')
    expect(notice.compareDocumentPosition(footer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Later' })).toBeTruthy()
    if (channel === 'dev') {
      const commits = screen.getByRole('tab', { name: 'Commits (25)' })
      expect(commits.getAttribute('aria-selected')).toBe('true')
      expect(screen.getByText('Polish update cards')).toBeTruthy()
      fireEvent.keyDown(commits, { key: 'End' })
      expect(screen.getByRole('tab', { name: /Notes/ }).getAttribute('aria-selected')).toBe('true')
    }
    expect(screen.getByText('Calmer updates.')).toBeTruthy()
    expect(screen.getByText('Your work keeps running.')).toBeTruthy()
    expect(screen.getByTestId('update-notes-link').getAttribute('href')).toBe(
      'https://example.test/release',
    )
    expect(
      screen.getByTestId('update-notes').compareDocumentPosition(notice) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Update now' }))
    expect(query).toHaveBeenCalledTimes(1)
  })

  it('unmounts the informational readout when the offer becomes a running update', () => {
    const query = vi.fn(() => new Promise<unknown>(() => {}))
    const f = offer(query)
    f.rerender(<UpdatePanel {...f.props} view={{ ...f.props.view, state: 'running' }} />)
    expect(screen.queryByTestId('update-space-notice')).toBeNull()
    expect(query).toHaveBeenCalledTimes(1)
  })

  it('checks only on presentation, ignoring late answers after replacement', async () => {
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
    await act(async () => {
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
    })
    expect(screen.getByText('No pending machine updates')).toBeTruthy()
    expect(query).toHaveBeenCalledTimes(2)
  })
})
