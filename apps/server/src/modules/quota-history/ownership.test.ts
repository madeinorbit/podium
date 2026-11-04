/**
 * QUOTA HISTORY BELONGS TO WHOEVER LOOKED AFTER THE RECORDING MACHINE (POD-6300).
 *
 * One member, the `quota.history` query over a real store. A window is owned by
 * the custodian of the machine that reported it, fixed when it is recorded, so it
 * stays visible after the login leaves the machine or the machine is gone, as it
 * was before owners existed. A window from a machine nobody looks after answers
 * to nobody.
 */

import { asMachineId, firstAdminMemberId, type MachineQuotaWire, type UserId } from '@podium/model'
import { afterEach, expect, it } from 'vitest'
import type { SessionStore } from '../../store'
import { openTestStore } from '../../test-support/open-test-store'
import type { FamilyState } from '../derived-family'
import { QUOTA_QUERIES } from '../misc-queries'
import { recordQuotaSamples } from './service'

const member = firstAdminMemberId()
const DESK = asMachineId('machine-desk')
const STRAY = asMachineId('machine-stray')

const stores: SessionStore[] = []
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close()
})

/** One reading of the member's Claude login on a machine. */
const reading = (machineId: string, email: string): MachineQuotaWire => ({
  machineId: asMachineId(machineId),
  machineName: machineId,
  hostname: machineId,
  agents: [
    {
      agent: 'claude-code',
      status: 'ok',
      account: { email },
      windows: [
        {
          key: 'five_hour',
          label: '5h',
          usedPercent: 30,
          resetsAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          windowMinutes: 300,
        },
      ],
      fetchedAt: new Date(Date.now() - 60_000).toISOString(),
    },
  ],
})

/** The query's view of its caller: `standing` is the caller's machines today. */
const asCaller = (
  store: SessionStore,
  userId: UserId,
  standing: ReadonlyMap<string, 'custody' | 'use'>,
): FamilyState =>
  ({
    store,
    caller: { userId },
    privateAccess: {
      machineStanding: async () => standing,
      mayReadMachineFiles: async () => true,
      ownsSession: async () => false,
    },
  }) as unknown as FamilyState

async function oneMemberStore(): Promise<SessionStore> {
  const store = await openTestStore(':memory:')
  stores.push(store)
  for (const id of [DESK, STRAY]) {
    await store.machines.upsertMachine({
      id,
      name: id,
      hostname: id,
      tokenHash: `${id}-token`,
      ownerUserId: id === DESK ? member : null,
      assignment: { server: false, agentExecution: true },
    })
  }
  await recordQuotaSamples(
    store.quotaHistory,
    [reading(DESK, 'old-login@example.com'), reading(STRAY, 'stray@example.com')],
    undefined,
    async (machineId) => await store.machines.custodian(machineId),
  )
  return store
}

const keysFor = async (state: FamilyState) =>
  (await QUOTA_QUERIES.history.run(state, { days: 1 })).map((row) => row.accountKey)

it('keeps a window after its login left every machine’s inventory', async () => {
  const store = await oneMemberStore()
  // The member switched Claude accounts: no inventory lists the old login.
  expect(await keysFor(asCaller(store, member, new Map([[DESK, 'custody']])))).toEqual([
    'claude-code::old-login@example.com',
  ])
})

it('keeps a window after the machine that recorded it is gone', async () => {
  const store = await oneMemberStore()
  expect(await keysFor(asCaller(store, member, new Map()))).toEqual([
    'claude-code::old-login@example.com',
  ])
})

it('gives a window from a machine nobody looks after to nobody', async () => {
  const store = await oneMemberStore()
  const all = (await store.quotaHistory.list(0, Date.now())).map((row) => row.accountKey).sort()
  expect(all).toEqual(['claude-code::old-login@example.com', 'claude-code::stray@example.com'])
  expect(await keysFor(asCaller(store, member, new Map([[STRAY, 'custody']])))).not.toContain(
    'claude-code::stray@example.com',
  )
})
