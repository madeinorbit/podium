import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asAccountId, asMachineId, asSessionId } from '@podium/model'
import type { Inventory } from '@podium/model'
import type { ControlMessage } from '@podium/protocol'
import { describe, expect, test } from 'vitest'
import { openEnrollmentLedger } from '../../enrollment-ledger'
import { SessionStore } from '../../store'
import { testClientPrincipal } from '../../test-support/client-principal'
import type { Send } from '../sessions/session'
import { sha256 } from './enrollment'
import { type MachinesDeps, MachinesService, type PairingGrant } from './service'

/** Only the socket bookkeeping is exercised here — none of these paths touch the store. */
function makeService(): MachinesService {
  const deps = {
    instanceId: 'default',
    store: {} as MachinesDeps['store'],
    hostMachineId: asMachineId('host-under-test'),
    sessionsChangedForMachine: () => {},
    clients: () => [],
    machinesForPrincipal: () => [],
  } satisfies MachinesDeps
  return new MachinesService(deps)
}

const MACHINE = 'vmi'
/** A keystroke — the message class that silently queued into the void during the outage. */
const keystroke: ControlMessage = { type: 'input', sessionId: asSessionId('s1'), data: 'ls\r' }

function recorder(): { send: Send<ControlMessage>; got: ControlMessage[] } {
  const got: ControlMessage[] = []
  return { send: (m) => got.push(m), got }
}

describe('MachinesService daemon socket identity', () => {
  test('a superseded socket’s late close does not evict the reconnected daemon', () => {
    // Reproduces the 2026-07-09 vmi outage: the daemon reconnects while its previous
    // socket is wedged; the keepalive sweep terminates the old socket a beat later and
    // its `close` fires. Keyed only by machineId, that close deleted the FRESH send —
    // leaving the machine unroutable while its daemon sat happily connected.
    const svc = makeService()
    const old = recorder()
    const fresh = recorder()

    svc.attach(MACHINE, old.send)
    svc.attach(MACHINE, fresh.send) // daemon reconnects, replacing the registration

    const detached = svc.detach(MACHINE, old.send) // the dead socket's late close

    expect(detached).toBe(false)
    expect(svc.hasDaemon(MACHINE)).toBe(true)

    // and control messages still reach the live socket rather than queueing forever
    svc.toMachine(MACHINE, keystroke)
    expect(fresh.got).toEqual([keystroke])
    expect(old.got).toEqual([])
  })

  test('the current socket’s close detaches the machine', () => {
    const svc = makeService()
    const only = recorder()

    svc.attach(MACHINE, only.send)
    const detached = svc.detach(MACHINE, only.send)

    expect(detached).toBe(true)
    expect(svc.hasDaemon(MACHINE)).toBe(false)
  })

  test('an unidentified detach still drops the socket (legacy callers)', () => {
    const svc = makeService()
    svc.attach(MACHINE, recorder().send)

    expect(svc.detach(MACHINE)).toBe(true)
    expect(svc.hasDaemon(MACHINE)).toBe(false)
  })
})

