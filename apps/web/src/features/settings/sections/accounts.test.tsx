import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@/test-support/mock-request-pool.test.fixture'
import { asMachineId, SHARED_MACHINE_ACCOUNT_WARNING } from '@podium/model'
import { Profiler, type ReactNode, useRef, useState, useSyncExternalStore } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AccountView } from './shared'

const trpc = {
  accounts: {
    list: { query: vi.fn() },
    connect: { mutate: vi.fn() },
    disconnect: { mutate: vi.fn() },
    login: { mutate: vi.fn() },
    send: { mutate: vi.fn() },
    unsend: { mutate: vi.fn() },
    useOnMyMachines: { mutate: vi.fn() },
    share: { mutate: vi.fn() },
    keys: { query: vi.fn() },
  },
}

/** Directory failures preserve the count-only fallback; members otherwise read names. */
const memberRequest = vi.fn(async (_origin: string, _action: string): Promise<unknown> => {
  throw new Error('The server refused this request (403).')
})
const authRequest = vi.fn(async (_origin: string, _path: string) => ({ sections: [] as string[] }))
vi.mock('@/features/setup/member-api', () => ({ memberRequest, authRequest }))
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
const MEMBER_DIRECTORY = {
  currentMemberId: 'user:ben',
  members: ADMIN_DIRECTORY.members.map(({ id, displayName, role }) => ({ id, displayName, role })),
}
function asMember(): void {
  memberRequest.mockImplementation(async (_origin, action) => {
    if (action !== 'directory') throw new Error('Administrator required')
    return MEMBER_DIRECTORY
  })
}
function asAdmin(): void {
  memberRequest.mockImplementation(async (_origin, action) => {
    if (action !== 'directory') throw new Error('Use the public directory')
    return { ...MEMBER_DIRECTORY, currentMemberId: 'user:admin' }
  })
  authRequest.mockResolvedValue({ sections: ['people', 'access', 'machines', 'instance', 'audit'] })
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

vi.mock('@podium/client-core/react', async (original) => {
  const { fixtureRuntimeHooks } = await import('@podium/client-core/test-support/command-hooks')
  return {
    ...(await original<typeof import('@podium/client-core/react')>()),
    ...fixtureRuntimeHooks(() => ({
      get access() {
        return storeSnapshot
      },
    })),
  }
})

vi.mock('@/app/store', () => {
  const useStore = () => storeSnapshot
  return {
    useStore,
    readFixture: useTestStoreSelector,
  }
})

const frame = vi.hoisted(() => ({ openTakeover: vi.fn(), closeTakeover: vi.fn() }))
vi.mock('../settings-frame', () => ({ useSettingsFrame: () => frame }))
function Harness() {
  const [flow, setFlow] = useState<ReactNode>(null)
  frame.openTakeover.mockImplementation(({ content }: { content: ReactNode }) => setFlow(content))
  frame.closeTakeover.mockImplementation(() => setFlow(null))
  return (
    <>
      <div hidden={flow !== null}>
        <AccountsSection />
      </div>
      <div data-testid="flow">{flow}</div>
    </>
  )
}
const flow = () => within(screen.getByTestId('flow'))

const { AccountsSection } = await import('./accounts')

const NATIVE: AccountView = {
  id: 'native:claude-code',
  provider: 'anthropic',
  source: 'native',
  harness: 'claude-code',
  status: 'not-configured',
  loginRequired: true,
  loginMachines: [{ id: asMachineId('desk'), name: 'Desk' }],
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
  authRequest.mockResolvedValue({ sections: [] })
  publication = 0
  storeSnapshot = {
    trpc,
    navigateToSession,
    sessions: [{ sessionId: 'login-session' }],
    publication,
  }
})

const OWN: AccountView = {
  ...API_KEY_ROW,
  identity: 'sk-a…f9x2',
  status: 'connected',
  credentialSource: 'stored',
  sharing: { everyone: false, users: [] },
}

async function openKey(account: AccountView = OWN, next: AccountView = account) {
  serveList([account], [next])
  render(<Harness />)
  fireEvent.click(await screen.findByRole('button', { name: /Anthropic API key/ }))
}

