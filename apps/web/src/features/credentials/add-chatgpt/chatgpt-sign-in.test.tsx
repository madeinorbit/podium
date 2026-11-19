/**
 * Sign in with ChatGPT on the credentials page (credential management §11;
 * epic Task 14, acceptance 11): waiting, paste instead, signed in as a named
 * account, failed. The server is a fake of the three calls; nothing here sees
 * a token.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChatgptSignIn, type ChatgptSignInCommands, type ChatgptStatus } from './chatgpt-sign-in'
import { listeningMachines } from './section'

const AUTHORIZE = 'https://auth.openai.com/api/accounts/authorize?client_id=dynamic_agent_client'
const SIGNED_IN: ChatgptStatus = {
  state: 'signed-in',
  credentialId: 'cred_new',
  label: 'My ChatGPT',
  email: 'person@example.test',
  planEnabled: true,
  updated: false,
}

function fakeServer(opts: { via: 'machine' | 'paste'; status?: ChatgptStatus[] }) {
  const statuses = [...(opts.status ?? [])]
  const commands = {
    chatgptSignInStart: {
      mutate: vi.fn(async () => ({
        attemptId: 'chatgpt_1',
        authorizeUrl: AUTHORIZE,
        via: opts.via,
      })),
    },
    chatgptSignInComplete: { mutate: vi.fn(async (): Promise<ChatgptStatus> => SIGNED_IN) },
    chatgptSignInStatus: {
      query: vi.fn(async (): Promise<ChatgptStatus> => statuses.shift() ?? { state: 'waiting' }),
    },
  } satisfies ChatgptSignInCommands
  return commands
}

function show(commands: ChatgptSignInCommands, machines = [{ id: 'machine:desk', name: 'Desk' }]) {
  const reload = vi.fn()
  const openUrl = vi.fn()
  const onDone = vi.fn()
  render(
    <ChatgptSignIn
      commands={commands}
      deps={{ reload }}
      machines={machines}
      openUrl={openUrl}
      pollMs={10}
      onDone={onDone}
    />,
  )
  return { reload, openUrl, onDone }
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('Sign in with ChatGPT', () => {
  it('waiting: a machine of mine listens; the page opens and the screen waits for it', async () => {
    const commands = fakeServer({ via: 'machine' })
    const { openUrl } = show(commands)
    expect((screen.getByRole('radio', { name: /On Desk/ }) as HTMLInputElement).checked).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Continue with ChatGPT' }))
    expect(await screen.findByText(/Waiting for you to finish signing in to ChatGPT/)).toBeTruthy()
    expect(commands.chatgptSignInStart.mutate).toHaveBeenCalledWith({ machineId: 'machine:desk' })
    expect(openUrl).toHaveBeenCalledWith(AUTHORIZE)
    await waitFor(() => expect(commands.chatgptSignInStatus.query).toHaveBeenCalled())
    expect(commands.chatgptSignInStatus.query).toHaveBeenCalledWith({ attemptId: 'chatgpt_1' })
    expect(
      screen.getByRole('link', { name: 'Open the ChatGPT sign-in page' }).getAttribute('href'),
    ).toBe(AUTHORIZE)
  })

  it('signed in as a named account, once the listening machine relayed the answer', async () => {
    const commands = fakeServer({ via: 'machine', status: [{ state: 'waiting' }, SIGNED_IN] })
    const { reload, onDone } = show(commands)
    fireEvent.click(screen.getByRole('button', { name: 'Continue with ChatGPT' }))
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toContain('Signed in as person@example.test'),
    )
    expect(reload).toHaveBeenCalledTimes(1)
    expect(
      screen.getByRole('link', { name: 'ChatGPT’s usage settings' }).getAttribute('href'),
    ).toBe('https://chatgpt.com/settings/usage')
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    expect(onDone).toHaveBeenCalled()
  })

  it('paste instead: with no machine of mine, the person pastes the address the browser ended on', async () => {
    const commands = fakeServer({ via: 'paste' })
    show(commands, [])
    expect(
      (screen.getByRole('radio', { name: /paste the address/ }) as HTMLInputElement).checked,
    ).toBe(true)
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'My ChatGPT' } })
    fireEvent.click(screen.getByRole('button', { name: 'Continue with ChatGPT' }))
    const field = await screen.findByLabelText('Address from the browser')
    expect(commands.chatgptSignInStart.mutate).toHaveBeenCalledWith({ label: 'My ChatGPT' })
    fireEvent.change(field, {
      target: { value: '  http://127.0.0.1:1455/auth/callback?code=FAKE&state=FAKE  ' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Finish sign-in' }))
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toContain('Signed in as person@example.test'),
    )
    expect(commands.chatgptSignInComplete.mutate).toHaveBeenCalledWith({
      attemptId: 'chatgpt_1',
      pastedUrl: 'http://127.0.0.1:1455/auth/callback?code=FAKE&state=FAKE',
    })
  })

  it('paste instead while a machine listens', async () => {
    const commands = fakeServer({ via: 'machine' })
    show(commands)
    fireEvent.click(screen.getByRole('button', { name: 'Continue with ChatGPT' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Paste the address instead' }))
    expect(screen.getByLabelText('Address from the browser')).toBeTruthy()
  })

  it('failed: the reason is shown and the person can try again', async () => {
    const commands = fakeServer({ via: 'paste' })
    commands.chatgptSignInComplete.mutate.mockResolvedValueOnce({
      state: 'failed',
      reason: 'The sign-in was cancelled in the browser. Nothing was stored.',
    })
    const { reload } = show(commands, [])
    fireEvent.click(screen.getByRole('button', { name: 'Continue with ChatGPT' }))
    fireEvent.change(await screen.findByLabelText('Address from the browser'), {
      target: { value: 'http://127.0.0.1:1455/auth/callback?error=access_denied&state=FAKE' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Finish sign-in' }))
    expect((await screen.findByRole('alert')).textContent).toContain('cancelled in the browser')
    expect(reload).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(screen.getByRole('button', { name: 'Continue with ChatGPT' })).toBeTruthy()
  })

  it('a refused start shows the server’s sentence', async () => {
    const commands = fakeServer({ via: 'machine' })
    commands.chatgptSignInStart.mutate.mockRejectedValueOnce(
      new Error('Podium on that machine is too old to listen for a sign-in.'),
    )
    show(commands)
    fireEvent.click(screen.getByRole('button', { name: 'Continue with ChatGPT' }))
    expect((await screen.findByRole('alert')).textContent).toContain('too old to listen')
  })

  it('offers only my own machines that are online', () => {
    expect(
      listeningMachines([
        { id: 'a', name: 'Mine, online', owned: true, online: true },
        { id: 'b', name: 'Mine, offline', owned: true, online: false },
        { id: 'c', name: 'Someone else’s', owned: false, online: true },
      ]),
    ).toEqual([{ id: 'a', name: 'Mine, online' }])
  })
})