describe('MachinesService.requireAgent refuses rather than falling through (POD-303)', () => {
  /** A service whose machine list is stubbed, so the gate can be driven with a
   *  `use` decision Phase 4 (POD-1079) will eventually put on the projection. */
  function serviceListing(machines: unknown[]): MachinesService {
    const svc = makeService()
    ;(svc as unknown as { listMachines: () => unknown[] }).listMachines = () => machines
    return svc
  }
  const runnable = {
    id: MACHINE,
    name: 'vmi',
    inventory: { agents: [{ kind: 'codex', installed: true, login: { state: 'in' as const } }] },
  }

  test('a denied machine throws about access, not about being offline', () => {
    // The counterfactual is the SAME machine without the denial: it is accepted,
    // so the throw is caused by `use`, not by the fixture being unrunnable. And
    // the offline machine is here too, proving the two refusals are different
    // messages rather than one generic "unavailable".
    expect(() =>
      serviceListing([{ ...runnable, online: true }]).requireAgent(MACHINE, 'codex'),
    ).not.toThrow()
    expect(() =>
      serviceListing([{ ...runnable, online: true, use: 'denied' }]).requireAgent(MACHINE, 'codex'),
    ).toThrow(/do not have access/)
    expect(() =>
      serviceListing([{ ...runnable, online: false }]).requireAgent(MACHINE, 'codex'),
    ).toThrow(/is offline/)
  })

  test('a shell on a denied machine is refused too — spawning is `use`', () => {
    // Shells skip the harness checks, and that shortcut must not skip the access
    // gate. Counterfactual: the same shell request on an undenied machine passes.
    expect(() =>
      serviceListing([{ id: MACHINE, name: 'vmi', online: true }]).requireAgent(MACHINE, 'shell'),
    ).not.toThrow()
    expect(() =>
      serviceListing([{ id: MACHINE, name: 'vmi', online: true, use: 'denied' }]).requireAgent(
        MACHINE,
        'shell',
      ),
    ).toThrow(/do not have access/)
  })
})

describe('the machine caches are dropped by pair/hello (POD-1479)', () => {
  // The row caches (machineRecordsCache / machineNameCache) are derived state:
  // every write to the machines table must invalidate them or a client keeps
  // reading the pre-write fleet. The credential lifecycle writes that table on
  // BOTH handshake arms, and reaches the caches only through EnrollmentHost —
  // so these tests drive `authenticateDaemon` and read the public projections
  // with NO manual invalidate in between. They also never `attach()`, because
  // attach invalidates defensively and would mask the loss.
  //
  // The cache is WARMED first in each case: an unwarmed read is a cache MISS
  // that rebuilds anyway, and would pass with invalidation removed entirely.

  function pairingService(): { svc: MachinesService; store: SessionStore } {
    const store = new SessionStore(':memory:')
    const codes = new Map<string, PairingGrant>()
    const svc = new MachinesService({
      instanceId: 'default',
      store,
      hostMachineId: store.hostMachineId,
      pairing: {
        mint: (grant = {}) => {
          codes.set('code-1', grant)
          return 'code-1'
        },
        redeem: (code) => {
          const grant = codes.get(code)
          codes.delete(code)
          return grant
        },
      },
      sessionsChangedForMachine: () => {},
      clients: () => [],
      machinesForPrincipal: () => [],
    } satisfies MachinesDeps)
    return { svc, store }
  }

  test('a paired machine is named and listed without a manual invalidate', () => {
    const { svc } = pairingService()
    // Warm both caches on the pre-pair fleet: machineName populates the name map,
    // listMachines the record list. Everything after this is served from them
    // until something drops them.
    svc.machineName(MACHINE)
    const before = svc.listMachines().map((m) => m.id)
    expect(before).not.toContain(MACHINE)

    const code = svc.mintPairingCode({ ownerUserId: 'user:sole' })
    const result = svc.authenticateDaemon({
      type: 'pair',
      code,
      machineId: MACHINE,
      hostname: 'vmi.local',
      name: 'Builder',
    })
    expect(result.ok).toBe(true)

    expect(svc.machineName(MACHINE)).toBe('Builder')
    expect(svc.listMachines().find((m) => m.id === MACHINE)?.name).toBe('Builder')
    // Ownership reads the same cache, and it is the authorization input.
    expect(svc.ownershipRows().find((m) => m.id === MACHINE)?.ownerUserId).toBe('user:sole')
  })

  test('a hello’s restamped hostname is visible without a manual invalidate', () => {
    const { svc, store } = pairingService()
    const token = 'tok-vmi'
    store.machines.upsertMachine({
      id: MACHINE,
      name: 'Builder',
      hostname: 'old.local',
      tokenHash: sha256(token),
      ownerUserId: 'user:sole',
    })

    // Warm on the pre-hello row — the upsert went straight to the store, so this
    // read is what puts the stale hostname in the cache.
    expect(svc.listMachines().find((m) => m.id === MACHINE)?.hostname).toBe('old.local')

    const result = svc.authenticateDaemon({
      type: 'hello',
      machineId: MACHINE,
      token,
      hostname: 'new.local',
    })
    expect(result.ok).toBe(true)

    expect(svc.listMachines().find((m) => m.id === MACHINE)?.hostname).toBe('new.local')
  })
})

