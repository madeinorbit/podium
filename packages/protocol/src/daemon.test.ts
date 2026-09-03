import { describe, expect, it } from 'vitest'
import {
  ControlMessage,
  DaemonMessage,
  encodeDaemonMessage,
  parseControlMessage,
  parseDaemonMessage,
  ShippingJobRequestMessage,
  shippingJobRequestFingerprint,
} from './daemon'
import * as commonProtocol from './index'

describe('daemon-only protocol entry', () => {
  it('keeps daemon and shipping runtime exports out of the common browser barrel', () => {
    expect(commonProtocol).not.toHaveProperty('ControlMessage')
    expect(commonProtocol).not.toHaveProperty('DaemonMessage')
    expect(commonProtocol).not.toHaveProperty('parseControlMessage')
    expect(commonProtocol).not.toHaveProperty('parseDaemonMessage')
    expect(commonProtocol).not.toHaveProperty('ShippingJobRequestMessage')
    expect(commonProtocol).not.toHaveProperty('ShippingJobResult')
    expect(commonProtocol).not.toHaveProperty('shippingJobRequestFingerprint')
  })

  it('owns daemon/control parsing and shipping request fingerprinting', () => {
    const request = ShippingJobRequestMessage.parse({
      type: 'shippingJobRequest',
      requestId: 'request-1',
      action: 'start',
      jobId: 'job-1',
      requestDigest: 'a'.repeat(64),
      orderId: 'order-1',
      attemptId: 'attempt-1',
      generation: 1,
      operation: 'preflight',
      shippingProtocolVersion: 2,
      repoPath: '/repo',
      repoId: 'repo-1',
      sourceBranch: 'feature',
      targetBranch: 'main',
      approvedBaseSha: 'base',
      approvedHeadSha: 'head',
      expectedTargetSha: 'target',
      destination: 'local:main',
      policyId: 'policy-1',
      validationProfile: {
        id: 'default',
        argv: ['bun', 'run', 'test'],
        cwd: 'integration-root',
        timeoutMs: 60_000,
        resourceLocks: [],
      },
    })
    // The fingerprint covers the JOB FACTS, not the envelope that carried them,
    // so the four transport keys come off before the parse. Handing the whole
    // request to the omitted schema is what made this red: omit() leaves the
    // object STRICT, so a key it no longer knows about is an error rather than
    // surplus the parse quietly drops.
    const {
      type: _type,
      requestId: _requestId,
      action: _action,
      requestDigest: _requestDigest,
      ...jobFacts
    } = request
    const facts = ShippingJobRequestMessage.omit({
      type: true,
      requestId: true,
      action: true,
      requestDigest: true,
    }).parse(jobFacts)

    expect(parseControlMessage(encodeDaemonMessage(request))).toEqual(request)
    expect(shippingJobRequestFingerprint(facts)).toContain('"jobId":"job-1"')

    const result = {
      type: 'shippingJobResult' as const,
      requestId: 'request-1',
      jobId: 'job-1',
      requestDigest: 'a'.repeat(64),
      orderId: 'order-1',
      attemptId: 'attempt-1',
      machineId: 'machine-1',
      generation: 1,
      operation: 'preflight' as const,
      state: 'succeeded' as const,
      classification: 'observed' as const,
      summary: 'observed',
      logs: [],
      artifactRefs: [],
      heartbeatedAt: '2026-08-13T00:00:00.000Z',
    }
    const parsedResult = DaemonMessage.parse(result)
    expect(parsedResult).toEqual(result)
    expect(parseDaemonMessage(encodeDaemonMessage(parsedResult))).toEqual(result)
    expect(ControlMessage.parse(request)).toEqual(request)
  })
})

