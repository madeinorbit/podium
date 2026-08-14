/**
 * THE MANIFEST AXIS, EXERCISED (POD-1761 W1).
 *
 * The taxonomy has ONE definition site — `@podium/harness`, beside the manifest
 * axis that declares it — so there is no second list here to reconcile. What
 * still needs proving is that the five manifests USE it correctly: that every
 * harness declares a terminal driver, that nobody names a driver this build has
 * never heard of, and that `select()` is behavior-neutral in W1 rather than
 * quietly promising a driver that does not exist yet.
 *
 * A manifest naming a phantom driver would typecheck perfectly and fail at spawn
 * time on somebody's machine, which is the worst possible place to discover a
 * typo in a taxonomy.
 */

import { AGENT_MANIFESTS, DRIVER_IDS } from '@podium/harness'
import { describe, expect, it } from 'vitest'
import { SUPPORTED_OPENCODE } from '../drivers/opencode/version.js'

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
    const chosen = AGENT_MANIFESTS.codex.runtime.select({
      auth: 'api-key',
      platform: 'linux',
      available: ['codex-app-server', 'generic-pty'],
      preference: 'codex-app-server',
    })
    // The operator asked for a specific driver and the machine can run it.
    // Overriding that with the policy's own order is how a settings toggle stops
    // meaning anything.
    expect(chosen).toBe('codex-app-server')
  })

  it('is TOTAL: an empty availability list still answers, with the terminal driver', () => {
    // The contract's stated shape, and the case no test covered before: a
    // machine that has not been probed, or genuinely cannot run this harness,
    // must still get an answer the caller can put in a diagnostic. Returning
    // nothing would push the same fallback decision onto every call site.
    for (const [kind, terminal] of [
      ['codex', 'generic-pty'],
      ['claude-code', 'claude-pty'],
      ['grok', 'generic-pty'],
    ] as const) {
      expect(
        AGENT_MANIFESTS[kind].runtime.select({
          auth: 'unknown',
          platform: 'linux',
          available: [],
        }),
      ).toBe(terminal)
    }
  })

  it('ignores a preference the machine cannot run', () => {
    const chosen = AGENT_MANIFESTS.codex.runtime.select({
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

  it('declares the embedded driver Claude-on-api-key will select', () => {
    // Declared now, selected later: W1 records WHICH driver an API-key principal
    // belongs on without routing anyone there.
    const embedded = AGENT_MANIFESTS['claude-code'].runtime.embedded
    expect(embedded.supported).toBe(true)
    if (!embedded.supported) return
    expect(embedded.value.driverId).toBe('claude-sdk')
    // Subscription OAuth is absent on purpose — that is what keeps subscription
    // sessions on the terminal driver.
    expect(embedded.value.auth).not.toContain('subscription')
  })

  it('is BEHAVIOR-NEUTRAL in W1: terminal even when a server driver is available', () => {
    // W1 ships declarations, not drivers. `select()` must not name a driver that
    // does not exist yet, however loudly the manifest declares its server spec —
    // a policy that returns `opencode-server` before W5 builds one turns this
    // work item into a behavior change, which is exactly what it must not be.
    for (const [kind, terminal] of [
      ['codex', 'generic-pty'],
      ['opencode', 'generic-pty'],
      ['claude-code', 'claude-pty'],
    ] as const) {
      expect(
        AGENT_MANIFESTS[kind].runtime.select({
          auth: 'api-key',
          platform: 'linux',
          available: [...DRIVER_IDS],
        }),
      ).toBe(terminal)
    }
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

  it('pins a version range ONLY where a driver has recorded fixtures behind it', () => {
    /**
     * THE RULE, UNCHANGED SINCE W1; WHAT MOVED IS WHO SATISFIES IT (POD-2023).
     *
     * A range is a claim about which wire shapes this build was TESTED against,
     * and an invented one is worse than none — it lets a driver start against a
     * protocol nobody verified while looking checked. W1 pinned neither because
     * it had no client to test with, and named W5/W6 as the items that would.
     *
     * W5 landed opencode's, so its range is now `supported` and the evidence is
     * `packages/agent-runtime/src/drivers/opencode/__fixtures__` — frames
     * recorded from a live 1.18.16, replayed by `protocol.test.ts`, and enforced
     * at runtime by `gateOpencodeVersion`. Codex has no driver yet, so it must
     * still decline, and this test is what keeps a future item from pinning a
     * range ahead of the fixtures that justify it.
     */
    const codex = AGENT_MANIFESTS.codex.runtime.server
    expect(codex.supported).toBe(true)
    if (codex.supported) {
      expect(codex.value.versionRange.supported).toBe(false)
      // Assert a reason EXISTS, not what it says. Pinning the prose would break
      // this test when W6 rewords it while pinning the range, which is the
      // opposite of what it should react to.
      if (!codex.value.versionRange.supported) {
        expect(codex.value.versionRange.reason.length).toBeGreaterThan(0)
      }
    }

    const opencode = AGENT_MANIFESTS.opencode.runtime.server
    expect(opencode.supported).toBe(true)
    if (opencode.supported) {
      expect(opencode.value.versionRange.supported).toBe(true)
      if (opencode.value.versionRange.supported) {
        // The range the driver's own gate enforces. Both sides moving together
        // is the point: a manifest that advertised a wider range than
        // `SUPPORTED_OPENCODE` admits would promise a version the driver refuses
        // to drive.
        expect(opencode.value.versionRange.value).toBe(
          `>=${SUPPORTED_OPENCODE.major}.${SUPPORTED_OPENCODE.minMinor} <${SUPPORTED_OPENCODE.major}.${SUPPORTED_OPENCODE.maxMinor + 1}`,
        )
      }
    }
  })
})
