/**
 * THE ATTRIBUTION GATE, ON MOBILE, WITH AN EFFECT (POD-1220).
 *
 * POD-377 built `migrateLegacyReplica` and POD-378 verified it; until this issue
 * NOTHING IN THE REPO CALLED IT. A gate with no caller reads identically to an
 * enforced one in every handoff that cites it, so the claim under test here is not
 * "the gate decides correctly" — `adoption.test.ts` owns that — but "this device
 * OBEYS it", which is a different claim and the one that was missing.
 *
 * WHY EVERY CASE RUNS OVER A REAL SQLITE FILE. The property is durability across a
 * process, and `:memory:` dies with the connection: an assertion that queued work
 * survived would pass by finding nothing in exactly the same shape as by finding the
 * right thing. `readDurable` therefore opens its OWN connection and reads the tables
 * directly, so the store's in-memory mirror can never answer for the engine.
 *
 * WHY THE REFUSAL ARMS ARE THE POINT AND THE ADOPT ARM IS NOT. Trap 2 of this
 * issue's handoff: entities and the cursor are retired UNCONDITIONALLY here — the
 * outbox is the only family the gate governs on mobile — so a wiring that ran the
 * gate and then ignored its verdict would still make the audit count drop, still
 * migrate, still report `adopted=N`, and still be a privacy hole. The mutation that
 * proves otherwise is the refusal cases below: flip ONLY the evidence, and the user's
 * queued work must stop being drainable.
 *
 * AND WHY THEY READ THROUGH `outboxStorage()` RATHER THAN THE TABLE. A
 * parked entry is still a ROW — dead-lettered, payload redacted, deliberately kept so
 * POD-316 can tell the user work was lost. Asserting the table is empty would fail on
 * correct behaviour; asserting the table is non-empty would pass on the hole. What
 * must be empty is what the ENGINE can replay, which is the storage pair the provider
 * hands it.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { REPLICA_KEY_PREFIX, type StorageApi } from '@podium/client-core/replica'
import {
  LEGACY_STANDALONE_OUTBOX_KEY,
  type LegacyIdentityEvidence,
} from '@podium/sync/adapters/legacy-replica'
import type { SqlDatabaseLike } from '@podium/sync/adapters/mobile-sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { LEGACY_HYDRATE_PREFIXES, openMobileReplica } from './MobileClientProvider'

// ---------------------------------------------------------------------------
// A REAL ENGINE, OR NOTHING
// ---------------------------------------------------------------------------

interface DatabaseConstructor {
  new (file: string): SqlDatabaseLike
}

/**
 * The runtime's own SQLite, or a refusal.
 *
 * Resolved the same way `packages/sync`'s adapter suites resolve it, and duplicated
 * here on purpose rather than imported: `test-support.ts` is deliberately absent
 * from `@podium/sync/adapters/mobile-sqlite`'s barrel because it imports `node:fs`,
 * and adding an export subpath to reach it would put a Node builtin on a
 * browser-entrypoint's public surface to save nine lines in one test.
 *
 * It THROWS rather than substituting a Map. A fake engine makes every durability
 * assertion below pass for the wrong reason — which is the whole failure class this
 * file exists inside.
 */
async function resolveSqlite(): Promise<(file: string) => SqlDatabaseLike> {
  const attempts: string[] = []
  for (const [specifier, exportName] of [
    ['bun:sqlite', 'Database'],
    ['node:sqlite', 'DatabaseSync'],
  ] as const) {
    try {
      const module = (await import(/* @vite-ignore */ specifier)) as Record<string, unknown>
      const Database = module[exportName] as DatabaseConstructor | undefined
      if (typeof Database !== 'function') {
        attempts.push(`${specifier}: no ${exportName}`)
        continue
      }
      return (file) => new Database(file)
    } catch (error) {
      attempts.push(`${specifier}: ${(error as Error).message}`)
    }
  }
  throw new Error(`no real SQLite in this runtime — refusing a fake (${attempts.join('; ')})`)
}

const openSqlite = await resolveSqlite()

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function freshDatabaseFile(): string {
  const directory = mkdtempSync(join(tmpdir(), 'podium-mobile-replica-'))
  directories.push(directory)
  return join(directory, 'replica.db')
}

/** Every outbox row, through a CONNECTION OF ITS OWN — never the store's mirror. */
function durableOutbox(file: string): { mutationId: string; record: Record<string, unknown> }[] {
  // A store that never created a table is an absent region, not an error: reading a
  // file the migration declined to write to is a legitimate case below.
  if (!fileExists(file)) return []
  const db = openSqlite(file)
  try {
    const tables = new Set(
      (
        db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as {
          name: string
        }[]
      ).map((row) => row.name),
    )
    if (!tables.has('outbox')) return []
    return (
      db.prepare(`SELECT mutation_id, record FROM outbox ORDER BY ordinal ASC`).all() as {
        mutation_id: string
        record: string
      }[]
    ).map((row) => ({
      mutationId: row.mutation_id,
      record: JSON.parse(row.record) as Record<string, unknown>,
    }))
  } finally {
    db.close()
  }
}

