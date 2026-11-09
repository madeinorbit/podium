import { fixtureRuntimeHooks } from '@podium/client-core/test-support/command-hooks'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@/test-support/mock-request-pool.test.fixture'
import { asMachineId, SHARED_MACHINE_ACCOUNT_WARNING } from '@podium/model'
import { Profiler, useRef, useSyncExternalStore } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AccountView } from './shared'

const trpc = {
  accounts: {
    list: { query: vi.fn() },
    connect: { mutate: vi.fn() },
    disconnect: { mutate: vi.fn() },
    login: { mutate: vi.fn() },
    send: { mutate: vi.fn() },
    useOnMyMachines: { mutate: vi.fn() },
    share: { mutate: vi.fn() },
    keys: { mutate: vi.fn() },
  },
}

/** The member directory read: refused by default (a member), answered for an admin. */
const memberRequest = vi.fn(async (_origin: string, _action: string): Promise<unknown> => {
  throw new Error('The server refused this request (403).')
})
vi.mock('@/features/setup/member-api', () => ({ memberRequest }))
const ADMIN_DIRECTORY = {
  currentMemberId: 'user:admin',
  mailAvailable: false,
  invites: [],
  members: [
    { id: 'user:admin', displayName: 'Robin', email: 'robin@example.com', role: 'admin' },
    { id: 'user:ana', displayName: 'Ana', email: 'ana@example.com', role: 'member' },
    { id: 'user:ben', displayName: 'Ben', email: 'ben@example.com', role: 'member' },
  ],
}
function asAdmin(): void {
  memberRequest.mockImplementation(async () => ADMIN_DIRECTORY)
}
const navigateToSession = vi.fn()
let publication = 0
const storeListeners = new Set<() => void>()
let storeSnapshot = {
  trpc,
  navigateToSession,
  sessions: [{ sessionId: 'login-session' }],
  publication,
}

function useTestStoreSelector<T>(
  selector: (store: typeof storeSnapshot) => T,
  isEqual: (left: T, right: T) => boolean = Object.is,
): T {
  const selectorRef = useRef(selector)
  const equalityRef = useRef(isEqual)
  equalityRef.current = isEqual
  const cache = useRef<{ snapshot: typeof storeSnapshot; selected: T } | null>(null)
  if (selectorRef.current !== selector) {
    selectorRef.current = selector
    cache.current = null
  }

  return useSyncExternalStore(
    (listener) => {
      storeListeners.add(listener)
      return () => storeListeners.delete(listener)
    },
    () => {
      if (cache.current?.snapshot === storeSnapshot) return cache.current.selected
      const next = selectorRef.current(storeSnapshot)
      const selected =
        cache.current && equalityRef.current(cache.current.selected, next)
          ? cache.current.selected
          : next
      cache.current = { snapshot: storeSnapshot, selected }
      return selected
    },
  )
}

function publishUnchangedSelection(): void {
  publication++
  storeSnapshot = { ...storeSnapshot, publication }
  for (const listener of storeListeners) listener()
}

vi.mock('@podium/client-core/react', async (original) => ({
  ...(await original<typeof import('@podium/client-core/react')>()),
  ...fixtureRuntimeHooks(() => ({
    get access() {
      return storeSnapshot
    },
  })),
}))

vi.mock('@/app/store', () => {
  const useStore = () => storeSnapshot
  return {
    useStore,
    useRuntimeSelector: useTestStoreSelector,
  }
})

const { AccountsSection } = await import('./accounts')

const NATIVE: AccountView = {
  id: 'native:claude-code',
  provider: 'anthropic',
  source: 'native',
  harness: 'claude-code',
  status: 'not-configured',
}
const API_KEY_ROW: AccountView = {
  id: 'managed:anthropic',
  provider: 'anthropic',
  source: 'managed',
  kind: 'api-key',
  status: 'not-configured',
}
const OAUTH_ROW: AccountView = {
  id: 'managed:claude-oauth',
  provider: 'anthropic',
  source: 'managed',
  kind: 'oauth',
  status: 'not-configured',
}

