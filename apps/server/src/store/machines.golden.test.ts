/**
 * The machines aggregate's DECLARED-MODE columns and its mapper decisions,
 * pinned against the drizzle conversion [POD-3394, spec §6 rule 28].
 *
 * WHY THIS FILE EXISTS, AND WHY IT IS NOT ABOUT METHOD COVERAGE. The coverage
 * census (POD-3244) puts machines.ts at zero never-named and zero
 * executed-but-never-named methods — every method here is named by some test.
 * That is exactly what made it the wrong place to feel safe, because rule 28 is
 * about VALUES, not methods.
 *
 * THE HAZARD, in one line: drizzle applies the schema's declared modes, so an
 * `integer({ mode: 'boolean' })` column arrives as `true`/`false` and not as
 * `1`/`0`, and a mapper still comparing it to a number silently answers `false`
 * for every row. `true === 1` is `false`, and it typechecks wherever the row is
 * `unknown`.
 *
 * WHAT MAKES IT LETHAL IS THAT THE WRONG ANSWER IS THE COMMON ANSWER, and this
 * file exists because that was demonstrated here rather than assumed. With
 * `podiumManaged` compared to `1`, the ENTIRE store lane passed — 72 files, 919
 * tests — because `podium_managed` defaults to 1 and every fixture in the lane
 * seeds an ordinary managed machine. Only `supervised` was caught, by one test
 * that happens to report a desktop shell. So both boolean columns this file
 * reads are pinned below AT THEIR NON-DEFAULT VALUE, which is the only value
 * that can tell the two worlds apart.
 *
 * The three mapper DECISIONS that survive the conversion (spec §6 rule 6) are
 * pinned with them, because each is a nullability rule a conversion could
 * "tidy" into a default: an unowned machine, an unpinned update channel, and
 * components that are unrecorded rather than empty.
 */

import { asMachineId, type UserId } from '@podium/model'
import { expect, it } from 'vitest'
import { openTestStore } from '../test-support/open-test-store'

const owner = 'user-1' as UserId

function register(
  store: ReturnType<typeof openTestStore>,
  id: string,
  over: Partial<{ podiumManaged: boolean; ownerUserId: UserId | null }> = {},
) {
  store.machines.upsertMachine({
    id,
    name: id,
    hostname: `${id}.local`,
    tokenHash: `hash-${id}`,
    ownerUserId: over.ownerUserId === undefined ? owner : over.ownerUserId,
    ...(over.podiumManaged === undefined ? {} : { podiumManaged: over.podiumManaged }),
  })
}

it('reads podium_managed as a boolean at BOTH values, including the non-default one', async () => {
  const store = await openTestStore(':memory:')
  try {
    // The column defaults to 1/true, so an unmanaged machine is the ONLY case
    // that distinguishes a boolean read from a numeric comparison. Verified by
    // mutation: comparing this column to `1` passes the whole store lane
    // without this assertion.
    register(store, 'unmanaged', { podiumManaged: false })
    register(store, 'managed', { podiumManaged: true })
    register(store, 'defaulted')

    expect(store.machines.getMachine('unmanaged')?.podiumManaged).toBe(false)
    expect(store.machines.getMachine('managed')?.podiumManaged).toBe(true)
    // Omitting the flag means managed, which is the caller-side default.
    expect(store.machines.getMachine('defaulted')?.podiumManaged).toBe(true)

    // Strictly boolean, never the underlying integer: `toBe(false)` above would
    // also hold for `0` under a loose comparison, this pins the type.
    expect(typeof store.machines.getMachine('unmanaged')?.podiumManaged).toBe('boolean')

    const listed = store.machines.listMachines()
    expect(listed.find((m) => m.id === 'unmanaged')?.podiumManaged).toBe(false)
    expect(listed.find((m) => m.id === 'managed')?.podiumManaged).toBe(true)
  } finally {
    store.close()
  }
})