/**
 * THE BOUNDARY THE RUNTIME CONTRACT IS SPLIT ON (POD-2470).
 *
 * The suite above pins the OLD daemon-plane families by name. That form is why
 * the runtime contract leaked in the first place: W1 added a whole new family
 * and no named assertion knew to grow. So this one is DERIVED — the daemon
 * plane is whatever `./messages/runtime` declares that
 * `./messages/runtime-interactions` does not, computed at run time — and a new
 * export added to the daemon half is covered the moment it exists, with nobody
 * having to remember this file.
 *
 * WHY IT MATTERS BEYOND TIDINESS: eager Zod schemas are constructed at module
 * scope, so a single value import from the common barrel pulls the entire
 * module into every browser bundle and no bundler can shake it out. Before this
 * split, `./messages/sync.ts` importing one interaction schema dragged ~19 kB of
 * daemon-plane request/result envelopes into the browser. The only thing that
 * caught it was the size ratchet — a byte ceiling that names no cause — and
 * POD-2560's paydown will create exactly the headroom for it to fit back in
 * silently.
 *
 * THIS SUITE IS NOT THE GUARD, AND MUST NOT BE READ AS ONE. It compares export
 * NAMES, and a reviewer defeated it in one line:
 *
 *     export { RuntimeEvent as BrowserRuntimeEvent } from './runtime'
 *
 * That rebuilds the exact dependency the split removed — the whole module lands
 * back in every browser bundle — while exposing no name the derivation below is
 * looking for, and this file stayed 5/5 green. A namespace check cannot see a
 * rename, because the thing that costs bytes is the import EDGE and an edge
 * does not care what the symbol is called on the way through.
 *
 * THE REAL GUARD IS `manifest-plane-leak` in scripts/check-boundaries.ts: it
 * walks the barrel's TRANSITIVE closure and refuses any edge into a module
 * `daemon.ts` owns, whatever the symbols are renamed to. Transitivity is the
 * other half — the original leak was `index -> sync -> runtime`, two hops, so a
 * scan of the barrel alone would have been green throughout the incident.
 *
 * What is kept here is the narrower statement the closure rule cannot make: the
 * daemon plane is not REDECLARED on the browser barrel by copy-paste, which
 * creates no edge to walk. Useful, and not a boundary guard.
 */
describe('the runtime contract browser boundary', () => {
  it('keeps every daemon-plane runtime export out of the common barrel', async () => {
    const daemonHalf = await import('./messages/runtime')
    const browserHalf = await import('./messages/runtime-interactions')
    // Derived, never listed. See the note above.
    const daemonOnly = Object.keys(daemonHalf).filter((name) => !(name in browserHalf))
    // Guard the guard: if the split were undone, this set would empty and the
    // loop below would pass vacuously.
    expect(daemonOnly.length).toBeGreaterThan(20)
    for (const name of daemonOnly) {
      expect(
        commonProtocol,
        `${name} is daemon-plane and must reach consumers through @podium/protocol/daemon, ` +
          'not the common barrel every browser bundle imports',
      ).not.toHaveProperty(name)
    }
  })

  it('still serves the interaction half the browser genuinely parses', async () => {
    const browserHalf = await import('./messages/runtime-interactions')
    // `./sync.ts` parses this as the `pendingInteraction` metadata feed arm, so
    // it is not merely allowed in the browser — it is required there.
    expect(commonProtocol).toHaveProperty('PendingInteractionWire')
    for (const name of Object.keys(browserHalf)) {
      expect(
        commonProtocol,
        `${name} is browser-facing and must stay on the common barrel`,
      ).toHaveProperty(name)
    }
  })

  /**
   * THE ASYMMETRY IS DELIBERATE, and this test records the decision rather than
   * leaving the next reader to wonder (review question, POD-2470).
   *
   * `./messages/runtime.ts` re-exports the interaction half, so
   * `@podium/protocol/daemon` carries BOTH halves and is not the strict
   * daemon-only surface its name suggests. That is correct: the daemon PRODUCES
   * interactions, so it needs the ask vocabulary, and one import site for the
   * whole contract is what keeps its consumers from drifting. The rule being
   * enforced is one-directional — the browser must not receive the daemon
   * plane; the daemon may hold everything.
   */
  it('lets the daemon entry point carry both halves, on purpose', async () => {
    const daemonEntry = await import('./daemon')
    expect(daemonEntry).toHaveProperty('PendingInteractionWire')
    expect(daemonEntry).toHaveProperty('RuntimeEvent')
  })
})