describe('MachinesService inventory persistence (#222)', () => {
  const INV: Inventory = {
    os: 'linux',
    arch: 'arm64',
    podiumVersion: '9.9.9',
    agents: [
      {
        kind: 'claude-code',
        installed: true,
        version: '2.1.0',
        login: { state: 'in', account: 'a@b.c' },
      },
      { kind: 'opencode', installed: false, login: { state: 'unknown' } },
    ],
    tools: [{ name: 'gh', installed: true, version: 'gh version 2.40.0' }],
  }

  function makeStoreService(): { svc: MachinesService; store: SessionStore } {
    const store = new SessionStore(':memory:')
    const svc = new MachinesService({
      instanceId: 'default',
      store,
      hostMachineId: store.hostMachineId,
      sessionsChangedForMachine: () => {},
      clients: () => [],
      machinesForPrincipal: () => [],
    } satisfies MachinesDeps)
    return { svc, store }
  }

  test('recordInventory persists the report and it survives a hello reconnect', () => {
    const { svc, store } = makeStoreService()
    store.machines.upsertMachine({
      id: MACHINE,
      name: 'vmi',
      hostname: 'vmi',
      tokenHash: 'x',
      ownerUserId: 'user:sole',
    })

    svc.recordInventory(MACHINE, INV)
    expect(store.machines.getMachine(MACHINE)?.inventory).toEqual(INV)

    // A hello only restamps last_seen_at/hostname — the inventory must remain.
    store.machines.touchMachine(MACHINE, 'vmi-renamed')
    expect(store.machines.getMachine(MACHINE)?.inventory).toEqual(INV)
    expect(store.machines.getMachine(MACHINE)?.hostname).toBe('vmi-renamed')
  })

  test('records the native identity fingerprint selected on the target machine', () => {
    const { svc, store } = makeStoreService()
    store.machines.upsertMachine({
      id: MACHINE,
      name: 'Builder',
      hostname: 'vmi',
      tokenHash: 'x',
      ownerUserId: 'user:sole',
    })
    svc.recordInventory(MACHINE, {
      ...INV,
      agents: [
        {
          kind: 'codex',
          installed: true,
          login: { state: 'in', identity: { fingerprint: 'fp-a' } },
        },
      ],
    })

    expect(svc.nativeAccountIdForMachine(MACHINE, 'codex', asAccountId('native:codex'))).toBe(
      'native:codex:fp-a',
    )
    expect(svc.nativeAccountIdForMachine(MACHINE, 'codex', asAccountId('native:codex:fp-b'))).toBe(
      'native:codex:fp-b',
    )
  })

  test('explicit session placement rejects a missing harness but starts logged out', () => {
    const { svc, store } = makeStoreService()
    store.machines.upsertMachine({
      id: MACHINE,
      name: 'Builder',
      hostname: 'vmi',
      tokenHash: 'x',
      ownerUserId: 'user:sole',
    })
    svc.attach(MACHINE, recorder().send)

    svc.recordInventory(MACHINE, INV)
    expect(() => svc.resolveMachineForAgent(MACHINE, '/repo', 'codex')).toThrow(
      "codex is not installed on machine 'Builder'",
    )

    svc.recordInventory(MACHINE, {
      ...INV,
      agents: [{ kind: 'codex', installed: true, login: { state: 'out' } }],
    })
    expect(svc.resolveMachineForAgent(MACHINE, '/repo', 'codex')).toBe(MACHINE)
    expect(svc.agentLoginCondition(MACHINE, 'codex')).toBe('logged-out')
  })

  test('implicit placement moves to a capable machine that owns the cwd', () => {
    const { svc, store } = makeStoreService()
    const other = 'capable'
    store.machines.upsertMachine({
      id: MACHINE,
      name: 'Missing',
      hostname: 'a',
      tokenHash: 'x',
      ownerUserId: 'user:sole',
    })
    store.machines.upsertMachine({
      id: other,
      name: 'Capable',
      hostname: 'b',
      tokenHash: 'y',
      ownerUserId: 'user:sole',
    })
    store.repos.addRepo('/repo', MACHINE)
    store.repos.addRepo('/repo', other)
    svc.attach(MACHINE, recorder().send)
    svc.attach(other, recorder().send)
    svc.recordInventory(MACHINE, {
      ...INV,
      agents: [{ kind: 'codex', installed: true, login: { state: 'out' } }],
    })
    svc.recordInventory(other, {
      ...INV,
      agents: [{ kind: 'codex', installed: true, login: { state: 'in' } }],
    })

    expect(svc.resolveMachineForAgent(undefined, '/repo/subdir', 'codex')).toBe(other)
  })
})

