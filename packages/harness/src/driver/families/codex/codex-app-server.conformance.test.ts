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
import { describe, expect, it } from 'vitest'
// `assertAttachHonoursOneControlLease` is the assertion, not a copy of it: the
// refusal worlds below are judged by the same corpus function the run judges its
// endpoint arm with. Imported from the module rather than the `testing/` barrel
// because the barrel is the corpus's surface to curate, and this file has no
// claim on widening it.
import { assertAttachHonoursOneControlLease } from '../../testing/conformance/suite.js'
import type { ConformanceControl, ConformanceTarget } from '../../testing/index.js'
import { runConformance } from '../../testing/index.js'
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

/**
 * THE ONE HOST FACT THIS FILE VARIES, and it is a fact about the MACHINE rather
 * than about the driver: whether this box can run `codex --remote unix://…` at
 * all, and for which attach modes. The capability declares `client` in every
 * one of them, because the variant this family produces does not change with the
 * host; what changes is whether a terminal can be started, and the driver turns
 * a host that starts none into the corpus's typed refusal (see `attachClient`).
 *
 *   `true` (default)     both modes, the ordinary machine;
 *   `false`              neither — nowhere to run a terminal at all;
 *   `'spectators-only'`  a read-only stream for watchers, but no seat to put a
 *                        controlling human in.
 *
 * The third is not a shape invented to make a test pass: it is the ONLY host
 * under which the corpus reaches its refused-TAKEOVER assertion, because
 * `assertAttachHonoursOneControlLease` returns at a refused peek and a host that
 * refuses everything never gets as far as asking for control. Both refusal
 * worlds are `describe`s at the bottom of this file.
 */
interface WorldOptions {
  hostsClientTerminals?: boolean | 'spectators-only'
}