/** accounts.list answers with `first`, then with `then` on every later refetch. */
function serveList(first: AccountView[], then: AccountView[] = first): void {
  let calls = 0
  trpc.accounts.list.query.mockImplementation(async () => (calls++ === 0 ? first : then))
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  memberRequest.mockImplementation(async () => {
    throw new Error('The server refused this request (403).')
  })
  publication = 0
  storeSnapshot = {
    trpc,
    navigateToSession,
    sessions: [{ sessionId: 'login-session' }],
    publication,
  }
})

describe('AccountsSection', () => {
  it('does not rerender native rows when a store publication leaves their fields unchanged', async () => {
    serveList([NATIVE])
    let updates = 0
    render(
      <Profiler
        id="accounts"
        onRender={(_id, phase) => {
          if (phase === 'update') updates++
        }}
      >
        <AccountsSection />
      </Profiler>,
    )
    expect(await screen.findByText('Not connected')).toBeTruthy()
    const updatesBeforePublication = updates

    act(() => publishUnchangedSelection())

    expect(updates).toBe(updatesBeforePublication)
    expect(trpc.accounts.list.query).toHaveBeenCalledTimes(1)
  })

  it('keeps a long connected identity readable without arbitrary character breaks', async () => {
    const identity = 'Tillmann Felippi · tillmann.felippi+podium@example.com'
    serveList([{ ...NATIVE, status: 'connected', identity }])
    render(<AccountsSection />)

    const value = await screen.findByText(identity)
    expect(value.className).toContain('break-words')
    expect(value.className).not.toContain('break-all')
    expect(value.className).not.toContain('truncate')
  })

  it('starts a native login on the selected machine and opens its PTY', async () => {
    serveList([
      {
        ...NATIVE,
        loginRequired: true,
        loginMachines: [
          { id: asMachineId('machine-a'), name: 'Alpha' },
          { id: asMachineId('machine-b'), name: 'Beta' },
        ],
      },
    ])
    trpc.accounts.login.mutate.mockResolvedValue({ sessionId: 'login-session' })
    render(<AccountsSection />)

    fireEvent.change(await screen.findByLabelText('claude-code login machine'), {
      target: { value: 'machine-b' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Log in' }))

    await waitFor(() =>
      expect(trpc.accounts.login.mutate).toHaveBeenCalledWith({
        harness: 'claude-code',
        machineId: 'machine-b',
      }),
    )
    await waitFor(() => expect(navigateToSession).toHaveBeenCalledWith('login-session'))
  })

  it('renders an unavailable native probe as unknown instead of claiming a logout', async () => {
    serveList([{ ...NATIVE, status: 'unknown' }])
    render(<AccountsSection />)

    expect(await screen.findByText('Status unavailable')).toBeTruthy()
    expect(screen.queryByText('Not connected')).toBeNull()
  })

  it('connects a managed API key, masks the input, and refetches so the row flips', async () => {
    const connected: AccountView = { ...API_KEY_ROW, identity: 'sk-a…f9x2', status: 'connected' }
    serveList([NATIVE, API_KEY_ROW], [NATIVE, connected])
    trpc.accounts.connect.mutate.mockResolvedValue({ id: 'managed:anthropic' })
    render(<AccountsSection />)

    fireEvent.click(await screen.findByRole('button', { name: 'Connect' }))
    const input = screen.getByLabelText('Anthropic API key secret') as HTMLInputElement
    expect(input.type).toBe('password')
    fireEvent.change(input, { target: { value: 'sk-ant-secret' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() =>
      expect(trpc.accounts.connect.mutate).toHaveBeenCalledWith({
        provider: 'anthropic',
        kind: 'api-key',
        credential: 'sk-ant-secret',
      }),
    )
    // Refetched, so the row shows the server's masked identity — not local state.
    expect(await screen.findByText('sk-a…f9x2')).toBeTruthy()
    expect(screen.queryByDisplayValue('sk-ant-secret')).toBeNull()
  })

  it('offers the setup-token affordance on the Claude subscription row only', async () => {
    serveList([API_KEY_ROW, OAUTH_ROW])
    render(<AccountsSection />)

    expect(await screen.findByText('Claude subscription (setup-token)')).toBeTruthy()
    expect(screen.getByText(/long-lived subscription token \(about a year\)/)).toBeTruthy()

    const rows = screen.getAllByRole('button', { name: 'Connect' })
    expect(rows).toHaveLength(2)
    fireEvent.click(rows[1] as HTMLElement)
    fireEvent.change(screen.getByLabelText('Claude subscription (setup-token) secret'), {
      target: { value: 'sk-ant-oat01-token' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    // OAuth is anthropic-only; the api-key row must never send kind 'oauth'.
    await waitFor(() =>
      expect(trpc.accounts.connect.mutate).toHaveBeenCalledWith({
        provider: 'anthropic',
        kind: 'oauth',
        credential: 'sk-ant-oat01-token',
      }),
    )
  })

  it('disconnects a connected managed account and refetches', async () => {
    const connected: AccountView = { ...API_KEY_ROW, identity: 'sk-a…f9x2', status: 'connected' }
    serveList([connected], [API_KEY_ROW])
    trpc.accounts.disconnect.mutate.mockResolvedValue({ ok: true })
    render(<AccountsSection />)

    fireEvent.click(await screen.findByRole('button', { name: 'Disconnect' }))
    await waitFor(() =>
      expect(trpc.accounts.disconnect.mutate).toHaveBeenCalledWith({ id: 'managed:anthropic' }),
    )
    expect(await screen.findByRole('button', { name: 'Connect' })).toBeTruthy()
  })

  // POD-6300 (MU-28): sending one's own connection to someone else's machine
  // shows the shared-machine warning first, and only then sends it.
  it('sends a connection to a shared machine only after showing the warning', async () => {
    const alice = { id: asMachineId('machine-alice'), name: 'alice-desk' }
    const connected: AccountView = {
      ...API_KEY_ROW,
      identity: 'sk-a…f9x2',
      status: 'connected',
      credentialSource: 'stored',
      sentTo: [],
      sendableTo: [alice],
    }
    serveList([connected], [{ ...connected, sentTo: [alice], sendableTo: [] }])
    trpc.accounts.send.mutate.mockResolvedValue({ ok: true, sent: true })
    render(<AccountsSection />)

    expect(screen.queryByText(SHARED_MACHINE_ACCOUNT_WARNING)).toBeNull()
    fireEvent.click(await screen.findByRole('button', { name: 'Send to a shared machine' }))
    expect(screen.getByText(SHARED_MACHINE_ACCOUNT_WARNING)).toBeTruthy()
    expect(trpc.accounts.send.mutate).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Send to alice-desk' }))
    await waitFor(() =>
      expect(trpc.accounts.send.mutate).toHaveBeenCalledWith({
        id: 'managed:anthropic',
        machineId: 'machine-alice',
        acknowledgeSharedMachine: true,
      }),
    )
    expect(await screen.findByText(/Also runs on alice-desk, someone else's machine/)).toBeTruthy()
  })

  // POD-6301 (D11): one unticked box per detected account; ticking it asks the
  // server to copy that account to the person's other machines.
  it('shows the D11 box unticked on a detected account and ticks it for that account', async () => {
    const detected: AccountView = {
      id: 'native:codex',
      provider: 'openai',
      source: 'native',
      harness: 'codex',
      identity: 'alice@example.com',
      identityFingerprint: 'fp-alice',
      machines: ['alice-laptop'],
      status: 'connected',
      useOnMyMachines: false,
      keptOn: [],
    }
    serveList([detected], [{ ...detected, useOnMyMachines: true }])
    trpc.accounts.useOnMyMachines.mutate.mockResolvedValue({ ok: true, enabled: true })
    render(<AccountsSection />)

    const box = await screen.findByRole('checkbox', {
      name: /Automatically transfer and use these credentials on other machines I own/,
    })
    expect(box.getAttribute('aria-checked')).toBe('false')
    expect(screen.getByText(/copies already made stay where they are/)).toBeTruthy()
    fireEvent.click(box)
    await waitFor(() =>
      expect(trpc.accounts.useOnMyMachines.mutate).toHaveBeenCalledWith({
        harness: 'codex',
        fingerprint: 'fp-alice',
        enabled: true,
      }),
    )
    await waitFor(() => expect(box.getAttribute('aria-checked')).toBe('true'))
  })

  it('says where a different login was kept, and shows no box without a known identity', async () => {
    serveList([
      {
        id: 'native:codex',
        provider: 'openai',
        source: 'native',
        harness: 'codex',
        identity: 'alice@example.com',
        identityFingerprint: 'fp-alice',
        status: 'connected',
        useOnMyMachines: true,
        keptOn: [{ id: asMachineId('alice-desk'), name: 'alice-desk' }],
      },
      { ...NATIVE, status: 'connected' },
    ])
    render(<AccountsSection />)
    expect(
      await screen.findByText(
        'Not copied to alice-desk: a different login is signed in there, and Podium kept it.',
      ),
    ).toBeTruthy()
    expect(screen.getAllByRole('checkbox')).toHaveLength(1)
  })

  it('surfaces a connect failure and keeps the form open', async () => {
    serveList([API_KEY_ROW])
    trpc.accounts.connect.mutate.mockRejectedValue(new Error('bad credential'))
    render(<AccountsSection />)

    fireEvent.click(await screen.findByRole('button', { name: 'Connect' }))
    fireEvent.change(screen.getByLabelText('Anthropic API key secret'), {
      target: { value: 'nope' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(await screen.findByText('bad credential')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Save' })).toBeTruthy()
  })

  it('shows the server-AI login and its last failure on the spent row (POD-4805)', async () => {
    serveList([
      {
        ...NATIVE,
        id: 'native:codex',
        harness: 'codex',
        status: 'connected',
        identity: 'user@example.com',
        serverAi: {
          machineId: asMachineId('desk'),
          machineName: 'Desk',
          lastError: "codex 400: The 'gpt-5.5' model is not supported.",
        },
      },
    ])
    render(<AccountsSection />)

    expect(await screen.findByText(/Server AI uses Desk/)).toBeTruthy()
    expect(screen.getByText(/Server AI last failed: /)).toBeTruthy()
    expect(screen.getByText(/not supported/)).toBeTruthy()
  })

  describe('key sharing (POD-6390)', () => {
    const OWN: AccountView = {
      ...API_KEY_ROW,
      identity: 'sk-a…f9x2',
      status: 'connected',
      credentialSource: 'stored',
      sharing: { everyone: false, users: [] },
    }

    it("shows the owner's sharing and shares their key with everyone", async () => {
      serveList([OWN], [{ ...OWN, sharing: { everyone: true, users: [] } }])
      trpc.accounts.share.mutate.mockResolvedValue({ ok: true })
      render(<AccountsSection />)

      expect(await screen.findByText('Only you')).toBeTruthy()
      fireEvent.click(screen.getByRole('button', { name: 'Change who can use Anthropic API key' }))
      fireEvent.click(screen.getByLabelText('Everyone on this server'))
      fireEvent.click(screen.getByRole('button', { name: 'Save' }))

      await waitFor(() =>
        expect(trpc.accounts.share.mutate).toHaveBeenCalledWith({
          id: 'managed:anthropic',
          everyone: true,
          users: [],
        }),
      )
      // Refetched: the editor closes and the line shows the server's answer.
      await waitFor(() => expect(screen.queryByRole('button', { name: 'Save' })).toBeNull())
      expect(await screen.findByText('Everyone on this server')).toBeTruthy()
    })

    it('a member without the member list cannot add people, but can revoke one already named', async () => {
      serveList([{ ...OWN, sharing: { everyone: false, users: ['user:ana'] } }], [OWN])
      trpc.accounts.share.mutate.mockResolvedValue({ ok: true })
      render(<AccountsSection />)

      expect(await screen.findByText('1 person')).toBeTruthy()
      fireEvent.click(screen.getByRole('button', { name: 'Change who can use Anthropic API key' }))
      // The named person is still listed (by id, since no directory names them).
      expect((screen.getByLabelText('user:ana') as HTMLInputElement).checked).toBe(true)
      fireEvent.click(screen.getByLabelText('Only you'))
      fireEvent.click(screen.getByRole('button', { name: 'Save' }))

      await waitFor(() =>
        expect(trpc.accounts.share.mutate).toHaveBeenCalledWith({
          id: 'managed:anthropic',
          everyone: false,
          users: [],
        }),
      )
      expect(await screen.findByText('Only you')).toBeTruthy()
      // No admin list for a member, and the admin read is never sent.
      expect(screen.queryByText("Members' keys")).toBeNull()
      expect(trpc.accounts.keys.mutate).not.toHaveBeenCalled()
    })

    it('a member with nobody named is told only an admin can pick people', async () => {
      serveList([OWN])
      render(<AccountsSection />)

      fireEvent.click(
        await screen.findByRole('button', { name: 'Change who can use Anthropic API key' }),
      )
      expect((screen.getByLabelText('Specific people') as HTMLInputElement).disabled).toBe(true)
      expect(screen.getByText(/Only an admin can see the member list/)).toBeTruthy()
    })

    it('an admin shares their own key with named people, by name', async () => {
      asAdmin()
      trpc.accounts.keys.mutate.mockResolvedValue([])
      serveList([OWN], [{ ...OWN, sharing: { everyone: false, users: ['user:ana', 'user:ben'] } }])
      trpc.accounts.share.mutate.mockResolvedValue({ ok: true })
      render(<AccountsSection />)

      fireEvent.click(
        await screen.findByRole('button', { name: 'Change who can use Anthropic API key' }),
      )
      fireEvent.click(screen.getByLabelText('Specific people'))
      // The viewer is the owner: not offered as a grantee.
      expect(screen.queryByLabelText('Robin')).toBeNull()
      const save = screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement
      expect(save.disabled).toBe(true)
      fireEvent.click(screen.getByLabelText('Ana'))
      fireEvent.click(screen.getByLabelText('Ben'))
      fireEvent.click(save)

      await waitFor(() =>
        expect(trpc.accounts.share.mutate).toHaveBeenCalledWith({
          id: 'managed:anthropic',
          everyone: false,
          users: ['user:ana', 'user:ben'],
        }),
      )
      expect(await screen.findByText('Ana and Ben')).toBeTruthy()
    })

    it("an admin manages another member's key from the members' keys list", async () => {
      asAdmin()
      const anas = {
        owner: 'user:ana',
        id: 'managed:openai',
        provider: 'openai',
        kind: 'api-key',
        identity: 'sk-p…1234',
        sharing: { everyone: false, users: [] },
      }
      trpc.accounts.keys.mutate
        .mockResolvedValueOnce([{ ...anas, owner: 'user:admin', id: 'managed:anthropic' }, anas])
        .mockResolvedValue([{ ...anas, sharing: { everyone: true, users: [] } }])
      trpc.accounts.share.mutate.mockResolvedValue({ ok: true })
      serveList([OWN])
      render(<AccountsSection />)

      expect(await screen.findByText("Members' keys")).toBeTruthy()
      expect(await screen.findByText('sk-p…1234')).toBeTruthy()
      // Ana's key is private: it is hers, not the viewing admin's.
      expect(screen.getByText('Only its owner')).toBeTruthy()
      // The admin's own key is not repeated in the list: one control for it, above.
      expect(
        screen
          .getAllByRole('button', { name: /^Change who can use / })
          .map((b) => b.getAttribute('aria-label')),
      ).toEqual(['Change who can use Anthropic API key', "Change who can use Ana's OpenAI API key"])
      fireEvent.click(
        screen.getByRole('button', { name: "Change who can use Ana's OpenAI API key" }),
      )
      fireEvent.click(screen.getByLabelText('Everyone on this server'))
      fireEvent.click(screen.getByRole('button', { name: 'Save' }))

      await waitFor(() =>
        expect(trpc.accounts.share.mutate).toHaveBeenCalledWith({
          id: 'managed:openai',
          owner: 'user:ana',
          everyone: true,
          users: [],
        }),
      )
      await waitFor(() => expect(trpc.accounts.keys.mutate).toHaveBeenCalledTimes(2))
      await waitFor(() => expect(screen.queryByRole('button', { name: 'Save' })).toBeNull())
      expect(await screen.findByText('Everyone on this server')).toBeTruthy()
    })

    it('names who shared a key with the viewer when the directory knows them', async () => {
      asAdmin()
      trpc.accounts.keys.mutate.mockResolvedValue([])
      serveList([
        {
          ...API_KEY_ROW,
          identity: 'sk-a…0000',
          status: 'connected',
          credentialSource: 'shared',
          sharedBy: 'user:ana',
        },
      ])
      render(<AccountsSection />)

      expect(await screen.findByText(/Shared with you by Ana/)).toBeTruthy()
      // Not the viewer's key: no sharing control on it.
      expect(screen.queryByRole('button', { name: /^Change who can use Anthropic/ })).toBeNull()
    })
  })
})
