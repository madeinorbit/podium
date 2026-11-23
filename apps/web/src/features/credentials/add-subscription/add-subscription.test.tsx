/**
 * Adding a subscription by signing in on a machine (credential management §6
 * way 2; epic Task 9, acceptance 8): waiting for sign-in, signed in as a named
 * account, failed. The server is a fake of the three calls; nothing here sees
 * a login.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AddSubscription,
  type SubscriptionSignInCommands,
  type SubscriptionSignInStatus,
  signedInSentence,
} from './add-subscription'

const STARTED = { credentialId: 'cred_new', terminalSessionId: 'session:signin-terminal' }
const WAITING: SubscriptionSignInStatus = {
  state: 'waiting',
  machineId: 'machine:desk',
  terminalSessionId: STARTED.terminalSessionId,
}
const SIGNED_IN: SubscriptionSignInStatus = {
  state: 'signed-in',
  credentialId: 'cred_new',
  label: 'Second Max',
  email: 'second@example.test',
  outcome: 'new',
}

function fakeServer(status: SubscriptionSignInStatus[] = []) {
  const statuses = [...status]
  return {
    signInStart: { mutate: vi.fn(async () => STARTED) },
    signInCancel: { mutate: vi.fn(async () => ({ ok: true })) },
    signInStatus: {
      query: vi.fn(async (): Promise<SubscriptionSignInStatus> => statuses.shift() ?? WAITING),
    },
  } satisfies SubscriptionSignInCommands
}

function show(
  commands: SubscriptionSignInCommands,
  machines = [
    { id: 'machine:desk', name: 'Desk' },
    { id: 'machine:laptop', name: 'Laptop' },
  ],
) {
  const reload = vi.fn()
  const openTerminal = vi.fn()
  const onDone = vi.fn()
  render(
    <AddSubscription
      commands={commands}
      deps={{ reload }}
      machines={machines}
      openTerminal={openTerminal}
      pollMs={10}
      onDone={onDone}
    />,
  )
  return { reload, openTerminal, onDone }
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('Add a subscription', () => {
  it('opens native Google sign-in on the selected machine and explains the authorization-code step', async () => {
    const commands = fakeServer()
    const { openTerminal } = show(commands)
    fireEvent.click(screen.getByRole('radio', { name: /Google AI subscription/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Sign in on Desk' }))
    expect(
      await screen.findByText(/Waiting for you to sign in to your Google AI subscription/),
    ).toBeTruthy()
    expect(commands.signInStart.mutate).toHaveBeenCalledWith({
      type: 'google.antigravity-login',
      machineId: 'machine:desk',
    })
    expect(openTerminal).toHaveBeenCalledWith(STARTED.terminalSessionId)
    expect(screen.getByText(/Paste the authorization code/)).toBeTruthy()
  })
  it('waiting for sign-in: the terminal opens on the chosen machine and the screen says what to do there', async () => {
    const commands = fakeServer()
    const { openTerminal } = show(commands)
    fireEvent.click(screen.getByRole('radio', { name: /ChatGPT subscription/ }))
    fireEvent.change(screen.getByLabelText('Machine'), { target: { value: 'machine:laptop' } })
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Work ChatGPT' } })
    fireEvent.click(screen.getByRole('button', { name: 'Sign in on Laptop' }))
    expect(
      await screen.findByText(
        /Waiting for you to sign in to your ChatGPT subscription in the terminal on Laptop/,
      ),
    ).toBeTruthy()
    expect(commands.signInStart.mutate).toHaveBeenCalledWith({
      type: 'openai.chatgpt-login',
      machineId: 'machine:laptop',
      label: 'Work ChatGPT',
    })
    expect(openTerminal).toHaveBeenCalledWith(STARTED.terminalSessionId)
    // Codex's device sign-in, and where ChatGPT keeps the device-code switch.
    expect(screen.getByText(/enter the one-time code/)).toBeTruthy()
    expect(screen.getByText(/allow device codes.*Settings › Security/)).toBeTruthy()
    await waitFor(() =>
      expect(commands.signInStatus.query).toHaveBeenCalledWith({ credentialId: 'cred_new' }),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Open the sign-in terminal' }))
    expect(openTerminal).toHaveBeenCalledTimes(2)
  })

  it('waiting for a Claude sign-in names the paste-code step', async () => {
    show(fakeServer())
    fireEvent.click(screen.getByRole('button', { name: 'Sign in on Desk' }))
    expect(
      await screen.findByText(/Waiting for you to sign in to your Claude subscription/),
    ).toBeTruthy()
    expect(screen.getByText(/paste the code/)).toBeTruthy()
  })

  it('cancel gives the sign-in up on the server', async () => {
    const commands = fakeServer()
    const { onDone } = show(commands)
    fireEvent.click(screen.getByRole('button', { name: 'Sign in on Desk' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel sign-in' }))
    await waitFor(() => expect(onDone).toHaveBeenCalled())
    expect(commands.signInCancel.mutate).toHaveBeenCalledWith({ credentialId: 'cred_new' })
  })

  it('signed in as a named account: the account that signed in is named, and the list reloads', async () => {
    const commands = fakeServer([WAITING, SIGNED_IN])
    const { reload } = show(commands)
    fireEvent.click(screen.getByRole('button', { name: 'Sign in on Desk' }))
    expect(
      await screen.findByText('Signed in as second@example.test. Added as “Second Max”.'),
    ).toBeTruthy()
    expect(commands.signInStart.mutate).toHaveBeenCalledWith({
      type: 'anthropic.claude-login',
      machineId: 'machine:desk',
    })
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('failed: the reason, and a way to try again', async () => {
    const commands = fakeServer([
      { state: 'failed', reason: 'The sign-in ended without signing in (exit 1).' },
    ])
    show(commands)
    fireEvent.click(screen.getByRole('button', { name: 'Sign in on Desk' }))
    expect((await screen.findByRole('alert')).textContent).toBe(
      'The sign-in ended without signing in (exit 1).',
    )
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(screen.getByRole('button', { name: 'Sign in on Desk' })).toBeTruthy()
  })

  it('a refused start shows the server’s sentence', async () => {
    const commands = fakeServer()
    commands.signInStart.mutate.mockRejectedValueOnce(
      new Error("This credential's owner has not sent it to this machine."),
    )
    show(commands)
    fireEvent.click(screen.getByRole('button', { name: 'Sign in on Desk' }))
    expect((await screen.findByRole('alert')).textContent).toBe(
      "This credential's owner has not sent it to this machine.",
    )
  })

  it('with no connected machine there is nothing to sign in on', () => {
    show(fakeServer(), [])
    expect(screen.getByRole('alert').textContent).toMatch(/None of your machines is connected/)
    expect((screen.getByRole('button', { name: /Sign in on/ }) as HTMLButtonElement).disabled).toBe(
      true,
    )
  })
})

describe('who signed in, in words (review focus 5)', () => {
  const base = { state: 'signed-in' as const, credentialId: 'c', label: 'Account A' }
  it('names the account that actually signed in for every outcome', () => {
    expect(signedInSentence({ ...base, email: 'b@example.test', outcome: 'attached' })).toBe(
      'Signed in as b@example.test. You already had “Account A” for this account, so this sign-in was added to it.',
    )
    expect(
      signedInSentence({
        ...base,
        email: 'b@example.test',
        previousEmail: 'a@example.test',
        outcome: 'identity-changed',
      }),
    ).toBe(
      'Signed in as b@example.test, not a@example.test. “Account A” now uses b@example.test, the account that signed in.',
    )
    expect(signedInSentence({ ...base, email: 'a@example.test', outcome: 'same' })).toBe(
      'Signed in again as a@example.test.',
    )
    expect(
      signedInSentence({
        ...base,
        label: 'b@example.test',
        email: 'b@example.test',
        outcome: 'new',
      }),
    ).toBe('Signed in as b@example.test.')
  })
})
