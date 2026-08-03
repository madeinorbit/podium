/**
 * The ADR 6 D6 migration, END TO END, from a CAPTURED REAL replica snapshot into a
 * REAL SQLite store.
 *
 * TWO THINGS ARE REAL HERE, and each replaces a way this could have certified
 * itself:
 *
 *   THE INPUT is `__fixtures__/captured-legacy-replica.json`, produced by
 *     `scripts/capture-legacy-replica-snapshot.ts` driving `createReplica` — the
 *     shipping TanStack-backed writer. Every other test of the importer builds its
 *     own blob and therefore certifies its own guess about TanStack's format
 *     (POD-306's shape). These bytes came out of TanStack DB.
 *
 *   THE STORE is `SqliteSyncStore` over the real engine from `../mobile-sqlite/test-support`,
 *     not a memory double. POD-374 and POD-375 both measured that the kernel's
 *     conformance suite is BLIND to what an adapter does inside its own transaction,
 *     so a migration asserted against a fake commit would be asserted against the
 *     one layer that cannot see the property it claims.
 *
 * WHAT THE KILL CASES ARE ACTUALLY TESTING. POD-377 requires that "a kill
 * mid-migration leaves a store that is discarded on next open, never adopted". The
 * three kills below are the three states a kill can leave, and the claim is that
 * none of them is a half-migrated store — see `migrate.ts`'s header for the
 * argument, which these drive rather than restate.
 */

import { rmSync, writeFileSync } from 'node:fs'
import { actorUser, asUserId } from '@podium/model'
import { afterEach, describe, expect, it } from 'vitest'
import type { OutboxAttribution, OutboxCommand, OutboxRecord } from '../../outbox/records'
import { SqliteSyncStore } from '../mobile-sqlite/store'
import { freshDatabaseFile, sqliteEngine } from '../mobile-sqlite/test-support'
import captured from './__fixtures__/captured-legacy-replica.json' with { type: 'json' }
import {
  LEGACY_UI_STATE_KEY,
  type LegacyIdentityEvidence,
  type LegacyKeyValueStore,
  migrateLegacyReplica,
} from './index'

/** Kept in step with `MIGRATION_PROBE_TEXT` in
 *  `packages/client-core/src/replica/legacy-snapshot.ts`; the drift guard there
 *  fails if the capture stops carrying it. */
const PROBE = 'the-users-own-words'

const PRINCIPAL = asUserId('operator')
const NOW = 1_800_000_000_000

const ATTRIBUTION: OutboxAttribution = {
  actor: actorUser(PRINCIPAL),
  onBehalfOf: PRINCIPAL,
}
const COMMANDS: Record<string, OutboxCommand> = {
  'sessions.rename': { name: 'sessions.rename', version: 3, delivery: 'offline-eligible' },
  'issues.close': { name: 'issues.close', version: 1, delivery: 'offline-eligible' },
}
const resolveCommand = (kind: string): OutboxCommand | undefined => COMMANDS[kind]

const SOLE_OPERATOR: LegacyIdentityEvidence = { kind: 'single-account', principal: PRINCIPAL }
const TWO_PEOPLE: LegacyIdentityEvidence = {
  kind: 'multi-user',
  signedInAs: 'u_bob',
  identitiesEverSignedIn: ['u_alice', 'u_bob'],
}

/** A mutable key-value store seeded from a captured device. */
function deviceStore(snapshot: Record<string, string>): LegacyKeyValueStore & {
  keys(): string[]
  read(key: string): string | null
  failRemovals(): void
  failWrites(): void
} {
  const data = new Map(Object.entries(snapshot))
  let removalsFail = false
  let writesFail = false
  return {
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => {
      if (writesFail) {
        const error = new Error('QuotaExceededError')
        error.name = 'QuotaExceededError'
        throw error
      }
      data.set(k, v)
    },
    removeItem: (k) => {
      if (removalsFail) throw new Error('storage unavailable')
      data.delete(k)
    },
    keys: () => [...data.keys()].sort(),
    read: (k) => data.get(k) ?? null,
    failRemovals: () => {
      removalsFail = true
    },
    failWrites: () => {
      writesFail = true
    },
  }
}

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const c of cleanups.splice(0)) {
    try {
      c()
    } catch {
      // A test that already closed a store must not fail in teardown.
    }
  }
})

function newDatabaseFile(): string {
  const { file, cleanup } = freshDatabaseFile()
  cleanups.push(cleanup)
  return file
}

