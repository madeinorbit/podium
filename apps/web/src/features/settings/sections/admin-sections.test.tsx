import '@/test-support/mock-request-pool.test.fixture'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { AuditSection } from './audit'

// The security log keeps its existing request/filter/cursor behavior.
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

async function chooseFilter(name: string, option: string) {
  fireEvent.click(screen.getByRole('combobox', { name }))
  const item = await screen.findByRole('option', { name: option })
  fireEvent.pointerDown(item, { pointerType: 'mouse', button: 0 })
  fireEvent.click(item)
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

test('Audit groups security sentences with delegated actors and refused attempts', async () => {
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
  await screen.findByText('Alice took over Spare build box')
  expect(screen.getByText('An agent for Alice made Bob an admin')).toBeTruthy()
  expect(screen.getByText('Alice invited a member')).toBeTruthy()
  expect(screen.getByText('Alice tried to disable Carol')).toBeTruthy()
  expect(screen.getByText('Refused')).toBeTruthy()
  expect(screen.queryByRole('table')).toBeNull()
  expect(screen.getAllByRole('heading', { level: 3 })).toHaveLength(1)
  fireEvent.click(screen.getByRole('button', { name: 'Show older events' }))
  await waitFor(() => expect(screen.getByText('Alice joined this workspace')).toBeTruthy())
  expect(screen.getAllByRole('heading', { level: 3 })).toHaveLength(1)
  expect(screen.getByText('Alice took over Spare build box')).toBeTruthy()
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
  await screen.findByText('Alice invited a member')
  await chooseFilter('Person', 'Bob')
  await screen.findByText('Alice removed a machine')
  expect(screen.queryByText('Alice invited a member')).toBeNull()
  await chooseFilter('Event kind', 'Comments')
  await screen.findByText('Alice edited another person’s comment')
  expect(screen.queryByText('Alice removed a machine')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Show older events' }))
  await screen.findByText('Alice deleted another person’s comment')
  expect(screen.getByText('Alice edited another person’s comment')).toBeTruthy()
  await chooseFilter('Event kind', 'Refused only')
  await screen.findByText('Nothing matches')
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
  await screen.findByText('No events yet')
  await chooseFilter('Event kind', 'Credentials')
  expect(await screen.findByText('Bob took a key back from Spare build box')).toBeTruthy()
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
  await screen.findByText('Alice invited a member')
  fireEvent.click(screen.getByRole('button', { name: 'Show older events' }))
  await chooseFilter('Event kind', 'Credentials')
  await screen.findByText('Alice set a workspace secret')
  await act(async () => {
    finishOlder(
      new Response(
        JSON.stringify({ events: [event(1, { command: 'members.join' })], nextBefore: 1 }),
      ),
    )
  })
  expect(screen.queryByText('Alice joined this workspace')).toBeNull()
  expect(screen.getByText('Alice set a workspace secret')).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Show older events' })).toBeNull()
})

test('Audit describes a removal without inventing a machine release', async () => {
  serve({
    '/auth/admin/audit?limit=100': {
      events: [event(1, { command: 'members.remove' })],
      nextBefore: null,
    },
  })
  render(<AuditSection />)
  expect(await screen.findByText('Alice removed a member')).toBeTruthy()
  expect(screen.queryByText(/releasing/)).toBeNull()
})
