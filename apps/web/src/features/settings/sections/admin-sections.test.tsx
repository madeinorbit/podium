import '@/test-support/mock-request-pool.test.fixture'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { AccessSection } from './access'
import { AuditSection } from './audit'

/** The admin area's Access and Audit sections (POD-6299). */
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function serve(answers: Record<string, unknown>) {
  const directory = {
    members: [
      { id: 'alice', displayName: 'Alice', role: 'admin' },
      { id: 'bob', displayName: 'Bob', role: 'member' },
      { id: 'carol', displayName: 'Carol', role: 'member', disabledAt: '2026-11-01T00:00:00Z' },
    ],
    invites: [],
    currentMemberId: 'alice',
    mailAvailable: false,
  }
  const fetchMock = vi.fn(async (url: string) => {
    const path = new URL(url).pathname + new URL(url).search
    const body = answers[path] ?? (path === '/auth/members/list' ? directory : undefined)
    return body === undefined
      ? { ok: false, status: 403, json: async () => ({ error: 'Administrator required' }) }
      : { ok: true, status: 200, json: async () => body }
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

const alice = { kind: 'member', id: 'alice', name: 'Alice' }
const event = (id: number, over: Record<string, unknown>) => ({
  id,
  at: '2026-11-04T10:00:00.000Z',
  result: 'applied',
  actor: alice,
  onBehalfOf: alice,
  target: null,
  facts: {},
  ...over,
})

test('Access shows invitation-only admission and each sign-in by member and device', async () => {
  serve({
    '/auth/admin/access': {
      admission: {
        mode: 'invitation',
        signInRequired: true,
        openInvites: 2,
        expiredInvites: 1,
        activeMembers: 2,
        disabledMembers: 1,
      },
      signIns: [
        {
          memberId: 'bob',
          memberName: 'Bob',
          kind: 'mobile',
          deviceName: 'Bob’s phone',
          platform: 'ios',
          createdAt: '2026-11-01T00:00:00.000Z',
          lastSeenAt: null,
          expiresAt: '2026-12-01T00:00:00.000Z',
        },
        {
          memberId: 'alice',
          memberName: 'Alice',
          kind: 'login',
          deviceName: null,
          platform: null,
          createdAt: '2026-11-02T00:00:00.000Z',
          lastSeenAt: null,
          expiresAt: '2026-12-02T00:00:00.000Z',
        },
      ],
    },
  })
  render(<AccessSection />)
  expect(await screen.findByText('Invitation only')).toBeTruthy()
  expect(screen.getByText('Required')).toBeTruthy()
  expect(screen.getByText('2 open · 1 expired')).toBeTruthy()
  expect(screen.getByText('2 active · 1 disabled')).toBeTruthy()
  expect(screen.getByText('Bob’s phone')).toBeTruthy()
  expect(screen.getByText('Browser or desktop')).toBeTruthy()
})

test('Access shows the server’s refusal', async () => {
  serve({})
  render(<AccessSection />)
  expect((await screen.findByRole('alert')).textContent).toBe('Administrator required')
})

test('Audit shows member, role, admission and custody events with who, for whom, target and result', async () => {
  serve({
    '/auth/admin/audit?limit=100': {
      events: [
        event(9, {
          command: 'takeover',
          target: { kind: 'machine', id: 'm-1', name: 'Spare build box' },
          facts: { previousOwner: 'Nobody', newOwner: 'Alice' },
        }),
        event(8, {
          command: 'members.setRole',
          actor: { kind: 'agent', id: 'session:s1', name: 'An agent' },
          target: { kind: 'member', id: 'bob', name: 'Bob' },
          facts: { from: 'member', to: 'admin' },
        }),
        event(7, {
          command: 'members.invite',
          target: { kind: 'invite', id: 'inv', name: 'An invitation' },
          facts: { role: 'member' },
        }),
        event(6, {
          command: 'members.disable',
          result: 'refused',
          target: { kind: 'member', id: 'carol', name: 'Carol' },
        }),
      ],
      nextBefore: 6,
    },
    '/auth/admin/audit?limit=100&before=6': {
      events: [
        event(5, { command: 'members.join', target: { kind: 'member', id: 'dana', name: 'Dana' } }),
      ],
      nextBefore: null,
    },
  })
  render(<AuditSection />)
  const table = await screen.findByRole('table', { name: 'Security events' })
  const rows = [...table.querySelectorAll('tbody tr')].map((row) =>
    [...row.querySelectorAll('td')].slice(1).map((cell) => cell.textContent),
  )
  expect(rows).toEqual([
    ['Alice', 'Took custodycustody Nobody → Alice', 'Spare build box', 'Done'],
    ['An agent for Alice', 'Changed rolemember → admin', 'Bob', 'Done'],
    ['Alice', 'Invitedas member', 'An invitation', 'Done'],
    ['Alice', 'Disabled', 'Carol', 'Refused'],
  ])
  fireEvent.click(screen.getByRole('button', { name: 'Show older events' }))
  await waitFor(() => expect(screen.getByText('Dana')).toBeTruthy())
  expect(screen.getByText('Spare build box')).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Show older events' })).toBeNull()
})

test('Audit filters on the server, pages with the same filters, and restarts when they change', async () => {
  const fetchMock = serve({
    '/auth/admin/audit?limit=100': {
      events: [event(20, { command: 'members.invite' })],
      nextBefore: 20,
    },
    '/auth/admin/audit?limit=100&actor=bob': {
      events: [event(18, { command: 'machines.revoke' })],
      nextBefore: 18,
    },
    '/auth/admin/audit?limit=100&actor=bob&kind=comments': {
      events: [event(16, { command: 'issues.editComment' })],
      nextBefore: 16,
    },
    '/auth/admin/audit?limit=100&actor=bob&kind=comments&before=16': {
      events: [event(4, { command: 'issues.deleteComment' })],
      nextBefore: null,
    },
    '/auth/admin/audit?limit=100&actor=bob&refusedOnly=true': { events: [], nextBefore: null },
  })
  render(<AuditSection />)
  await screen.findByText('Invited')
  fireEvent.change(screen.getByRole('combobox', { name: 'Person' }), { target: { value: 'bob' } })
  await screen.findByText('Revoked machine')
  expect(screen.queryByText('Invited')).toBeNull()
  expect(screen.getByRole('option', { name: 'Carol' })).toBeTruthy()
  fireEvent.change(screen.getByRole('combobox', { name: 'Event kind' }), {
    target: { value: 'comments' },
  })
  await screen.findByText('Edited another member’s comment')
  expect(screen.queryByText('Revoked machine')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Show older events' }))
  await screen.findByText('Deleted another member’s comment')
  expect(screen.getByText('Edited another member’s comment')).toBeTruthy()
  fireEvent.change(screen.getByRole('combobox', { name: 'Event kind' }), {
    target: { value: 'refused' },
  })
  await screen.findByText('No matching events.')
  expect(screen.queryByRole('table')).toBeNull()
  expect(screen.queryByRole('button', { name: 'Show older events' })).toBeNull()
  expect(
    fetchMock.mock.calls.map(([url]) => new URL(url).pathname + new URL(url).search),
  ).toContain('/auth/admin/audit?limit=100&actor=bob&refusedOnly=true')
})

test('Audit labels taking a key back from a machine in the Credentials filter', async () => {
  serve({
    '/auth/admin/audit?limit=100': { events: [], nextBefore: null },
    '/auth/admin/audit?limit=100&kind=credentials': {
      events: [
        event(1, {
          command: 'accounts.unsend',
          actor: { kind: 'member', id: 'bob', name: 'Bob' },
          onBehalfOf: { kind: 'member', id: 'bob', name: 'Bob' },
          target: { kind: 'machine', id: 'm-1', name: 'Spare build box' },
        }),
      ],
      nextBefore: null,
    },
  })
  render(<AuditSection />)
  await screen.findByText('No events yet.')
  fireEvent.change(screen.getByRole('combobox', { name: 'Event kind' }), {
    target: { value: 'credentials' },
  })
  const table = await screen.findByRole('table', { name: 'Security events' })
  expect(
    [...table.querySelectorAll('tbody tr td')].slice(1).map((cell) => cell.textContent),
  ).toEqual(['Bob', 'Took a key back', 'Spare build box', 'Done'])
})

test('Audit discards an older page that arrives after a filter change', async () => {
  serve({
    '/auth/admin/audit?limit=100': {
      events: [event(20, { command: 'members.invite' })],
      nextBefore: 20,
    },
    '/auth/admin/audit?limit=100&kind=credentials': {
      events: [event(15, { command: 'settings.setSecret' })],
      nextBefore: null,
    },
  })
  const originalFetch = globalThis.fetch
  let finishOlder!: (value: Response) => void
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) =>
      url.includes('before=20')
        ? new Promise<Response>((resolve) => {
            finishOlder = resolve
          })
        : originalFetch(url, init),
    ),
  )
  render(<AuditSection />)
  await screen.findByText('Invited')
  fireEvent.click(screen.getByRole('button', { name: 'Show older events' }))
  fireEvent.change(screen.getByRole('combobox', { name: 'Event kind' }), {
    target: { value: 'credentials' },
  })
  await screen.findByText('Set secret')
  await act(async () => {
    finishOlder(
      new Response(
        JSON.stringify({ events: [event(1, { command: 'members.join' })], nextBefore: 1 }),
      ),
    )
  })
  expect(screen.queryByText('Joined')).toBeNull()
  expect(screen.getByText('Set secret')).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Show older events' })).toBeNull()
})

test('Audit mentions moderation and labels a removal without inventing a machine release', async () => {
  serve({
    '/auth/admin/audit?limit=100': {
      events: [event(1, { command: 'members.remove' })],
      nextBefore: null,
    },
  })
  render(<AuditSection />)
  expect(await screen.findByText('Removed')).toBeTruthy()
  expect(screen.getByText(/comment moderation/)).toBeTruthy()
  expect(screen.queryByText(/releasing a machine/)).toBeNull()
})
