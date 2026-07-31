/**
 * THE HARNESS IS LIVE — can this instrument say NO? [POD-736]
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS AT ALL
 * ---------------------------------------------------------------------------
 *
 * The dominant defect of this rewrite fan-out is instruments that cannot refuse,
 * and a latency harness has an unusually comfortable version of it: after the
 * POD-308/POD-1203 cutover, the ORIGINAL harness still ran, still returned a
 * populated `perf.snapshot`, and still produced plausible p50/p90 numbers —
 * because `sessionsBroadcast.*` still fires for the issue-projection rebuild. It
 * simply no longer observed the path that serves clients. Every symptom of a
 * working harness, measuring a shrinking remainder.
 *
 * `registry.test.ts` covers the ring's arithmetic against a hand-built registry.
 * That is exactly the shape that cannot catch this: a registry you `record()`
 * into yourself will always have samples in it. So this file drives the REAL
 * composition — `SessionRegistry`, a real client connection, a real write — and
 * asserts against the PROCESS-LEVEL singleton every production site writes to.
 *
 * ---------------------------------------------------------------------------
 * HOW EACH ASSERTION CAN FAIL, WHICH IS THE PART THAT MATTERS
 * ---------------------------------------------------------------------------
 *
 * Every `it` below names the mutation that reddens it. They were run: see
 * `docs/agents/pod-736-harness-evidence.md` for the applied-mutant transcript.
 * An assertion here with no such sentence is a claim nobody has tested.
 *
 * THE ORDER IS DELIBERATE: each test proves the instrument can say YES about the
 * live path before any test asserts an absence, because "no cross-principal
 * leak" is satisfied perfectly by a harness that recorded nothing at all.
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { PHASE_MIGRATION } from '@podium/protocol'
import { DEVICE_GRADE_PRINCIPAL } from '@podium/sync'
import { SessionRegistry } from '../../relay'
import { perfPrincipal } from './principal'
import { perf } from './registry'

/** The digest the live serving path attributes to today. DERIVED, not typed out:
 *  a literal here would keep passing after `feedPrincipalOf` stopped returning
 *  this principal, which is the drift the dimension exists to catch. */
const LIVE = perfPrincipal(DEVICE_GRADE_PRINCIPAL)

function drive(): { registry: SessionRegistry; inbox: unknown[] } {
  const registry = new SessionRegistry()
  const inbox: unknown[] = []
  const id = registry.clientGateway.attachClient((msg) => inbox.push(msg))
  registry.clientGateway.routeClientFrame(id, {
    type: 'hello',
    clientId: '',
    viewport: { cols: 80, rows: 24, dpr: 1 },
    caps: ['metadataDelta'],
  })
  // A real write through the real funnel, then the deterministic flush seam.
  registry.issues.create({ repoPath: '/r', title: 'switch-latency probe', startNow: false })
  registry.modules.funnel.flushDeltas()
  return { registry, inbox }
}