function makeWorld(options: WorldOptions = {}): { target: ConformanceTarget } {
  const hostsClientTerminals = options.hostsClientTerminals ?? true
  let runtime: CodexRuntime | undefined
  let seq = 0
  /** World-wide thread minting — see `launch`. */
  let mintedThreads = 0
  /** Codex's rollout files, per WORLD rather than per app-server: the child dies
   *  with the daemon, the JSONL on disk does not. */
  const rollouts = new Map<string, Record<string, unknown>[]>()
  /** …and, for the same reason, WHICH THREADS EXIST: per world, not per server.
   *  A restarted app-server must still be able to resume a thread an earlier
   *  incarnation started, and must still refuse one nobody ever started. */
  const threads = new Set<string>()
  const servers = new Map<SessionId, FakeAppServer>()
  /** Servers a relaunch superseded. The driver stops them through the endpoint;
   *  `reset` closes any the property left standing. */
  const retired: FakeAppServer[] = []
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
    stageAttachment: async ({ source }) => {
      const id = 'attachment-' + ++seq
      return {
        id,
        path: '/tmp/' + id + '-' + source.filename,
        filename: source.filename,
        mediaType: source.mediaType,
        kind: source.mediaType.startsWith('image/') ? 'image' : 'file',
      }
    },
    journal,
    now: () => Date.UTC(2026, 7, 14) + ++seq * 1000,
    mintSessionId: () => `cx-session-${++seq}` as SessionId,

    async launch(input) {
      /**
       * THREAD IDS ARE MINTED PER WORLD, NOT PER SERVER (POD-2703).
       *
       * The fixture used to take the fake's default list, which starts at
       * `thr-1` for EVERY server it builds. Codex does not: a thread id names a
       * conversation on disk, globally, and two `codex app-server` incarnations
       * never mint the same one.
       *
       * The difference was invisible until `resume()` came under the corpus, and
       * then it was load-bearing in the worst way: a mutant whose `resume()`
       * THREW THE REF AWAY and started a brand-new thread still came back
       * holding `thr-1`, so "the resumed session is on the conversation we asked
       * for" was true by coincidence and the property could not fail. A fixture
       * whose ids collide cannot tell a resumed conversation from a fresh one —
       * which is the single thing that property exists to tell.
       */
      const server = startFakeAppServer({
        threadIds: [`thr-w${++mintedThreads}`],
        rollouts,
        threads,
      })
      /**
       * A RELAUNCH REPLACES THE SERVER FOR THIS SESSION under the same
       * session-derived identity — but it does NOT kill the outgoing one, and
       * that distinction cost POD-2293 an afternoon.
       *
       * This used to `close()` the previous server here, on the argument that a
       * relaunch means the old child is already gone. True of the path this
       * fixture was written for (adopt after a supervisor restart) and FALSE
       * whenever the driver replaces a connection while the old child is alive
       * and still serving the session — it swaps first and only then awaits
       * `oldEndpoint.stop()`. Killing it at launch made every send during such a
       * swap refuse `not_running` against a connection the real world would have
       * kept answering. (The fine-watch upgrade was the path that found this;
       * POD-2745 removed that upgrade, but relaunch-while-alive is a shape of
       * this fixture's host contract rather than of any one caller.)
       *
       * So the outgoing server stays up and `endpoint.stop()`/`kill()` closes
       * it, exactly as the driver expects. `retired` keeps a handle on it so
       * `reset` can still close everything this fixture ever started.
       */
      const outgoing = servers.get(input.sessionId)
      if (outgoing) retired.push(outgoing)
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
        resources: () => ({ memoryBytes: 96 * 1024 * 1024, oomKills: 0 }),
      }
      return endpoint
    },

    async attachClient(input) {
      // `codex --remote unix://…` would run here on a real host. The fixture only
      // has to prove the driver produces the endpoint VARIANT its capability
      // declares — the corpus checks the kind against the declaration.
      //
      // AND THAT THE ANSWER MAY DEPEND ON THE MODE. `input.mode` has always been
      // on the host contract — a real host needs it to decide what to spawn —
      // and a machine that hands a watcher a read-only stream while refusing to
      // seat a controller is what makes the corpus's second refusal assertion
      // reachable at all. See {@link WorldOptions}.
      if (hostsClientTerminals === false) return undefined
      if (hostsClientTerminals === 'spectators-only' && input.mode === 'takeover') return undefined
      return { streamId: `cx-attach-${input.sessionId}`, warmTtlMs: 300_000 }
    },

    async readRollout(path: string) {
      /**
       * THE THREAD'S ACTUAL ROLLOUT, not a constant (POD-2703, review 1).
       *
       * This returned the same 24 bytes for every session, which made every
       * export assertion above it metadata-only — the reviewer replaced each
       * driver's payload with one garbage byte and the suite stayed green, and
       * here the payload already WAS a constant. The rollout path names a
       * thread; that thread's items are what `export()` has to ship, or the
       * archive is a backup of nothing.
       */
      // `rollout-<threadId>.jsonl`, the name `threadPayload` reports.
      const threadId = /rollout-(.+)\.jsonl$/.exec(path.split('/').at(-1) ?? '')?.[1] ?? ''
      const lines = (rollouts.get(threadId) ?? []).map((item) => JSON.stringify(item))
      return new TextEncoder().encode(`${['{"type":"session_meta"}', ...lines].join('\n')}\n`)
    },
  }

  const serverFor = (sessionId: SessionId): FakeAppServer => {
    const server = servers.get(sessionId)
    if (!server) throw new Error(`no fake codex app-server for ${sessionId}`)
    return server
  }

  /** Distinct item ids per streamed reply, so two turns in one property cannot
   *  alias each other's fragments. */
  let streamSeq = 0

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

    /**
     * The fragment run and then the item that closes it, carrying the SAME
     * `msg_…` id — which is what codex does and why this family's join was never
     * in doubt. The corpus still runs the property here: a driver that dropped
     * the id on the floor, or emitted fragments for a fenced turn, would be
     * caught by the same assertions that caught opencode.
     */
    async streamAssistantText(sessionId, chunks) {
      const server = serverFor(sessionId)
      const itemId = `msg_stream_${streamSeq++}`
      for (const chunk of chunks) server.emitDelta(itemId, chunk)
      server.emitAgentMessage(chunks.join(''), itemId)
      await new Promise((resolve) => setTimeout(resolve, 20))
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

    model: {
      // A model this family names the way an operator names it, and an effort,
      // because Codex takes them as two separate turn parameters and a wake
      // could drop either one alone.
      policy: () => ({ model: 'gpt-5-codex', effort: 'high' }),
      // The other side of every configure property: a model an operator could
      // really pick here, differing from `policy` in both fields.
      alternate: () => ({ model: 'gpt-5.1-codex-max', effort: 'medium' }),
      // READ OFF THE SERVER, not remembered from what the driver was told. What
      // the corpus is asking is what the harness RECEIVED.
      requested: (sessionId) => servers.get(sessionId)?.lastTurnModel,
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
        for (const server of retired) server.close()
        retired.length = 0
        servers.clear()
        entries.clear()
        // Per-WORLD, but a property must not inherit a previous one's thread.
        rollouts.clear()
        threads.clear()
        seq = 0
        mintedThreads = 0
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

/**
 * THE REFUSAL ARM, ON A REAL DRIVER (POD-2486; the arms are POD-2121's and
 * POD-2131's, landed for opencode first and byte-equivalent here).
 *
 * ---------------------------------------------------------------------------
 * WHY THE ARM WAS UNREACHABLE, AND WHAT THAT LEFT UNGUARDED
 * ---------------------------------------------------------------------------
 *
 * `assertAttachHonoursOneControlLease` branches on whether the driver hands back
 * an ENDPOINT or a REFUSAL, and the refusal side carries the invariant with
 * teeth: a refused take-over must not be holding the control lease. The fixture
 * above returned an endpoint unconditionally, so this driver only ever took the
 * endpoint branch, and `runtime.ts`'s reserve-then-roll-back — the `!client`
 * arm that puts `previousLease` back — was guarded by nothing on this family.
 * POD-2131's reviewer found the same hole here and in grok-acp after fixing it
 * for opencode; this is that fix, and the codex-specific trap below is the part
 * that did not port over unchanged.
 *
 * WHY NOT A SECOND FULL `runConformance`. Nothing else in the corpus reads
 * `attachClient`, so a second whole-corpus pass would re-prove ~90 properties to
 * reach one branch. The suite exports the assertion for exactly this.
 */
describe('codex-app-server on a host with nowhere to run a terminal', () => {
  it('refuses the attach, typed, and does not walk off with the lease', async () => {
    const world = makeWorld({ hostsClientTerminals: false })
    const { driver } = world.target.createDriver()
    try {
      const handle = await driver.create(world.target.spec())

      /**
       * THE ARM IS PINNED BEFORE THE PROPERTY RUNS, because the property is
       * satisfied by EITHER arm and would go green on this world without ever
       * reaching the refusal branch — the exact failure that kept the branch
       * dormant, reproduced one level up.
       *
       * `supported` stays TRUE: this is a declared attach refused by a
       * particular machine, not a family with no terminal at all. The two reach
       * different branches — the declared-gap arm asserts the family may have no
       * attach, and would say nothing about a box that simply cannot host one.
       *
       * Pinning here forces the CLASSIFICATION path — a refusal must be typed —
       * to run. It does not reach the lease invariant: a peek never touches the
       * lease, so no mode-guarded driver can fail that half. The `describe` below
       * is the one with teeth.
       */
      expect(driver.capabilities().attach.supported).toBe(true)
      expect(await handle.attach({ mode: 'peek', holder: 'probe' })).toMatchObject({
        reason: 'unsupported',
      })

      await assertAttachHonoursOneControlLease(handle, driver.capabilities(), world.target.family)
    } finally {
      world.target.reset()
    }
  })
})

/**
 * THE HALF WITH THE TEETH: A REFUSED TAKE-OVER IS NOT HOLDING THE LEASE.
 *
 * ---------------------------------------------------------------------------
 * THE MACHINE
 * ---------------------------------------------------------------------------
 *
 * A box that can pipe a read-only stream to watchers and has no seat for a
 * controlling human. The peek succeeds and only the take-over is refused, and
 * that ordering is the whole point: `assertAttachHonoursOneControlLease` RETURNS
 * at a refused peek, so the world above never gets as far as asking for control,
 * while the ordinary world hosts both and never refuses at all.
 *
 * What it pins in THIS driver: `attach` reserves the lease before awaiting
 * `host.attachClient` — deliberately, to close a race where two take-overs both
 * won while the first was still starting — so the invariant now rides entirely
 * on the rollback in the `!client` branch. Delete `session.lease = previousLease`
 * there and a caller refused control is nonetheless recorded as the human
 * controller: the steward will not nudge, `lease.acquire` will refuse the next
 * comer with `lease_held`, and no terminal exists for anyone to type into.
 *
 * ---------------------------------------------------------------------------
 * TWO TRAPS, BOTH MEASURED
 * ---------------------------------------------------------------------------
 *
 * TRAP 1 — THE PIN NEEDS A SESSION OF ITS OWN. The pin has to establish that on
 * this world a peek yields an endpoint and a take-over is refused, or the
 * property could be satisfied through the endpoint branch and prove nothing.
 * But the pin's own take-over IS the call under test, and a driver with the bug
 * leaves the lease taken behind it. Pinning on the judged session would then
 * hand the property a poisoned starting state: it reads the lease BEFORE its own
 * take-over and compares the two, so a lease already wrongly held reads as
 * "unchanged" and the bug passes. MEASURED ON THIS DRIVER, not inherited from
 * opencode's finding: with the rollback deleted, judging the property on the
 * probe session instead of a fresh one leaves the whole package green. Two
 * fresh sessions answer it — the pin is a statement about the MACHINE, which the
 * host decides per call off `input.mode` alone, so it holds for both.
 *
 * TRAP 2 — CODEX HAS REFUSAL REASONS THE CORPUS DID NOT ACCEPT, and unlike
 * opencode it can reach them from `attach`: a take-over during an open turn is
 * `busy` and one with an unanswered ask is `needs_user`, because Codex hands its
 * single writer to the native TUI only while idle. `suite.ts`'s `answered()`
 * whitelist stopped at `unsupported | not_running | lease_held`. WIDENED, not
 * normalized — the reasoning is recorded at that whitelist, and the short form
 * is that `busy` means "ask again in a moment" while `unsupported` means "never
 * on this machine", and collapsing them would defeat the branch-on-why the
 * assertion exists to guarantee. Neither reason fires on the idle sessions
 * below; the whitelist was widened because the driver can legally produce them,
 * not because this test does.
 */
describe('codex-app-server on a host that streams to watchers but seats no controller', () => {
  it('refuses the take-over without walking off with the lease', async () => {
    const world = makeWorld({ hostsClientTerminals: 'spectators-only' })
    const { driver } = world.target.createDriver()
    try {
      const probe = await driver.create(world.target.spec())
      expect(driver.capabilities().attach.supported).toBe(true)
      expect('kind' in (await probe.attach({ mode: 'peek', holder: 'probe' }))).toBe(true)
      expect(await probe.attach({ mode: 'takeover', holder: 'probe' })).toMatchObject({
        reason: 'unsupported',
      })

      // TRAP 1: the judged session is a FRESH one, untouched by the pin above.
      const handle = await driver.create(world.target.spec())
      await assertAttachHonoursOneControlLease(handle, driver.capabilities(), world.target.family)
    } finally {
      world.target.reset()
    }
  })
})

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
