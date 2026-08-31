// @vitest-environment happy-dom
/**
 * The two mobile-handoff surfaces, against the three rules that define them
 * (POD-1320): the first task is the gate, the sheet opens on a click and can be
 * put away, and "no thanks" is permanent.
 */
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { parsePodiumLink } from '@podium/protocol'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeIssue } from '@/lib/test-issue'

const fixture = vi.hoisted(() => {
  const rows = new Map<string, string>()
  const listeners = new Set<() => void>()
  const infoQuery = vi.fn()
  return {
    issues: [] as ReturnType<typeof makeIssue>[],
    infoQuery,
    trpc: { setup: { info: { query: infoQuery } } },
    versionFetch: vi.fn(),
    paneA: null as string | null,
    rows,
    uiState: {
      get: (key: string) => rows.get(key) ?? null,
      set: (key: string, value: string | null) => {
        if (value === null) rows.delete(key)
        else rows.set(key, value)
        for (const listener of listeners) listener()
      },
      subscribe: (listener: () => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    },
    reset: () => {
      rows.clear()
      listeners.clear()
      fixture.paneA = null
    },
  }
})

vi.mock('@/app/store', () => ({
  useReplicaIssues: () => fixture.issues,
  useStoreSelector: (selector: (store: unknown) => unknown) =>
    selector({
      uiState: fixture.uiState,
      trpc: fixture.trpc,
      httpOrigin: 'https://local.example',
      issues: fixture.issues,
      selectedIssueId: null,
      selectedWorktree: null,
      workspaces: {},
      paneA: fixture.paneA,
      paneB: null,
      split: false,
      focusedPane: 'A',
    }),
}))

import { MobileHandoffChip } from './MobileHandoffChip'
import { MobilePromoCard } from './MobilePromoCard'
import { mobileHandoffUrl, useMobileHandoffUrl } from './mobile-handoff'

beforeEach(() => {
  fixture.issues = []
  fixture.reset()
  fixture.infoQuery.mockReset()
  fixture.infoQuery.mockResolvedValue({ publicUrl: null })
  fixture.versionFetch.mockReset()
  fixture.versionFetch.mockResolvedValue({
    json: async () => ({ instanceId: 'instance-one' }),
  })
  vi.stubGlobal('fetch', fixture.versionFetch)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const withOneTask = (): void => {
  fixture.issues = [makeIssue({ id: 'iss_1', title: 'First task' })]
  fixture.paneA = 'session-private-id'
}

describe('the first task is the gate', () => {
  it('shows neither surface on a shell with no task', () => {
    render(
      <>
        <MobileHandoffChip />
        <MobilePromoCard />
      </>,
    )
    expect(screen.queryByTestId('mobile-handoff-chip')).toBeNull()
    expect(screen.queryByTestId('mobile-promo-card')).toBeNull()
  })

  it('shows both once a focused session exists', async () => {
    withOneTask()
    render(
      <>
        <MobileHandoffChip />
        <MobilePromoCard />
      </>,
    )
    expect(await screen.findByTestId('mobile-handoff-chip')).toBeTruthy()
    expect(await screen.findByTestId('mobile-promo-card')).toBeTruthy()
  })

  it('shows no destination when the credential-free version response has no instance id', async () => {
    withOneTask()
    fixture.versionFetch.mockResolvedValue({ json: async () => ({}) })
    render(<MobileHandoffChip />)
    await waitFor(() => expect(fixture.versionFetch).toHaveBeenCalledOnce())
    expect(screen.queryByTestId('mobile-handoff-chip')).toBeNull()
  })
})

describe('handoff identity loading', () => {
  it('aborts and fences an old session probe before publishing the replacement session', async () => {
    let resolveOld: ((response: { json(): Promise<unknown> }) => void) | undefined
    fixture.versionFetch
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveOld = resolve
        }),
      )
      .mockResolvedValue({ json: async () => ({ instanceId: 'instance-one' }) })
    const trpc = { setup: { info: { query: fixture.infoQuery } } } as never
    const { result, rerender } = renderHook(
      ({ sessionId }) => useMobileHandoffUrl(trpc, 'https://local.example', sessionId),
      { initialProps: { sessionId: 'old-session' } },
    )
    await waitFor(() => expect(fixture.versionFetch).toHaveBeenCalledOnce())
    const firstSignal = fixture.versionFetch.mock.calls[0]?.[1]?.signal as AbortSignal

    rerender({ sessionId: 'new-session' })
    await waitFor(() => expect(fixture.versionFetch).toHaveBeenCalledTimes(2))
    expect(firstSignal.aborted).toBe(true)
    await waitFor(() =>
      expect(result.current).toBe(
        mobileHandoffUrl('https://local.example', 'instance-one', 'new-session'),
      ),
    )

    await act(async () => {
      resolveOld?.({ json: async () => ({ instanceId: 'old-instance' }) })
      await Promise.resolve()
    })
    expect(result.current).toBe(
      mobileHandoffUrl('https://local.example', 'instance-one', 'new-session'),
    )
  })
})