describe('switch-latency harness observes the delta-feed path [POD-736]', () => {
  let registry: SessionRegistry
  let inbox: unknown[]

  beforeEach(() => {
    // The singleton is process-level, so a previous file's samples would satisfy
    // every "count > 0" below. Resetting first is what makes them about THIS run.
    perf.reset()
    const driven = drive()
    registry = driven.registry
    inbox = driven.inbox
    return () => registry.dispose()
  })

  it('records a bootstrap phase when a connection is served its world', () => {
    // Control: the connection really was served something. Without this, an
    // attach that silently did nothing would satisfy the phase assertion only by
    // way of a bug elsewhere, and the failure would read as a perf regression.
    expect(inbox.length).toBeGreaterThan(0)
    // FAILS IF: `serveWorld` stops calling `perf.record`, or the attach path
    // stops going through `FeedServing` at all — which is the cutover-drift this
    // whole issue exists to catch.
    expect(perf.snapshot().phases['feedBootstrap.total']?.count).toBeGreaterThan(0)
    expect(perf.snapshot().phases['feedBootstrap.read']?.count).toBeGreaterThan(0)
  })

  it('records the publish phases when a write reaches the feed', () => {
    const phases = perf.snapshot().phases
    // FAILS IF: the funnel's flush stops publishing, or `FeedServing.publish`
    // stops being the tail. Both are exactly what a future serving-path change
    // would do silently.
    expect(phases['feedPublish.total']?.count).toBeGreaterThan(0)
    expect(phases['feedPublish.scope']?.count).toBeGreaterThan(0)
    expect(phases['feedPublish.frame']?.count).toBeGreaterThan(0)
    expect(phases['feedPublish.fanout']?.count).toBeGreaterThan(0)
  })

  it('every phase the migration map promises as a successor is actually emitted', () => {
    const phases = perf.snapshot().phases
    const successors = [...new Set(Object.values(PHASE_MIGRATION))]
    // The map is not empty — otherwise the loop below asserts nothing at all,
    // which is how a "every X satisfies Y" test passes over an empty X forever.
    expect(successors.length).toBeGreaterThan(0)
    for (const name of successors) {
      // FAILS IF: the map names a phase nobody records — a baseline-migration
      // story that points at nothing, which is worse than no map because a
      // reader trusts it.
      expect(phases[name], `${name} is promised by PHASE_MIGRATION but never recorded`).toBeDefined()
    }
  })

  it('attributes those samples to the real feed principal, with its slice size', () => {
    const snap = perf.snapshot()
    const slice = snap.byPrincipal[LIVE.digest]
    // FAILS IF: a site passes DEPLOYMENT where it has a real principal, or
    // `feedPrincipalOf` stops matching what the funnel publishes for — the two
    // must be the same value or a connection is never published to at all.
    expect(slice, 'the live feed principal has no partition').toBeDefined()
    // EVERY feed phase, not just one. Asserting `feedPublish.total` alone let a
    // measured mutant survive: `total` is recorded in `modules/funnel.ts` and
    // `frame`/`fanout` in `gateway/feed-serving.ts`, so swapping only the
    // serving edge's attribution to DEPLOYMENT passed all six tests while half
    // the switch cost silently left the principal's partition. A partition
    // missing half its phases still yields a plausible p50 — which is the
    // failure this whole file exists to make impossible.
    for (const name of Object.keys(snap.phases).filter((n) => n.startsWith('feedPublish.'))) {
      expect(
        slice?.phases[name]?.count,
        `${name} is recorded deployment-wide but missing from the live principal's partition`,
      ).toBeGreaterThan(0)
    }
    // …and the aggregate really had those phases, so the loop above is not
    // iterating over an empty list.
    expect(Object.keys(snap.phases).filter((n) => n.startsWith('feedPublish.')).length).toBe(4)
    // The slice size was MEASURED, not defaulted. `samples: 0` would mean the
    // bootstrap never reported one, and `last` would then be a 0 that reads as
    // an empty world — the exact ambiguity `PerfSliceSize.samples` exists for.
    expect(slice?.sliceSize.samples).toBeGreaterThan(0)
  })

  it('a same-principal comparison is available WITHOUT reading the deployment-wide aggregate', () => {
    // This is the acceptance criterion's mechanism, asserted as a capability
    // rather than described: an A/B that controls for slice size needs both
    // numbers from ONE place, or the person doing the comparison has to join two
    // tables by hand and will eventually join the wrong rows.
    const scoped = perf.snapshotFor(LIVE)
    expect(scoped?.phases['feedPublish.total']?.p50Ms).toBeTypeOf('number')
    expect(scoped?.sliceSize.last).toBeTypeOf('number')
    expect(scoped?.principal.digest).toBe(LIVE.digest)
  })

  it('the partition key is a digest and never the principal id itself', () => {
    // YES arm first: there IS a partition to inspect, so the absence below is an
    // absence rather than an empty table.
    expect(perf.snapshot().byPrincipal[LIVE.digest]).toBeDefined()
    // The device-grade principal's id is `user:device:shared-instance-password`.
    // The digest must not contain it, nor the `user:` / `agent:` prefix that
    // `principalIdOf` uses — for an AGENT principal that prefix is followed by a
    // session id, and that is the leak this guards.
    expect(LIVE.digest).not.toContain('device:')
    expect(LIVE.digest).not.toContain('user:')
    expect(LIVE.digest).toMatch(/^[0-9a-f]{16}$/)
    // …and it is a function OF the id, not a constant: a different principal
    // digests differently. A digest that ignored its input would pass every
    // assertion above and merge every principal into one partition.
    const other = perfPrincipal({
      kind: 'agent',
      sessionId: 'sess-someone-else',
      onBehalfOf: 'u1',
      scope: { kind: 'all' },
    })
    expect(other.digest).not.toBe(LIVE.digest)
    expect(other.digest).not.toContain('sess-someone-else')
    expect(other.kind).toBe('agent')
  })
})
