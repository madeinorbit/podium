import '@/test-support/mock-core-store-handle'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Trpc } from '@/app/trpc'
import type { AdminViewer } from '../admin-viewer'
import { resetForcedSettingCache } from '../use-forced-setting'
import { type AccessAnswer, AccessSection, filterSignIns } from './access'

const fixture = vi.hoisted(() => ({
  trpc: {} as Trpc,
  viewer: { status: 'ready', sections: ['access'], retry: vi.fn() } as AdminViewer,
  setSettingsTab: vi.fn(),
  openTakeover: vi.fn(),
  closeTakeover: vi.fn(),
}))
vi.mock('../stable-access', () => ({
  useSettingsTrpc: () => fixture.trpc,
  useSettingsClient: () => fixture,
}))
vi.mock('../admin-viewer', () => ({ useAdminSections: () => fixture.viewer }))
vi.mock('../settings-frame', () => ({ useSettingsFrame: () => fixture }))

const signIn = (id: string, kind: string): AccessAnswer['signIns'][number] => ({
  id,
  memberId: id,
  memberName: id,
  kind,
  deviceName: `${id} device`,
  platform: null,
  createdAt: '2026-11-01T00:00:00.000Z',
  lastSeenAt: null,
  expiresAt: '2026-12-01T00:00:00.000Z',
})

function serve({
  mode = 'server',
  capped = false,
  hasOwnCredential = true,
  loginRequiredReason = null,
}: {
  mode?: string
  capped?: boolean
  hasOwnCredential?: boolean
  loginRequiredReason?: 'hosted' | 'several-members' | null
} = {}) {
  let loginRequired = true
  let signIns = [
    signIn('Browser', 'login'),
    signIn('Phone', 'mobile'),
    signIn('Link', 'upstream'),
    signIn('Recovery', 'break-glass'),
  ]
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname
    if (path === '/auth/admin/sign-ins/revoke') {
      const { id } = JSON.parse(String(init?.body))
      signIns = signIns.filter((row) => row.id !== id)
    }
    const answer =
      path === '/auth/admin/access'
        ? { signIns, signInsTotal: capped ? 201 : signIns.length }
        : { ok: true }
    return new Response(JSON.stringify(answer), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  })
  vi.stubGlobal('fetch', fetchMock)
  fixture.trpc = {
    setup: {
      info: {
        query: vi.fn().mockResolvedValue({
          mode,
          publicUrl: 'https://podium.example',
          serverUrl: 'https://upstream.example',
          publicUrlSource: 'file',
          networkOption: 'tailscale-serve',
          allowedOrigins: [],
        }),
      },
      provenance: { query: vi.fn().mockResolvedValue({}) },
    },
    auth: {
      status: {
        query: vi.fn(async () => ({
          loginRequired,
          loginRequiredReason,
          hasOwnCredential,
          canManageInstance: true,
          loginPolicySource: 'settings',
        })),
      },
      profile: { query: vi.fn().mockResolvedValue({ email: 'admin@example.test' }) },
      setLoginRequired: {
        mutate: vi.fn(async ({ required }: { required: boolean }) => {
          loginRequired = required
          return { loginRequired }
        }),
      },
    },
  } as unknown as Trpc
  return fetchMock
}

