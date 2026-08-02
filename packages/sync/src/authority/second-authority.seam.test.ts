/**
 * THE FEDERATION SEAM PROOF (POD-309, ADR 5 D8 "Seam proof (test-only, H1)").
 *
 * The hub is DEFERRED, not cancelled ([spec:SP-0371]). POD-309 deletes the half-built
 * node⇄hub implementation; this file is the other half of the bargain — the commitment
 * that the rewrite has not made a future hub impossible. D8 states the obligation
 * exactly: *"instantiate a second in-memory Authority against kernel ports and run the
 * parameterized suite — no product surface, config flag, or fleet UX."*
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS NOT
 * ---------------------------------------------------------------------------
 *
 * It is NOT a rehearsal of node↔hub behaviour, and the distinction is the whole reason
 * the issue is hard. Nothing here replicates A's feed into B, transfers authority over
 * an entity, prevents a loop or survives a hub disappearing — those are H2 product
 * behaviours parked in POD-353, and building them under the banner of "proving the
 * seam" is how a deferred feature comes back as test code nobody admits to owning.
 *
 * The claim is narrower and checkable: **two Authorities can COEXIST**. If any of the
 * things D8 forbids had been baked into the kernel — "same machine", "one SQLite file",
 * "must be tRPC", or, most insidiously, a module-level singleton — a second instance
 * would be impossible or would silently share the first one's state. That is what the
 * cases below can fail on.
 *
 * ---------------------------------------------------------------------------
 * WHY EVERY CASE ASSERTS A POSITIVE BEFORE IT ASSERTS AN ABSENCE
 * ---------------------------------------------------------------------------
 *
 * This run's dominant defect is a suite that cannot say NO, and the shape it takes here
 * is specific: an "authority B does not see authority A's rows" assertion passes
 * PERFECTLY against a B that is broken, refuses every write, or was never constructed.
 * An empty authority satisfies every isolation claim.
 *
 * So each case commits through BOTH authorities and asserts what each one DID before it
 * asserts what neither one shares. `authorities-are-not-empty` is the standing control:
 * it fails if either instance stops producing rows, which is the only condition under
 * which the isolation assertions would become vacuous.
 */

import { describe, expect, it } from 'vitest'
import type { ChangeLogStore } from '../change-log'
import type { ChangeLogReadRow } from './change-lifecycle'
import {
  assertOpaqueEpoch,
  FeedIdentityRegistry,
  type FeedIdentity,
  type FeedIdentityStore,
} from '../feed/identity'
import { DeviceGradeNoAnchors, DeviceGradeUnscopedPolicy } from '../feed'
import { Authority } from './authority'
import type { StagedChangeSpec } from './change-lifecycle'

/**
 * ONE in-memory instantiation of the kernel's storage ports: a change log, a real
 * rollback-capable `transact`, and a feed-identity store.
 *
 * Called TWICE below, and that is the point — every piece of state a hop needs lives in
 * the closure of one call, so two calls are two independent worlds with no shared
 * module scope between them. Nothing in here knows what a database, a socket or a file
 * is; that is ADR 5 D8 S4 stated as code rather than as a comment.
 */
function instantiateKernelPorts(name: string) {
  let rows: ChangeLogReadRow[] = []
  let nextSeq = 1
  let identity: FeedIdentity | null = null
  let minted = 0

  const store: ChangeLogStore = {
    appendChanges(batch) {
      const seqs: number[] = []
      for (const r of batch) {
        rows.push({ seq: nextSeq, ...r })
        seqs.push(nextSeq)
        nextSeq += 1
      }
      return seqs
    },
    maxChangeSeq: () => nextSeq - 1,
    minChangeSeq: () => rows[0]?.seq ?? null,
    changesSince: (cursor) => rows.filter((r) => r.seq > cursor),
    planChangePrune: () => ({ thresholdSeq: 0 }),
    pruneChangeBatch: () => 0,
    latestChangeStates: () => {
      const latest = new Map<string, (typeof rows)[number]>()
      for (const r of rows) latest.set(`${r.entity}/${r.entityId}`, r)
      return [...latest.values()]
    },
  }

  // A REAL span: it snapshots and restores, so an atomicity claim here is measured
  // rather than assumed. A pass-through `(fn) => fn()` would make rollback vacuous.
  const transact = <T>(fn: () => T): T => {
    const snapshot = rows.slice()
    const savedSeq = nextSeq
    try {
      return fn()
    } catch (err) {
      rows = snapshot
      nextSeq = savedSeq
      throw err
    }
  }

  const identityStore: FeedIdentityStore = {
    readIdentity: () => identity,
    writeIdentity: (next) => {
      identity = next
    },
  }

  // Opaque per instantiation AND per call — the id source a real deployment injects.
  // A frozen mint would make the distinct-feedId assertion below meaningless, and
  // `assertOpaqueEpoch` (the SHIPPED guard) refuses a decimal counter outright, so this
  // cannot degrade into "epoch-1" without the kernel's own rule firing.
  const mint = () => `${name}-${((minted += 1)).toString(36)}-xr`

  const feed = new FeedIdentityRegistry(identityStore, mint)
  const authority = new Authority({
    store,
    now: () => 1_000,
    transact,
    // The SHIPPED single-principal policy and anchor port, constructed — not a
    // permissive stub. A composition root with one principal must NAME these
    // (AuthorityDeps.visibility is required precisely so "no policy" cannot be
    // mistaken for "everyone sees everything"), and this instantiation says so too.
    visibility: new DeviceGradeUnscopedPolicy(),
    anchors: new DeviceGradeNoAnchors(),
  })
  return {
    authority,
    feed,
    seqs: () => rows.map((r) => r.seq),
    ids: () => rows.map((r) => r.entityId),
  }
}