function fileExists(file: string): boolean {
  try {
    readFileSync(file)
    return true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// THE LEGACY DEVICE
// ---------------------------------------------------------------------------

/**
 * The hydrated AsyncStorage bridge, as the provider passes it.
 *
 * A Map-backed `StorageApi` is not a stand-in here: `createAsyncStorageReplicaStorage`
 * returns exactly this shape — a synchronous map over a hydrated snapshot — and the
 * async write-behind it wraps is the bridge's business, not this file's.
 */
function legacyDevice(entries: Record<string, string>): StorageApi & { keys(): string[] } {
  const data = new Map(Object.entries(entries))
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key),
    keys: () => [...data.keys()],
  }
}

/** One queued rename and one queued tuck, plus the entity and cursor state that
 *  ADR 6 D1 forbids from living here at all. */
const QUEUED_RENAME = {
  mutationId: 'm-rename',
  kind: 'rename',
  input: { sessionId: 's1', name: 'renamed on the train' },
  queuedAt: 1_700_000_000_000,
}
const QUEUED_TUCK = {
  mutationId: 'm-tuck',
  kind: 'issueSetTucked',
  input: { id: 'i1', tucked: true },
  queuedAt: 1_700_000_001_000,
}

function seededDevice() {
  return legacyDevice({
    'podium.replica.outbox.v1': JSON.stringify([QUEUED_RENAME, QUEUED_TUCK]),
    'podium.replica.sessions.v1': JSON.stringify([{ sessionId: 's1', name: 'stale' }]),
    'podium.replica.cursor.v1': '42',
  })
}

const SINGLE_ACCOUNT: LegacyIdentityEvidence = { kind: 'single-account', principal: 'default' }

/**
 * The three ways a device can fail to name its owner. Each is a DISTINCT arm of
 * `decideLegacyAdoption`, and they are driven separately because a suite that only
 * ran `unknown` would pass against a gate that had lost the `multi-user` branch
 * entirely.
 */
const UNATTRIBUTABLE: { label: string; evidence: LegacyIdentityEvidence }[] = [
  { label: 'identity-unknown', evidence: { kind: 'unknown' } },
  {
    label: 'multiple-identities',
    evidence: {
      kind: 'multi-user',
      signedInAs: 'alice',
      identitiesEverSignedIn: ['alice', 'bob'],
    },
  },
  {
    label: 'foreign-identity',
    evidence: { kind: 'multi-user', signedInAs: 'alice', identitiesEverSignedIn: ['bob'] },
  },
]

async function open(args: {
  file: string
  storage: StorageApi
  evidence?: LegacyIdentityEvidence
}) {
  const degradations: string[] = []
  const opened = await openMobileReplica({
    openDatabase: () => openSqlite(args.file),
    deleteDatabase: () => rmSync(args.file, { force: true }),
    storage: args.storage,
    evidence: args.evidence ?? SINGLE_ACCOUNT,
    onDegraded: (message) => degradations.push(message),
    now: () => 1_700_000_009_000,
  })
  return { ...opened, degradations }
}

// ---------------------------------------------------------------------------

