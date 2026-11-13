import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@/test-support/mock-request-pool.test.fixture'
import { asMachineId } from '@podium/model'
import { useRef, useSyncExternalStore } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AccountView } from '@/features/settings/sections/shared'

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
  },
}

/** Directory failures preserve the count-only fallback; members otherwise read names. */
const memberRequest = vi.fn(async (_origin: string, _action: string): Promise<unknown> => {
  throw new Error('The server refused this request (403).')
})
const authRequest = vi.fn(async (_origin: string, _path: string) => ({ sections: [] as string[] }))
vi.mock('@/features/setup/member-api', () => ({ memberRequest, authRequest }))
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

const { MachineLogins } = await import('./machine-logins')

const NATIVE: AccountView = {
  id: 'native:claude-code',
  provider: 'anthropic',
  source: 'native',
  harness: 'claude-code',
  status: 'not-configured',
  loginRequired: true,
  loginMachines: [{ id: asMachineId('desk'), name: 'Desk' }],
}
/** accounts.list answers with `first`, then with `then` on every later refetch. */
function serveList(first: AccountView[], then: AccountView[] = first): void {
  let calls = 0
  trpc.accounts.list.query.mockImplementation(async () => (calls++ === 0 ? first : then))
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  publication = 0
  storeSnapshot = {
    trpc,
    navigateToSession,
    sessions: [{ sessionId: 'login-session' }],
    publication,
  }
})

describe('subscription logins on the credentials page (acceptance 8)', () => {
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
    render(<MachineLogins />)
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
    render(<MachineLogins />)
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
})
