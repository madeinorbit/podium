/**
 * QUEUED OFFLINE WRITES ALREADY ON THIS DISK REACH THE KERNEL OUTBOX (POD-1232).
 *
 * The engine's queue is the kernel Outbox over IndexedDB. Everything queued from
 * now on lands there; everything queued BEFORE is in localStorage, written by a
 * build the user was running last week, and until this migration ran the side
 * cache merely moved those blobs to another localStorage key that the kernel
 * Outbox never reads. The entries were not deleted — they were stranded, which a
 * user cannot tell apart from deleted.
 *
 * WHY IT DRIVES THE REAL ROOT. `openKernelAssembly` is where the ordering lives:
 * the migration must commit before the kernel Outbox opens and hydrates, or the
 * entries land in a store the queue has already read past. A test over
 * `migrateLegacyReplica` alone would pass with that ordering inverted, which is
 * exactly the bug shape this file exists to catch — so the assertions are made
 * against `assembly.createOutboxFn`, the queue the app itself drains.
 *
 * THE SECOND SOURCE IS THE ONE THAT MATTERS MOST. `<prefix>.outbox.v1` is where
 * the ALREADY-SHIPPED kernel build folded people's queues. Those are the entries
 * on real disks today, and the raw-key case would pass without them.
 */

import { principalKeyPrefix } from '@podium/client-core/replica'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, describe, expect, it } from 'vitest'
import { KERNEL_SIDE_CACHE_PREFIX, openKernelAssembly } from './kernelReplica'

const trpc = {
  sync: { feedChangesSince: { query: async () => ({ changes: [] }) } },
  pins: { set: { mutate: async () => ({}) } },
} as unknown as Parameters<typeof openKernelAssembly>[0]['trpc']

const PRINCIPAL = 'alice'
/** Derived through the SAME function the root uses, not respelled: a hand-written
 *  prefix that drifted would make this case pass against a key nobody writes. */
const SIDE_PREFIX = principalKeyPrefix(KERNEL_SIDE_CACHE_PREFIX, PRINCIPAL)

/** Recent on purpose: the kernel Outbox dead-letters anything past D10's 14-day
 *  horizon at open, so a fixture stamped at epoch 1 would be testing expiry
 *  rather than migration — and would pass this file's counterfactual by accident. */
const RECENTLY = Date.now() - 60_000

const entry = (mutationId: string, kind: string, queuedAt: number, extra = {}) => ({
  mutationId,
  kind,
  input: { sessionId: 's1', title: 'the users own words' },
  queuedAt,
  ...extra,
})

afterEach(() => {
  globalThis.localStorage.clear()
})

let db = 0
async function open(): Promise<{
  assembly: Awaited<ReturnType<typeof openKernelAssembly>>
  degraded: unknown[]
}> {
  const degraded: unknown[] = []
  db += 1
  const assembly = await openKernelAssembly({
    trpc,
    factory: new IDBFactory() as never,
    databaseName: `migration-${db}`,
    principal: PRINCIPAL,
    evidence: { kind: 'single-account', principal: PRINCIPAL },
    onDegraded: (detail) => degraded.push(detail),
  })
  return { assembly, degraded }
}

/** The queue the APP drains, read through the engine's own factory. */
function queued(assembly: Awaited<ReturnType<typeof openKernelAssembly>>): string[] {
  const outbox = assembly.createOutboxFn({
    api: trpc as never,
    replica: assembly.createReplicaFn(assembly.principal),
    notices: { error: () => {}, info: () => {} },
  })
  return outbox.pending().map((e) => e.mutationId)
}

const migrationReport = (degraded: unknown[]) =>
  degraded.find((d) => (d as { kind?: unknown })?.kind === 'legacy-outbox-migrated') as
    | { adopted: number; parked: number; rejected: number; quarantined: string[]; notice?: string }
    | undefined

