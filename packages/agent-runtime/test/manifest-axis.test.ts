/**
 * THE MANIFEST AXIS, PINNED AGAINST THE CONTRACT (POD-1761 W1).
 *
 * `AgentManifest.runtime` names a driver; `packages/agent-runtime` owns what a
 * driver IS. The two lists cannot import each other — the manifest package sits
 * BELOW this one — so `RuntimeDriverId` is restated there and the agreement is a
 * promise rather than a shared constant.
 *
 * This file is what makes that promise checkable. A manifest naming a driver
 * this package has never heard of would otherwise typecheck perfectly and fail
 * at spawn time on somebody's machine, which is the worst possible place to
 * discover a typo in a taxonomy.
 */

import { AGENT_MANIFESTS, type RuntimeDriverId } from '@podium/harness'
import { describe, expect, it } from 'vitest'
import { DRIVER_IDS, type DriverId } from '../src/contract.js'

// Compile-time half: the two unions are the SAME SET, not merely overlapping.
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
const exact = <A, B>(_proof: Exact<A, B>): void => {}
exact<RuntimeDriverId, DriverId>(true)

const MANIFESTS = Object.entries(AGENT_MANIFESTS)

describe('the AgentManifest runtime axis', () => {
  it.each(MANIFESTS)('%s declares a terminal driver', (_kind, manifest) => {
    // §2's decision, enforced: the terminal family is a PERMANENT tier and every
    // harness has one. It is the only subscription-preserving way to run Claude
    // Code and the only way to run a harness that never grows a protocol, so a
    // manifest without one describes a session Podium cannot fall back to.
    expect(manifest.runtime.terminal.driverId).toBeTruthy()
    expect(DRIVER_IDS).toContain(manifest.runtime.terminal.driverId)
  })

  it.each(MANIFESTS)('%s names only drivers this build knows', (_kind, manifest) => {
    const named = [
      manifest.runtime.terminal.driverId,
      ...(manifest.runtime.server.supported ? [manifest.runtime.server.value.driverId] : []),
      ...(manifest.runtime.embedded.supported ? [manifest.runtime.embedded.value.driverId] : []),
    ]
    for (const id of named) expect(DRIVER_IDS).toContain(id)
  })

  it.each(MANIFESTS)('%s declares a send proof its terminal driver can produce', (_k, manifest) => {
    // A terminal driver with no declared proof could only ever return
    // `unverified`, which is a weakness the family is permitted but not one it
    // should have by default.
    expect(manifest.runtime.terminal.sendProof.length).toBeGreaterThan(0)
  })

  it.each(MANIFESTS)('%s selects an AVAILABLE driver, never a wish', (_kind, manifest) => {
    const terminal = manifest.runtime.terminal.driverId
    const chosen = manifest.runtime.select({
      auth: 'subscription',
      platform: 'linux',
      available: [terminal],
      role: 'executor',
    })
    // A policy that names a driver the machine cannot run is a bug in the
    // policy, not a runtime fallback.
    expect(chosen).toBe(terminal)
  })

  it('honours an available operator preference over the policy order', () => {
    const codex = AGENT_MANIFESTS.codex
    const chosen = codex.runtime.select({
      auth: 'api-key',
      platform: 'linux',
      available: ['codex-app-server', 'generic-pty'],
      preference: 'generic-pty',
    })
    // The operator asked for a visible terminal. Overriding that with the
    // "better" driver is how a settings toggle stops meaning anything.
    expect(chosen).toBe('generic-pty')
  })

  it('ignores a preference the machine cannot run', () => {
    const codex = AGENT_MANIFESTS.codex
    const chosen = codex.runtime.select({
      auth: 'api-key',
      platform: 'linux',
      available: ['generic-pty'],
      preference: 'codex-app-server',
    })
    // Honouring an unavailable preference would turn a stale settings value
    // into a session that cannot start.
    expect(chosen).toBe('generic-pty')
  })
})

describe('per-harness selection (spec §2 matrix)', () => {
  it('keeps Claude-on-subscription on the terminal driver', () => {
    // The compliant path, and the reason the terminal family is permanent.
    expect(
      AGENT_MANIFESTS['claude-code'].runtime.select({
        auth: 'subscription',
        platform: 'linux',
        available: ['claude-pty', 'claude-sdk'],
      }),
    ).toBe('claude-pty')
  })

  it('moves Claude-on-api-key to the embedded driver', () => {
    expect(
      AGENT_MANIFESTS['claude-code'].runtime.select({
        auth: 'api-key',
        platform: 'linux',
        available: ['claude-pty', 'claude-sdk'],
      }),
    ).toBe('claude-sdk')
  })

  it('prefers the server driver for Codex under EVERY auth mode', () => {
    // The one harness where that is true: ChatGPT subscription auth works
    // headless, so no auth mode forces the terminal.
    for (const auth of ['subscription', 'api-key'] as const) {
      expect(
        AGENT_MANIFESTS.codex.runtime.select({
          auth,
          platform: 'linux',
          available: ['codex-app-server', 'generic-pty'],
        }),
      ).toBe('codex-app-server')
    }
  })

  it('prefers the server driver for opencode', () => {
    expect(
      AGENT_MANIFESTS.opencode.runtime.select({
        auth: 'api-key',
        platform: 'linux',
        available: ['opencode-server', 'generic-pty'],
      }),
    ).toBe('opencode-server')
  })

  it.each(['grok', 'cursor'] as const)('leaves %s terminal-only', (kind) => {
    const runtime = AGENT_MANIFESTS[kind].runtime
    expect(runtime.server.supported).toBe(false)
    expect(runtime.embedded.supported).toBe(false)
    expect(runtime.terminal.driverId).toBe('generic-pty')
  })
})

describe('server specs carry their security posture', () => {
  it('requires a per-session secret for opencode loopback TCP', () => {
    const server = AGENT_MANIFESTS.opencode.runtime.server
    expect(server.supported).toBe(true)
    if (!server.supported) return
    expect(server.value.transport).toBe('loopback-tcp')
    // An unauthenticated per-session HTTP server holding a credentialed agent
    // is reachable by every local process and user — not acceptable even on
    // loopback (spec §6). This is the declaration W5's driver must honour and
    // the conformance corpus tests.
    expect(server.value.requiresPerSessionSecret).toBe(true)
  })

  it('needs no secret for Codex, because a 0600 unix socket already authenticates', () => {
    const server = AGENT_MANIFESTS.codex.runtime.server
    expect(server.supported).toBe(true)
    if (!server.supported) return
    expect(server.value.transport).toBe('unix-socket')
    expect(server.value.requiresPerSessionSecret).toBe(false)
  })

  it('pins NO version range yet, and says why', () => {
    for (const kind of ['codex', 'opencode'] as const) {
      const server = AGENT_MANIFESTS[kind].runtime.server
      if (!server.supported) continue
      // A range is a claim about which wire shapes this build was tested
      // against. W1 has no client to test with, and an invented range would let
      // a driver start against a protocol nobody verified while LOOKING
      // checked. W5/W6 pin it against recorded fixtures.
      expect(server.value.versionRange.supported).toBe(false)
      if (server.value.versionRange.supported) continue
      expect(server.value.versionRange.reason).toMatch(/pins the range/)
    }
  })
})