async function openStore(
  file = newDatabaseFile(),
): Promise<{ store: SqliteSyncStore; file: string }> {
  const store = await SqliteSyncStore.open({
    openDatabase: () => sqliteEngine.open(file),
    deleteDatabase: () => rmSync(file, { force: true }),
    onDegraded: () => {},
  })
  cleanups.push(() => store.close())
  return { store, file }
}

async function runMigration(
  legacy: LegacyKeyValueStore,
  store: SqliteSyncStore,
  evidence: LegacyIdentityEvidence,
) {
  return migrateLegacyReplica({
    legacy,
    outbox: store.viewFor(PRINCIPAL).outbox,
    transact: store.unitOfWork.transact,
    resolveCommand,
    attribution: ATTRIBUTION,
    evidence,
    now: () => NOW,
  })
}

/** Read the outbox back through a CONNECTION OF ITS OWN, so the assertion sees
 *  durable rows rather than the mirror the write went through. */
async function durableOutbox(file: string): Promise<readonly OutboxRecord[]> {
  const reopened = await SqliteSyncStore.open({
    openDatabase: () => sqliteEngine.open(file),
    deleteDatabase: () => rmSync(file, { force: true }),
    onDegraded: () => {},
  })
  cleanups.push(() => reopened.close())
  return reopened.viewFor(PRINCIPAL).outbox.read()
}

describe('the capture is what this file claims it is', () => {
  it('contains queued entries in the two shapes real devices have', () => {
    // The control every case below rests on. A capture that had drifted to an
    // empty outbox would satisfy most assertions here perfectly.
    expect(Object.keys(captured.collections)).toContain('podium.replica.outbox.v1')
    expect(captured.collections['podium.replica.outbox.v1']).toContain(PROBE)
    expect(captured.collections['podium.replica.outbox-awaiting.v1']).toContain(PROBE)
    expect(captured.preReplica['podium.outbox.v1']).toContain(PROBE)
    // TanStack's own envelope, which is the part no hand-written fixture gets right.
    expect(captured.collections['podium.replica.outbox.v1']).toContain('versionKey')
  })
})

describe('adoption — a sole-operator device carries its queued work across', () => {
  it('lands every entry, FIFO by authored time, through a real transaction', async () => {
    const legacy = deviceStore(captured.collections)
    const { store, file } = await openStore()

    const outcome = await runMigration(legacy, store, SOLE_OPERATOR)

    expect(outcome.ran).toBe(true)
    expect(outcome.reason).toBe('adopted-single-account')
    expect(outcome.adopted).toBe(4)
    expect(outcome.parked).toBe(0)
    expect(outcome.rejected).toEqual([])

    const durable = await durableOutbox(file)
    expect(durable.map((r) => r.mutationId)).toEqual([
      'mut_ancient',
      'mut_queued_1',
      'mut_awaiting',
      'mut_queued_2',
    ])
    // The user's own text survived — this is the adopt arm's whole point.
    expect(JSON.stringify(durable)).toContain(PROBE)
  })

  it('imports the awaiting-truth entry as ACCEPTED, never as queued', async () => {
    // The counterfactual matters: mapping it to `queued` would RE-SEND a mutation
    // the Authority already took, which is the bug that split the two legacy homes
    // apart in the first place.
    const { store, file } = await openStore()
    await runMigration(deviceStore(captured.collections), store, SOLE_OPERATOR)

    const durable = await durableOutbox(file)
    const byId = new Map(durable.map((r) => [r.mutationId as string, r]))
    expect(byId.get('mut_awaiting')?.state).toBe('accepted')
    expect(byId.get('mut_queued_1')?.state).toBe('queued')
  })

  it('reads the PRE-REPLICA device, whose blob is an array and not a TanStack map', async () => {
    const { store, file } = await openStore()
    const outcome = await runMigration(deviceStore(captured.preReplica), store, SOLE_OPERATOR)

    expect(outcome.adopted).toBe(1)
    expect((await durableOutbox(file)).map((r) => r.mutationId)).toEqual(['mut_ancient'])
  })

  it('retires the replica keys and LEAVES the ui-state preferences alone', async () => {
    const legacy = deviceStore(captured.collections)
    const { store } = await openStore()
    await runMigration(legacy, store, SOLE_OPERATOR)

    expect(legacy.keys()).toEqual([LEGACY_UI_STATE_KEY])
    // ADR 6 D1 permits prefs on this store; deleting them would wipe the user's
    // layout on upgrade, which is why the predicate is a membership test.
    expect(legacy.getItem(LEGACY_UI_STATE_KEY)).not.toBeNull()
  })

  it('says the cursor was dropped, so the client can explain the re-bootstrap', async () => {
    const { store } = await openStore()
    const outcome = await runMigration(deviceStore(captured.collections), store, SOLE_OPERATOR)
    expect(outcome.cursorDiscarded).toBe(true)
  })
})

