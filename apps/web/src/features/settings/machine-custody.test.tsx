import '@/test-support/mock-request-pool.test.fixture'
import { SHARED_MACHINE_ACCOUNT_WARNING } from '@podium/model/browser'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { useWorklistPool } from '@/app/store-worklist-pool'
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

function seed() {
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
  act(() =>
    useWorklistPool()!.apply({
      type: 'replace',
      rows: [
        {
          kind: 'machine',
          id: 'm-1',
          value: { id: 'm-1', name: 'Build box', custodian: 'alice', loggedOutHarnesses: [] },
        },
      ],
    }),
  )
}

test('names the custodian and gives use only after the warning is acknowledged', async () => {
  seed()
  const mutate = vi.fn().mockResolvedValue([])
  render(<MachineCustody machineId="m-1" transferable trpc={{ machines: { share: { mutate } } }} />)
  expect(await screen.findByText('Custody: Alice')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Give use…' }))
  expect(screen.getByRole('note').textContent).toBe(SHARED_MACHINE_ACCOUNT_WARNING)
  fireEvent.change(screen.getByLabelText('Member'), { target: { value: 'bob' } })
  const give = screen.getByRole('button', { name: 'Give use' })
  // Not before the person confirms the warning.
  expect(give).toHaveProperty('disabled', true)
  fireEvent.click(give)
  expect(mutate).not.toHaveBeenCalled()
  fireEvent.click(screen.getByLabelText('I understand that we will share this machine’s account'))
  fireEvent.click(screen.getByRole('button', { name: 'Give use' }))
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
  seed()
  render(
    <MachineCustody
      machineId="m-1"
      transferable={false}
      trpc={{ machines: { share: { mutate: vi.fn() } } }}
    />,
  )
  expect(await screen.findByText('Custody: Alice')).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Give use…' })).toBeNull()
})
