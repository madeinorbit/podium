/**
 * THE codex app-server DRIVER UNDER THE CONFORMANCE CORPUS — ZERO EXEMPTIONS
 * BEYOND THE ONE ITS FAMILY CARRIES (POD-1761 W6; plan §6).
 *
 * ---------------------------------------------------------------------------
 * THE EXEMPTION LIST IS THE HEADLINE, AND IT SAYS SOMETHING NEW
 * ---------------------------------------------------------------------------
 *
 * `CODEX_SERVER_PERMITTED_FAILURES` is `['no-native-steer']` — the server
 * family's row, unchanged, because the corpus requires the claim to equal the
 * row exactly. What is new is that this driver does not USE it: Codex has
 * `turn/steer`, the capability declares it, and `./permitted-failures.test.ts`
 * asserts the gap between what the family permits and what this driver exhibits.
 * The two that matter — `unverified-send` and `at-least-once-interactions` — are
 * the terminal family's, this driver claims neither, and the corpus refuses both
 * a driver that claims a weakness its family does not permit and one that
 * exhibits a weakness it did not claim.
 *
 * ---------------------------------------------------------------------------
 * THE PROCESS KEY IS SESSION-DERIVED, AND THAT IS LOAD-BEARING
 * ---------------------------------------------------------------------------
 *
 * The corpus requires `after.binding.process.key` to equal `before`'s across a
 * supervisor restart. For a family whose child cannot survive the daemon (see
 * ../runtime.ts) that is only true if the key names the SESSION rather than the
 * incarnation — which is also what makes `adopt`'s exact-identity check mean
 * something. The daemon host derives the same key the same way, from the scope
 * label, so the fixture is not modelling something the real host does
 * differently.
 */

import type { SessionId } from '@podium/model'
import { runConformance } from '../../testing/index.js'
import type { ConformanceControl, ConformanceTarget } from '../../testing/index.js'
import { CODEX_SERVER_PERMITTED_FAILURES } from './permitted-failures.js'
import {
  type CodexJournal,
  type CodexJournalEntry,
  type CodexRuntime,
  type CodexRuntimeHost,
  type CodexServerEndpoint,
  createCodexRuntime,
} from './runtime.js'
import { type FakeAppServer, startFakeAppServer } from './test-support/fake-app-server.js'