describe('the mobile replica composition root', () => {
  it('adopts an attributable device: the queued writes are drainable AND durable in SQLite', async () => {
    const file = freshDatabaseFile()
    const device = seededDevice()

    const { replica, outcome } = await open({ file, storage: device })

    expect(outcome.ran).toBe(true)
    expect(outcome.reason).toBe('adopted-single-account')
    expect(outcome.adopted).toBe(2)
    expect(outcome.parked).toBe(0)

    // What the ENGINE will replay — `wiring.ts` takes exactly this off the replica.
    expect(
      replica
        .outboxStorage()
        .load()
        .map((entry) => entry.mutationId),
    ).toEqual(['m-rename', 'm-tuck'])
    // FIFO by intent age, and the payload intact: a lossy import would replay a
    // rename with no name.
    expect(replica.outboxStorage().load()[0]?.input).toEqual(QUEUED_RENAME.input)

    // Durable, in the file, before anything was awaited past the open.
    expect(durableOutbox(file).map((row) => row.mutationId)).toEqual(['m-rename', 'm-tuck'])
  })

  it('drains from SQLITE, not from AsyncStorage — the half that makes the gate matter', async () => {
    const file = freshDatabaseFile()
    const device = seededDevice()
    await open({ file, storage: device })

    // The migration retired every legacy replica key it owns (ADR 6 D1: none of this
    // may live on AsyncStorage). If the engine were still reading the legacy outbox,
    // the user's queued work would now be GONE — which is trap 1 of this issue,
    // reported as success at every other level.
    expect(device.keys()).not.toContain('podium.replica.outbox.v1')

    // A SECOND open over the same file, with a device that has nothing left to
    // migrate. The work is still there because its home is now the database.
    const second = await open({ file, storage: legacyDevice({}) })
    expect(second.outcome.ran).toBe(false)
    expect(
      second.replica
        .outboxStorage()
        .load()
        .map((e) => e.mutationId),
    ).toEqual(['m-rename', 'm-tuck'])
  })

  it('a write through the replica lands in SQLite, not in the legacy key space', async () => {
    const file = freshDatabaseFile()
    const device = legacyDevice({})
    const { replica } = await open({ file, storage: device })

    replica
      .outboxStorage()
      .save([{ mutationId: 'm-new', kind: 'snoozeClear', input: { sessionId: 's9' }, queuedAt: 5 }])

    // Read through a separate connection with NOTHING awaited in between: the
    // adapter's commit is synchronous, and that is the property the whole
    // sync-save-over-async-apply binding rests on.
    expect(durableOutbox(file).map((row) => row.mutationId)).toEqual(['m-new'])
    expect(device.keys()).toEqual(['podium.replica.principal.default.namespace.v1'])
  })

  for (const arm of UNATTRIBUTABLE) {
    it(`refuses an unattributable device (${arm.label}): the queued work is NOT drainable`, async () => {
      const file = freshDatabaseFile()
      const device = seededDevice()

      const { replica, outcome } = await open({ file, storage: device, evidence: arm.evidence })

      expect(outcome.ran).toBe(true)
      expect(outcome.reason).toBe(`discarded-${arm.label}`)
      expect(outcome.adopted).toBe(0)
      expect(outcome.parked).toBe(2)

      // THE MUTATION. Only the evidence changed between this and the adopt case
      // above; if these two lines could both pass, the gate would have no effect.
      expect(replica.outboxStorage().load()).toEqual([])
      expect(replica.outboxAwaitingStorage().load()).toEqual([])

      // The rows SURVIVE as dead letters — POD-316 tells the user work was lost —
      // with the payload redacted, because on a device we could not attribute,
      // showing the text would turn a migration into a disclosure.
      const parked = durableOutbox(file)
      expect(parked.map((row) => row.mutationId)).toEqual(['m-rename', 'm-tuck'])
      expect(parked.map((row) => row.record.state)).toEqual(['dead-letter', 'dead-letter'])
      expect(parked.map((row) => row.record.input)).toEqual([null, null])
    })
  }

  it('discards and re-bootstraps: after an unattributable open nothing paints from cache', async () => {
    const file = freshDatabaseFile()
    const device = seededDevice()

    const { replica, outcome } = await open({
      file,
      storage: device,
      evidence: { kind: 'unknown' },
    })

    // Entities and the cursor go unconditionally — there is no honest way to import
    // a bare-integer cursor into `{feedId, epoch, seq}` (ADR 2 D1) — so this is the
    // half the gate does NOT govern, asserted so the next reader does not mistake it
    // for the gate working.
    expect(outcome.cursorDiscarded).toBe(true)
    expect(device.keys()).toEqual(['podium.replica.principal.default.namespace.v1'])

    const hydrated = await replica.hydrate()
    expect(hydrated.sessions).toEqual([])
    expect(hydrated.cursor).toBeNull()
  })

  it('carries the PRE-replica standalone outbox when the bridge hydrated it', async () => {
    const file = freshDatabaseFile()
    const device = legacyDevice({
      [LEGACY_STANDALONE_OUTBOX_KEY]: JSON.stringify([QUEUED_RENAME]),
    })

    const { replica, outcome } = await open({ file, storage: device })

    expect(outcome.adopted).toBe(1)
    expect(
      replica
        .outboxStorage()
        .load()
        .map((e) => e.mutationId),
    ).toEqual(['m-rename'])
  })

  it('and the bridge is TOLD to hydrate it — it is outside the default prefix', () => {
    // Stated as a constant rather than a behaviour, and the limitation is named
    // rather than dressed up: the only consumer of this list is `LiveProvider`'s
    // effect, which needs React and the native module and so cannot run in this
    // lane. What the case above proves is that the key MATTERS; what this one
    // proves is that the root asks for it.
    //
    // `podium.outbox.v1` does not start with `podium.replica`, so
    // `createAsyncStorageReplicaStorage`'s default prefix hydrates a snapshot with
    // no trace of it — and the migration then honestly reports nothing to do. The
    // device this strands upgraded straight from a build older than the replica
    // collections, so this key is the ONLY place its queued work lives.
    expect(LEGACY_HYDRATE_PREFIXES).toContain(LEGACY_STANDALONE_OUTBOX_KEY)
    expect(LEGACY_HYDRATE_PREFIXES).toContain(REPLICA_KEY_PREFIX)
  })

  it('a device with nothing to migrate is not a migration', async () => {
    const file = freshDatabaseFile()
    const { outcome, replica } = await open({ file, storage: legacyDevice({}) })

    expect(outcome.ran).toBe(false)
    expect(outcome.adopted).toBe(0)
    expect(outcome.parked).toBe(0)
    expect(replica.outboxStorage().load()).toEqual([])
  })
})