describe('discard — an ambiguous device parks the work without disclosing it', () => {
  it('parks every entry as a dead letter and redacts the payload', async () => {
    const legacy = deviceStore(captured.collections)
    const { store, file } = await openStore()

    const outcome = await runMigration(legacy, store, TWO_PEOPLE)

    expect(outcome.ran).toBe(true)
    expect(outcome.reason).toBe('discarded-multiple-identities')
    expect(outcome.adopted).toBe(0)
    expect(outcome.parked).toBe(4)

    const durable = await durableOutbox(file)
    expect(durable).toHaveLength(4)
    for (const record of durable) expect(record.state).toBe('dead-letter')
    // The decisive assertion, made against the whole durable read rather than one
    // field: user A's unsent words must not be reachable from user B's store.
    expect(JSON.stringify(durable)).not.toContain(PROBE)
  })

  it('still retires the legacy keys — a refused adoption must not wedge the client', async () => {
    // D6 clause 4. If a discard left the keys behind, every subsequent open would
    // re-run the migration and the client would never reach a settled state.
    const legacy = deviceStore(captured.collections)
    const { store } = await openStore()
    await runMigration(legacy, store, TWO_PEOPLE)
    expect(legacy.keys()).toEqual([LEGACY_UI_STATE_KEY])
  })
})

describe('a kill mid-migration leaves no half-migrated store', () => {
  it('KILLED BEFORE COMMIT — nothing written, every legacy key intact, re-runs clean', async () => {
    const legacy = deviceStore(captured.collections)
    const { store, file } = await openStore()
    const before = legacy.keys()

    // The kill: the transaction throws instead of committing.
    const outcome = await migrateLegacyReplica({
      legacy,
      outbox: store.viewFor(PRINCIPAL).outbox,
      transact: async () => {
        throw new Error('power loss')
      },
      resolveCommand,
      attribution: ATTRIBUTION,
      evidence: SOLE_OPERATOR,
      now: () => NOW,
    })

    expect(outcome.ran).toBe(false)
    expect(outcome.keysLeftBehind.length).toBeGreaterThan(0)
    // Nothing was retired: the input for the retry is still whole. Retiring here
    // is precisely the data loss D6 clause 3's ordering exists to prevent.
    expect(legacy.keys()).toEqual(before)
    expect(await durableOutbox(file)).toEqual([])

    // And the retry, on a fresh process, completes.
    const { store: reopened, file: file2 } = await openStore()
    const retry = await runMigration(legacy, reopened, SOLE_OPERATOR)
    expect(retry.ran).toBe(true)
    expect((await durableOutbox(file2)).length).toBe(4)
  })

  it('KILLED AFTER COMMIT, BEFORE RETIREMENT — the re-run is idempotent, not duplicative', async () => {
    const legacy = deviceStore(captured.collections)
    legacy.failRemovals() // the kill: the commit landed, the deletions did not
    const { store, file } = await openStore()

    const first = await runMigration(legacy, store, SOLE_OPERATOR)
    expect(first.ran).toBe(true)
    expect(first.keysLeftBehind.length).toBeGreaterThan(0)

    // Next open: the same keys are still there, so the whole migration runs again
    // against the SAME store. Outbox rows are keyed by mutationId — a client-minted
    // idempotency key — so this replaces rather than appends.
    const second = await runMigration(legacy, store, SOLE_OPERATOR)
    expect(second.ran).toBe(true)

    const durable = await durableOutbox(file)
    expect(durable).toHaveLength(4)
    expect(new Set(durable.map((r) => r.mutationId)).size).toBe(4)
  })

  it('TORN STORE FILE — the store is DISCARDED on next open, and never adopted half-way', async () => {
    const legacy = deviceStore(captured.collections)
    const { store: first, file } = await openStore()
    first.close()

    // Damage the file the way a kill during a write can: it is no longer a
    // database this driver will open.
    rmSync(file, { force: true })
    writeFileSync(file, 'not a sqlite database at all')

    const store = await SqliteSyncStore.open({
      openDatabase: () => sqliteEngine.open(file),
      deleteDatabase: () => rmSync(file, { force: true }),
      onDegraded: () => {},
    })
    cleanups.push(() => store.close())

    // D4.5: cleared and cold-started rather than wedged — and crucially the legacy
    // keys were never retired, so the migration's input survived the damage.
    expect(await store.viewFor(PRINCIPAL).outbox.read()).toEqual([])
    expect(legacy.getItem('podium.replica.outbox.v1')).not.toBeNull()

    const outcome = await runMigration(legacy, store, SOLE_OPERATOR)
    expect(outcome.ran).toBe(true)
    expect(outcome.adopted).toBe(4)
  })
})

