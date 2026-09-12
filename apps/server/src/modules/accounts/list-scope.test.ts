/**
 * `accounts.list` RETURNS ONE PERSON'S PROVIDER CONNECTIONS (PDM-271).
 *
 * The read used to build its native rows from every machine's inventory, so any
 * caller received every other person's harness login identity and the names of
 * the hosts it was observed on. The census row `accounts.list` carries severity
 * `discloses-private-execution` for exactly that.
 *
 * WHAT MAKES THE NEGATIVES MEAN ANYTHING. Every "Alice cannot see it" assertion
 * below is paired with a POSITIVE from the same fixture through the same call —
 * Bob asks and gets the row Alice was refused. Without that pair the negatives
 * would pass just as well against a fixture that produced no rows at all, which
 * is the vacuous shape the phase A catalogue records twice (entries 1 and 13).
 *
 * NEITHER PERSON IS AN ADMIN HERE, and that is the catalogue's entry 14: a
 * fixture that mints its second human wearing the admin capability decides every
 * isolation assertion by the admin short circuit rather than by the rule under
 * test. `machineIdsUsableBy` builds a member-grade principal for whoever asks, so
 * no caller in this file can reach one — and `machine-scope` invariance is pinned
 * separately below.
 */

import type { MachineId, UserId } from '@podium/model'
import { asMachineId, asUserId } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { userCommandPrincipal } from '../../command-principal'
import { checkMachineUse, ownershipSnapshotFromMachines } from '../../machine-access'
import type { MachineRecord } from '../../store/types'
import { machineIdsUsableBy } from './machine-scope'
import { ACCOUNT_QUERIES } from './queries'
import type { AccountState } from './registry'

const ALICE = asUserId('user:alice')
const BOB = asUserId('user:bob')

const ALPHA = asMachineId('machine-alpha')
const BETA = asMachineId('machine-beta')
const ORPHAN = asMachineId('machine-orphan')

/** One machine with one logged-in harness.
 *
 *  The cast is confined to this helper and covers only the bookkeeping columns
 *  (`createdAt`, `deliveryCaps`, the service-assignment pair and so on) that no
 *  assertion in this file reads. Everything the read actually consults — the id,
 *  the name, the owner and the inventory — is written out, so a shape change in
 *  those cannot be absorbed by the cast. */
function machine(input: {
  id: MachineId
  name: string
  owner: UserId | null
  harness: 'codex' | 'claude-code' | 'grok'
  email: string
}): MachineRecord {
  return {
    id: input.id,
    name: input.name,
    ownerUserId: input.owner,
    inventory: {
      os: 'linux',
      arch: 'x64',
      tools: [],
      agents: [
        {
          kind: input.harness,
          installed: true,
          login: {
            state: 'in',
            account: input.email,
            identity: { fingerprint: `fp:${input.email}`, email: input.email },
          },
        },
      ],
    },
  } as unknown as MachineRecord
}

const FLEET: readonly MachineRecord[] = [
  machine({ id: ALPHA, name: 'Alpha', owner: ALICE, harness: 'codex', email: 'alice@example.com' }),
  machine({ id: BETA, name: 'Beta', owner: BOB, harness: 'claude-code', email: 'bob@example.com' }),
  // D19.4b quarantine: an owner-less machine grants `use` to nobody, so its
  // login belongs to neither caller. Present so the refusal is observed rather
  // than assumed from the absence of such a machine.
  machine({ id: ORPHAN, name: 'Orphan', owner: null, harness: 'grok', email: 'ghost@example.com' }),
]

interface Seen {
  attemptViewers: UserId[]
  requiredScopes: ReadonlySet<MachineId>[]
}

function stateFor(caller: UserId, grants: { grantee: string; verb: string }[] = []): {
  state: AccountState
  seen: Seen
} {
  const seen: Seen = { attemptViewers: [], requiredScopes: [] }
  const machineService = {
    listMachines: async () =>
      FLEET.map((row) => ({
        id: row.id,
        name: row.name,
        online: true,
        inventory: row.inventory,
      })),
    ownershipRows: async () =>
      FLEET.map((row) => ({ id: row.id, name: row.name, ownerUserId: row.ownerUserId })),
    grantsForMachine: async (machineId: MachineId) =>
      machineId === ALPHA ? grants : [],
  }
  const state = {
    accounts: { list: async () => [] },
    machines: { listMachines: async () => [...FLEET] },
    machineService,
    settings: { apiKeyFor: async () => undefined },
    nativeLogin: {
      attempt: (_harness: string, viewer: UserId) => {
        seen.attemptViewers.push(viewer)
        return undefined
      },
      isRequired: (_harness: string, machineIds: ReadonlySet<MachineId>) => {
        seen.requiredScopes.push(machineIds)
        return false
      },
    },
    callerUserId: caller,
  } as unknown as AccountState
  return { state, seen }
}

const listFor = async (caller: UserId, grants?: { grantee: string; verb: string }[]) => {
  const { state, seen } = stateFor(caller, grants)
  const rows = await ACCOUNT_QUERIES.list.run(state, {})
  return { rows, seen, payload: JSON.stringify(rows) }
}

