// @vitest-environment happy-dom
import type { SessionIssueOutcome } from '@podium/client-core/values'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { IssueOutcomeCard } from './IssueOutcomeCard'

const store = vi.hoisted(() => ({
  setIssueTucked: vi.fn(async (_id: string, _tucked: boolean) => undefined),
  updateIssue: vi.fn(async () => undefined),
}))
vi.mock('@/app/store', () => ({
  readFixture: (read: (state: typeof store) => unknown) => read(store),
}))

afterEach(() => {
  cleanup()
  store.setIssueTucked.mockReset()
  store.setIssueTucked.mockImplementation(async () => undefined)
})

const closed = (patch: Partial<SessionIssueOutcome>): SessionIssueOutcome =>
  ({ kind: 'closed', at: null, reason: 'done', issueId: 'root', ...patch }) as SessionIssueOutcome

// POD-2293: the card files a task away only where the sidebar can fold its row.
it('offers Tuck only where the sidebar row offers it, and Archive always', () => {
  render(<IssueOutcomeCard outcome={closed({ tuckable: false, tucked: false })} />)

  expect(screen.queryByRole('button', { name: /Tuck/ })).toBeNull()
  expect(screen.getByRole('button', { name: /Archive/ })).toBeTruthy()
})

it('shows an already tucked task as Tucked, not as a second Tuck', () => {
  render(<IssueOutcomeCard outcome={closed({ tuckable: false, tucked: true })} />)

  const button = screen.getByRole('button', { name: /Tucked/ }) as HTMLButtonElement
  expect(button.disabled).toBe(true)
})

it('sends one tuck however fast it is clicked, until the write settles', async () => {
  let settle!: () => void
  store.setIssueTucked.mockImplementation(
    () =>
      new Promise<undefined>((resolve) => {
        settle = () => resolve(undefined)
      }),
  )
  render(<IssueOutcomeCard outcome={closed({ tuckable: true, tucked: false })} />)
  const button = screen.getByRole('button', { name: /Tuck/ }) as HTMLButtonElement

  fireEvent.click(button)
  fireEvent.click(button)

  expect(store.setIssueTucked).toHaveBeenCalledTimes(1)
  expect(store.setIssueTucked).toHaveBeenCalledWith('root', true)
  expect(button.disabled).toBe(true)
  await act(async () => settle())
  expect(button.disabled).toBe(false)
})