describe('personal AI accounts', () => {
  it('does not read the admin keys directory, even for an admin', async () => {
    asAdmin()
    serveList([OWN])
    render(<Harness />)
    expect(await screen.findByText('Only you')).toBeTruthy()
    expect(screen.queryByText("Members' keys")).toBeNull()
    expect(trpc.accounts.keys.query).not.toHaveBeenCalled()
  })

  it('keeps native rows stable across unrelated store publications', async () => {
    serveList([NATIVE])
    let updates = 0
    render(
      <Profiler id="accounts" onRender={() => updates++}>
        <Harness />
      </Profiler>,
    )
    await screen.findByText('Claude Code')
    const before = updates
    await act(async () => publishUnchangedSelection())
    expect(updates).toBe(before)
  })

  it('shows each identity, its preserved warning, and a switch with one section explanation', async () => {
    const login: AccountView = {
      ...NATIVE,
      id: 'native:codex',
      harness: 'codex',
      identity: 'alice@example.com',
      identityFingerprint: 'fp-alice',
      machines: ['Desk'],
      status: 'connected',
      loginRequired: false,
      useOnMyMachines: false,
      keptOn: [{ id: asMachineId('laptop'), name: 'Laptop' }],
    }
    serveList(
      [
        login,
        { ...NATIVE, id: 'native:pi', harness: 'pi', loginMachines: [], loginRequired: false },
      ],
      [{ ...login, useOnMyMachines: true }],
    )
    trpc.accounts.useOnMyMachines.mutate.mockResolvedValue({ ok: true })
    render(<Harness />)
    const toggle = await screen.findByRole('switch', {
      name: /Use on all my machines.*alice@example\.com/,
    })
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    expect(screen.getByText(/Not copied to Laptop/)).toBeTruthy()
    expect(screen.getByText(/Pi are supported too/)).toBeTruthy()
    expect(screen.getAllByText(/copies a login to every machine/)).toHaveLength(1)
    fireEvent.click(toggle)
    await waitFor(() =>
      expect(trpc.accounts.useOnMyMachines.mutate).toHaveBeenCalledWith({
        harness: 'codex',
        fingerprint: 'fp-alice',
        enabled: true,
      }),
    )
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('true'))
  })

  it('chooses a qualified machine for Sign in and opens the resulting session', async () => {
    serveList([
      {
        ...NATIVE,
        loginMachines: [
          { id: asMachineId('desk'), name: 'Desk' },
          { id: asMachineId('laptop'), name: 'Laptop' },
        ],
      },
    ])
    trpc.accounts.login.mutate.mockResolvedValue({ sessionId: 'login-session' })
    render(<Harness />)
    fireEvent.change(await screen.findByLabelText('Claude Code sign-in machine'), {
      target: { value: 'laptop' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    await waitFor(() =>
      expect(trpc.accounts.login.mutate).toHaveBeenCalledWith({
        harness: 'claude-code',
        machineId: 'laptop',
      }),
    )
    await waitFor(() => expect(navigateToSession).toHaveBeenCalledWith('login-session'))
  })

  it('moves sharing into the key takeover and saves on change', async () => {
    trpc.accounts.share.mutate.mockResolvedValue({ ok: true })
    await openKey()
    expect(flow().getByText('Who can use it')).toBeTruthy()
    expect(flow().getByText(/Your coding agents, background and superagent/)).toBeTruthy()
    fireEvent.click(flow().getByRole('button', { name: 'Everyone' }))
    await waitFor(() =>
      expect(trpc.accounts.share.mutate).toHaveBeenCalledWith({
        id: OWN.id,
        everyone: true,
        users: [],
      }),
    )
    expect(flow().queryByRole('button', { name: 'Save' })).toBeNull()
  })

  it('lets a member choose named people and removes their last share immediately', async () => {
    asMember()
    trpc.accounts.share.mutate.mockResolvedValue({ ok: true })
    await openKey(OWN, { ...OWN, sharing: { everyone: false, users: ['user:ana'] } })
    await waitFor(() =>
      expect(
        (flow().getByRole('button', { name: 'Specific people' }) as HTMLButtonElement).disabled,
      ).toBe(false),
    )
    fireEvent.click(flow().getByRole('button', { name: 'Specific people' }))
    expect(flow().queryByRole('switch', { name: 'Ben' })).toBeNull()
    fireEvent.click(flow().getByRole('switch', { name: 'Ana' }))
    await waitFor(() =>
      expect(trpc.accounts.share.mutate).toHaveBeenLastCalledWith({
        id: OWN.id,
        everyone: false,
        users: ['user:ana'],
      }),
    )
    await waitFor(() =>
      expect(flow().getByRole('switch', { name: 'Ana' }).getAttribute('aria-disabled')).not.toBe(
        'true',
      ),
    )
    fireEvent.click(flow().getByRole('switch', { name: 'Ana' }))
    await waitFor(() =>
      expect(trpc.accounts.share.mutate).toHaveBeenLastCalledWith({
        id: OWN.id,
        everyone: false,
        users: [],
      }),
    )
    expect(memberRequest).toHaveBeenCalledWith(expect.any(String), 'directory')
    expect(trpc.accounts.keys.query).not.toHaveBeenCalled()
  })

  it('restores sharing after a refused save and shows the reason', async () => {
    trpc.accounts.share.mutate.mockRejectedValue(new Error('Sharing refused'))
    await openKey()
    fireEvent.click(flow().getByRole('button', { name: 'Everyone' }))
    expect(await flow().findByText('Sharing refused')).toBeTruthy()
    expect(flow().getByRole('button', { name: 'Only you' }).getAttribute('aria-pressed')).toBe(
      'true',
    )
  })

  it('shows who shares a key and offers a write-only personal key entry', async () => {
    asMember()
    serveList([{ ...OWN, credentialSource: 'shared', sharedBy: 'user:ana' }], [OWN])
    trpc.accounts.connect.mutate.mockResolvedValue({ id: OWN.id })
    render(<Harness />)
    expect(await screen.findByText(/Ana’s key/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Add your own' }))
    fireEvent.click(flow().getByRole('button', { name: 'Add' }))
    const input = flow().getByLabelText('Anthropic API key', {
      selector: 'input',
    }) as HTMLInputElement
    expect(input.type).toBe('password')
    expect(input.value).toBe('')
    fireEvent.change(input, { target: { value: 'sk-new-personal-key' } })
    fireEvent.click(flow().getByRole('button', { name: 'Save' }))
    await waitFor(() =>
      expect(trpc.accounts.connect.mutate).toHaveBeenCalledWith({
        provider: 'anthropic',
        kind: 'api-key',
        credential: 'sk-new-personal-key',
      }),
    )
    await waitFor(() => expect(screen.queryByDisplayValue('sk-new-personal-key')).toBeNull())
  })

  it('adds a Claude subscription token using the oauth command shape', async () => {
    serveList([OAUTH_ROW])
    trpc.accounts.connect.mutate.mockResolvedValue({ id: OAUTH_ROW.id })
    render(<Harness />)
    fireEvent.click(await screen.findByRole('button', { name: 'Add key' }))
    expect(flow().getByText(/claude setup-token/)).toBeTruthy()
    fireEvent.click(flow().getByRole('button', { name: 'Add' }))
    fireEvent.change(flow().getByLabelText('Claude subscription token', { selector: 'input' }), {
      target: { value: 'sk-ant-oat01-token' },
    })
    fireEvent.click(flow().getByRole('button', { name: 'Save' }))
    await waitFor(() =>
      expect(trpc.accounts.connect.mutate).toHaveBeenCalledWith({
        provider: 'anthropic',
        kind: 'oauth',
        credential: 'sk-ant-oat01-token',
      }),
    )
  })

  it('requires the shared-machine acknowledgement before sending', async () => {
    trpc.accounts.send.mutate.mockResolvedValue({ ok: true, sent: true })
    await openKey({
      ...OWN,
      sentTo: [],
      sendableTo: [{ id: asMachineId('foreign'), name: 'Foreign' }],
    })
    fireEvent.click(flow().getByRole('switch', { name: 'Send key to Foreign' }))
    expect(flow().getByText(SHARED_MACHINE_ACCOUNT_WARNING)).toBeTruthy()
    const send = flow().getByRole('button', { name: 'Send to Foreign' }) as HTMLButtonElement
    expect(send.disabled).toBe(true)
    expect(trpc.accounts.send.mutate).not.toHaveBeenCalled()
    await userEvent.click(flow().getByText(/^I understand we will share/))
    fireEvent.click(send)
    await waitFor(() =>
      expect(trpc.accounts.send.mutate).toHaveBeenCalledWith({
        id: OWN.id,
        machineId: 'foreign',
        acknowledgeSharedMachine: true,
      }),
    )
  })

  it('takes a sent key back and preserves the running-session explanation', async () => {
    const note = 'Running sessions keep it until they restart.'
    trpc.accounts.unsend.mutate.mockResolvedValue({ ok: true, removed: true, note })
    await openKey({
      ...OWN,
      sentTo: [{ id: asMachineId('foreign'), name: 'Foreign' }],
      sendableTo: [],
    })
    fireEvent.click(flow().getByRole('switch', { name: 'Send key to Foreign' }))
    await waitFor(() =>
      expect(trpc.accounts.unsend.mutate).toHaveBeenCalledWith({
        id: OWN.id,
        machineId: 'foreign',
      }),
    )
    expect(await flow().findByText(note)).toBeTruthy()
  })

  it('confirms removal inline before disconnecting the key', async () => {
    trpc.accounts.disconnect.mutate.mockResolvedValue({ ok: true })
    await openKey()
    fireEvent.click(flow().getByRole('button', { name: 'Remove' }))
    expect(trpc.accounts.disconnect.mutate).not.toHaveBeenCalled()
    fireEvent.click(flow().getByRole('button', { name: 'Remove key' }))
    await waitFor(() =>
      expect(trpc.accounts.disconnect.mutate).toHaveBeenCalledWith({ id: OWN.id }),
    )
  })

  it('renders an unavailable native probe as unknown instead of claiming a logout', async () => {
    serveList([{ ...NATIVE, status: 'unknown', loginRequired: false }])
    render(<Harness />)
    expect(await screen.findByText('Status unavailable')).toBeTruthy()
    expect(screen.queryByText(/not signed in|Not connected/)).toBeNull()
  })

  it('keeps a long connected identity readable without arbitrary character breaks', async () => {
    const identity = 'Avery Example · avery.example+podium@example.com'
    serveList([{ ...NATIVE, status: 'connected', identity, loginRequired: false }])
    render(<Harness />)
    const value = await screen.findByText(identity)
    expect(value.className).toContain('break-words')
    expect(value.className).not.toContain('break-all')
    expect(value.className).not.toContain('truncate')
  })

  it('surfaces a connect failure and keeps the secret entry open for correction', async () => {
    serveList([API_KEY_ROW])
    trpc.accounts.connect.mutate.mockRejectedValue(new Error('Bad credential'))
    render(<Harness />)
    fireEvent.click(await screen.findByRole('button', { name: 'Add key' }))
    fireEvent.click(flow().getByRole('button', { name: 'Add' }))
    fireEvent.change(flow().getByLabelText('Anthropic API key', { selector: 'input' }), {
      target: { value: 'invalid-key' },
    })
    fireEvent.click(flow().getByRole('button', { name: 'Save' }))
    expect(await flow().findByText('Bad credential')).toBeTruthy()
    expect(
      (flow().getByLabelText('Anthropic API key', { selector: 'input' }) as HTMLInputElement).type,
    ).toBe('password')
    expect(flow().getByRole('button', { name: 'Save' })).toBeTruthy()
    expect(frame.closeTakeover).not.toHaveBeenCalled()
  })

  it('lets a member remove an already named person when the names directory fails', async () => {
    trpc.accounts.share.mutate.mockResolvedValue({ ok: true })
    await openKey({ ...OWN, sharing: { everyone: false, users: ['user:ana'] } }, OWN)
    await waitFor(() => expect(memberRequest).toHaveBeenCalledWith(expect.any(String), 'directory'))
    const person = flow().getByRole('switch', { name: 'user:ana' })
    expect(person.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(person)
    await waitFor(() =>
      expect(trpc.accounts.share.mutate).toHaveBeenCalledWith({
        id: OWN.id,
        everyone: false,
        users: [],
      }),
    )
    await waitFor(() =>
      expect(flow().getByRole('button', { name: 'Only you' }).getAttribute('aria-pressed')).toBe(
        'true',
      ),
    )
    expect(trpc.accounts.keys.query).not.toHaveBeenCalled()
  })

  it('explains an unavailable names directory without requiring an admin', async () => {
    await openKey()
    expect(
      await flow().findByText('People could not be loaded. Existing shares can still be removed.'),
    ).toBeTruthy()
    expect(
      (flow().getByRole('button', { name: 'Specific people' }) as HTMLButtonElement).disabled,
    ).toBe(true)
    expect((flow().getByRole('button', { name: 'Only you' }) as HTMLButtonElement).disabled).toBe(
      false,
    )
    expect(screen.queryByText(/Only an admin can see the member list/)).toBeNull()
    expect(trpc.accounts.keys.query).not.toHaveBeenCalled()
  })
})
