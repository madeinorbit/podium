/**
 * THE ATTRIBUTION GATE + v2 FEED ASSEMBLY, ON MOBILE (POD-1220 + POD-1241).
 *
 * POD-1220: the gate has a caller and an effect on the durable outbox.
 * POD-1241: the composition root assembles KernelReplica + FeedAuthorityClient
 * so entity rows land in SQLite and paint on cold start.
 *
 * WHY EVERY CASE RUNS OVER A REAL SQLITE FILE. The property is durability across a
 * process, and `:memory:` dies with the connection: an assertion that queued work
 * survived would pass by finding nothing in exactly the same shape as by finding the
 * right thing. `readDurable` therefore opens its OWN connection and reads the tables
 * directly, so the store's in-memory mirror can never answer for the engine.
 *
 * WHY THE REFUSAL ARMS ARE THE POINT AND THE ADOPT ARM IS NOT (outbox). A wiring
 * that ran the gate and then ignored its verdict would still make the audit count
 * drop, still migrate, still report `adopted=N`, and still be a privacy hole. The
 * mutation that proves otherwise is the refusal cases below: flip ONLY the
 * evidence, and the user's queued work must stop being drainable.
 *
 * WHY THEY READ THROUGH THE QUEUE RATHER THAN THE TABLE. A parked entry is still a
 * ROW — dead-lettered, payload redacted. Asserting the table is empty would fail on
 * correct behaviour; asserting it non-empty would pass on the hole. What must be
 * empty is what the ENGINE can replay, so the assertions are made on the queue's own
 * `pending()`. That queue is the kernel `Outbox` since POD-2073 (it was the
 * compatibility one over a pair of SQLite-backed `OutboxStorage` views before);
 * `engineOutbox` below builds it exactly as the provider does.
 *
 * WHY COLD-START PAINT RUNS AGAINST A SILENT AUTHORITY (POD-1241). An authority
 * whose frames never arrive paints an empty slice that looks exactly like a
 * working offline cold start. A test that only ever ran against a live feed
 * cannot tell "store is wired" from "empty and quiet". The positive case seeds
 * the store, silences the authority, and asserts rows paint; the negative case
 * proves the same assertion goes red when the store is empty.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PodiumClientApi } from '@podium/client-core/api'
import type { CreateEngineOutbox, EngineOutbox, StoreNotices } from '@podium/client-core/engine'
import {
  principalKeyPrefix,
  REPLICA_KEY_PREFIX,
  type Replica,
  type StorageApi,
} from '@podium/client-core/replica'
import { asMutationId, asSessionId } from '@podium/model'
import type { FeedChangesSinceReplyLenient } from '@podium/protocol'
import {
  LEGACY_STANDALONE_OUTBOX_KEY,
  type LegacyIdentityEvidence,
} from '@podium/sync/adapters/legacy-replica'
import type { SqlDatabaseLike } from '@podium/sync/adapters/mobile-sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'

// AsyncStorage's native CommonJS entry requires React Native directly, outside
// Vite's source aliasing, and therefore asks Node to parse React Native's Flow.
// This suite injects storage into openMobileReplica and never uses the package;
// keep the composition-root import on the same inert storage boundary.
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getAllKeys: async () => [],
    getItem: async () => null,
    setItem: async () => {},
    removeItem: async () => {},
  },
}))
// The replica assembler is below the server-selection UI. Keep this focused
// suite on that boundary rather than importing Expo Router's externalized CJS
// graph, whose direct React Native require cannot use Vite's web alias.
vi.mock('./ServerProfileGate', () => ({ useOptionalServerProfile: () => null }))

import { LEGACY_HYDRATE_PREFIXES, openMobileReplica } from './MobileClientProvider'

/**
 * An authority that delivers NOTHING. Used so a cold-start paint assertion can
 * only pass if the durable store is wired — a live feed cannot rescue it.
 */
const SILENT_AUTHORITY = async (): Promise<FeedChangesSinceReplyLenient> => ({
  kind: 'bootstrap-required',
  reason: 'silent-test-authority',
})

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

