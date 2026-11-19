import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { CurrentInterface } from './CurrentInterface'

const repair = vi.hoisted(() => vi.fn())
vi.mock('@/lib/boot-interface', () => ({ repairInterfaceOnBoot: repair }))
vi.mock('./trpc', () => ({ serverConfig: () => ({ httpOrigin: 'https://podium.example' }) }))

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

it('does not mount sign-in until the served interface is checked', async () => {
  let settle!: (value: 'ready') => void
  repair.mockReturnValue(
    new Promise((resolve) => {
      settle = resolve
    }),
  )
  render(
    <CurrentInterface>
      <p>Sign in</p>
    </CurrentInterface>,
  )
  expect(screen.queryByText('Sign in')).toBeNull()
  await act(async () => settle('ready'))
  expect(screen.getByText('Sign in')).toBeTruthy()
})

it('shows a retryable error when a reload fails to navigate', async () => {
  vi.useFakeTimers()
  repair.mockResolvedValue('reloading')
  render(
    <CurrentInterface>
      <p>Sign in</p>
    </CurrentInterface>,
  )
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10000)
  })
  expect(screen.getByRole('alert').textContent).toContain('did not finish')
  expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy()
  expect(screen.queryByText('Sign in')).toBeNull()
})