describe('the web root carries pre-kernel queued writes into the kernel Outbox', () => {
  it('adopts entries from the RAW legacy key, and the engine can drain them', async () => {
    globalThis.localStorage.setItem(
      'podium.outbox.v1',
      JSON.stringify([entry('m-ancient', 'rename', RECENTLY + 1)]),
    )
    const { assembly, degraded } = await open()

    expect(queued(assembly)).toEqual(['m-ancient'])
    expect(migrationReport(degraded)?.adopted).toBe(1)
    // Retired only after the durable commit (D6 clause 3).
    expect(globalThis.localStorage.getItem('podium.outbox.v1')).toBeNull()
    await assembly.dispose()
  })

  it('adopts entries an EARLIER KERNEL BUILD folded into the side cache', async () => {
    globalThis.localStorage.setItem(
      `${SIDE_PREFIX}.outbox.v1`,
      JSON.stringify([entry('m-folded', 'pinSet', RECENTLY + 2)]),
    )
    globalThis.localStorage.setItem(
      `${SIDE_PREFIX}.outbox-awaiting.v1`,
      JSON.stringify([entry('m-held', 'rename', RECENTLY + 3, { state: 'awaiting-truth' })]),
    )
    const { assembly, degraded } = await open()

    // BOTH are carried — the awaiting-truth home is user work too, and the fold
    // that stranded the queued blob stranded this one beside it.
    //
    // The importer lands it as D9 `accepted` ("the Authority took it"), and the
    // kernel's own `reconcileOnOpen` then returns it to `queued`: an entry that
    // was accepted by a process that is gone reports no outcome, which D9
    // invariant 4 calls a transport failure and replays under the SAME
    // mutationId for the Authority to dedupe (D11.7). So the state at rest here
    // is `queued`, and that is the kernel's rule rather than a lossy import —
    // asserted so a change to it shows up as this case going red.
    const durable = await assembly.store.viewFor(assembly.principal.userId).outbox.read()
    expect(new Map(durable.map((r) => [r.mutationId as string, r.state]))).toEqual(
      new Map([
        ['m-folded', 'queued'],
        ['m-held', 'queued'],
      ]),
    )
    expect(queued(assembly)).toEqual(['m-folded', 'm-held'])
    expect(migrationReport(degraded)?.adopted).toBe(2)
    expect(globalThis.localStorage.getItem(`${SIDE_PREFIX}.outbox.v1`)).toBeNull()
    await assembly.dispose()
  })

  it('is IDEMPOTENT across a second open — no duplicate, no loss', async () => {
    globalThis.localStorage.setItem(
      'podium.outbox.v1',
      JSON.stringify([entry('m-once', 'rename', RECENTLY + 1)]),
    )
    const first = await open()
    expect(queued(first.assembly)).toEqual(['m-once'])
    await first.assembly.dispose()

    // Same principal, a fresh IndexedDB: the legacy key is already retired, so
    // the second open finds nothing to do and reports nothing.
    const second = await open()
    expect(migrationReport(second.degraded)).toBeUndefined()
    await second.assembly.dispose()
  })

  it('KEEPS a write whose kind names no contract, and says so', async () => {
    // A kind renamed between the build that queued this offline and the build
    // opening the store. It cannot be imported (a guessed contract re-authors the
    // write) and it must not be deleted.
    const blob = JSON.stringify([entry('m-orphan', 'sessions.renameToSomethingGone', RECENTLY + 4)])
    globalThis.localStorage.setItem('podium.outbox.v1', blob)
    const { assembly, degraded } = await open()

    const report = migrationReport(degraded)
    expect(report?.adopted).toBe(0)
    expect(report?.rejected).toBe(1)
    expect(report?.quarantined).toContain('podium.outbox.v1')
    // VERBATIM on disk, and out of every reader's way.
    expect(globalThis.localStorage.getItem('podium.outbox.v1.unmigrated')).toBe(blob)
    expect(globalThis.localStorage.getItem('podium.outbox.v1')).toBeNull()
    // And the user is told, in a sentence rather than a console line.
    expect(report?.notice).toMatch(/could not be matched/)
    await assembly.dispose()
  })

  it('reports NOTHING on a device with no queued work — the counterfactual', async () => {
    const { assembly, degraded } = await open()
    expect(migrationReport(degraded)).toBeUndefined()
    expect(queued(assembly)).toEqual([])
    await assembly.dispose()
  })

  it('does not FOLD the legacy queue into the side cache any more', async () => {
    // Two folds in different directions is how one queued write becomes two sends.
    globalThis.localStorage.setItem(
      'podium.outbox.v1',
      JSON.stringify([entry('m-solo', 'rename', RECENTLY + 1)]),
    )
    const { assembly } = await open()

    expect(globalThis.localStorage.getItem(`${SIDE_PREFIX}.outbox.v1`)).toBeNull()
    expect(queued(assembly)).toEqual(['m-solo'])
    await assembly.dispose()
  })

  it('makes no SECOND stranded copy when the legacy key survives retirement', async () => {
    /**
     * The case that tells the fold being OFF apart from the fold having nothing
     * to do. On a healthy device the migration retires the legacy key, so a fold
     * running afterwards finds an empty store and the two settings look alike —
     * measured, not assumed: turning `adoptLegacyOutbox` back on left every
     * other case in this file green.
     *
     * They come apart when `removeItem` fails (D4.5's locked or quota-bound
     * store): the entry is durable in the kernel Outbox AND still under its
     * legacy key, and a fold would copy it into `<prefix>.outbox.v1` — a second
     * copy of one queued write, in the one place nothing drains. That is the
     * strand this issue exists to end, recreated by the code meant to prevent it.
     */
    const real = globalThis.localStorage
    const backing = new Map<string, string>([
      ['podium.outbox.v1', JSON.stringify([entry('m-stuck', 'rename', RECENTLY + 1)])],
    ])
    const fake: Record<string, unknown> = {}
    const define = (name: string, value: unknown) =>
      Object.defineProperty(fake, name, { value, enumerable: false, configurable: true })
    define('getItem', (k: string) => backing.get(k) ?? null)
    define('setItem', (k: string, v: string) => backing.set(k, String(v)))
    define('removeItem', (k: string) => {
      // Only the legacy key resists: everything else must keep working, or the
      // case would be testing a store that is broken rather than one that is full.
      if (k === 'podium.outbox.v1') throw new Error('storage unavailable')
      backing.delete(k)
    })
    Object.defineProperty(globalThis, 'localStorage', { value: fake, configurable: true })
    // The double must be able to say NO before anything is concluded from it.
    expect(() => globalThis.localStorage.removeItem('podium.outbox.v1')).toThrow(/unavailable/)
    try {
      const { assembly } = await open()
      expect(queued(assembly)).toEqual(['m-stuck'])
      // Still under its legacy key (retirement failed) and NOT copied anywhere else.
      expect(backing.get('podium.outbox.v1')).toContain('m-stuck')
      expect(backing.get(`${SIDE_PREFIX}.outbox.v1`)).toBeUndefined()
      await assembly.dispose()
    } finally {
      Object.defineProperty(globalThis, 'localStorage', { value: real, configurable: true })
    }
  })
})
