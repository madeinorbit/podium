/**
 * THE MANIFEST AXIS, EXERCISED (POD-1761 W1).
 *
 * The taxonomy has ONE definition site — `@podium/harness`, beside the manifest
 * axis that declares it — so there is no second list here to reconcile. What
 * still needs proving is that the five manifests USE it correctly: that every
 * harness declares a terminal driver, that nobody names a driver this build has
 * never heard of, and that `select()` ranks each shipped server driver ahead of
 * its permanent terminal fallback only when the machine admits it.
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
      preference: 'generic-pty',
    })
    // An explicit terminal request remains the opt-out from the headless
    // default; replacing it with the policy order would make the override lie.
    expect(chosen).toBe('generic-pty')
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

  it.each([
    ['opencode', 'opencode-server'],
    ['codex', 'codex-app-server'],
    ['grok', 'grok-acp'],
  ] as const)('%s defaults to its admitted server and falls back to PTY', (kind, server) => {
    const runtime = AGENT_MANIFESTS[kind].runtime
    const terminal = runtime.terminal.driverId
    expect(
      runtime.select({
        auth: 'unknown',
        platform: 'linux',
        available: [server, terminal],
      }),
    ).toBe(server)
    expect(
      runtime.select({
        auth: 'unknown',
        platform: 'linux',
        available: [terminal],
      }),
    ).toBe(terminal)
    expect(
      runtime.select({
        auth: 'unknown',
        platform: 'linux',
        available: [server, terminal],
        preference: terminal,
      }),
    ).toBe(terminal)
  })

  it('leaves cursor terminal-only', () => {
    const kind = 'cursor' as const
    const runtime = AGENT_MANIFESTS[kind].runtime
    expect(runtime.server.supported).toBe(false)
    expect(runtime.embedded.supported).toBe(false)
    expect(runtime.terminal.driverId).toBe('generic-pty')
  })

  it('prefers Grok ACP when the admitted driver is available', () => {
    const runtime = AGENT_MANIFESTS.grok.runtime
    expect(runtime.server.supported).toBe(true)
    expect(runtime.embedded.supported).toBe(false)
    expect(runtime.terminal.driverId).toBe('generic-pty')
    expect(
      runtime.select({
        auth: 'subscription',
        platform: 'linux',
        available: ['grok-acp', 'generic-pty'],
      }),
    ).toBe('grok-acp')
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

  it('needs no secret for Codex, because an inherited pipe has no other end to reach', () => {
    /**
     * THE POSTURE IS THE SAME; THE MECHANISM IS NOT WHAT W1 EXPECTED (POD-2024).
     *
     * W1 declared `unix-socket` and justified the absent secret with "a 0600
     * socket already authenticates". W6 measured the pinned binary and found
     * that socket is not the client surface at all: `codex app-server --listen
     * unix://PATH` does create one at 0600, and it CLOSES THE CONNECTION on a
     * JSON-RPC `initialize` — including through codex's own `app-server proxy
     * --sock` bridge. Codex's own log calls it the app-server CONTROL socket,
     * and `app-server daemon` puts one at a fixed, machine-global path for
     * `daemon version`/`stop` to speak.
     *
     * The client channel is the child's inherited stdio, which reaches the same
     * conclusion by a stronger route: there is no filesystem object to find, no
     * port, no mode bits to get wrong, and no name by which a process that did
     * not fork the child could reach it. So `requiresPerSessionSecret: false`
     * survives the correction — for a better reason than the one it shipped with.
     */
    const server = AGENT_MANIFESTS.codex.runtime.server
    expect(server.supported).toBe(true)
    if (!server.supported) return
    expect(server.value.transport).toBe('stdio')
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
     * at runtime by `gateOpencodeVersion`.
     *
     * W6 has now landed codex's, so BOTH sides of the rule are satisfied rather
     * than one being the negative case (POD-2024). Its evidence is
     * `drivers/codex/__fixtures__` — frames recorded from a live 0.147.0
     * app-server, replayed by that driver's `protocol.test.ts`, and enforced at
     * runtime by `gateCodexVersion`. The pin is deliberately NARROW (two minors)
     * because codex is pre-1.0 and has renamed app-server approval methods
     * before, and a wrong method name there does not error: the approval simply
     * never arrives and the session hangs on its first tool call.
     *
     * THE RULE THIS TEST ENFORCES IS UNCHANGED — a range may be `supported` only
     * where recorded fixtures justify it. What it can no longer do is catch a
     * range pinned ahead of its fixtures by asserting codex declines, because
     * codex no longer declines. That guard now lives where it can still bite:
     * each driver's own fixture test, which fails if the recorded frames stop
     * parsing with the schemas the driver ships.
     */
    const codex = AGENT_MANIFESTS.codex.runtime.server
    expect(codex.supported).toBe(true)
    if (codex.supported) {
      expect(codex.value.versionRange.supported).toBe(true)
      // Assert a range EXISTS, not what it says. Pinning the prose would break
      // this test on every re-record, which is the opposite of what it should
      // react to — the fixtures are what make the number true, and they have
      // their own test.
      if (codex.value.versionRange.supported) {
        expect(codex.value.versionRange.value.length).toBeGreaterThan(0)
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
