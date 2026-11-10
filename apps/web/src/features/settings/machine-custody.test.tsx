import '@/test-support/mock-request-pool.test.fixture'
import { SHARED_MACHINE_ACCOUNT_WARNING } from '@podium/model/browser'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { useWorklistPool as fixturePool } from '@/app/store-worklist-pool'
import { MachineCustody } from './machine-custody'

/**
 * GIVING ANOTHER MEMBER USE OF A MACHINE (POD-6299, over POD-6300's server
 * refusal): the grant shows the shared-machine warning and is sent with
 * `acknowledgeSharedMachine: true` only after the person ticks that they
 * understand it.
 */
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const UNSHARE = { mutate: vi.fn() }

async function sharingSection() {
  const heading = await screen.findByRole('heading', { name: 'Who else can run agents here' })
  const section = heading.closest('section')
  if (!section) throw new Error('Machine sharing section is missing')
  return section
}

function seed(grants?: unknown[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      json: async () => ({
        currentMemberId: 'alice',
        members: [
          { id: 'alice', displayName: 'Alice', email: null, role: 'admin' },
          { id: 'bob', displayName: 'Bob', email: null, role: 'member' },
        ],
      }),
    })),
  )
  // This test module supplies a plain pool accessor, without React hooks.
  const pool = fixturePool()
  if (!pool) throw new Error('Missing test pool')
  act(() =>
    pool.apply({
      type: 'replace',
      rows: [
        {
          kind: 'machine',
          id: 'm-1',
          value: {
            id: 'm-1',
            name: 'Build box',
            custodian: 'alice',
            loggedOutHarnesses: [],
            transferable: true,
            grants: grants ?? [],
          },
        },
      ],
    }),
  )
}

test('gives use only after the inline shared-machine warning is acknowledged', async () => {
  seed()
  const mutate = vi.fn().mockResolvedValue([])
  render(
    <MachineCustody
      machineId="m-1"
      transferable
      trpc={{ machines: { share: { mutate }, unshare: UNSHARE } }}
    />,
  )
  expect(await screen.findByRole('heading', { name: 'Who else can run agents here' })).toBeTruthy()
  fireEvent.click(await screen.findByRole('button', { name: 'Add someone' }))
  expect(screen.getByText(SHARED_MACHINE_ACCOUNT_WARNING).textContent).toBe(
    SHARED_MACHINE_ACCOUNT_WARNING,
  )
  const give = screen.getByRole('button', { name: 'Let them run agents here' })
  // Not before the person confirms the warning.
  expect(give).toHaveProperty('disabled', true)
  fireEvent.click(give)
  expect(mutate).not.toHaveBeenCalled()
  fireEvent.click(screen.getByLabelText('I understand we will share this machine’s account'))
  fireEvent.click(screen.getByRole('button', { name: 'Let them run agents here' }))
  await waitFor(() =>
    expect(mutate).toHaveBeenCalledExactlyOnceWith({
      id: 'm-1',
      grantee: 'bob',
      verb: 'use',
      acknowledgeSharedMachine: true,
    }),
  )
  expect(await screen.findByText('Bob can now run agents here.')).toBeTruthy()
})

test('offers no grant without custody authority', async () => {
  seed([BOB_USE])
  render(
    <MachineCustody
      machineId="m-1"
      transferable={false}
      trpc={{ machines: { share: { mutate: vi.fn() }, unshare: UNSHARE } }}
    />,
  )
  expect(await screen.findByRole('heading', { name: 'Who else can run agents here' })).toBeTruthy()
  expect(await screen.findByText('Bob')).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Add someone' })).toBeNull()
})

/**
 * WHO ELSE HAS ACCESS, AND REMOVING IT (POD-6700): the custodian or an admin
 * reads the machine's grants and removes one through `machines.unshare`.
 */
const BOB_USE = {
  grantee: 'bob',
  verb: 'use',
  grantedAt: '2026-11-08T10:00:00.000Z',
  grantedBy: 'alice',
}

test('lists who else has access and removes a grant', async () => {
  seed([BOB_USE])
  const unshare = vi.fn().mockResolvedValue([])
  render(
    <MachineCustody
      machineId="m-1"
      transferable
      trpc={{ machines: { share: { mutate: vi.fn() }, unshare: { mutate: unshare } } }}
    />,
  )
  const list = await sharingSection()
  await waitFor(() => expect(list.textContent).toContain('Bob'))
  fireEvent.click(screen.getByRole('button', { name: 'Remove Bob: can run agents' }))
  await waitFor(() =>
    expect(unshare).toHaveBeenCalledExactlyOnceWith({ id: 'm-1', grantee: 'bob', verb: 'use' }),
  )
  expect(
    await screen.findByText(
      'Bob can no longer start agents here. Sessions already running finish.',
    ),
  ).toBeTruthy()
})

test('shows the server’s refusal of a removal', async () => {
  seed([BOB_USE])
  const unshare = vi
    .fn()
    .mockRejectedValue(new Error('only the machine owner or an admin may change sharing'))
  render(
    <MachineCustody
      machineId="m-1"
      transferable
      trpc={{ machines: { share: { mutate: vi.fn() }, unshare: { mutate: unshare } } }}
    />,
  )
  fireEvent.click(await screen.findByRole('button', { name: /^Remove / }))
  expect((await screen.findByRole('alert')).textContent).toBe(
    'only the machine owner or an admin may change sharing',
  )
})

test('shows no grant removal without custody authority', async () => {
  seed([BOB_USE])
  render(
    <MachineCustody
      machineId="m-1"
      transferable={false}
      trpc={{ machines: { share: { mutate: vi.fn() }, unshare: UNSHARE } }}
    />,
  )
  expect(await screen.findByRole('heading', { name: 'Who else can run agents here' })).toBeTruthy()
  expect(await screen.findByText('Bob')).toBeTruthy()
  expect(screen.queryByRole('button', { name: /^Remove / })).toBeNull()
})