// ---------------------------------------------------------------------------
// OWNERSHIP TRANSFER — THE PROJECTION TAIL (POD-1480)
// ---------------------------------------------------------------------------
//
// `transferOwnership` appends to the enrollment ledger (the commit point,
// D19.4d) and then projects: row write → invalidateMachineCache →
// broadcastMachines. Until this suite the ONLY caller anywhere passed
// `skipRowUpdate: true` and returned before that tail, so none of those three
// steps had ever executed — POD-1467 confirmed it by replacing
// `broadcastMachines` with a THROW and watching the whole lane stay green.
//
// So these tests do not assert that the tail is CALLED — a call spy is satisfied
// by a no-op that still calls. They read the PROJECTION BACK through the public
// surface, with the caches deliberately warmed on the pre-transfer fleet first,
// and they snapshot what the fleet looked like AT BROADCAST TIME so the
// invalidate-before-broadcast ordering is asserted rather than assumed.
describe('ownership transfer projects onto the fleet (POD-1480)', () => {
  const OWNER_A = 'user:alice'
  const OWNER_B = 'user:bob'

  function transferWorld(): {
    svc: MachinesService
    store: SessionStore
    dir: string
    /** One entry per broadcast, holding the OWNER the fleet read back at the
     *  moment the broadcast went out. */
    broadcasts: (string | null | undefined)[]
  } {
    const dir = mkdtempSync(join(tmpdir(), 'podium-transfer-'))
    const store = new SessionStore(':memory:')
    const broadcasts: (string | null | undefined)[] = []
    const known = new Set([OWNER_A, OWNER_B])
    let svc!: MachinesService
    svc = new MachinesService({
      instanceId: 'default',
      store,
      hostMachineId: store.hostMachineId,
      enrollment: openEnrollmentLedger(dir),
      userExists: (id) => known.has(id),
      sessionsChangedForMachine: () => {},
      clients: () => [{ principal: testClientPrincipal('c1'), send: () => {} }],
      // Called once per client on every broadcast. Reading `ownershipRows()`
      // here is the load-bearing part: it goes through the SAME record cache the
      // transfer must have dropped, so a stale entry lands in this array.
      machinesForPrincipal: () => {
        broadcasts.push(svc.ownershipRows().find((r) => r.id === MACHINE)?.ownerUserId)
        return []
      },
    } satisfies MachinesDeps)
    store.machines.upsertMachine({
      id: MACHINE,
      name: 'Builder',
      hostname: 'vmi.local',
      tokenHash: sha256('tok'),
      ownerUserId: OWNER_A,
    })
    return { svc, store, dir, broadcasts }
  }

  // A NOTE ON THE CACHE, measured rather than assumed. `transferOwnership` calls
  // `invalidateMachineCache` between the row write and the broadcast, and
  // REMOVING that call does not redden anything here — deliberately reported
  // rather than papered over. It is not "never entered" (replacing the very next
  // statement, `broadcastMachines`, with a throw DOES redden three of these) and
  // it is not an assertion gap that a better probe would close: it is
  // EQUIVALENT for this write, because the record cache has exactly two readers
  // and neither exposes a stale owner. `ownershipRows` overlays `effectiveOwner`,
  // which reads the ledger live (D19.4d rule 4, ledger-wins); and `listMachines`
  // carries no owner FACT of its own — POD-1495's `owned` is a viewer-relative
  // answer supplied by the command layer, which computes it from that same
  // ledger-live index rather than from the cached row. The invalidate is defensive — correct to
  // keep, since a future reader of the raw cached row would need it — but no
  // public read can currently distinguish its presence.
  test('the row is written, the fleet serves the NEW owner, and one broadcast goes out', () => {
    const { svc, store, dir, broadcasts } = transferWorld()
    try {
      // Warm on the pre-transfer fleet. Without this the read-back below is a
      // cache MISS that rebuilds anyway and would pass with the invalidate gone.
      expect(svc.ownershipRows().find((r) => r.id === MACHINE)?.ownerUserId).toBe(OWNER_A)
      expect(broadcasts).toHaveLength(0)

      svc.transferMachineOwnership(MACHINE, OWNER_B, OWNER_A)

      // 1 — THE ROW. Read straight from the store, past every cache.
      expect(store.machines.getMachine(MACHINE)?.ownerUserId).toBe(OWNER_B)
      // 2 — THE FLEET. The same public read that was warmed above, with no
      // manual invalidate in between.
      expect(svc.ownershipRows().find((r) => r.id === MACHINE)?.ownerUserId).toBe(OWNER_B)
      // 3 — THE BROADCAST, and its ORDERING: exactly one went out, and the fleet
      // it was built from already showed the new owner — so it was emitted
      // AFTER the transition committed, not before.
      expect(broadcasts).toEqual([OWNER_B])
      // 4 — THE LEDGER, which is the commit point the row merely projects.
      expect(svc.effectiveOwner(MACHINE)).toBe(OWNER_B)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('the outgoing owner’s audience does not travel with the machine', () => {
    const { svc, store, dir } = transferWorld()
    try {
      store.grants.upsert({
        resourceKind: 'machine',
        resourceId: MACHINE,
        grantee: 'user:carol',
        verb: 'use',
        owner: OWNER_A,
        visibility: 'owned-compute',
        createdAt: new Date().toISOString(),
        actorKind: 'user',
        actorId: 'alice',
        onBehalfOf: OWNER_A,
      })
      expect(svc.grantsForMachine(MACHINE)).toHaveLength(1)

      svc.transferMachineOwnership(MACHINE, OWNER_B, OWNER_A)

      // Carol's `use` was Alice's deliberate act on Alice's hardware. It is not
      // Bob's, and `use` is a code-execution boundary (readiness M2).
      expect(svc.grantsForMachine(MACHINE)).toHaveLength(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a non-owner is refused at the service too, and the fleet is untouched', () => {
    const { svc, store, dir, broadcasts } = transferWorld()
    try {
      // SECOND PRINCIPAL. The gate refuses this in `fleetAuthzFailure`; the
      // service refuses it again, because a service reachable from more than one
      // transport must not depend on every one of them remembering.
      expect(() => svc.transferMachineOwnership(MACHINE, OWNER_A, OWNER_B)).toThrow(
        'only the machine owner may transfer ownership',
      )
      expect(store.machines.getMachine(MACHINE)?.ownerUserId).toBe(OWNER_A)
      // A refused transfer is SILENT — no ledger append, no broadcast.
      expect(broadcasts).toEqual([])
      expect(svc.effectiveOwner(MACHINE)).toBe(OWNER_A)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('an unknown recipient is refused rather than quarantining the machine', () => {
    const { svc, store, dir, broadcasts } = transferWorld()
    try {
      expect(() => svc.transferMachineOwnership(MACHINE, 'user:typo', OWNER_A)).toThrow(
        'unknown user: user:typo',
      )
      // The hazard this closes: an owner the ledger records but `userExists`
      // cannot resolve is quarantined by the next reconcile — owner null, usable
      // by nobody. Nothing was appended, so nothing to reconcile.
      expect(store.machines.getMachine(MACHINE)?.ownerUserId).toBe(OWNER_A)
      expect(svc.effectiveOwner(MACHINE)).toBe(OWNER_A)
      expect(broadcasts).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('transferring to the current owner is refused, not a silent no-op broadcast', () => {
    const { svc, dir, broadcasts } = transferWorld()
    try {
      expect(() => svc.transferMachineOwnership(MACHINE, OWNER_A, OWNER_A)).toThrow(
        'machine is already owned by that user',
      )
      expect(broadcasts).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

/**
 * ADOPTION (POD-1494) — giving an owner to a machine that has none.
 *
 * The suite above proves transfer moves ownership BETWEEN two people. This one
 * covers the case transfer refuses by construction, and its whole subject is
 * WHICH machines qualify: "unowned" is three distinguishable states, and the
 * thing that distinguishes them is the ENROLLMENT LEDGER, never the
 * `machines.owner_user_id` projection (D19.4d).
 */
describe('adoption of an unowned machine (POD-1494)', () => {
  const ALICE = 'user:alice'
  const BOB = 'user:bob'

  function adoptWorld(opts: { rowOwner?: string | null; known?: string[] } = {}): {
    svc: MachinesService
    store: SessionStore
    dir: string
    /** Mutable, so a test can make a recorded owner STOP resolving — which is
     *  the only way to produce the quarantine state (D19.4b) honestly. */
    known: Set<string>
    /** Rebuild the service over the SAME ledger directory and the same store.
     *  The constructor runs `reconcileOwnersFromLedger`, so this is the boot
     *  repair path, and it is how a test can ask what the LEDGER alone says. */
    reboot: () => MachinesService
  } {
    const dir = mkdtempSync(join(tmpdir(), 'podium-adopt-'))
    const store = new SessionStore(':memory:')
    const known = new Set(opts.known ?? [ALICE, BOB])
    const build = (): MachinesService =>
      new MachinesService({
        instanceId: 'default',
        store,
        hostMachineId: store.hostMachineId,
        enrollment: openEnrollmentLedger(dir),
        userExists: (id) => known.has(id),
        sessionsChangedForMachine: () => {},
        clients: () => [],
        machinesForPrincipal: () => [],
      } satisfies MachinesDeps)
    const svc = build()
    store.machines.upsertMachine({
      id: MACHINE,
      name: 'Builder',
      hostname: 'vmi.local',
      tokenHash: sha256('tok'),
      ownerUserId: opts.rowOwner ?? null,
    })
    store.machines.setMachineOwner(MACHINE, opts.rowOwner ?? null)
    return { svc, store, dir, known, reboot: build }
  }

  // -------------------------------------------------------------------------
  // THE THREE UNOWNED STATES, each produced the way production produces it
  // -------------------------------------------------------------------------

  test('state 1 — NEVER RECORDED: no owner event was ever appended', () => {
    const { svc, store, dir } = adoptWorld()
    try {
      // The ledger holds nothing about this machine's ownership at all.
      expect(svc.effectiveOwner(MACHINE)).toBeNull()

      svc.adoptMachine(MACHINE, ALICE)

      expect(svc.effectiveOwner(MACHINE)).toBe(ALICE)
      expect(store.machines.getMachine(MACHINE)?.ownerUserId).toBe(ALICE)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('state 2 — RECORDED AS UNOWNED: the pairing code carried no owner', () => {
    const { svc, store, dir } = adoptWorld()
    try {
      // What `authenticateDaemon` writes for a code with no `ownerUserId`: an
      // owner event whose owner is explicitly null, not a missing event.
      svc.transferOwnership(MACHINE, null as unknown as string)
      expect(svc.effectiveOwner(MACHINE)).toBeNull()

      svc.adoptMachine(MACHINE, BOB)

      expect(svc.effectiveOwner(MACHINE)).toBe(BOB)
      expect(store.machines.getMachine(MACHINE)?.ownerUserId).toBe(BOB)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('state 3 — QUARANTINE: the recorded owner no longer resolves (D19.4b)', () => {
    const { svc, store, dir, known, reboot } = adoptWorld({ rowOwner: ALICE })
    try {
      svc.transferOwnership(MACHINE, ALICE)
      expect(svc.effectiveOwner(MACHINE)).toBe(ALICE)

      // Alice's account goes away. This is POD-1114's quarantine, reached
      // exactly as production reaches it: `userExists` stops resolving a name
      // the ledger still records, and boot reconcile projects null.
      known.delete(ALICE)
      const rebooted = reboot()
      expect(store.machines.getMachine(MACHINE)?.ownerUserId).toBeNull()
      // The LEDGER still says Alice — it is append-only and never rewritten.
      // What changed is that Alice no longer resolves, which is why this reads
      // null while the ledger entry survives.
      expect(rebooted.effectiveOwner(MACHINE)).toBeNull()

      // ADOPTION IS ALLOWED HERE, and this is the deliberate part. POD-1114
      // refused AUTOMATIC assignment to the first admin on a restore; it did not
      // refuse assignment. Without this the machine is usable by nobody forever,
      // because its only other remedy is revoke plus a physical re-pair.
      rebooted.adoptMachine(MACHINE, BOB)

      expect(rebooted.effectiveOwner(MACHINE)).toBe(BOB)
      expect(store.machines.getMachine(MACHINE)?.ownerUserId).toBe(BOB)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // -------------------------------------------------------------------------
  // THE STATE IT REFUSES
  // -------------------------------------------------------------------------

  test('a machine with a LIVE owner is refused — that is transfer’s act, not this one', () => {
    const { svc, store, dir } = adoptWorld({ rowOwner: ALICE })
    try {
      svc.transferOwnership(MACHINE, ALICE)

      // TWO PRINCIPALS' WORTH OF ROUTE, at the service seam: adoption refuses
      // Alice's machine whether the adopter meant to take it themselves or hand
      // it to someone else. Neither recipient makes the machine unowned.
      expect(() => svc.adoptMachine(MACHINE, BOB)).toThrow('machine already has an owner')
      expect(() => svc.adoptMachine(MACHINE, ALICE)).toThrow('machine already has an owner')

      // Refused means SILENT: the ledger was not appended and the row is intact.
      expect(svc.effectiveOwner(MACHINE)).toBe(ALICE)
      expect(store.machines.getMachine(MACHINE)?.ownerUserId).toBe(ALICE)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('the refusal reads the LEDGER, not the row it is a projection of', () => {
    const { svc, store, dir } = adoptWorld({ rowOwner: ALICE })
    try {
      svc.transferOwnership(MACHINE, ALICE)
      // Force the row to disagree with the ledger — the state D19.4d says can
      // exist between an append and its projection, and which boot repair
      // exists to fix. A service that asked the ROW would now happily adopt a
      // machine the ledger says is Alice's.
      store.machines.setMachineOwner(MACHINE, null)
      svc.invalidateMachineCache()
      expect(store.machines.getMachine(MACHINE)?.ownerUserId).toBeNull()
      expect(svc.effectiveOwner(MACHINE)).toBe(ALICE)

      expect(() => svc.adoptMachine(MACHINE, BOB)).toThrow('machine already has an owner')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('an unknown recipient is refused rather than re-quarantining the machine', () => {
    const { svc, store, dir } = adoptWorld()
    try {
      expect(() => svc.adoptMachine(MACHINE, 'user:typo')).toThrow('unknown user: user:typo')
      // The hazard: adopting to an unresolvable id appends an owner the next
      // reconcile cannot resolve, so the machine comes out of adoption in
      // exactly the quarantine it went in with. Nothing was appended.
      expect(svc.effectiveOwner(MACHINE)).toBeNull()
      expect(store.machines.getMachine(MACHINE)?.ownerUserId).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('an unknown machine is refused before anything is read', () => {
    const { svc, dir } = adoptWorld()
    try {
      expect(() => svc.adoptMachine('ghost', ALICE)).toThrow("unknown machine 'ghost'")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // -------------------------------------------------------------------------
  // THE COMMIT POINT
  // -------------------------------------------------------------------------

  test('THE LEDGER APPEND IS THE COMMIT POINT — the row is only a projection', () => {
    const { svc, store, dir, reboot } = adoptWorld()
    try {
      svc.adoptMachine(MACHINE, ALICE)
      expect(store.machines.getMachine(MACHINE)?.ownerUserId).toBe(ALICE)

      // DESTROY THE PROJECTION and nothing else. If the row were the source of
      // truth this machine is now unowned again and the adoption is lost.
      store.machines.setMachineOwner(MACHINE, null)
      expect(store.machines.getMachine(MACHINE)?.ownerUserId).toBeNull()

      // Boot repair, from the ledger alone: the adoption comes back. This is
      // the same `reconcileOwnersFromLedger` sequence that recovers a crash
      // between the append and the row write, and it is what makes the append —
      // not the row — the moment the adoption became real.
      const rebooted = reboot()
      expect(store.machines.getMachine(MACHINE)?.ownerUserId).toBe(ALICE)
      expect(rebooted.effectiveOwner(MACHINE)).toBe(ALICE)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('adoption APPENDS — it never rewrites the ledger entry that was there', () => {
    const { svc, dir, known, reboot } = adoptWorld({ rowOwner: ALICE })
    try {
      svc.transferOwnership(MACHINE, ALICE)
      known.delete(ALICE)
      const quarantined = reboot()
      quarantined.adoptMachine(MACHINE, BOB)

      // Alice's account comes back — a half-restored directory finishing its
      // import. The ledger is append-only and never-delete, so her original
      // entry is still on disk; adoption must have SUPERSEDED it with a later
      // append rather than overwritten it, or Bob's ownership would evaporate
      // the moment Alice resolves again.
      known.add(ALICE)
      expect(reboot().effectiveOwner(MACHINE)).toBe(BOB)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('grant edges surviving on the unowned row do not reach the adopter', () => {
    const { svc, store, dir } = adoptWorld()
    try {
      // An edge from before the machine lost its owner. While the owner is null
      // `machineVerbsFor` grants nobody anything, so this edge is INVISIBLE —
      // and would come back to life the instant an owner exists.
      store.grants.upsert({
        resourceKind: 'machine',
        resourceId: MACHINE,
        grantee: 'user:carol',
        verb: 'use',
        owner: ALICE,
        visibility: 'owned-compute',
        createdAt: new Date().toISOString(),
        actorKind: 'user',
        actorId: 'alice',
        onBehalfOf: ALICE,
      })
      expect(svc.grantsForMachine(MACHINE)).toHaveLength(1)

      svc.adoptMachine(MACHINE, BOB)

      // Carol's `use` was approved under a regime that is gone, on hardware that
      // is now Bob's. `use` is a code-execution boundary (readiness M2).
      expect(svc.grantsForMachine(MACHINE)).toHaveLength(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