function durableEntityCount(file: string, principal: string): number {
  if (!fileExists(file)) return 0
  const db = openSqlite(file)
  try {
    const tables = new Set(
      (
        db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as {
          name: string
        }[]
      ).map((row) => row.name),
    )
    if (!tables.has('entities')) return 0
    const row = db
      .prepare('SELECT COUNT(*) AS count FROM entities WHERE principal = ?')
      .get(principal) as { count: number }
    return row.count
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

/**
 * THE ENGINE'S QUEUE, BUILT THE WAY THE PROVIDER BUILDS IT (POD-2073).
 *
 * These cases used to read `replica.outboxStorage()`, which on mobile resolved
 * to a pair of `OutboxStorage` views over the SQLite outbox rows. Those views
 * are gone: the kernel `Outbox` drives those records now, on both platforms, and
 * a second `OutboxStorage` driver over them was the arrangement `facade.ts`
 * rules out. `outboxStorage()` still answers — with the side cache — so reading
 * it here would have kept passing while asserting nothing about the queue.
 *
 * So the observation point moves to the queue itself. `pending()` is what the
 * engine will replay and `deadLetters()` is what it has parked, which is the
 * distinction every case below turns on.
 *
 * OFFLINE BY CONSTRUCTION. `isOnline: () => false` because this file's subject is
 * what the store holds, not what a transport does with it — and the stub api
 * would otherwise be handed a user's migrated writes to "send", which is a
 * different test in a different file.
 */
function engineOutbox(opened: {
  createOutboxFn: CreateEngineOutbox
  replica: Replica
}): EngineOutbox {
  return opened.createOutboxFn({
    api: STUB_API,
    replica: opened.replica,
    notices: { error: () => {}, info: () => {} } as unknown as StoreNotices,
    isOnline: () => false,
  })
}

/** Enough of a client to construct the queue, and deliberately not enough to
 *  send: a case here that reached the network would be lying about its subject. */
const STUB_API = {} as unknown as PodiumClientApi

async function open(args: {
  file: string
  storage: StorageApi & { keys?: () => string[] }
  evidence?: LegacyIdentityEvidence
  /** WHO IS SIGNED IN. Omitted, the pre-identity default stands (the legacy
   *  arm the cases above exercise); named, the store is opened under that
   *  principal's namespace and nobody else's. */
  principal?: string
  /** Defaults to a silent authority so cold-start cases cannot be rescued by a feed. */
  fetchChangesSince?: () => Promise<FeedChangesSinceReplyLenient>
  pendingPrincipalCleanups?: readonly {
    principal: string
    complete(): Promise<void>
  }[]
  flushStorage?: () => Promise<void>
}) {
  const degradations: string[] = []
  const opened = await openMobileReplica({
    api: STUB_API,
    openStore: async () => {
      const { SqliteSyncStore } = await import('@podium/sync/adapters/mobile-sqlite')
      return SqliteSyncStore.open({
        openDatabase: () => openSqlite(args.file),
        deleteDatabase: () => rmSync(args.file, { force: true }),
        onDegraded: (degradation) =>
          degradations.push(
            `Offline changes may not survive a restart on this device (${degradation.cause}).`,
          ),
      })
    },
    storage: args.storage,
    ...(args.principal !== undefined ? { principal: args.principal } : {}),
    ...(args.storage.keys !== undefined ? { enumerateKeys: args.storage.keys } : {}),
    ...(args.pendingPrincipalCleanups !== undefined
      ? { pendingPrincipalCleanups: args.pendingPrincipalCleanups }
      : {}),
    ...(args.flushStorage !== undefined ? { flushStorage: args.flushStorage } : {}),
    evidence: args.evidence ?? SINGLE_ACCOUNT,
    fetchChangesSince: args.fetchChangesSince ?? SILENT_AUTHORITY,
    onDegraded: (message) => degradations.push(message),
    now: () => 1_700_000_009_000,
  })
  return { ...opened, degradations }
}

/** Seed one issue into the durable entity cache of an already-opened store. */
function seedIssue(
  store: { viewFor(principal: string): { cache: { applyAtomic(m: unknown): void } } },
  principal: string,
  issue: { id: string; title: string },
): void {
  store.viewFor(principal).cache.applyAtomic({
    operations: [
      {
        kind: 'upsert',
        entity: 'issue',
        entityId: issue.id,
        value: { id: issue.id, title: issue.title, status: 'open' },
        provenance: {
          seq: 1,
          originId: 'o',
          causationId: 'c',
          mutationId: asMutationId('m-seed'),
        },
      },
    ],
    cursor: { feedId: 'feed', epoch: 'e1', seq: 1 },
  })
}

// ---------------------------------------------------------------------------

describe('the mobile replica composition root', () => {
  it('erases a tombstoned profile replica before completing its durable cleanup intent', async () => {
    const file = freshDatabaseFile()
    const device = legacyDevice({})
    const stalePrincipal = 'server:old-profile:user:user%3Aadmin'
    const stalePrefix = principalKeyPrefix(REPLICA_KEY_PREFIX, stalePrincipal)
    const seeded = await open({ file, storage: device, principal: stalePrincipal })
    seedIssue(seeded.store, stalePrincipal, { id: 'i-stale', title: 'private old-server work' })
    device.setItem(`${stalePrefix}.draft.v1`, 'private old-server draft')
    await seeded.store.settled()
    seeded.store.close()

    let flushed = false
    let completed = false
    const current = await open({
      file,
      storage: device,
      principal: 'server:new-profile:user:user%3Aadmin',
      flushStorage: async () => {
        flushed = true
      },
      pendingPrincipalCleanups: [
        {
          principal: stalePrincipal,
          complete: async () => {
            expect(flushed).toBe(true)
            expect(
              device.keys().some((key) => key === stalePrefix || key.startsWith(`${stalePrefix}.`)),
            ).toBe(false)
            expect(durableEntityCount(file, stalePrincipal)).toBe(0)
            completed = true
          },
        },
      ],
    })

    expect(completed).toBe(true)
    current.store.close()
  })

  it('leaves cleanup incomplete after a storage failure so the same tombstone can retry', async () => {
    const file = freshDatabaseFile()
    const device = legacyDevice({})
    const stalePrincipal = 'server:old-profile:user:user%3Aadmin'
    let completed = 0
    const cleanup = {
      principal: stalePrincipal,
      complete: async () => {
        completed += 1
      },
    }

    await expect(
      open({
        file,
        storage: device,
        principal: 'server:new-profile:user:user%3Aadmin',
        pendingPrincipalCleanups: [cleanup],
        flushStorage: async () => {
          throw new Error('write-behind flush failed')
        },
      }),
    ).rejects.toThrow('write-behind flush failed')
    expect(completed).toBe(0)

    const retried = await open({
      file,
      storage: device,
      principal: 'server:new-profile:user:user%3Aadmin',
      pendingPrincipalCleanups: [cleanup],
      flushStorage: async () => {},
    })
    expect(completed).toBe(1)
    retried.store.close()
  })

  it('adopts an attributable device: the queued writes are drainable AND durable in SQLite', async () => {
    const file = freshDatabaseFile()
    const device = seededDevice()

    const opened = await open({ file, storage: device })
    const { outcome } = opened

    expect(outcome.ran).toBe(true)
    expect(outcome.reason).toBe('adopted-single-account')
    expect(outcome.adopted).toBe(2)
    expect(outcome.parked).toBe(0)

    // What the ENGINE will replay — the kernel queue's own pending set, which is
    // what `StoreProvider` receives through `createOutboxFn`.
    const queue = engineOutbox(opened)
    expect(queue.pending().map((entry) => entry.mutationId)).toEqual(['m-rename', 'm-tuck'])
    // FIFO by intent age, and the payload intact: a lossy import would replay a
    // rename with no name.
    expect(queue.pending()[0]?.input).toEqual(QUEUED_RENAME.input)
    // Adopted, not parked. The two are one row apart in the file and a whole
    // outcome apart for the user, so the absence has to be asserted too.
    expect(queue.deadLetters()).toEqual([])
    queue.dispose()

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
    const queue = engineOutbox(second)
    expect(queue.pending().map((e) => e.mutationId)).toEqual(['m-rename', 'm-tuck'])
    queue.dispose()
  })

  it('a write through the queue lands in SQLite, not in the legacy key space', async () => {
    const file = freshDatabaseFile()
    const device = legacyDevice({})
    const opened = await open({ file, storage: device })

    const queue = engineOutbox(opened)
    // The kernel queue mints the id, so what identifies the row here is the
    // CONTRACT it was authored under — which is also the thing a replay is
    // judged against, and the thing a lossy write would lose.
    await queue.enqueue('snoozeClear', { sessionId: asSessionId('s9') })

    // `enqueue` resolves only after the durable commit (ADR 6 D4.3), and this
    // reads through a SEPARATE connection: the store's in-memory mirror cannot
    // answer for the file.
    const rows = durableOutbox(file)
    expect(rows).toHaveLength(1)
    expect((rows[0]?.record.command as { name: string }).name).toBe('snoozes.clear')
    expect(rows[0]?.record.input).toEqual({ sessionId: 's9' })
    expect(rows[0]?.record.state).toBe('queued')
    queue.dispose()
    // Side-cache may write ui-state keys under the principal prefix; the outbox
    // and entity rows must NOT land on AsyncStorage (ADR 6 D1).
    expect(device.keys()).toContain('podium.replica.principal.default.namespace.v1')
    expect(device.keys().some((k) => k.includes('outbox'))).toBe(false)
    expect(device.keys().some((k) => k.includes('sessions') || k.includes('issues'))).toBe(false)
  })

  for (const arm of UNATTRIBUTABLE) {
    it(`refuses an unattributable device (${arm.label}): the queued work is NOT drainable`, async () => {
      const file = freshDatabaseFile()
      const device = seededDevice()

      const opened = await open({ file, storage: device, evidence: arm.evidence })
      const { outcome } = opened

      expect(outcome.ran).toBe(true)
      expect(outcome.reason).toBe(`discarded-${arm.label}`)
      expect(outcome.adopted).toBe(0)
      expect(outcome.parked).toBe(2)

      // THE MUTATION. Only the evidence changed between this and the adopt case
      // above; if these two lines could both pass, the gate would have no effect.
      // Read through the KERNEL queue, which is the thing that would replay
      // them: a parked row is a row the engine can see and must not send, so
      // "not drainable" has to be asserted where drainability is decided.
      const queue = engineOutbox(opened)
      expect(queue.pending()).toEqual([])
      expect(queue.awaiting()).toEqual([])
      queue.dispose()

      // AND THE USER IS TOLD. `parked: 2` above is what `LiveProvider` turns
      // into "2 queued change(s) from an earlier session could not be carried
      // over and were not sent" — the D4.4 sentence, said in the same session
      // the loss happened in.
      //
      // WHAT IS NOT HERE ANY MORE, and why this is the honest assertion rather
      // than the one that reads better. The gate parks these rows as dead
      // letters with the payload REDACTED — on a device we could not attribute,
      // showing the text would turn a migration into a disclosure — and they
      // used to stay in the file. They do not now: `openKernelEngineOutbox`
      // reconciles automatic bookkeeping at open, and `shouldParkDeadLetter`
      // decides that from `recoverableAuthoredText(input)`, which a redacted
      // entry has none of by construction. So the receipt is retired before
      // anything could show it.
      //
      // This is WEB's behaviour too — same migration, same reconciliation, same
      // order — so it arrived here as parity rather than as a regression, and
      // it is filed as POD-2083 rather than fixed under a parity issue. What
      // this case still pins is the property it was written for: only the
      // evidence changed between here and the adopt case, and the user's queued
      // work must stop being drainable.
      expect(durableOutbox(file)).toEqual([])
    })
  }

  it('discards and re-bootstraps: after an unattributable open nothing paints from cache', async () => {
    const file = freshDatabaseFile()
    const device = seededDevice()

    // Seed the SQLite entity cache under an attributable open first, so the
    // refusal has something real to discard — otherwise empty-after-refuse is
    // indistinguishable from never having rows. Close without erase so the
    // bytes remain for the second open to refuse.
    const seeded = await open({ file, storage: legacyDevice({}) })
    seedIssue(seeded.store, seeded.principal, { id: 'i-seed', title: 'should not survive' })
    await seeded.store.settled()
    expect(seeded.replica.rows('issues').map((r) => r.id)).toEqual(['i-seed'])
    seeded.store.close()

    const { replica, outcome } = await open({
      file,
      storage: device,
      evidence: { kind: 'unknown' },
    })

    // Legacy AsyncStorage entities/cursor are retired by the migration; the
    // SQLite entity cache is discarded by the same attribution decision that
    // parks the outbox (POD-1241 extends the gate to the read path).
    expect(outcome.cursorDiscarded).toBe(true)
    expect(device.keys()).toContain('podium.replica.principal.default.namespace.v1')
    expect(device.keys().some((k) => k.includes('outbox'))).toBe(false)
    expect(device.keys()).not.toContain('podium.replica.sessions.v1')
    expect(device.keys()).not.toContain('podium.replica.cursor.v1')

    const hydrated = await replica.hydrate()
    expect(hydrated.sessions).toEqual([])
    expect(hydrated.issues).toEqual([])
    expect(hydrated.cursor).toBeNull()
  })

  it('carries the PRE-replica standalone outbox when the bridge hydrated it', async () => {
    const file = freshDatabaseFile()
    const device = legacyDevice({
      [LEGACY_STANDALONE_OUTBOX_KEY]: JSON.stringify([QUEUED_RENAME]),
    })

    const opened = await open({ file, storage: device })

    expect(opened.outcome.adopted).toBe(1)
    const queue = engineOutbox(opened)
    expect(queue.pending().map((e) => e.mutationId)).toEqual(['m-rename'])
    queue.dispose()
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
    const opened = await open({ file, storage: legacyDevice({}) })

    expect(opened.outcome.ran).toBe(false)
    expect(opened.outcome.adopted).toBe(0)
    expect(opened.outcome.parked).toBe(0)
    const queue = engineOutbox(opened)
    expect(queue.pending()).toEqual([])
    queue.dispose()
  })

  it('hands the provider a kernel queue, already open over this principal', async () => {
    // The wiring itself, asserted where it is easy to LOSE: the provider passes
    // `createOutboxFn` to `StoreProvider`, and an assembly that stopped
    // returning one would leave the engine building its own compatibility queue
    // over `replica.outboxStorage()` — the side cache — with the durable SQLite
    // rows driven by nobody. Every queued offline write would go invisible and
    // unsent, and every case above would still be green, because they read the
    // store rather than the seam.
    const file = freshDatabaseFile()
    const opened = await open({ file, storage: seededDevice() })
    expect(typeof opened.createOutboxFn).toBe('function')

    const queue = engineOutbox(opened)
    expect(queue.pending()).toHaveLength(2)
    // CONSUMED ONCE. Two engines over one durable queue is two writers on the
    // same records, so the factory refuses rather than handing out a second.
    expect(() => engineOutbox(opened)).toThrow()
    queue.dispose()
  })

  it('exposes a v2 feed sink so the hub advertises wire 2', async () => {
    const file = freshDatabaseFile()
    const { feed, attachHub } = await open({ file, storage: legacyDevice({}) })
    expect(typeof feed.connected).toBe('function')
    expect(typeof feed.disconnected).toBe('function')
    expect(typeof feed.frame).toBe('function')
    expect(typeof attachHub).toBe('function')
  })
})

// ---------------------------------------------------------------------------
// COLD-START PAINT — the empty-slice failure POD-1241 exists to close
// ---------------------------------------------------------------------------

describe('cold-start paint from the durable store (POD-1241)', () => {
  it('a cold start over a populated store paints the rows when the authority delivers nothing', async () => {
    const file = freshDatabaseFile()

    // First process: adopt, seed durable rows, settle, tear down.
    const first = await open({ file, storage: legacyDevice({}) })
    seedIssue(first.store, first.principal, { id: 'i-cold', title: 'from disk' })
    await first.store.settled()
    expect(first.replica.rows('issues').map((r) => r.id)).toEqual(['i-cold'])
    // Do NOT erase — we want the file to survive for the second open. Close the
    // store so the second open is a true process-boundary re-read.
    first.store.close()

    // Second process: same file, empty legacy device, SILENT authority.
    // If paint came only from the feed, this goes red. If the store is wired,
    // the rows are already durable and hydrate without a single frame.
    const cold = await open({
      file,
      storage: legacyDevice({}),
      fetchChangesSince: SILENT_AUTHORITY,
    })
    const hydrated = await cold.replica.hydrate()
    expect(hydrated.issues).toMatchObject([{ id: 'i-cold', title: 'from disk' }])
    expect(cold.replica.rows('issues').map((r) => r.id)).toEqual(['i-cold'])
    // Cursor survived too — a cold start that forgot the watermark would look
    // caught up forever or force a needless full bootstrap.
    expect(hydrated.cursor).toBe(1)
  })

  it('the same assertion goes red when the store is empty and the authority is silent', async () => {
    // THE FAILURE PROOF for the case above. Without this, a test that only
    // ever ran against a live feed (or that never asserted rows) could not
    // distinguish "working" from "empty and quiet" — the whole hazard.
    const file = freshDatabaseFile()
    const cold = await open({
      file,
      storage: legacyDevice({}),
      fetchChangesSince: SILENT_AUTHORITY,
    })
    const hydrated = await cold.replica.hydrate()
    expect(hydrated.issues).toEqual([])
    expect(cold.replica.rows('issues')).toEqual([])
    expect(hydrated.cursor).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// FEED DELIVERY — empty-handler trap (POD-279 goal)
// ---------------------------------------------------------------------------
//
// A test that only asserts "no rows after a quiet feed" passes identically
// against a correct empty world AND against a sink that drops every frame.
// Drive a feed that CARRIES rows and assert they arrive; assert empty separately.

/** Wait until `probe` is true, or fail with `label` (no silent hangs). */
async function waitUntil(label: string, probe: () => boolean, ms = 2_000): Promise<void> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (probe()) return
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error(`timed out waiting for ${label}`)
}

function bootstrapFrame(args: {
  seq: number
  changes: {
    seq: number
    entity: string
    entityId: string
    value: Record<string, unknown>
  }[]
}) {
  return {
    type: 'feedBootstrap' as const,
    feedId: 'feed',
    epoch: 'e1',
    fromSeq: 0,
    seq: args.seq,
    minAvailableSeq: 0,
    last: true,
    changes: args.changes.map((c) => ({
      seq: c.seq,
      entity: c.entity,
      entityId: c.entityId,
      op: 'upsert' as const,
      value: c.value,
    })),
  }
}

/** Bring the assembled sink online and serve the socket's mandatory initial world. */
function onlineWithBootstrap(
  opened: Awaited<ReturnType<typeof open>>,
  frame: ReturnType<typeof bootstrapFrame>,
): void {
  let delivered = false
  const deliver = () => {
    if (delivered) return
    delivered = true
    // Asynchronous, like the real server push after socket admission.
    void Promise.resolve().then(() => {
      opened.feed.frame(frame as never)
    })
  }
  opened.attachHub({
    requestFreshWorld: deliver,
  } as never)
  // A world IS promised here: this helper models the admission of a connection
  // that presented no position (POD-2061), which is the contract the pushed
  // world below belongs to.
  opened.feed.connected(true)
  deliver()
}

describe('feed delivery through the assembled sink (POD-1241)', () => {
  it('publishes one React notification burst for a large bootstrap install', async () => {
    const file = freshDatabaseFile()
    const opened = await open({ file, storage: legacyDevice({}) })
    const paintedSizes: number[] = []
    opened.replica.subscribeRows('issues', () => {
      paintedSizes.push(opened.replica.rows('issues').length)
    })
    const changes = Array.from({ length: 1_000 }, (_, index) => ({
      seq: index + 1,
      entity: 'issue',
      entityId: `i-batch-${index}`,
      value: { id: `i-batch-${index}`, title: `Issue ${index}`, status: 'open' },
    }))

    onlineWithBootstrap(opened, bootstrapFrame({ seq: changes.length, changes }))

    await waitUntil('large bootstrap install', () => opened.replica.getCursor() === changes.length)
    expect(opened.replica.rows('issues')).toHaveLength(changes.length)
    // Without the mobile composition root's batchEvents hook this is 1,001
    // synchronous drains (one per row plus bootstrap-installed), which is the
    // measured multi-second input freeze this regression guards.
    expect(paintedSizes).toEqual([changes.length])
  })

  it('a bootstrap that carries rows paints them — proves the sink is not a silent drop', async () => {
    const file = freshDatabaseFile()
    const opened = await open({ file, storage: legacyDevice({}) })

    // Pre-project empty so a missing onKernelEvent fan-out cannot be masked:
    // the facade caches the empty projection, and only onKernelEvent clears it.
    // Without that wiring, the store would hold the row and rows() would still
    // answer empty — the empty-handler failure mode, one layer down.
    expect(opened.replica.rows('issues')).toEqual([])

    onlineWithBootstrap(
      opened,
      bootstrapFrame({
        seq: 1,
        changes: [
          {
            seq: 1,
            entity: 'issue',
            entityId: 'i-feed',
            value: { id: 'i-feed', title: 'from feed', status: 'open' },
          },
        ],
      }),
    )

    await waitUntil(
      'feed bootstrap to paint i-feed (got: ' +
        JSON.stringify(opened.replica.rows('issues').map((r) => r.id)) +
        ')',
      () => opened.replica.rows('issues').some((r) => r.id === 'i-feed'),
    )
    expect(opened.replica.rows('issues').map((r) => r.id)).toEqual(['i-feed'])
    expect(opened.replica.getCursor()).toBe(1)
  })

  it('an empty bootstrap paints empty with a cursor — correct empty, not a drop', async () => {
    // Separated from the case above on purpose. Empty alone cannot prove the
    // sink works; together with "carries rows", empty is "correctly empty".
    const file = freshDatabaseFile()
    const opened = await open({ file, storage: legacyDevice({}) })
    expect(opened.replica.rows('issues')).toEqual([])

    onlineWithBootstrap(opened, bootstrapFrame({ seq: 3, changes: [] }))

    await waitUntil(
      'empty bootstrap to establish cursor=3 (got: ' + String(opened.replica.getCursor()) + ')',
      () => opened.replica.getCursor() === 3,
    )
    expect(opened.replica.rows('issues')).toEqual([])
    expect(opened.replica.getCursor()).toBe(3)
  })

  it('a delta after bootstrap adds the row the empty case cannot see', async () => {
    const file = freshDatabaseFile()
    const opened = await open({ file, storage: legacyDevice({}) })
    expect(opened.replica.rows('issues')).toEqual([])

    onlineWithBootstrap(opened, bootstrapFrame({ seq: 1, changes: [] }))
    await waitUntil('cursor after empty bootstrap', () => opened.replica.getCursor() === 1)

    opened.feed.frame({
      type: 'feedDelta',
      feedId: 'feed',
      epoch: 'e1',
      fromSeq: 1,
      seq: 2,
      minAvailableSeq: 0,
      changes: [
        {
          seq: 2,
          entity: 'issue',
          entityId: 'i-delta',
          op: 'upsert',
          value: { id: 'i-delta', title: 'from delta', status: 'open' },
        },
      ],
    } as never)

    await waitUntil(
      'delta to paint i-delta (got: ' +
        JSON.stringify(opened.replica.rows('issues').map((r) => r.id)) +
        ')',
      () => opened.replica.rows('issues').some((r) => r.id === 'i-delta'),
    )
    expect(opened.replica.rows('issues').map((r) => r.id)).toEqual(['i-delta'])
    expect(opened.replica.getCursor()).toBe(2)
  })

  /**
   * POD-541 — the offline task-detail gap.
   *
   * Painting after a delta is not enough: a reload (or a notification link
   * opened while the server is unreachable) must still see that row. The cold-
   * start case above seeds through `applyAtomic` directly; this one arrives
   * ONLY over the feed, which is the path create-task takes in production.
   * Without this, "feed paints" and "disk has the row" can diverge and the
   * offline detail screen reports "Task not found" for a task that existed.
   */
  it('a feed delta is durable across process reopen (POD-541)', async () => {
    const file = freshDatabaseFile()
    const first = await open({ file, storage: legacyDevice({}) })

    onlineWithBootstrap(first, bootstrapFrame({ seq: 1, changes: [] }))
    await waitUntil('cursor after empty bootstrap', () => first.replica.getCursor() === 1)

    first.feed.frame({
      type: 'feedDelta',
      feedId: 'feed',
      epoch: 'e1',
      fromSeq: 1,
      seq: 2,
      minAvailableSeq: 0,
      changes: [
        {
          seq: 2,
          entity: 'issue',
          entityId: 'i-offline',
          op: 'upsert',
          value: { id: 'i-offline', title: 'must survive reload', status: 'open' },
        },
      ],
    } as never)
    await waitUntil('delta paint before close', () =>
      first.replica.rows('issues').some((r) => r.id === 'i-offline'),
    )
    // No await of a flush API: SQLite commits inside applyAtomic, so the file
    // must already hold the row before we tear the process down.
    await first.store.settled()
    first.store.close()

    const cold = await open({
      file,
      storage: legacyDevice({}),
      fetchChangesSince: SILENT_AUTHORITY,
    })
    const hydrated = await cold.replica.hydrate()
    expect(hydrated.issues).toMatchObject([{ id: 'i-offline', title: 'must survive reload' }])
    expect(cold.replica.rows('issues').map((r) => r.id)).toEqual(['i-offline'])
    expect(hydrated.cursor).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// PER-PRINCIPAL LOCAL STATE ACROSS A USER SWITCH (POD-332, doc §3.1/§3.2)
// ---------------------------------------------------------------------------
//
// WHY THIS IS A MOBILE CASE AND NOT A WEB ONE. The phone process is long-lived:
// it is backgrounded and foregrounded rather than reloaded, so a user switch can
// happen with the previous principal's engine still warm in the same process.
// The failure it must not have is specific and silent — a cursor left by the
// previous principal makes a NEW principal's empty slice look permanently
// caught up, so `changesSince(N)` answers "nothing new" over a world that
// person has never received, and no rung of the healing ladder detects it.
//
// Every case below therefore asserts on the SECOND principal, not the first.

describe('local persistence is per-principal on mobile (doc §3.2)', () => {
  it("a user switch in a live process never adopts the previous principal's rows or cursor", async () => {
    const file = freshDatabaseFile()
    const device = legacyDevice({})

    // Alice, signed in, with durable rows and a cursor.
    const alice = await open({ file, storage: device, principal: 'alice' })
    seedIssue(alice.store, 'alice', { id: 'i-alice', title: 'alice private work' })
    await alice.store.settled()
    expect(alice.replica.rows('issues').map((r) => r.id)).toEqual(['i-alice'])
    expect(alice.replica.getCursor()).toBe(1)

    // BACKGROUND → FOREGROUND ACROSS A SWITCH. The process survives, so Alice's
    // store is still open; Bob signs in and the engine is rebuilt on his
    // namespace. Nothing is torn down first, which is exactly the case a
    // reload-based test cannot reach.
    const bob = await open({ file, storage: device, principal: 'bob' })

    expect(bob.principal).toBe('bob')
    expect(bob.replica.rows('issues')).toEqual([])
    // THE SILENT ONE. A cursor is what makes an empty slice look caught up.
    expect(bob.replica.getCursor()).toBeNull()
    const hydrated = await bob.replica.hydrate()
    expect(hydrated.issues).toEqual([])
    expect(hydrated.cursor).toBeNull()

    // And Alice's rows are not merely hidden from Bob's projection — they are
    // under her own namespace, which is what makes the isolation structural
    // rather than a filter someone could forget to apply.
    expect(alice.replica.rows('issues').map((r) => r.id)).toEqual(['i-alice'])
  })

  it('and the same assertion PASSES for the same principal — so the case above is about identity, not emptiness', async () => {
    // The failure proof. Without this, "Bob sees nothing" is indistinguishable
    // from "a second open sees nothing", which would be a bug in the store
    // rather than the isolation working.
    const file = freshDatabaseFile()
    const device = legacyDevice({})

    const first = await open({ file, storage: device, principal: 'alice' })
    seedIssue(first.store, 'alice', { id: 'i-alice', title: 'alice private work' })
    await first.store.settled()

    const again = await open({ file, storage: device, principal: 'alice' })
    expect(again.replica.rows('issues').map((r) => r.id)).toEqual(['i-alice'])
    expect(again.replica.getCursor()).toBe(1)
  })

  it("the AsyncStorage side-cache is namespaced too — a switch cannot read the other principal's keys", async () => {
    const file = freshDatabaseFile()
    const device = legacyDevice({})

    await open({ file, storage: device, principal: 'alice' })
    await open({ file, storage: device, principal: 'bob' })

    // Both namespaces exist, each under its own root: no key is shared, so
    // there is nothing for a new principal to inherit by accident.
    const keys = device.keys()
    expect(keys.some((k) => k.includes('principal.alice'))).toBe(true)
    expect(keys.some((k) => k.includes('principal.bob'))).toBe(true)
    expect(keys.some((k) => k.startsWith('podium.replica.issues'))).toBe(false)
    expect(keys.some((k) => k.startsWith('podium.replica.cursor'))).toBe(false)
  })
})