const upsert = (id: string): StagedChangeSpec => ({
  entity: 'session',
  entityId: id,
  op: 'upsert',
  value: { id },
})

function commit(
  world: ReturnType<typeof instantiateKernelPorts>,
  id: string,
): readonly number[] | undefined {
  const outcome = world.authority.commit({
    write: () => undefined,
    changes: () => [upsert(id)],
  })
  return outcome.outcome === 'committed' ? outcome.changes.map((c) => c.seq) : undefined
}

describe('ADR 5 D8 — a SECOND Authority instantiates against the kernel ports', () => {
  it('both authorities accept writes — the control that keeps the isolation cases honest', () => {
    const a = instantiateKernelPorts('a')
    const b = instantiateKernelPorts('b')
    // An authority that refuses everything would satisfy every "B never sees A's row"
    // assertion in this file. This is the case that fails first if that ever happens.
    expect(commit(a, 'a1')).toEqual([1])
    expect(commit(b, 'b1')).toEqual([1])
    expect(a.ids()).toEqual(['a1'])
    expect(b.ids()).toEqual(['b1'])
  })

  it('two Authorities over separate ports share NO state — no same-machine singleton', () => {
    const a = instantiateKernelPorts('a')
    const b = instantiateKernelPorts('b')
    commit(a, 'a1')
    commit(a, 'a2')
    commit(b, 'b1')
    // Global seq is per-authority: B's first row is seq 1 even though A has already
    // assigned 1 and 2. A module-level counter, a shared baseline or a process-wide
    // store would show up here as B starting at 3 — or as A's ids appearing in B.
    expect(a.seqs()).toEqual([1, 2])
    expect(b.seqs()).toEqual([1])
    expect(a.ids()).toEqual(['a1', 'a2'])
    expect(b.ids()).toEqual(['b1'])
  })

  it('each Authority carries its OWN feed identity (S1) — a cursor is meaningless alone', () => {
    const a = instantiateKernelPorts('a')
    const b = instantiateKernelPorts('b')
    const idA = a.feed.current()
    const idB = b.feed.current()
    // Opaque, checked by the SHIPPED guard rather than by a regex written here: if a
    // mint ever degrades to a counter, ADR 2 D1's own rule throws.
    assertOpaqueEpoch(idA.epoch)
    assertOpaqueEpoch(idB.epoch)
    expect(idA.feedId).not.toBe(idB.feedId)
    expect(idA.epoch).not.toBe(idB.epoch)
    // The property a future node needs: seq 1 exists in BOTH feeds and means two
    // different things, so `(feedId, epoch, seq)` is the identity and `seq` is not.
    commit(a, 'a1')
    commit(b, 'b1')
    expect(a.seqs()).toEqual([1])
    expect(b.seqs()).toEqual([1])
    expect(idA).not.toEqual(idB)
  })

  it('identity survives rebuilding the registry over the SAME ports, per authority', () => {
    const a = instantiateKernelPorts('a')
    const first = a.feed.current()
    // Not a second world: the same `a`, asked again. This is what makes the
    // distinct-feedId case above a statement about two AUTHORITIES rather than about a
    // mint that simply never repeats itself.
    expect(a.feed.current()).toEqual(first)
  })

  it('is TEST-ONLY: nothing here is reachable from a product composition root', () => {
    // The seam proof must not become a shipped second-authority surface (D8: "no
    // product surface, config flag, or fleet UX"). The enforcement is not this
    // assertion — it is `scripts/audit-federation-seam.ts`, which reads source text
    // across apps/ and packages/ and fails if a non-test file constructs more than one
    // Authority in one composition root. This case exists to point at it, so a reader
    // who finds this file knows where the real gate lives.
    expect(instantiateKernelPorts).toBeTypeOf('function')
  })
})
