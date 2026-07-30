/**
 * THE CROSS-HOP CONFORMANCE SUITE (POD-373) — one suite, parameterized by
 * instantiation.
 *
 * `describeSyncConformance(instantiation)` is the whole public surface. POD-307,
 * POD-308, POD-309, POD-374 and POD-375 each supply a `SyncInstantiation` and call
 * it; nothing in this file may be edited to admit them and nothing in it may assume
 * the in-memory one. Every case reaches storage only through the ports in
 * `instantiation.ts`.
 *
 * WHAT MAKES IT A GATE RATHER THAN A REPORT. The human decision of 2026-07-29 made
 * the visibility machinery load-bearing from day one, so its coverage is a Phase-2
 * gate condition. `gates.ts` holds that set as data and `assertGatesCovered` is a
 * totality test over it, run in `afterAll`: a gate with no test fails the suite. The
 * ids are stable strings, so renaming a test cannot silently un-register a gate.
 *
 * THE CHAOS RULE, applied uniformly: every fault case asserts EITHER no data loss OR
 * an explicitly surfaced degradation. Never silence. Where the surfaced form is what
 * holds, the case asserts the surface — an event, a posture, a dead letter — and not
 * merely that nothing threw.
 *
 * TWO HABITS WORTH NOTICING BEFORE EDITING:
 *
 *  - **Positive control first.** Every case that asserts an ABSENCE (nothing
 *    retired, no heal, no eviction rendered as a deletion) is preceded by, or
 *    contains, the observation that the same instrument reports the PRESENCE. An
 *    absence from an instrument that cannot say yes is not evidence.
 *  - **Counterfactual in the fixture.** A name containing "only", "exactly",
 *    "never" or "instead of" needs the alternative to be PRESENT and eligible.
 *    "Converges on exactly its slice" is asserted against an authority that also
 *    holds rows this principal must not get; "the agent cannot drain past its own
 *    scope" is asserted against an agent whose HUMAN can see the target.
 */

import { describe, expect, it, afterAll, beforeEach } from 'vitest'
import { normalizeRefusal, recoveryPlanFor } from '../outbox/reasons'
import { isDelegated } from '../outbox/records'
import type { Cursor } from '../replica/types'
import {
  ConformanceAuthority,
  type ConformancePrincipal,
  FIRST_EPOCH,
  attributionOf,
  keyOf,
} from './authority'
import { GateLedger, assertGatesCovered } from './gates'
import {
  type Client,
  Clock,
  DAY_MS,
  enqueueWrite,
  nextFrame,
  openClient,
  pumpUntilCaughtUp,
  sliceOf,
} from './harness'
import type { ConformanceStorage, SyncInstantiation } from './instantiation'

const ADA: ConformancePrincipal = { kind: 'user', userId: 'ada' }
const GRACE: ConformancePrincipal = { kind: 'user', userId: 'grace' }

/** ADA's agent, scoped to ONE issue. Its human can see more — that is A2's whole point. */
const ADAS_AGENT: ConformancePrincipal = {
  kind: 'agent',
  sessionId: 'ses_ada_agent',
  onBehalfOf: 'ada',
  scope: new Set([keyOf('issue', 'ADA-1')]),
}