describe('the footer chip', () => {
  it('opens the sheet on a click and closes it again', async () => {
    withOneTask()
    render(<MobileHandoffChip />)
    expect(screen.queryByTestId('mobile-handoff-sheet')).toBeNull()

    await userEvent.click(await screen.findByTestId('mobile-handoff-chip'))
    await waitFor(() => expect(screen.getByText('Open on your phone')).toBeTruthy())

    await userEvent.click(screen.getByLabelText('Close'))
    await waitFor(() => expect(screen.queryByTestId('mobile-handoff-sheet')).toBeNull())
  })

  it('carries the public URL once the instance reports one', async () => {
    withOneTask()
    fixture.infoQuery.mockResolvedValue({ publicUrl: 'https://podium.example.com' })
    render(<MobileHandoffChip />)
    await userEvent.click(await screen.findByTestId('mobile-handoff-chip'))
    await waitFor(() =>
      expect(screen.getByTestId('mobile-handoff-qr').getAttribute('aria-label')).toBe(
        'Opens the current session in Podium',
      ),
    )
    expect(fixture.versionFetch).toHaveBeenCalledWith(
      'https://local.example/version',
      expect.objectContaining({ credentials: 'omit' }),
    )
  })
})

describe('the address the code resolves to', () => {
  it('is off both surfaces until the code is hovered', async () => {
    withOneTask()
    fixture.infoQuery.mockResolvedValue({ publicUrl: 'https://podium.example.com' })
    render(
      <>
        <MobileHandoffChip />
        <MobilePromoCard />
      </>,
    )
    await userEvent.click(await screen.findByTestId('mobile-handoff-chip'))
    await waitFor(() => expect(screen.getByTestId('mobile-handoff-sheet')).toBeTruthy())
    // Printed nowhere: the camera reads the code, and the plate's label — plus
    // the tooltip it opens — is where the address answers for itself.
    expect(screen.queryByText('the current session in Podium')).toBeNull()
  })

  it('opens in a tooltip when the code is hovered', async () => {
    withOneTask()
    fixture.infoQuery.mockResolvedValue({ publicUrl: 'https://podium.example.com' })
    render(<MobilePromoCard />)
    const plate = await screen.findByTestId('mobile-handoff-qr')
    await waitFor(() =>
      expect(plate.getAttribute('aria-label')).toBe('Opens the current session in Podium'),
    )
    expect(screen.queryByText('the current session in Podium')).toBeNull()
    fireEvent.pointerEnter(plate, { pointerType: 'mouse' })
    fireEvent.mouseEnter(plate)
    fireEvent.mouseMove(plate)
    await waitFor(() => expect(screen.getByText('the current session in Podium')).toBeTruthy())
  })
})

describe('the work-column card', () => {
  it('dismisses for good, and stays gone on the next mount', async () => {
    withOneTask()
    const first = render(<MobilePromoCard />)
    fireEvent.click(await screen.findByTestId('mobile-promo-dismiss'))
    await waitFor(() => expect(screen.queryByTestId('mobile-promo-card')).toBeNull())
    first.unmount()

    render(<MobilePromoCard />)
    expect(screen.queryByTestId('mobile-promo-card')).toBeNull()
  })

  it('stores the refusal where it follows the user, not this browser', async () => {
    withOneTask()
    render(<MobilePromoCard />)
    fireEvent.click(await screen.findByTestId('mobile-promo-dismiss'))
    // The routed ui-state key — replicated per user, see UI_STATE_ROUTES.
    expect(fixture.rows.get('podium.mobile.promoDismissed')).toBe('true')
  })
})

describe('the URL both surfaces point at', () => {
  it('contains only canonical server identity and the opaque session id', () => {
    const href = mobileHandoffUrl(
      'HTTPS://PODIUM.EXAMPLE.COM:443/path',
      'instance-one',
      'session-private-id',
    )
    expect(href).not.toBeNull()
    const link = parsePodiumLink(href ?? '')
    expect(link).toEqual({
      kind: 'internal',
      origin: null,
      target: {
        kind: 'session',
        session: 'session-private-id',
        search: '?origin=https%3A%2F%2Fpodium.example.com&instance=instance-one',
      },
    })
    expect(href).not.toMatch(/password|token|bearer|pair/i)
  })

  it('refuses a destination without a canonical server origin or session', () => {
    expect(mobileHandoffUrl('tauri://localhost', 'instance-one', 'session-private-id')).toBeNull()
    expect(mobileHandoffUrl('https://podium.example.com', '', 'session-private-id')).toBeNull()
    expect(mobileHandoffUrl('https://podium.example.com', 'instance-one', '')).toBeNull()
  })
})