describe('entries the importer cannot decode are reported, never swallowed', () => {
  it('surfaces an unresolvable command instead of guessing its contract version', async () => {
    const legacy = deviceStore(captured.collections)
    const { store, file } = await openStore()

    const outcome = await migrateLegacyReplica({
      legacy,
      outbox: store.viewFor(PRINCIPAL).outbox,
      transact: store.unitOfWork.transact,
      resolveCommand: (kind) => (kind === 'issues.close' ? COMMANDS['issues.close'] : undefined),
      attribution: ATTRIBUTION,
      evidence: SOLE_OPERATOR,
      now: () => NOW,
    })

    expect(outcome.rejected.map((r) => r.reason)).toEqual([
      'unknown-command',
      'unknown-command',
      'unknown-command',
    ])
    // The one that DID resolve still landed — a rejection must not take the rest
    // of the queue down with it.
    expect((await durableOutbox(file)).map((r) => r.mutationId)).toEqual(['mut_queued_2'])
  })

  /**
   * THE ENTRY THAT CANNOT BE MAPPED IS THE POINT (POD-1232).
   *
   * The three cases above prove the unmappable entry is REPORTED. Reporting is
   * not keeping: before this, the key it lived in was retired with everything
   * else, so a `kind` that no longer names a contract — a mutation renamed
   * between the build that queued it offline and the build that opens the store —
   * meant the user's words were deleted and a counter said so. ADR 6 D4.3 does
   * not allow that trade.
   */
  it('QUARANTINES the blob of a key it could not fully map, instead of deleting it', async () => {
    const legacy = deviceStore(captured.collections)
    const before = legacy.read('podium.replica.outbox.v1')
    expect(before).toContain(PROBE)
    const { store } = await openStore()

    const outcome = await migrateLegacyReplica({
      legacy,
      outbox: store.viewFor(PRINCIPAL).outbox,
      transact: store.unitOfWork.transact,
      // Nothing resolves: every entry on this device is unmappable, which is the
      // shape of a client two renames behind.
      resolveCommand: () => undefined,
      attribution: ATTRIBUTION,
      evidence: SOLE_OPERATOR,
      now: () => NOW,
    })

    expect(outcome.adopted).toBe(0)
    expect(outcome.quarantined).toContain('podium.replica.outbox.v1')
    // VERBATIM, and still holding the user's own text: a quarantine that dropped
    // the payload would be the redaction the refusal path does deliberately, done
    // here by accident.
    expect(legacy.read('podium.replica.outbox.v1.unmigrated')).toBe(before)
    // The original is gone, so nothing re-imports it and nothing drains it.
    expect(legacy.read('podium.replica.outbox.v1')).toBeNull()
  })

  it('leaves the ORIGINAL key when the quarantine copy cannot be written', async () => {
    const legacy = deviceStore(captured.collections)
    const { store } = await openStore()
    // The store that refuses the copy is exactly the store on which deleting the
    // original would be unrecoverable.
    legacy.failWrites()

    const outcome = await migrateLegacyReplica({
      legacy,
      outbox: store.viewFor(PRINCIPAL).outbox,
      transact: store.unitOfWork.transact,
      resolveCommand: () => undefined,
      attribution: ATTRIBUTION,
      evidence: SOLE_OPERATOR,
      now: () => NOW,
    })

    expect(outcome.quarantined).toEqual([])
    expect(outcome.keysLeftBehind).toContain('podium.replica.outbox.v1')
    expect(legacy.read('podium.replica.outbox.v1')).toContain(PROBE)
  })

  it('does not quarantine a key that mapped cleanly — the counterfactual', async () => {
    const legacy = deviceStore(captured.collections)
    const { store } = await openStore()

    const outcome = await runMigration(legacy, store, SOLE_OPERATOR)

    expect(outcome.rejected).toEqual([])
    expect(outcome.quarantined).toEqual([])
    expect(legacy.keys().filter((k) => k.endsWith('.unmigrated'))).toEqual([])
  })
})