beforeEach(() => {
  fixture.viewer = { status: 'ready', sections: ['access'], retry: vi.fn() }
})
afterEach(() => {
  cleanup()
  resetForcedSettingCache()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('Access', () => {
  it('maps phones and advanced sign-ins without losing other sign-in kinds', () => {
    const rows = [
      signIn('a', 'login'),
      signIn('b', 'mobile'),
      signIn('c', 'upstream'),
      signIn('d', 'break-glass'),
      signIn('e', 'future-kind'),
    ]
    expect(filterSignIns(rows, 'everyone').map((row) => row.id)).toEqual(['a', 'b', 'e'])
    expect(filterSignIns(rows, 'phones').map((row) => row.id)).toEqual(['b'])
    expect(filterSignIns(rows, 'advanced').map((row) => row.id)).toEqual(['c', 'd'])
  })

  it('shows invitation action and device sign-ins, with links and recovery under Advanced', async () => {
    serve()
    render(<AccessSection />)
    expect(await screen.findByRole('switch', { name: 'Require sign-in' })).toBeTruthy()
    expect(screen.getByText('With an invite link')).toBeTruthy()
    expect(screen.queryByText('Admission')).toBeNull()
    expect(screen.queryByText('Invitations')).toBeNull()
    expect(screen.queryByText('Members')).toBeNull()
    const regular = screen.getByRole('heading', { name: 'Signed in now' }).closest('section')
    const advanced = screen.getByRole('heading', { name: 'Advanced' }).closest('section')
    if (!regular || !advanced) throw new Error('Access sections are missing')
    expect(await within(regular).findByText('Phone device')).toBeTruthy()
    expect(within(regular).queryByText('Link device')).toBeNull()
    expect(within(advanced).getByText('Link device')).toBeTruthy()
    expect(within(advanced).getByText('Recovery device')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Invite' }))
    expect(fixture.setSettingsTab).toHaveBeenCalledWith('members')
  })

  it('filters phones, shows the cap and signs out just that device', async () => {
    const fetchMock = serve({ capped: true })
    render(<AccessSection />)
    await screen.findByText('Phone device')
    expect(screen.getByText(/Showing 4 of 201 sign-ins/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Phones' }))
    expect(screen.queryByText('Browser device')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Sign out Phone’s Phone device' }))
    await waitFor(() => expect(screen.queryByText('Phone device')).toBeNull())
    const revoke = fetchMock.mock.calls.find(([url]) => url.endsWith('/auth/admin/sign-ins/revoke'))
    expect(JSON.parse(String(revoke?.[1]?.body))).toEqual({ id: 'Phone' })
    expect(screen.getByText('Link device')).toBeTruthy()
  })

  it('turns sign-in off with password and acknowledgement, then back on with the same credential', async () => {
    const fetchMock = serve()
    render(<AccessSection />)
    const control = await screen.findByRole('switch', { name: 'Require sign-in' })
    fireEvent.click(control)
    const disable = screen.getByRole('button', { name: 'Turn off sign-in' })
    expect((disable as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('Your password'), { target: { value: 'the password' } })
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(disable)
    await waitFor(() => expect(control.getAttribute('aria-checked')).toBe('false'))
    expect(fixture.trpc.auth.setLoginRequired.mutate).toHaveBeenCalledWith({
      required: false,
      current: 'the password',
      acknowledgeNoPassword: true,
    })
    fireEvent.click(control)
    fireEvent.change(screen.getByLabelText('Your password'), { target: { value: 'the password' } })
    fireEvent.click(screen.getByRole('button', { name: 'Require sign-in', exact: true }))
    await waitFor(() => expect(control.getAttribute('aria-checked')).toBe('true'))
    expect(fixture.trpc.auth.setLoginRequired.mutate).toHaveBeenLastCalledWith({
      required: true,
      current: 'the password',
    })
    expect(fetchMock.mock.calls.some(([url]) => url.endsWith('/auth/login'))).toBe(true)
  })

  it('asks only for the acknowledgement when the admin has no personal password', async () => {
    serve({ hasOwnCredential: false })
    render(<AccessSection />)
    fireEvent.click(await screen.findByRole('switch', { name: 'Require sign-in' }))
    expect(screen.queryByLabelText('Your password')).toBeNull()
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: 'Turn off sign-in' }))
    await waitFor(() =>
      expect(fixture.trpc.auth.setLoginRequired.mutate).toHaveBeenCalledWith({
        required: false,
        current: '',
        acknowledgeNoPassword: true,
      }),
    )
  })

  it.each([
    ['hosted', 'Always on for hosted workspaces'],
    ['several-members', 'Required while more than one person uses this workspace'],
  ] as const)('keeps mandatory %s sign-in read-only with its reason', async (loginRequiredReason, reason) => {
    serve({ loginRequiredReason })
    render(<AccessSection />)
    expect(await screen.findByText(reason)).toBeTruthy()
    expect(screen.queryByRole('switch', { name: 'Require sign-in' })).toBeNull()
    expect(fixture.trpc.auth.setLoginRequired.mutate).not.toHaveBeenCalled()
  })

  it('keeps host policy and sign-ins off a worker page', async () => {
    const fetchMock = serve({ mode: 'daemon' })
    render(<AccessSection />)
    expect(await screen.findByText('https://upstream.example')).toBeTruthy()
    expect(screen.queryByRole('switch')).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('waits for machine mode before reading or showing host controls', () => {
    const fetchMock = serve()
    vi.mocked(fixture.trpc.setup.info.query).mockReturnValue(new Promise(() => {}))
    render(<AccessSection />)
    expect(screen.getByText('Loading access settings…')).toBeTruthy()
    expect(screen.queryByRole('switch')).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('keeps the address visible when the sign-in read fails and offers retry', async () => {
    serve()
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: 'Administrator required' }), {
          status: 403,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    )
    render(<AccessSection />)
    expect((await screen.findByRole('alert')).textContent).toContain('Administrator required')
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy()
    expect(screen.getByText('https://podium.example')).toBeTruthy()
  })

  it.each([
    'loading',
    'error',
    'member',
  ])('does not read admin data while viewer is %s', (state) => {
    serve()
    fixture.viewer = {
      status: state === 'member' ? 'ready' : (state as 'loading' | 'error'),
      sections: [],
      retry: vi.fn(),
    }
    render(<AccessSection />)
    expect(fixture.trpc.setup.info.query).not.toHaveBeenCalled()
    expect(screen.queryByRole('switch')).toBeNull()
  })
})