it('reads supervised as a boolean, and an unreported machine is false rather than null', async () => {
  const store = await openTestStore(':memory:')
  try {
    register(store, 'm1')
    // NULL until a daemon reports, which the mapper reads as false: the
    // truthful answer, since a supervised daemon re-asserts on every hello.
    expect(store.machines.getMachine('m1')?.supervised).toBe(false)

    const build = {
      appVersion: '1.2.3',
      wireSchemaDigest: 'digest',
      installKind: 'installed' as const,
    }
    store.machines.setMachineBuild('m1', { ...build, supervised: true }, ['payload'], 'at-1')
    expect(store.machines.getMachine('m1')?.supervised).toBe(true)
    expect(typeof store.machines.getMachine('m1')?.supervised).toBe('boolean')

    // Written on EVERY report, so a machine that stops being supervised loses
    // the flag on its next hello rather than keeping it forever.
    store.machines.setMachineBuild('m1', { ...build, supervised: false }, ['payload'], 'at-2')
    expect(store.machines.getMachine('m1')?.supervised).toBe(false)

    expect(store.machines.getMachine('m1')).toMatchObject({
      appVersion: '1.2.3',
      wireSchemaDigest: 'digest',
      installKind: 'installed',
      deliveryCaps: ['payload'],
      buildReportedAt: 'at-2',
    })
  } finally {
    store.close()
  }
})

it('keeps an unowned machine unowned, and never substitutes an owner', async () => {
  const store = await openTestStore(':memory:')
  try {
    register(store, 'orphan', { ownerUserId: null })
    // POD-1079: null is MEANINGFUL and refuses `use` to everyone. A conversion
    // that coalesced it to a default would be the fail-open shape the nullable
    // column exists to avoid.
    expect(store.machines.getMachine('orphan')?.ownerUserId).toBeNull()

    // A returning hello does NOT transfer ownership, but it does fill a NULL.
    register(store, 'orphan', { ownerUserId: owner })
    expect(store.machines.getMachine('orphan')?.ownerUserId).toBe(owner)
    register(store, 'orphan', { ownerUserId: 'user-2' as UserId })
    expect(store.machines.getMachine('orphan')?.ownerUserId).toBe(owner)

    // The forced projection is the path that DOES move it, and null is quarantine.
    store.machines.setMachineOwner('orphan', 'user-2' as UserId)
    expect(store.machines.getMachine('orphan')?.ownerUserId).toBe('user-2')
    store.machines.setMachineOwner('orphan', null)
    expect(store.machines.getMachine('orphan')?.ownerUserId).toBeNull()
  } finally {
    store.close()
  }
})

it('reads an unpinned update channel as null and keeps an unreadable one unpinned', async () => {
  const store = await openTestStore(':memory:')
  try {
    register(store, 'm1')
    // POD-1882: null means "follow the fleet default", not "no answer".
    expect(store.machines.getMachine('m1')?.updateChannelOverride).toBeNull()

    store.machines.setUpdateChannel('m1', 'edge')
    expect(store.machines.getMachine('m1')?.updateChannelOverride).toBe('edge')
    store.machines.setUpdateChannel('m1', null)
    expect(store.machines.getMachine('m1')?.updateChannelOverride).toBeNull()
  } finally {
    store.close()
  }
})

it('distinguishes components NOT RECORDED from components recorded as none', async () => {
  const store = await openTestStore(':memory:')
  try {
    register(store, 'm1')
    // NULL is distinct from '[]' (POD-2700): a machine that has not said what it
    // runs refuses nothing, where one that runs nothing must refuse.
    expect(store.machines.getMachine('m1')?.components).toBeNull()

    expect(store.machines.addMachineComponent('m1', 'daemon')).toBe(true)
    expect(store.machines.getMachine('m1')?.components).toEqual(['daemon'])

    // ADDITIVE and idempotent: the second writer must not evict the first, and
    // a repeated stamp reports no change so the caller skips its broadcast.
    expect(store.machines.addMachineComponent('m1', 'server')).toBe(true)
    expect(store.machines.getMachine('m1')?.components).toEqual(['daemon', 'server'])
    expect(store.machines.addMachineComponent('m1', 'daemon')).toBe(false)
    expect(store.machines.getMachine('m1')?.components).toEqual(['daemon', 'server'])

    expect(store.machines.addMachineComponent('absent', 'daemon')).toBe(false)
  } finally {
    store.close()
  }
})

it('finds no retired machine sentinel on a database a supported install can hold', async () => {
  const store = await openTestStore(':memory:')
  try {
    register(store, asMachineId('11111111-1111-4111-8111-111111111111'))
    // The boot refusal's input. Empty is the only answer a shipped Podium can
    // produce, and the check exists because the alternative to finding out is
    // not finding out.
    expect(store.machines.legacyMachineSentinelSites()).toEqual([])
  } finally {
    store.close()
  }
})
