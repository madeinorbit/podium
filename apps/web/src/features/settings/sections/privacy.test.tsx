/**
 * Settings → Privacy tests [spec:SP-f933].
 *
 * The behaviours that matter: the toggle self-persists (no Save button to
 * forget), a kill switch disables it WITH the reason, and the page shows the
 * real report rather than marketing copy.
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const trpcMock = vi.hoisted(() => ({
  state: vi.fn(),
  set: vi.fn(),
  resetId: vi.fn(),
  preview: vi.fn(),
}))

vi.mock('@/app/store', () => ({
  useStoreSelector: (fn: (s: unknown) => unknown) =>
    fn({
      trpc: {
        telemetry: {
          state: { query: trpcMock.state },
          set: { mutate: trpcMock.set },
          resetId: { mutate: trpcMock.resetId },
          preview: { query: trpcMock.preview },
        },
      },
    }),
}))

import { PrivacySection } from './privacy'

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

const OFF = { usage: 'absent', crash: 'absent', endpoint: 'https://telemetry.podium.dev' }

beforeEach(() => {
  trpcMock.state.mockResolvedValue(OFF)
  trpcMock.preview.mockResolvedValue(null)
  trpcMock.set.mockImplementation(async (input: Record<string, string>) => ({
    ...OFF,
    ...input,
    installId: '3f9c1a2e-0000-4000-8000-000000000000',
  }))
  trpcMock.resetId.mockResolvedValue({ ...OFF, installId: 'new-id-0000-4000-8000-000000000000' })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

const renderSection = async () => {
  const { container } = render(<PrivacySection />)
  await act(async () => {
    await flush()
  })
  return within(container)
}

describe('PrivacySection', () => {
  it('shows both tiers off on a fresh install', async () => {
    const view = await renderSection()
    expect(view.getByTestId('telemetry-usage').getAttribute('aria-checked')).toBe('false')
    expect(view.getByTestId('telemetry-crash').getAttribute('aria-checked')).toBe('false')
    expect(view.getAllByText(/never enabled/i).length).toBe(2)
  })

  it('persists a toggle IMMEDIATELY — there is no Save button to forget', async () => {
    const view = await renderSection()
    await act(async () => {
      // The Switch is a Base UI button with no htmlFor label — click it directly.
      fireEvent.click(view.getByTestId('telemetry-usage'))
      await flush()
    })
    expect(trpcMock.set).toHaveBeenCalledWith({ usage: 'on' })
  })

  it('toggles each tier independently', async () => {
    const view = await renderSection()
    await act(async () => {
      fireEvent.click(view.getByTestId('telemetry-crash'))
      await flush()
    })
    expect(trpcMock.set).toHaveBeenCalledWith({ crash: 'on' })
    expect(trpcMock.set).not.toHaveBeenCalledWith(
      expect.objectContaining({ usage: expect.anything() }),
    )
  })

  it('reverts the switch when the write fails (never a false "off")', async () => {
    trpcMock.set.mockRejectedValue(new Error('disk full'))
    const view = await renderSection()
    await act(async () => {
      fireEvent.click(view.getByTestId('telemetry-usage'))
      await flush()
    })
    expect(view.getByTestId('telemetry-usage').getAttribute('aria-checked')).toBe('false')
    expect(view.getByRole('alert').textContent).toContain('disk full')
  })

  it('disables the switches and says WHY under a kill switch', async () => {
    trpcMock.state.mockResolvedValue({ ...OFF, suppressedBy: 'DO_NOT_TRACK' })
    const view = await renderSection()
    expect(view.getByTestId('telemetry-suppressed').textContent).toContain('DO_NOT_TRACK')
    expect(view.getByTestId('telemetry-usage').hasAttribute('data-disabled')).toBe(true)
  })

  it('shows the example report before anyone opts in', async () => {
    const view = await renderSection()
    expect(view.getByTestId('telemetry-report').textContent).toContain('"installAge": "1-7d"')
    expect(view.getByText(/what a report looks like/i)).toBeTruthy()
  })

  it('shows the REAL pending report once there is one', async () => {
    trpcMock.preview.mockResolvedValue({ schema: 1, sessions: { codex: 7 } })
    const view = await renderSection()
    expect(view.getByText(/your next report/i)).toBeTruthy()
    expect(view.getByTestId('telemetry-report').textContent).toContain('"codex": 7')
  })

  it('names what is never sent, and where reports go', async () => {
    const view = await renderSection()
    expect(view.getByText(/never sent:/i).textContent).toMatch(/repo names/i)
    expect(view.getByText(/drops your IP/i).textContent).toContain('telemetry.podium.dev')
  })

  it('offers a reset only once an install id exists', async () => {
    expect((await renderSection()).queryByRole('button', { name: /reset/i })).toBeNull()
    cleanup()
    trpcMock.state.mockResolvedValue({ ...OFF, usage: 'on', installId: 'abc' })
    const view = await renderSection()
    await act(async () => {
      fireEvent.click(view.getByRole('button', { name: /reset/i }))
      await flush()
    })
    expect(trpcMock.resetId).toHaveBeenCalled()
  })
})
