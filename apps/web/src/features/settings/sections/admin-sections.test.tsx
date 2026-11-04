import '@/test-support/mock-request-pool.test.fixture'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { AccessSection } from './access'
import { AuditSection } from './audit'

/** The admin area's Access and Audit sections (POD-6299). */
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function serve(answers: Record<string, unknown>) {
  const fetchMock = vi.fn(async (url: string) => {
    const path = new URL(url).pathname + new URL(url).search
    const body = answers[path]
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
