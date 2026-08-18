// @vitest-environment happy-dom
/**
 * The two mobile-handoff surfaces, against the three rules that define them
 * (POD-1320): the first task is the gate, the sheet opens on a click and can be
 * put away, and "no thanks" is permanent.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeIssue } from '@/lib/test-issue'

const fixture = vi.hoisted(() => {
  const rows = new Map<string, string>()
  const listeners = new Set<() => void>()
  return {
    issues: [] as ReturnType<typeof makeIssue>[],
    publicUrl: null as string | null,
    infoQuery: vi.fn(),
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
    },
  }
})

vi.mock('@/app/store', () => ({
  useReplicaIssues: () => fixture.issues,
  useStoreSelector: (selector: (store: unknown) => unknown) =>
    selector({
      uiState: fixture.uiState,
      trpc: { setup: { info: { query: fixture.infoQuery } } },
    }),
}))

import { MobileHandoffChip } from './MobileHandoffChip'
import { MobilePromoCard } from './MobilePromoCard'
import { mobileHandoffUrl } from './mobile-handoff'

beforeEach(() => {
  fixture.issues = []
  fixture.reset()
  fixture.infoQuery.mockReset()
  fixture.infoQuery.mockResolvedValue({ publicUrl: null })
})

afterEach(() => {
  cleanup()
})

const withOneTask = (): void => {
  fixture.issues = [makeIssue({ id: 'iss_1', title: 'First task' })]
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

  it('shows both once a task exists', () => {
    withOneTask()
    render(
      <>
        <MobileHandoffChip />
        <MobilePromoCard />
      </>,
    )
    expect(screen.getByTestId('mobile-handoff-chip')).toBeTruthy()
    expect(screen.getByTestId('mobile-promo-card')).toBeTruthy()
  })
})

describe('the footer chip', () => {
  it('opens the sheet on a click and closes it again', async () => {
    withOneTask()
    render(<MobileHandoffChip />)
    expect(screen.queryByTestId('mobile-handoff-sheet')).toBeNull()

    fireEvent.click(screen.getByTestId('mobile-handoff-chip'))
    await waitFor(() => expect(screen.getByText('Open on your phone')).toBeTruthy())

    fireEvent.click(screen.getByLabelText('Close'))
    await waitFor(() => expect(screen.queryByTestId('mobile-handoff-sheet')).toBeNull())
  })

  it('carries the public URL once the instance reports one', async () => {
    withOneTask()
    fixture.infoQuery.mockResolvedValue({ publicUrl: 'https://podium.example.com' })
    render(<MobileHandoffChip />)
    fireEvent.click(screen.getByTestId('mobile-handoff-chip'))
    await waitFor(() => expect(screen.getByText('podium.example.com/mobile')).toBeTruthy())
  })
})

describe('the work-column card', () => {
  it('dismisses for good, and stays gone on the next mount', async () => {
    withOneTask()
    const first = render(<MobilePromoCard />)
    fireEvent.click(screen.getByTestId('mobile-promo-dismiss'))
    await waitFor(() => expect(screen.queryByTestId('mobile-promo-card')).toBeNull())
    first.unmount()

    render(<MobilePromoCard />)
    expect(screen.queryByTestId('mobile-promo-card')).toBeNull()
  })

  it('stores the refusal where it follows the user, not this browser', () => {
    withOneTask()
    render(<MobilePromoCard />)
    fireEvent.click(screen.getByTestId('mobile-promo-dismiss'))
    // The routed ui-state key — replicated per user, see UI_STATE_ROUTES.
    expect(fixture.rows.get('podium.mobile.promoDismissed')).toBe('true')
  })
})

describe('the URL both surfaces point at', () => {
  it('is /mobile on the given origin, with no query or fragment', () => {
    expect(mobileHandoffUrl('https://podium.example.com')).toBe('https://podium.example.com/mobile')
    expect(mobileHandoffUrl('https://podium.example.com/?x=1#y')).toBe(
      'https://podium.example.com/mobile',
    )
  })
})