describe('accounts.list reader scoping', () => {
  it('returns a native login to the machine owner and not to another member', async () => {
    const alice = await listFor(ALICE)
    const bob = await listFor(BOB)

    // POSITIVE FIRST — the fixture really does produce each row for somebody, so
    // the refusals below are refusals rather than an empty catalog.
    expect(alice.payload).toContain('alice@example.com')
    expect(bob.payload).toContain('bob@example.com')
    expect(bob.payload).toContain('Beta')

    // The disclosure this issue exists to close: the identity AND the host name.
    expect(alice.payload).not.toContain('bob@example.com')
    expect(alice.payload).not.toContain('Beta')
    expect(bob.payload).not.toContain('alice@example.com')
    expect(bob.payload).not.toContain('Alpha')
  })

  it('refuses an owner-less machine to everyone', async () => {
    for (const caller of [ALICE, BOB]) {
      const { payload } = await listFor(caller)
      expect(payload).not.toContain('ghost@example.com')
      expect(payload).not.toContain('Orphan')
    }
  })

  it('honours an explicit `use` grant, so the filter is the machine rule and not an owner equality', async () => {
    const granted = await listFor(BOB, [{ grantee: BOB, verb: 'use' }])
    expect(granted.payload).toContain('alice@example.com')
    expect(granted.payload).toContain('Alpha')

    // A `see` grant is NOT a `use` grant (M2: see never implies use), and a
    // native row describes what an agent spawned there would authenticate as.
    const seeOnly = await listFor(BOB, [{ grantee: BOB, verb: 'see' }])
    expect(seeOnly.payload).not.toContain('alice@example.com')
  })

  it('offers login targets only on machines the caller may execute on', async () => {
    const { rows } = await listFor(ALICE)
    const targets = rows.flatMap((row) => row.loginMachines ?? [])
    expect(targets.map((target) => target.name)).toEqual(['Alpha'])
  })

  it('asks the login service about the caller and about that caller`s machines', async () => {
    const { seen } = await listFor(ALICE)

    // Both halves of the read are resolved from ONE answer. A harness-only
    // question here is what let a colleague's in-flight login and a colleague's
    // "login required" flag through while the rows themselves were scoped.
    expect(seen.attemptViewers.length).toBeGreaterThan(0)
    expect(new Set(seen.attemptViewers)).toEqual(new Set([ALICE]))
    expect(seen.requiredScopes.length).toBeGreaterThan(0)
    for (const scope of seen.requiredScopes) expect([...scope]).toEqual([ALPHA])
  })
})

describe('machineIdsUsableBy', () => {
  const source = (grants: { grantee: string; verb: string }[] = []) => ({
    ownershipRows: async () =>
      FLEET.map((row) => ({ id: row.id, name: row.name, ownerUserId: row.ownerUserId })),
    grantsForMachine: async (machineId: MachineId) => (machineId === ALPHA ? grants : []),
  })

  it('resolves ownership and grants, and never the owner-less machine', async () => {
    expect([...(await machineIdsUsableBy(source(), ALICE))]).toEqual([ALPHA])
    expect([...(await machineIdsUsableBy(source(), BOB))]).toEqual([BETA])
    expect([...(await machineIdsUsableBy(source([{ grantee: BOB, verb: 'use' }]), BOB))]).toEqual([
      ALPHA,
      BETA,
    ])
  })

  /**
   * WHY `machineIdsUsableBy` MAY PASS A ROLE IT DID NOT LOOK UP.
   *
   * It builds a member-grade principal because the accounts family's state
   * carries an identity and deliberately no capability. That is only safe if the
   * role cannot change a `use` answer, which is an argument in a comment until it
   * is measured — so measure it. The role DOES move the refusal WORD on an
   * owner-less machine (an admin may `see` it in order to assign an owner, so the
   * failure is `unauthorized` rather than `absent`); it never moves the verdict.
   * If that stops being true, this goes red and the comment stops being trusted.
   */
  it('refuses `use` identically whether the caller is a member or an admin', async () => {
    const ownership = await ownershipSnapshotFromMachines(source())
    for (const role of ['member', 'admin'] as const) {
      const alice = userCommandPrincipal(ALICE, role)
      expect(checkMachineUse(alice, ALPHA, ownership)).toBeUndefined()
      expect(checkMachineUse(alice, BETA, ownership)).not.toBeUndefined()
      expect(checkMachineUse(alice, ORPHAN, ownership)).not.toBeUndefined()
    }
    // The one thing the role does change, stated so the claim above is exact
    // rather than approximately true.
    const ownershipRows = await ownershipSnapshotFromMachines(source())
    expect(checkMachineUse(userCommandPrincipal(ALICE, 'member'), ORPHAN, ownershipRows)).toBe(
      'absent',
    )
    expect(checkMachineUse(userCommandPrincipal(ALICE, 'admin'), ORPHAN, ownershipRows)).toBe(
      'unauthorized',
    )
  })
})
