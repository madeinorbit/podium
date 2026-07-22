// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeIssue } from '@/lib/test-issue'
import { IssueCompactControls } from './IssueCompactControls'

vi.mock('@/lib/use-feature', () => ({ useFeature: () => false }))

const setOpenIssueId = vi.fn()
const setView = vi.fn()
const navigateToSession = vi.fn()
const archiveSession = vi.fn(async () => {})

vi.mock('@/app/store', () => {
  const state = () => ({
    trpc: {
      issues: {
        start: { mutate: vi.fn(async () => ({})) },
        close: { mutate: vi.fn(async () => ({})) },
        update: { mutate: vi.fn(async () => ({})) },
        clearNeedsHuman: { mutate: vi.fn(async () => ({})) },
      },
      sessions: { sendText: { mutate: vi.fn(async () => ({})) } },
    },
    issues: [],
    setOpenIssueId,
    setView,
    navigateToSession,
    archiveSession,
    markIssueRead: vi.fn(),
    markIssueUnread: vi.fn(),
    sessions: [],
    repos: [],
    machines: [],
    httpOrigin: '',
  })
  return {
    useStore: () => state(),
    useStoreSelector: (selector: (value: ReturnType<typeof state>) => unknown) => selector(state()),
  }
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('IssueCompactControls', () => {
  it('uses full-page language only for the real full issue destination', () => {
    render(
      <IssueCompactControls
        issue={makeIssue({ id: 'i', description: 'A concise human-facing summary.' })}
      />,
    )

    fireEvent.click(screen.getByTestId('compact-open-full'))
    expect(setOpenIssueId).toHaveBeenCalledWith('i')
    expect(setView).toHaveBeenCalledWith('issues')
    expect(screen.getByText('A concise human-facing summary.')).toBeTruthy()
  })

  it('omits unrelated shared checkout dirt', () => {
    render(
      <IssueCompactControls
        issue={makeIssue({
          gitState: {
            updatedAt: '2026-07-22T00:00:00.000Z',
            branch: 'main',
            shared: true,
            dirtyFiles: 26,
            fallback: true,
          },
        })}
      />,
    )

    expect(screen.queryByText(/26 dirty/)).toBeNull()
  })
})