export function describeSyncConformance(instantiation: SyncInstantiation): void {
  const ledger = new GateLedger(instantiation.name)

  describe(`sync kernel conformance [${instantiation.name}]`, () => {
    let authority: ConformanceAuthority
    let storage: ConformanceStorage
    let clock: Clock
    let ids: number

    const nextId = (): never => `m${(ids += 1)}` as never

    beforeEach(async () => {
      authority = new ConformanceAuthority()
      storage = await instantiation.open()
      clock = new Clock()
      ids = 0
    })

    const client = async (principal: ConformancePrincipal): Promise<Client> =>
      (await openClient({
        authority,
        storage,
        principal,
        clock,
        newMutationId: nextId,
      })) as Client

    /** ADA sees ADA-1 and ADA-2; GRACE sees GRACE-1 and the SHARED row. Two real slices. */
    const seedTwoSlices = (): void => {
      authority.append({ entity: 'issue', entityId: 'ADA-1', op: 'upsert', payload: { n: 1 } })
      authority.append({ entity: 'issue', entityId: 'ADA-2', op: 'upsert', payload: { n: 2 } })
      authority.append({ entity: 'issue', entityId: 'GRACE-1', op: 'upsert', payload: { n: 3 } })
      authority.append({ entity: 'issue', entityId: 'SHARED', op: 'upsert', payload: { n: 4 } })
      authority.policy.grant('ada', 'issue', 'ADA-1')
      authority.policy.grant('ada', 'issue', 'ADA-2')
      authority.policy.grant('grace', 'issue', 'GRACE-1')
      authority.policy.grant('grace', 'issue', 'SHARED')
    }

    /**
     * Let D10's transient backoff elapse.
     *
     * An `unreachable` attempt sets `nextAttemptAt` — durable, deliberately, so a
     * reconnect burst cannot reset the spacing to zero and hammer an authority that is
     * already struggling. So a drain immediately after the link returns correctly does
     * NOTHING, and every offline case needs the clock moved past the cap (60s) before
     * the retry is eligible. Advancing an explicit clock rather than sleeping: a fixed
     * sleep before an assertion is a bug, and this way the backoff is exercised rather
     * than waited out.
     */
    const backoffElapsed = (): void => clock.advance(5 * 60_000)

    const connected = async (principal: ConformancePrincipal): Promise<Client> => {
      const c = await client(principal)
      c.replica.connect()
      await c.settle()
      return c
    }

    // ─────────────────────────────────────────────────────────────────────────
    describe('base — the ladder, the queue, and the normal path', () => {
      it(`${ledger.cover('base/bootstrap-chunked')} — bootstrap installs the principal's OWN slice, chunked and paced`, async () => {
        seedTwoSlices()
        authority.chunkSize = 1
        const ada = await connected(ADA)

        expect(ada.replica.posture).toBe('live')
        expect(sliceOf(ada)).toEqual(['issue:ADA-1', 'issue:ADA-2'])
        // Chunked, not one shot: >1 chunk for a 2-row slice at chunkSize 1.
        expect(authority.chunkTrace.filter((t) => t.startsWith('ada:')).length).toBeGreaterThan(1)
        // Buffered state returns to zero outside `bootstrapping` (D13.4).
        expect(ada.replica.stats().bufferedFrames).toBe(0)
      })

      it(`${ledger.cover('base/cold-start')} — a client with NO cursor takes rung 2, cause cold-start`, async () => {
        seedTwoSlices()
        const ada = await client(ADA)
        expect(ada.replica.cursor).toBeNull()

        ada.replica.connect()
        await ada.settle()

        const installed = ada.replicaEvents.find((e) => e.type === 'bootstrap-installed')
        expect(installed).toMatchObject({ cause: 'cold-start' })
        // Counterfactual: a client that DOES have a cursor resumes instead of
        // bootstrapping, so "cold-start" is a real branch and not the only one.
        const before = authority.bootstrapCalls
        ada.replica.disconnect()
        ada.replica.connect()
        await ada.settle()
        expect(authority.bootstrapCalls).toBe(before)
        expect(ada.replica.posture).toBe('live')
      })

      it(`${ledger.cover('base/disconnect-stale-visible')} — disconnected keeps its slice, marked stale, never blank`, async () => {
        seedTwoSlices()
        const ada = await connected(ADA)

        ada.replica.disconnect()

        expect(ada.replica.posture).toBe('stale')
        expect(ada.replica.isStale).toBe(true)
        // NEVER BLANK. This is the assertion D7 exists for.
        expect(sliceOf(ada)).toEqual(['issue:ADA-1', 'issue:ADA-2'])
        expect(ada.replica.view('issue', 'ADA-1')).toEqual({ n: 1 })
      })

      it(`${ledger.cover('base/gap-heals')} — a gap takes rung 1, heals through changesSince, and resolves downward`, async () => {
        seedTwoSlices()
        const ada = await connected(ADA)
        const atBootstrap = ada.replica.cursor as Cursor

        // Two more visible changes, then hand the replica ONLY the later frame: its
        // `fromSeq` is above the cursor, so it is a gap and must not be applied.
        authority.append({ entity: 'issue', entityId: 'ADA-1', op: 'upsert', payload: { n: 10 } })
        const secondSeq = authority.append({
          entity: 'issue',
          entityId: 'ADA-2',
          op: 'upsert',
          payload: { n: 20 },
        })
        ada.replica.receive(authority.frameFor(ADA, secondSeq - 1, secondSeq))
        await ada.settle()

        expect(ada.replicaEvents.some((e) => e.type === 'heal' && e.rung === 1)).toBe(true)
        // Resolved DOWNWARD and converged: the heal filled the hole rather than looping.
        expect(ada.replica.posture).toBe('live')
        expect(ada.replica.cursor?.seq).toBe(authority.head())
        expect(ada.replica.cursor?.seq).toBeGreaterThan(atBootstrap.seq)
        expect(ada.replica.view('issue', 'ADA-1')).toEqual({ n: 10 })
        expect(ada.replica.view('issue', 'ADA-2')).toEqual({ n: 20 })
      })

      it(`${ledger.cover('base/offline-writes-drain')} — writes queued while disconnected drain on reconnect`, async () => {
        seedTwoSlices()
        const ada = await connected(ADA)
        const transport = authority.transportFor(ADA)
        transport.offline = true

        ada.replica.disconnect()
        const queued = await enqueueWrite(ada, {
          entity: 'issue',
          entityId: 'ADA-1',
          value: { closed: true },
        })
        // Durably queued and locally acked — nothing has been told to anyone yet.
        expect(ada.outboxEvents).toContainEqual({ type: 'local-ack', mutationId: queued.mutationId })
        expect(await ada.view.outbox.read()).toHaveLength(1)

        transport.offline = false
        ada.replica.connect()
        await ada.settle()
        backoffElapsed()
        await ada.outbox.drain()

        expect(authority.receiptFor(queued.mutationId)).toBeDefined()
        await pumpUntilCaughtUp(authority, ada)
        expect(ada.replica.view('issue', 'ADA-1')).toEqual({ closed: true })
        // Retired once covering truth landed. Nothing lost, nothing duplicated.
        expect(ada.outbox.find(queued.mutationId)).toBeUndefined()
        expect(await ada.view.outbox.read()).toEqual([])
      })

      it(`${ledger.cover('base/duplicate-delivery')} — a re-delivered frame is idempotent and the cursor never regresses`, async () => {
        seedTwoSlices()
        const ada = await connected(ADA)
        const seq = authority.append({
          entity: 'issue',
          entityId: 'ADA-1',
          op: 'upsert',
          payload: { n: 99 },
        })
        const frame = authority.frameFor(ADA, seq - 1, seq)

        ada.replica.receive(frame)
        await ada.settle()
        const afterFirst = ada.replica.cursor as Cursor
        const entitiesAfterFirst = sliceOf(ada)

        // The SAME frame again. Its `fromSeq` is now below the cursor, so it is stale,
        // not a gap — and a replica that treated it as a gap would heal forever.
        ada.replica.receive(frame)
        ada.replica.receive(frame)
        await ada.settle()

        expect(ada.replica.cursor).toEqual(afterFirst)
        expect(sliceOf(ada)).toEqual(entitiesAfterFirst)
        expect(ada.replica.view('issue', 'ADA-1')).toEqual({ n: 99 })
        expect(ada.replica.posture).toBe('live')
      })

      it(`${ledger.cover('base/rejection-dead-letter')} — a definitive refusal dead-letters with a recovery plan and does NOT retry`, async () => {
        seedTwoSlices()
        const ada = await connected(ADA)
        // A target ADA may not see: definitive, not transport.
        const doomed = await enqueueWrite(ada, {
          entity: 'issue',
          entityId: 'GRACE-1',
          value: { closed: true },
        })
        const fine = await enqueueWrite(ada, {
          entity: 'issue',
          entityId: 'ADA-1',
          value: { closed: true },
        })

        await ada.outbox.drain()
        await ada.outbox.drain()
        await ada.outbox.drain()

        const parked = ada.outbox.deadLetters()
        expect(parked.map((p) => p.mutationId)).toEqual([doomed.mutationId])
        expect(parked[0]?.reason).toEqual({ code: 'unauthorized' })
        expect(parked[0]?.parkedFrom).toBe('rejected')
        // Recovery is offered, and it is derived from the code alone.
        expect(parked[0]?.recovery).toEqual(recoveryPlanFor('unauthorized'))
        // The author's own intent is recoverable verbatim. D9 invariant 1.
        expect(parked[0]?.input).toEqual({
          entity: 'issue',
          entityId: 'GRACE-1',
          value: { closed: true },
        })
        // ZERO automatic retries for a definitive refusal (D10) — and the
        // counterfactual is in the same fixture: the legal write DID go through, so
        // "did not retry" is not "the drain never ran".
        expect(authority.transportFor(ADA).attempts(doomed.mutationId)).toBe(1)
        expect(ada.outbox.find(doomed.mutationId)?.state).toBe('dead-letter')
        // The legal write DID apply. It waits in `applied` for covering truth rather
        // than vanishing — retirement is the frame's job, not the drain's (D9
        // invariant 1's second licence).
        expect(ada.outbox.find(fine.mutationId)?.state).toBe('applied')
        expect(authority.receiptFor(fine.mutationId)).toBeDefined()
        // …and it retires as soon as that truth arrives, which is what makes the
        // `applied` state above a waypoint rather than a leak.
        await pumpUntilCaughtUp(authority, ada)
        expect(ada.outbox.find(fine.mutationId)).toBeUndefined()
      })
    })

    // ─────────────────────────────────────────────────────────────────────────
    describe('chaos — no data loss, or an explicitly surfaced degradation', () => {
      it(`${ledger.cover('base/crash-between-writes')} — crash between entity, cursor and outbox writes lands on PRE or POST, never a torn mix`, async () => {
        seedTwoSlices()
        const ada = await connected(ADA)

        // Durable pre-state: entity at r0, a cursor, and a mutation applied at the
        // authority but still awaiting covering truth locally.
        const preCursor = ada.replica.cursor as Cursor
        const preValue = ada.replica.view('issue', 'ADA-1')
        const record = await enqueueWrite(ada, {
          entity: 'issue',
          entityId: 'ADA-1',
          value: { closed: true },
        })
        await ada.outbox.drain()
        // `applied` and not `accepted`: this authority's apply hop is atomic, which
        // `OutboxSubmitOutcome` explicitly permits ("report `applied` directly when the
        // hop is atomic"). The entry is awaiting COVERING TRUTH, which is the state the
        // D10 crash case is defined over.
        expect(ada.outbox.find(record.mutationId)?.state).toBe('applied')
        const preOutbox = await ada.view.outbox.read()
        expect(preOutbox).toHaveLength(1)

        // The certified frame carrying E@r1 with provenance matching M.
        const frame = nextFrame(authority, ada)
        expect(frame.changes.some((c) => c.mutationId === record.mutationId)).toBe(true)

        // Fail AFTER both participants enrolled and BEFORE the shared commit.
        const transactionsBefore = storage.unitOfWorkTransactions()
        storage.failNextCommit(new Error('power loss mid-transaction'))
        ada.replica.receive(frame)
        // SURFACED on the unit of work the Replica joined, not swallowed.
        await expect(ada.settle()).rejects.toThrow('power loss')
        // ONE transaction was opened for both regions, not two — through the kernel's
        // own commit path, which is what POD-1158's fix made reachable.
        expect(storage.unitOfWorkTransactions()).toBe(transactionsBefore + 1)

        // Recreate BOTH kernels from the store. Whatever they see is what committed.
        const recovered = (await ada.recover()) as Client
        const durableOutbox = await recovered.view.outbox.read()
        const cursorAfter = recovered.view.cache.readCursor()
        const valueAfter = recovered.view.cache.read('issue', 'ADA-1')?.value

        // PRE is the only legal snapshot here: entity at r0, the old cursor, M still
        // awaiting. POST would be all three moved. A torn mix is any other combination,
        // and each half is asserted separately so a mix cannot hide inside one match.
        expect(cursorAfter).toEqual(preCursor)
        expect(valueAfter).toEqual(preValue)
        expect(durableOutbox).toEqual(preOutbox)
        // NO DATA LOSS: the user's write is still there, recoverable, unretired.
        expect(recovered.outbox.find(record.mutationId)?.state).toBe('applied')

        // POSITIVE CONTROL, same window, same wiring: without the injected failure the
        // very same frame commits all three regions. Without this the assertions above
        // could be satisfied by a path that never wrote anything.
        recovered.replica.connect()
        await recovered.settle()
        recovered.replica.receive(nextFrame(authority, recovered))
        await recovered.settle()
        expect(recovered.view.cache.readCursor()?.seq).toBe(frame.seq)
        expect(recovered.view.cache.read('issue', 'ADA-1')?.value).toEqual({ closed: true })
        expect(await recovered.view.outbox.read()).toEqual([])
      })

      it(`${ledger.cover('base/quota-exhaustion')} — a denied durable write surfaces and loses nothing`, async () => {
        seedTwoSlices()
        const ada = await connected(ADA)
        const survivor = await enqueueWrite(ada, {
          entity: 'issue',
          entityId: 'ADA-1',
          value: { first: true },
        })
        const durableBefore = await ada.view.outbox.read()
        expect(durableBefore).toHaveLength(1)

        // ADR 6 D4.4 — the denial must SURFACE and must not partially apply.
        storage.setWritesDenied(true)
        await expect(
          enqueueWrite(ada, { entity: 'issue', entityId: 'ADA-2', value: { second: true } }),
        ).rejects.toThrow(/quota/i)

        // Nothing half-landed: the store holds exactly what it held before.
        expect(await ada.view.outbox.read()).toEqual(durableBefore)
        // And the earlier work is untouched — a denial is not a reset.
        expect(ada.outbox.find(survivor.mutationId)?.state).toBe('queued')

        // Space freed: the SAME operation now succeeds, so the refusal was the gate and
        // not a permanent wedge.
        storage.setWritesDenied(false)
        const second = await enqueueWrite(ada, {
          entity: 'issue',
          entityId: 'ADA-2',
          value: { second: true },
        })
        expect((await ada.view.outbox.read()).map((r) => r.mutationId)).toEqual([
          survivor.mutationId,
          second.mutationId,
        ])
      })

      it('an unreadable outbox store is LOUD — the one case where user work is lost', async () => {
        seedTwoSlices()
        const ada = await connected(ADA)
        await enqueueWrite(ada, { entity: 'issue', entityId: 'ADA-1', value: { closed: true } })

        storage.setCorrupt(true)
        const reopened = (await ada.recover()) as Client

        // It does NOT start quietly empty. ADR 2 D7: that loss must be loud.
        expect(reopened.storeUnreadable).toHaveLength(1)
        expect(reopened.outboxEvents.some((e) => e.type === 'store-unreadable')).toBe(true)
      })
    })

    // ─────────────────────────────────────────────────────────────────────────
    describe('the four cases the ADRs assign to this suite by name', () => {
      it(`${ledger.cover('adr/restore-then-stale-client')} — restore, keep writing, stale client reconnects at the SAME seq`, async () => {
        seedTwoSlices()
        const ada = await connected(ADA)
        const cursorBefore = ada.replica.cursor as Cursor
        ada.replica.disconnect()

        // A BACKUP RESTORE. The authority comes back on a new epoch and re-issues the
        // very same seq numbers for DIFFERENT content — which is why D1 says a counter
        // re-collides across repeated restores and identity must be compared by equality.
        authority.bumpEpoch('epoch-2-after-restore')
        authority.append({ entity: 'issue', entityId: 'ADA-1', op: 'upsert', payload: { post: 1 } })

        // The stale client's cursor seq is still valid-looking. Only the epoch differs.
        const divergent = authority.frameFor(ADA, cursorBefore.seq)
        expect(divergent.seq).toBeLessThanOrEqual(cursorBefore.seq + 2)
        expect(divergent.epoch).not.toBe(cursorBefore.epoch)

        ada.replica.receive(divergent)
        await ada.settle()

        // DETECTED, by identity and not by seq: rung 4, then a re-bootstrap.
        expect(
          ada.replicaEvents.some((e) => e.type === 'heal' && e.cause === 'epoch-mismatch'),
        ).toBe(true)
        expect(ada.replica.cursor?.epoch).toBe('epoch-2-after-restore')
        expect(ada.replica.view('issue', 'ADA-1')).toEqual({ post: 1 })

        // COUNTERFACTUAL: a frame on the SAME epoch at the same seq is applied, so the
        // rejection above is about identity and not about the seq being unwelcome.
        const seq = authority.append({
          entity: 'issue',
          entityId: 'ADA-2',
          op: 'upsert',
          payload: { same: true },
        })
        ada.replica.receive(authority.frameFor(ADA, seq - 1, seq))
        await ada.settle()
        expect(ada.replica.view('issue', 'ADA-2')).toEqual({ same: true })
      })

      it(`${ledger.cover('adr/reconnect-storm')} — N replicas bootstrapping at once; bootstrap paces, yields, and never owns the loop`, async () => {
        // Rows for six principals, each with its own slice. The requirement here is
        // BEHAVIOURAL; the thresholds belong to POD-337.
        const humans = ['p0', 'p1', 'p2', 'p3', 'p4', 'p5']
        for (const who of humans) {
          for (let n = 0; n < 3; n += 1) {
            authority.append({ entity: 'issue', entityId: `${who}-${n}`, op: 'upsert', payload: { n } })
            authority.policy.grant(who, 'issue', `${who}-${n}`)
          }
        }
        authority.chunkSize = 1

        const clients = await Promise.all(
          humans.map(async (who) => await client({ kind: 'user', userId: who })),
        )
        // ALL AT ONCE.
        for (const c of clients) c.replica.connect()
        await Promise.all(clients.map(async (c) => await c.settle()))

        // Nobody starved: every replica installed its OWN slice, complete.
        for (const [i, c] of clients.entries()) {
          const who = humans[i] as string
          expect(c.replica.posture).toBe('live')
          expect(sliceOf(c)).toEqual([`issue:${who}-0`, `issue:${who}-1`, `issue:${who}-2`])
        }
        // They genuinely overlapped, so "did not starve" is not "ran one at a time".
        expect(authority.peakConcurrentBootstraps).toBeGreaterThan(1)
        // And bootstrap did not own the loop: chunks INTERLEAVE across principals
        // rather than one walk running to completion before the next starts.
        const owners = authority.chunkTrace.map((t) => t.split(':')[0] as string)
        const runs = owners.filter((who, i) => who !== owners[i - 1]).length
        expect(runs).toBeGreaterThan(humans.length)
      })

      it(`${ledger.cover('adr/offline-writes-across-epoch-bump')} — queued writes survive an epoch bump: they drain or surface, and none vanish`, async () => {
        seedTwoSlices()
        const ada = await connected(ADA)
        const transport = authority.transportFor(ADA)
        transport.offline = true
        ada.replica.disconnect()

        const legal = await enqueueWrite(ada, {
          entity: 'issue',
          entityId: 'ADA-1',
          value: { closed: true },
        })
        const doomed = await enqueueWrite(ada, {
          entity: 'issue',
          entityId: 'GRACE-1',
          value: { closed: true },
        })
        await ada.outbox.drain() // unreachable: both stay queued

        // THE EPOCH BUMP. The cache is worthless; the queue is not.
        authority.bumpEpoch('epoch-2')
        ada.replica.connect()
        await ada.settle()
        expect(ada.replica.cursor?.epoch).toBe('epoch-2')
        transport.offline = false
        backoffElapsed()

        // KEPT. Discarding the cache reached neither entry.
        expect((await ada.view.outbox.read()).map((r) => r.mutationId).sort()).toEqual(
          [legal.mutationId, doomed.mutationId].sort(),
        )

        await ada.outbox.drain()
        await ada.outbox.drain()
        await ada.outbox.drain()

        // Each one either DRAINED or SURFACED. Neither vanished, and the suite says
        // which happened to which rather than counting survivors.
        expect(authority.receiptFor(legal.mutationId)).toBeDefined()
        expect(ada.outbox.deadLetters().map((d) => d.mutationId)).toEqual([doomed.mutationId])
        expect(ada.outbox.find(legal.mutationId)?.state ?? 'retired').not.toBe('queued')
      })

      it(`${ledger.cover('adr/slow-consumer-demoted-converges')} — demote-to-resync CONVERGES, it does not merely survive`, async () => {
        seedTwoSlices()
        const ada = await connected(ADA)
        // The authority sheds load while ADA is behind: more visible truth exists than
        // ADA's cursor has seen.
        authority.append({ entity: 'issue', entityId: 'ADA-1', op: 'upsert', payload: { n: 11 } })
        authority.append({ entity: 'issue', entityId: 'ADA-2', op: 'upsert', payload: { n: 22 } })
        const behind = ada.replica.cursor?.seq as number
        expect(behind).toBeLessThan(authority.head())

        ada.replica.receive({
          kind: 'resync-required',
          feedId: authority.feedId,
          epoch: authority.epoch,
          reason: 'outbound queue full',
        })
        await ada.settle()

        // CONVERGENCE, asserted on content and cursor — not "posture is live".
        expect(ada.replica.cursor?.seq).toBe(authority.head())
        expect(ada.replica.view('issue', 'ADA-1')).toEqual({ n: 11 })
        expect(ada.replica.view('issue', 'ADA-2')).toEqual({ n: 22 })
        const installed = ada.replicaEvents.filter((e) => e.type === 'bootstrap-installed')
        // Distinguishable from an authz event in telemetry, which is D14.4's rule.
        expect(installed.at(-1)).toMatchObject({ cause: 'resync-required' })
      })
    })

    // ─────────────────────────────────────────────────────────────────────────
    describe('the seven scoped multi-user gates', () => {
      it(`${ledger.cover('scoped/grant-mid-session')} — a row becomes visible to a LIVE replica, arrives correctly, contiguity intact`, async () => {
        seedTwoSlices()
        const ada = await connected(ADA)
        expect(sliceOf(ada)).not.toContain('issue:SHARED')
        const cursorBefore = ada.replica.cursor as Cursor
        // A BASELINE, not an empty list: the cold-start bootstrap that got this replica
        // live is itself a rung-2 heal, so `toEqual([])` here would assert something
        // false about the setup rather than something true about the grant.
        const healsBefore = ada.replicaEvents.filter((e) => e.type === 'heal').length

        // A colleague shares. The entity's revision does NOT move (D14.2).
        const grantSeq = authority.grant('ada', 'issue', 'SHARED')
        await pumpUntilCaughtUp(authority, ada)

        expect(sliceOf(ada)).toEqual(['issue:ADA-1', 'issue:ADA-2', 'issue:SHARED'])
        expect(ada.replica.view('issue', 'SHARED')).toEqual({ n: 4 })
        // CONTIGUITY INTACT: it arrived as an ordinary frame, not through the ladder.
        expect(ada.replica.cursor?.seq).toBe(grantSeq)
        expect(ada.replica.cursor?.seq).toBeGreaterThan(cursorBefore.seq)
        expect(ada.replica.posture).toBe('live')
        expect(ada.replicaEvents.filter((e) => e.type === 'heal').length).toBe(healsBefore)
        // GRACE, who already had it, saw that seq as a WATERMARK — the counterfactual
        // that makes "per-principal" a fact rather than a label.
        const graceFrame = authority.frameFor(GRACE, grantSeq - 1, grantSeq)
        expect(graceFrame.changes).toEqual([])
      })

      it(`${ledger.cover('scoped/revoke-mid-session')} — the replica EVICTS without rendering a deletion, and its cursor stays contiguous`, async () => {
        seedTwoSlices()
        authority.policy.grant('ada', 'issue', 'SHARED')
        const ada = await connected(ADA)
        expect(sliceOf(ada)).toContain('issue:SHARED')
        const healsBefore = ada.replicaEvents.filter((e) => e.type === 'heal').length

        // POSITIVE CONTROL FIRST: a real tombstone DOES render as a deletion, on the
        // same replica, through the same pipe. Without it "not a deletion" is unfalsifiable.
        const removeSeq = authority.append({ entity: 'issue', entityId: 'ADA-2', op: 'remove' })
        ada.replica.receive(authority.frameFor(ADA, removeSeq - 1, removeSeq))
        await ada.settle()
        expect(ada.replicaEvents.some((e) => e.type === 'removed' && e.entityId === 'ADA-2')).toBe(
          true,
        )
        expect(ada.replica.exitKind('issue', 'ADA-2')).toBe('removed')

        // Now the revoke.
        const revokeSeq = authority.revoke('ada', 'issue', 'SHARED')
        ada.replica.receive(authority.frameFor(ADA, revokeSeq - 1, revokeSeq))
        await ada.settle()

        // Gone from the view…
        expect(sliceOf(ada)).not.toContain('issue:SHARED')
        // …and NOT A DELETION. Asserted three ways, because this is D14.1's whole point.
        expect(ada.replicaEvents.some((e) => e.type === 'evicted' && e.entityId === 'SHARED')).toBe(
          true,
        )
        expect(ada.replicaEvents.some((e) => e.type === 'removed' && e.entityId === 'SHARED')).toBe(
          false,
        )
        // REMOVE AND EVICT ARE DISTINGUISHABLE AT THE REPLICA (D14.5), and the
        // instrument is proven able to say either — it said 'removed' for ADA-2 above.
        expect(ada.replica.exitKind('issue', 'SHARED')).toBe('evicted')
        expect(ada.replica.exitKind('issue', 'SHARED')).not.toBe(
          ada.replica.exitKind('issue', 'ADA-2'),
        )
        // …AND THE DISTINCTION CROSSES THE STORAGE PORT. This is not redundant with the
        // three assertions above, and a mutation proved it: making the Replica hand the
        // store `remove` for an eviction survived all of them, because the public
        // projection reads the ENVELOPE's op while the in-memory adapter deletes the row
        // either way. A durable adapter may write a tombstone for one and not the other
        // (POD-374/POD-375), so the kind that reaches the port is its own obligation.
        const exits = storage
          .cacheOperations()
          .filter((op) => op.kind !== 'upsert' && op.entity === 'issue')
        expect(exits).toEqual([
          { kind: 'remove', entity: 'issue', entityId: 'ADA-2' },
          { kind: 'evict', entity: 'issue', entityId: 'SHARED' },
        ])
        // CURSOR STAYS CONTIGUOUS — no heal, no re-bootstrap for a revoke.
        expect(ada.replica.cursor?.seq).toBe(revokeSeq)
        expect(ada.replica.posture).toBe('live')
        expect(ada.replicaEvents.filter((e) => e.type === 'heal').length).toBe(healsBefore)
      })

      it(`${ledger.cover('scoped/gap-heal-exact-slice')} — a scoped heal converges on EXACTLY its slice, never more`, async () => {
        seedTwoSlices()
        const ada = await connected(ADA)

        // Truth ADA missed: some of it hers, some of it emphatically not. The
        // counterfactual is IN the range being healed — an unscoped heal would
        // over-deliver here and the upper bound would catch it.
        authority.append({ entity: 'issue', entityId: 'ADA-1', op: 'upsert', payload: { n: 100 } })
        authority.append({ entity: 'issue', entityId: 'GRACE-1', op: 'upsert', payload: { n: 200 } })
        authority.append({ entity: 'issue', entityId: 'SHARED', op: 'upsert', payload: { n: 300 } })
        const last = authority.append({
          entity: 'issue',
          entityId: 'ADA-2',
          op: 'upsert',
          payload: { n: 400 },
        })

        // Force rung 1 by delivering only the tail.
        ada.replica.receive(authority.frameFor(ADA, last - 1, last))
        await ada.settle()

        expect(ada.replicaEvents.some((e) => e.type === 'heal' && e.rung === 1)).toBe(true)
        expect(ada.replica.cursor?.seq).toBe(authority.head())
        // THE UPPER BOUND, not merely convergence.
        expect(sliceOf(ada)).toEqual(['issue:ADA-1', 'issue:ADA-2'])
        expect(ada.replica.view('issue', 'ADA-1')).toEqual({ n: 100 })
        expect(ada.replica.view('issue', 'ADA-2')).toEqual({ n: 400 })
        expect(ada.replica.view('issue', 'GRACE-1')).toBeUndefined()
        expect(ada.replica.view('issue', 'SHARED')).toBeUndefined()
      })

      it(`${ledger.cover('scoped/revoked-offline-with-queued-writes')} — apply-time re-authorization refuses DEFINITIVELY and surfaces recovery`, async () => {
        seedTwoSlices()
        authority.policy.grant('ada', 'issue', 'SHARED')
        const ada = await connected(ADA)
        const transport = authority.transportFor(ADA)

        // ADA had visibility and queued offline.
        transport.offline = true
        ada.replica.disconnect()
        const authored = await enqueueWrite(ada, {
          entity: 'issue',
          entityId: 'SHARED',
          value: { note: 'my work' },
        })
        const ownWork = await enqueueWrite(ada, {
          entity: 'issue',
          entityId: 'ADA-1',
          value: { note: 'still mine' },
        })
        await ada.outbox.drain()
        // Still queued: the transport was unreachable, which is D9 invariant 4 and NOT
        // a verdict. If this ever reads `applied`, the offline injector is not wired to
        // the transport the Outbox actually holds and every case below is vacuous.
        expect(ada.outbox.find(authored.mutationId)?.state).toBe('queued')

        // …and then LOST visibility while offline. Nothing on the client knows.
        authority.revoke('ada', 'issue', 'SHARED')

        transport.offline = false
        ada.replica.connect()
        await ada.settle()
        backoffElapsed()
        await ada.outbox.drain()
        await ada.outbox.drain()
        await ada.outbox.drain()

        // The refusal is DEFINITIVE — no endless retry — and it is SURFACED with
        // recovery, never silently dropped.
        const parked = ada.outbox.deadLetters()
        expect(parked.map((p) => p.mutationId)).toEqual([authored.mutationId])
        expect(parked[0]?.reason).toEqual({ code: 'unauthorized' })
        expect(parked[0]?.recovery.edit).toBe(true)
        expect(parked[0]?.recovery.discard).toBe(true)
        // THE USER'S AUTHORED WORK IS RECOVERABLE, verbatim.
        expect(parked[0]?.input).toEqual({
          entity: 'issue',
          entityId: 'SHARED',
          value: { note: 'my work' },
        })
        // NOT AN ENDLESS RETRY, asserted as the count STOPPING rather than as a magic
        // number. Two attempts happened and both were correct: one hit an unreachable
        // transport while offline (D9 invariant 4 — stay queued), and one reached the
        // authority and was definitively refused (D10 — zero automatic retries after a
        // verdict). What matters is that further drains add none.
        const attemptsAtRefusal = authority.transportFor(ADA).attempts(authored.mutationId)
        expect(attemptsAtRefusal).toBe(2)
        backoffElapsed()
        await ada.outbox.drain()
        await ada.outbox.drain()
        expect(authority.transportFor(ADA).attempts(authored.mutationId)).toBe(attemptsAtRefusal)
        // COUNTERFACTUAL, same drain: the write ADA may still make DID apply, so the
        // refusal is about rights and not about the drain being broken.
        expect(authority.receiptFor(ownWork.mutationId)).toBeDefined()
      })

      it(`${ledger.cover('scoped/slow-scoped-replica-converges')} — demote-to-resync still converges when the resync is SCOPED`, async () => {
        seedTwoSlices()
        const ada = await connected(ADA)
        // Truth accumulates for BOTH principals while ADA is behind.
        authority.append({ entity: 'issue', entityId: 'ADA-1', op: 'upsert', payload: { v: 'a' } })
        authority.append({ entity: 'issue', entityId: 'GRACE-1', op: 'upsert', payload: { v: 'g' } })
        authority.append({ entity: 'issue', entityId: 'ADA-2', op: 'upsert', payload: { v: 'b' } })

        ada.replica.receive({
          kind: 'resync-required',
          feedId: authority.feedId,
          epoch: authority.epoch,
        })
        await ada.settle()

        // Converged, AND the resync respected the slice: content plus upper bound.
        expect(ada.replica.cursor?.seq).toBe(authority.head())
        expect(sliceOf(ada)).toEqual(['issue:ADA-1', 'issue:ADA-2'])
        expect(ada.replica.view('issue', 'ADA-1')).toEqual({ v: 'a' })
        expect(ada.replica.view('issue', 'ADA-2')).toEqual({ v: 'b' })
        expect(ada.replica.view('issue', 'GRACE-1')).toBeUndefined()
      })

      it(`${ledger.cover('scoped/crash-with-watermark-in-flight')} — D10 holds with a watermark in flight, and the watermarked range is not a gap`, async () => {
        seedTwoSlices()
        const ada = await connected(ADA)
        const record = await enqueueWrite(ada, {
          entity: 'issue',
          entityId: 'ADA-1',
          value: { closed: true },
        })
        await ada.outbox.drain()

        // GRACE's traffic, invisible to ADA: the range between ADA's cursor and her own
        // confirming change is a genuine suppressed stretch, not an empty literal.
        authority.append({ entity: 'issue', entityId: 'GRACE-1', op: 'upsert', payload: { g: 1 } })
        authority.append({ entity: 'issue', entityId: 'GRACE-1', op: 'upsert', payload: { g: 2 } })
        const frame = nextFrame(authority, ada)
        expect(frame.seq).toBeGreaterThan((frame.changes.at(-1)?.seq ?? 0) - 1)
        // The frame certifies a range WIDER than the changes it carries. That is the
        // watermark-in-flight condition, asserted rather than assumed.
        expect(frame.seq - frame.fromSeq).toBeGreaterThan(frame.changes.length)

        const preCursor = ada.replica.cursor as Cursor
        const preOutbox = await ada.view.outbox.read()
        storage.failNextCommit(new Error('crash with watermark in flight'))
        ada.replica.receive(frame)
        await expect(ada.settle()).rejects.toThrow('crash with watermark')

        const recovered = (await ada.recover()) as Client
        // ONE TRANSACTION RULE HELD: neither region moved.
        expect(recovered.view.cache.readCursor()).toEqual(preCursor)
        expect(await recovered.view.outbox.read()).toEqual(preOutbox)

        // And the recovered replica does NOT treat the watermarked range as a gap: the
        // same frame applies cleanly, advancing the cursor across the suppressed span
        // with no heal.
        recovered.replica.connect()
        await recovered.settle()
        const healsBefore = recovered.replicaEvents.filter((e) => e.type === 'heal').length
        recovered.replica.receive(nextFrame(authority, recovered))
        await recovered.settle()
        expect(recovered.replica.cursor?.seq).toBe(authority.head())
        expect(recovered.replicaEvents.filter((e) => e.type === 'heal').length).toBe(healsBefore)
        expect(recovered.replica.posture).toBe('live')
      })

      it(`${ledger.cover('scoped/rescope-keeps-the-outbox')} — a rescope discards the cache, re-bootstraps, and KEEPS the outbox`, async () => {
        seedTwoSlices()
        const ada = await connected(ADA)
        const transport = authority.transportFor(ADA)
        transport.offline = true

        const queued = await enqueueWrite(ada, {
          entity: 'issue',
          entityId: 'ADA-1',
          value: { closed: true },
        })
        const second = await enqueueWrite(ada, {
          entity: 'issue',
          entityId: 'ADA-2',
          value: { closed: true },
        })
        await ada.outbox.drain()
        const durableBefore = await ada.view.outbox.read()
        expect(durableBefore).toHaveLength(2)

        // A colleague changes a share. Under private-by-default this is ROUTINE, and it
        // resolves to rung 2 — the same rung an epoch bump takes.
        authority.grant('ada', 'issue', 'SHARED')
        ada.replica.receive({
          kind: 'rescope',
          feedId: authority.feedId,
          epoch: authority.epoch,
          reason: 'shares changed',
        })
        await ada.settle()

        // Cache discarded and re-bootstrapped, scoped to the NEW slice.
        const installed = ada.replicaEvents.filter((e) => e.type === 'bootstrap-installed')
        expect(installed.at(-1)).toMatchObject({ cause: 'rescope' })
        expect(sliceOf(ada)).toEqual(['issue:ADA-1', 'issue:ADA-2', 'issue:SHARED'])

        // THE OUTBOX SURVIVED — byte for byte, both entries, nothing retired.
        expect(await ada.view.outbox.read()).toEqual(durableBefore)
        expect(ada.outbox.pending().map((r) => r.mutationId)).toEqual([
          queued.mutationId,
          second.mutationId,
        ])
        expect(ada.outbox.deadLetters()).toEqual([])
        // Not silently retired: no `retired`, `cancelled` or `expired` event escaped.
        expect(
          ada.outboxEvents.filter((e) =>
            ['retired', 'cancelled', 'expired', 'dead-lettered'].includes(e.type),
          ),
        ).toEqual([])
        // And they still drain afterwards, so "kept" means usable and not merely present.
        transport.offline = false
        backoffElapsed()
        await ada.outbox.drain()
        expect(authority.receiptFor(queued.mutationId)).toBeDefined()
        expect(authority.receiptFor(second.mutationId)).toBeDefined()
      })
    })

    // ─────────────────────────────────────────────────────────────────────────
    describe('cross-cutting assertions the whole suite carries under multi-user', () => {
      it(`${ledger.cover('cross/no-existence-oracle')} — an invisible target fails IDENTICALLY to a nonexistent id`, async () => {
        seedTwoSlices()
        const ada = await connected(ADA)

        // INVISIBLE: GRACE-1 exists and ADA may not see it.
        const invisible = await enqueueWrite(ada, {
          entity: 'issue',
          entityId: 'GRACE-1',
          value: { x: 1 },
        })
        // NONEXISTENT: no such id anywhere.
        const nonexistent = await enqueueWrite(ada, {
          entity: 'issue',
          entityId: 'NO-SUCH-ISSUE',
          value: { x: 1 },
        })
        expect(authority.policy.exists('issue', 'GRACE-1')).toBe(true)
        expect(authority.policy.exists('issue', 'NO-SUCH-ISSUE')).toBe(false)

        await ada.outbox.drain()
        await ada.outbox.drain()
        await ada.outbox.drain()

        const forInvisible = ada.outbox.deadLetters().find((d) => d.mutationId === invisible.mutationId)
        const forNonexistent = ada.outbox
          .deadLetters()
          .find((d) => d.mutationId === nonexistent.mutationId)
        expect(forInvisible).toBeDefined()
        expect(forNonexistent).toBeDefined()

        // EQUALITY, not "both failed". Same shape, same reason text, same recovery.
        expect(forInvisible?.reason).toEqual(forNonexistent?.reason)
        expect(forInvisible?.recovery).toEqual(forNonexistent?.recovery)
        expect(forInvisible?.parkedFrom).toBe(forNonexistent?.parkedFrom)
        expect(Object.keys(forInvisible ?? {}).sort()).toEqual(
          Object.keys(forNonexistent ?? {}).sort(),
        )
        // And the collapse is the normalizer's, at ONE site: the authority may report
        // two arms honestly and both land on one durable reason.
        expect(normalizeRefusal({ kind: 'unauthorized' })).toEqual(
          normalizeRefusal({ kind: 'target-not-found' }),
        )
        // POSITIVE CONTROL: a DIFFERENT refusal does NOT collapse into the same reason,
        // so the equality above is a property of these two arms and not of the
        // normalizer flattening everything it is handed.
        expect(normalizeRefusal({ kind: 'conflict' })).not.toEqual(
          normalizeRefusal({ kind: 'unauthorized' }),
        )
      })

      it(`${ledger.cover('cross/watermarks-are-not-gaps')} — a watermark-only stretch never heals and never grows replica state`, async () => {
        seedTwoSlices()
        const ada = await connected(ADA)

        // POSITIVE CONTROL FIRST, on this very replica: a real gap DOES heal. An
        // absence from an instrument that cannot say yes is worth nothing.
        const a = authority.append({ entity: 'issue', entityId: 'ADA-1', op: 'upsert', payload: { g: 1 } })
        const b = authority.append({ entity: 'issue', entityId: 'ADA-1', op: 'upsert', payload: { g: 2 } })
        expect(b).toBe(a + 1)
        ada.replica.receive(authority.frameFor(ADA, b - 1, b))
        await ada.settle()
        expect(ada.replicaEvents.some((e) => e.type === 'heal' && e.rung === 1)).toBe(true)
        const healsAfterControl = ada.replicaEvents.filter((e) => e.type === 'heal').length
        const statsBefore = ada.replica.stats()

        // Now 300 seqs of GRACE's traffic — genuinely suppressed for ADA, not empty
        // frames a fixture handed over.
        for (let i = 0; i < 300; i += 1) {
          authority.append({ entity: 'issue', entityId: 'GRACE-1', op: 'upsert', payload: { i } })
        }
        let from = ada.replica.cursor?.seq as number
        while (from < authority.head()) {
          const to = Math.min(from + 1, authority.head())
          const frame = authority.frameFor(ADA, from, to)
          expect(frame.changes).toEqual([]) // it IS a watermark, asserted not assumed
          ada.replica.receive(frame)
          from = to
        }
        await ada.settle()

        // The cursor crossed the suppressed range…
        expect(ada.replica.cursor?.seq).toBe(authority.head())
        expect(ada.replica.stats().watermarksApplied).toBeGreaterThanOrEqual(300)
        // …with NO heal — distinguishable from "delta missing" because the range was
        // certified.
        expect(ada.replicaEvents.filter((e) => e.type === 'heal').length).toBe(healsAfterControl)
        // …and BOUNDED state (D13.4): nothing accumulated per watermark.
        const statsAfter = ada.replica.stats()
        expect(statsAfter.bufferedFrames).toBe(0)
        expect(statsAfter.bufferedChanges).toBe(0)
        expect(statsAfter.pendingGaps).toBe(0)
        expect(statsAfter.entityCount).toBe(statsBefore.entityCount)
        // A watermark-carrying cursor event says so, so a consumer can tell the two apart.
        const cursorEvents = ada.replicaEvents.filter((e) => e.type === 'cursor')
        expect(cursorEvents.some((e) => e.type === 'cursor' && e.watermarkOnly)).toBe(true)
        expect(cursorEvents.some((e) => e.type === 'cursor' && !e.watermarkOnly)).toBe(true)
      })

      it(`${ledger.cover('cross/attribution-survives-every-hop')} — actor and on-behalf-of survive replay, duplicate delivery, crash recovery and dead-lettering`, async () => {
        seedTwoSlices()
        authority.policy.grant('ada', 'issue', 'SHARED')
        const ada = await connected(ADA)
        const agentAttribution = attributionOf(ADAS_AGENT)
        expect(isDelegated(agentAttribution)).toBe(true)

        const transport = authority.transportFor(ADA)
        transport.offline = true
        // Agent-authored work, and a doomed one so dead-lettering is on the same path.
        const agentWork = await enqueueWrite(ada, {
          entity: 'issue',
          entityId: 'ADA-1',
          value: { by: 'agent' },
          attribution: agentAttribution,
        })
        const doomedAgentWork = await enqueueWrite(ada, {
          entity: 'issue',
          entityId: 'GRACE-1',
          value: { by: 'agent' },
          attribution: agentAttribution,
        })

        // NOT RECONSTRUCTABLE FROM PAYLOAD: nothing identity-shaped rides the wire.
        await ada.outbox.drain() // unreachable — an attempt, so an envelope exists
        const envelope = transport.envelopes.find((e) => e.mutationId === agentWork.mutationId)
        expect(envelope).toBeDefined()
        expect(Object.keys(envelope ?? {})).not.toContain('attribution')
        expect(JSON.stringify(envelope)).not.toContain('ses_ada_agent')

        // 1. REPLAY (retry after transport loss) — attribution intact on the record.
        transport.offline = false
        backoffElapsed()
        await ada.outbox.drain()
        await ada.outbox.drain()
        await ada.outbox.drain()
        expect(authority.receiptFor(agentWork.mutationId)?.attribution).toEqual(
          attributionOf(ADA),
        )
        // The AUTHORITY stamped from ITS transport principal (D7), which for this
        // client is ADA — proof the pair is never taken from the client's payload.

        // 2. DEAD-LETTERING — the parked record keeps the pair the user authored under.
        const parked = ada.outbox.deadLetters().find((d) => d.mutationId === doomedAgentWork.mutationId)
        expect(parked?.attribution).toEqual(agentAttribution)

        // 3. CRASH RECOVERY — rebuild both kernels from the store.
        const recovered = (await ada.recover()) as Client
        expect(
          recovered.outbox.deadLetters().find((d) => d.mutationId === doomedAgentWork.mutationId)
            ?.attribution,
        ).toEqual(agentAttribution)

        // 4. DUPLICATE DELIVERY — deliver the confirming frame twice; the pair the
        // replica renders provisionally is unchanged and never synthesised.
        //
        // Against a row the slice does NOT hold, so the pending command MATERIALISES it:
        // that is the only case in which a provisional attribution is rendered at all
        // (readiness §3.1.3 A4 — an agent's creation is owned by its human, with the
        // agent as actor). Asserting it over an existing row would have asserted
        // `undefined === undefined` and passed no matter what the projection did.
        authority.policy.grant('ada', 'issue', 'ADA-NEW')
        const stillQueued = await enqueueWrite(recovered, {
          entity: 'issue',
          entityId: 'ADA-NEW',
          value: { by: 'agent' },
          attribution: agentAttribution,
        })
        const projected = recovered.replica.overlay('issue', 'ADA-NEW')
        expect(projected.provisionalOwner).toBe('ada')
        expect(projected.provisionalActor).toEqual(agentAttribution.actor)
        // NOT the agent's session id as the owner: the pair is carried, not collapsed.
        expect(projected.provisionalOwner).not.toBe('ses_ada_agent')
        const frame = nextFrame(authority, recovered)
        recovered.replica.receive(frame)
        recovered.replica.receive(frame)
        await recovered.settle()
        expect(recovered.outbox.find(stillQueued.mutationId)?.attribution).toEqual(
          agentAttribution,
        )
      })

      it(`${ledger.cover('cross/two-principals-one-authority')} — two principals with DIFFERENT slices against ONE authority, and an agent bounded by BOTH its scope and its human`, async () => {
        seedTwoSlices()
        const ada = await connected(ADA)
        const grace = await connected(GRACE)

        // Different slices, one authority, one global sequence.
        expect(sliceOf(ada)).toEqual(['issue:ADA-1', 'issue:ADA-2'])
        expect(sliceOf(grace)).toEqual(['issue:GRACE-1', 'issue:SHARED'])
        expect(ada.view).not.toBe(grace.view)

        // A2 — the human is a CEILING, not the default grant. ADA can see ADA-2; her
        // agent was spawned for ADA-1 only, so ADA-2 is the counterfactual that makes
        // the intersection observable. A fixture giving the agent everything its human
        // holds could not fail this.
        expect(authority.policy.canSee(ADA, 'issue', 'ADA-2')).toBe(true)
        expect(authority.policy.canSee(ADAS_AGENT, 'issue', 'ADA-2')).toBe(false)
        expect(authority.policy.canSee(ADAS_AGENT, 'issue', 'ADA-1')).toBe(true)

        // A1 — resolved LIVE over the chain: revoke the HUMAN and the agent loses it,
        // with no reaper involved.
        authority.policy.revoke('ada', 'issue', 'ADA-1')
        expect(authority.policy.canSee(ADAS_AGENT, 'issue', 'ADA-1')).toBe(false)

        // …and the agent's own drain is refused at apply time for the same reason.
        const agentClient = await connected(ADAS_AGENT)
        const work = await enqueueWrite(agentClient, {
          entity: 'issue',
          entityId: 'ADA-1',
          value: { by: 'agent' },
          attribution: attributionOf(ADAS_AGENT),
        })
        await agentClient.outbox.drain()
        await agentClient.outbox.drain()
        await agentClient.outbox.drain()
        expect(agentClient.outbox.deadLetters().map((d) => d.mutationId)).toEqual([
          work.mutationId,
        ])
        expect(authority.receiptFor(work.mutationId)).toBeUndefined()
      })

      it(`${ledger.cover('cross/no-instance-id')} — multi-user is not multi-tenancy: no instance_id in any fixture or wire shape`, async () => {
        seedTwoSlices()
        const ada = await connected(ADA)
        await enqueueWrite(ada, { entity: 'issue', entityId: 'ADA-1', value: { closed: true } })
        const transport = authority.transportFor(ADA)
        await ada.outbox.drain()
        await pumpUntilCaughtUp(authority, ada)

        const surfaces = JSON.stringify({
          frame: authority.frameFor(ADA, 0),
          cursor: ada.replica.cursor,
          entities: ada.replica.entities(),
          durableOutbox: await ada.view.outbox.read(),
          envelopes: transport.envelopes,
          receipts: authority.receipts,
        })
        // ADR 1 D5 stands: an instance is a DEPLOYMENT partition, and multi-user lives
        // inside one. The detector covers every spelling the concept could take,
        // because a check for one form is a check for nothing.
        for (const spelling of ['instance_id', 'instanceId', 'tenantId', 'tenant_id']) {
          expect(surfaces).not.toContain(spelling)
        }
        // POSITIVE CONTROL: the detector can say yes.
        expect(JSON.stringify({ instance_id: 'x' })).toContain('instance_id')
      })
    })

    // ─────────────────────────────────────────────────────────────────────────
    describe('the D10 seam, through the kernel path', () => {
      /**
       * The DEFECT this suite found lives in `../unit-of-work-seam.test.ts`, pinned by
       * name against both real kernels. What belongs here is the property every case
       * above silently depends on: that the kernel's own commit path is the transacted
       * one. If that ever stops being true, every crash assertion above degrades into a
       * check that two sequential writes both happened, and would still be green.
       */
      it('a frame confirming a queued command commits BOTH regions in ONE transaction, with no second write', async () => {
        seedTwoSlices()
        const ada = await connected(ADA)
        const record = await enqueueWrite(ada, {
          entity: 'issue',
          entityId: 'ADA-1',
          value: { closed: true },
        })
        await ada.outbox.drain()

        const uowBefore = storage.unitOfWorkTransactions()
        const outboxWritesBefore = storage.outboxWrites()
        ada.replica.receive(nextFrame(authority, ada))
        await ada.settle()

        // ONE transaction for the whole logical commit (D10 clause 5).
        expect(storage.unitOfWorkTransactions()).toBe(uowBefore + 1)
        // The queue region published exactly once, INSIDE it. Two would mean the
        // retirement took a transaction of its own, which is the non-compliance.
        expect(storage.outboxWrites()).toBe(outboxWritesBefore + 1)
        expect(await ada.view.outbox.read()).toEqual([])
        expect(ada.view.cache.read('issue', 'ADA-1')?.value).toEqual({ closed: true })
        expect(ada.outbox.find(record.mutationId)).toBeUndefined()
      })

      it('a frame with NOTHING to retire is a single-region autocommit, and opens no transaction', async () => {
        seedTwoSlices()
        const ada = await connected(ADA)
        const uowBefore = storage.unitOfWorkTransactions()

        // No provenance ⇒ no retirement ⇒ one region. D10 clause 2 permits an
        // autocommit, and a span to enrol one participant would add a unit of work
        // whose commit and abort are already the store write's own.
        const seq = authority.append({
          entity: 'issue',
          entityId: 'ADA-1',
          op: 'upsert',
          payload: { n: 7 },
        })
        ada.replica.receive(authority.frameFor(ADA, seq - 1, seq))
        await ada.settle()

        expect(ada.replica.view('issue', 'ADA-1')).toEqual({ n: 7 })
        expect(storage.unitOfWorkTransactions()).toBe(uowBefore)
        // COUNTERFACTUAL, same replica: with a retirement to make, it DOES open one —
        // so the arm above is chosen by the absence of a second participant and not by
        // this replica never transacting at all.
        const record = await enqueueWrite(ada, {
          entity: 'issue',
          entityId: 'ADA-2',
          value: { closed: true },
        })
        await ada.outbox.drain()
        ada.replica.receive(nextFrame(authority, ada))
        await ada.settle()
        expect(storage.unitOfWorkTransactions()).toBe(uowBefore + 1)
        expect(ada.outbox.find(record.mutationId)).toBeUndefined()
      })
    })

    afterAll(() => {
      // The totality test. A gate with no test fails the suite here, which is the
      // difference between "registered as a gate condition" and a sentence in a brief.
      assertGatesCovered(ledger)
    })
  })
}

/** Re-exported so a hop's own test file needs one import. */
export { FIRST_EPOCH, DAY_MS }