function makeWorld(): { target: ConformanceTarget } {
  let runtime: CodexRuntime | undefined
  let seq = 0
  const servers = new Map<SessionId, FakeAppServer>()
  const entries = new Map<SessionId, CodexJournalEntry>()

  const journal: CodexJournal = {
    read: (sessionId) => entries.get(sessionId),
    write: (entry) => {
      entries.set(entry.sessionId, entry)
    },
    clear: (sessionId) => {
      entries.delete(sessionId)
    },
  }

  /** The SESSION's key, not the incarnation's — see the header. */
  const processKey = (sessionId: SessionId): string => `podium-cx-${sessionId}`

  const host: CodexRuntimeHost = {
    journal,
    now: () => Date.UTC(2026, 7, 14) + ++seq * 1000,
    mintSessionId: () => `cx-session-${++seq}` as SessionId,

    async launch(input) {
      // A RELAUNCH REPLACES THE SERVER FOR THIS SESSION, which is exactly what
      // happens on the real host: the old child is gone (it died with the
      // daemon, or was stopped) and a new one takes its place under the same
      // session-derived identity.
      const server = startFakeAppServer()
      servers.get(input.sessionId)?.close()
      servers.set(input.sessionId, server)
      const endpoint: CodexServerEndpoint = {
        transport: server.transport,
        clientAddress: `unix:///tmp/${input.sessionId}.sock`,
        process: {
          key: processKey(input.sessionId),
          pid: 4242 + seq,
          scopeUnit: `podium-cx-${input.sessionId}.scope`,
        },
        stop: async () => {
          server.close()
        },
        kill: async () => {
          server.close()
          servers.delete(input.sessionId)
        },
        memoryBytes: () => 96 * 1024 * 1024,
      }
      return endpoint
    },

    async attachClient(input) {
      // `codex --remote unix://…` would run here on a real host. The fixture only
      // has to prove the driver produces the endpoint VARIANT its capability
      // declares — the corpus checks the kind against the declaration.
      return { streamId: `cx-attach-${input.sessionId}`, warmTtlMs: 300_000 }
    },

    async readRollout() {
      // The archive's bytes. Real on the daemon host; here it only has to prove
      // the driver ships the rollout rather than a re-serialization.
      return new TextEncoder().encode('{"type":"session_meta"}\n')
    },
  }

  const serverFor = (sessionId: SessionId): FakeAppServer => {
    const server = servers.get(sessionId)
    if (!server) throw new Error(`no fake codex app-server for ${sessionId}`)
    return server
  }

  const control: ConformanceControl = {
    askInteraction(sessionId, spec) {
      const server = serverFor(sessionId)
      const ask = typeof spec === 'string' ? { kind: spec } : spec
      if (ask.kind === 'elicitation') return server.askElicitation()
      /**
       * EVERY OTHER KIND ARRIVES AS A COMMAND APPROVAL, AND THAT IS HONEST
       * RATHER THAN CONVENIENT.
       *
       * Codex's server→client channel carries approvals and MCP elicitations,
       * and this driver DECLARES exactly those two kinds. The corpus asks in a
       * kind the driver declares, so a bare `'permission'` and the declared-kind
       * path both land here. A spec naming a kind Codex has no channel for would
       * be the corpus asking a driver to fabricate an ask its harness cannot
       * produce, and the fixture raises the nearest REAL channel instead of
       * inventing one.
       */
      const payload = 'payload' in ask ? (ask.payload as Record<string, unknown>) : {}
      return server.askCommandApproval({
        canAlwaysAllow: payload.canAlwaysAllow === true,
        ...(typeof payload.inputSummary === 'string' ? { command: payload.inputSummary } : {}),
      })
    },

    reaskInteraction(sessionId, previous) {
      // The server family does not claim `at-least-once`, so the corpus never
      // reaches this — but a duplicate ask is still what a re-ask MEANS, and
      // returning the same id would make a future property silently vacuous.
      void previous
      return control.askInteraction(sessionId, 'permission')
    },

    completeTurn(sessionId) {
      serverFor(sessionId).completeTurn('completed')
    },

    failTurn(sessionId) {
      serverFor(sessionId).completeTurn('failed')
    },

    processEvent(sessionId, ev) {
      if (ev.ev !== 'exited') return
      // THE CONNECTION CLOSING IS THE EXIT from the driver's point of view —
      // see `onClose` in ../client.ts.
      serverFor(sessionId).crash()
    },

    textDeliveries(sessionId) {
      /**
       * TURN STARTS **PLUS** STEERS — and the difference from the counter I
       * reverted is the contract, not the arithmetic.
       *
       * The old instrument was `deliveryAttempts`, and I widened it to this exact
       * sum to make a red property pass. That was wrong and I reverted it: the
       * contract had not asked for it, so widening the counter was answering a
       * broken measurement by changing what is measured. POD-2085 then rewrote
       * the instrument and the question with it — `textDeliveries` asks about the
       * AGENT, not about turns, and rule 2 says in writing that a native steer
       * counts, citing this driver's 1-vs-1 reading as the evidence.
       *
       * So the same sum is now the honest answer rather than a convenient one.
       * The two facts stay separately observable on the fake (`turnStarts`,
       * `steers`) precisely so this function can be read as a deliberate sum.
       *
       * RULE 3 IS SATISFIED BY CONSTRUCTION, not by care here: a queued send
       * issues no `turn/start` until `drainQueue` delivers it, so the count moves
       * at the DRAIN and never at the send — which is exactly what a `queued`
       * receipt promises the caller.
       */
      const server = serverFor(sessionId)
      return server.turnStarts + server.steers
    },

    failNextVerification(sessionId) {
      // There is NO verification window in this family — the RPC either answered
      // with a turn or it answered an error. The corpus pushes a driver at the
      // `unverified` outcome here, and a server driver must answer with
      // something else; making the call fail is the only honest way to push.
      serverFor(sessionId).failNextTurn()
    },

    restartSupervisor() {
      // Handles die. So, for this family, do the CHILDREN — `codex app-server`
      // exits on stdin EOF, so a daemon restart takes every one of them with it.
      // `forget` closes the client connection, which is precisely what the real
      // ending looks like from in here.
      for (const sessionId of [...servers.keys()]) runtime?.forget(sessionId)
    },

    connectWithoutSecret(sessionId) {
      /**
       * REFUSED BY THE FILESYSTEM BOUNDARY, NOT A PROTOCOL TOKEN.
       *
       * The corpus requires a server-family driver to refuse an unauthenticated
       * connection, because opencode's loopback port is reachable by every local
       * process and needs a secret to be safe. Codex instead uses a per-session
       * Unix listener below a mode-0700 instance directory with a mode-0600
       * socket. An actor outside that OS-user boundary cannot open the transport
       * at all; the host-level regression pins both modes.
       *
       * `true` is therefore the honest answer rather than a stub — and it is the
       * reason `requiresPerSessionSecret` is `false` in the manifest for a better
       * reason than "we didn't build one".
       */
      void sessionId
      return { refused: true }
    },
  }

  return {
    target: {
      name: 'codex-app-server',
      family: 'server',
      createDriver: () => {
        runtime = createCodexRuntime(host)
        return { driver: runtime.driver, control }
      },
      reset: () => {
        runtime?.dispose()
        runtime = undefined
        for (const server of servers.values()) server.close()
        servers.clear()
        entries.clear()
        seq = 0
      },
      spec: () => ({
        harness: 'codex',
        selection: { auth: 'subscription', platform: 'linux', available: ['codex-app-server'] },
        workdir: '/tmp/conformance-codex',
        model: {},
        instructions: { supported: false, reason: 'fixture' },
        mcpServers: { supported: false, reason: 'fixture' },
      }),
    },
  }
}

const { target } = makeWorld()

runConformance(target.createDriver, {
  name: target.name,
  family: target.family,
  reset: target.reset,
  spec: target.spec,
  /**
   * THE CLAIM THE SUITE CHECKS BEFORE IT RUNS A SINGLE PROPERTY. It must equal
   * the server family's row exactly — so this driver fails both by claiming a
   * weakness the family does not permit and by exhibiting one it did not claim.
   */
  exemptions: CODEX_SERVER_PERMITTED_FAILURES,
})
