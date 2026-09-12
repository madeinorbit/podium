import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
const begin = vi.hoisted(() => vi.fn())
vi.mock('../client/hosted-sign-in-runtime', () => ({ hostedSignIn: { begin } }))
vi.mock('react-native', async (original) => ({
  ...(await original<typeof import('react-native')>()),
  Platform: { OS: 'ios' },
}))
vi.mock('./PressableScale', () => ({
  PressableScale: ({ onPress, children, disabled }: any) => (
    <button disabled={disabled} onClick={onPress}>
      {children}
    </button>
  ),
}))
import { HostedSignInButton } from './HostedSignInButton'
afterEach(() => {
  cleanup()
  begin.mockReset()
})
it('opens one browser attempt on repeated presses and offers a retry', async () => {
  let finish!: () => void
  begin.mockReturnValue(
    new Promise<void>((r) => {
      finish = r
    }),
  )
  render(<HostedSignInButton />)
  const button = screen.getByRole('button', { name: 'Continue with Podium Cloud' })
  fireEvent.click(button)
  fireEvent.click(button)
  expect(begin).toHaveBeenCalledTimes(1)
  expect(begin).toHaveBeenCalledWith(
    'https://api.podium.do',
    'https://ade.podium.do/account/sign-in',
  )
  finish()
  await screen.findByText('Finish signing in in your browser, then return to Podium.')
  await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false))
})
it('shows a recoverable error without exposing a server response', async () => {
  begin.mockRejectedValue(new Error('secret response'))
  render(
    <HostedSignInButton
      server="https://api.example"
      signInUrl="https://app.example/account/sign-in"
    />,
  )
  fireEvent.click(screen.getByRole('button'))
  await screen.findByText('Could not start sign-in. Try again.')
  expect(screen.queryByText('secret response')).toBeNull()
})
