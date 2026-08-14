/**
 * THE opencode SERVER DRIVER UNDER THE CONFORMANCE CORPUS — ZERO EXEMPTIONS
 * BEYOND THE ONE ITS FAMILY CARRIES (POD-1761 W5; plan §5).
 *
 * ---------------------------------------------------------------------------
 * WHAT IS REAL HERE AND WHAT IS FAKE
 * ---------------------------------------------------------------------------
 *
 * REAL: every line of the driver, the client, the SSE parser, the event mapping,
 * the receipt logic, the interaction reconciliation — and the TRANSPORT. The
 * server on the other end is a real `node:http` listener on a real loopback
 * port, speaking the shapes recorded from opencode 1.18.16, enforcing the same
 * Basic-auth check. The unauthenticated-connection refusal is proved by opening
 * an actual connection with no credentials.
 *
 * FAKE: the agent. No model runs, no PTY exists, nothing waits out a timing
 * ladder. That is what makes this the epic's first driver whose conformance run
 * is deterministic end to end — the terminal driver had to virtualize a clock to
 * get here, and this one simply has no clock to virtualize.
 *
 * ---------------------------------------------------------------------------
 * THE EXEMPTION LIST IS THE HEADLINE
 * ---------------------------------------------------------------------------
 *
 * `SERVER_PERMITTED_FAILURES` is `['no-native-steer']` and nothing else. The two
 * that matter — `unverified-send` and `at-least-once-interactions` — are the
 * terminal family's, this driver claims neither, and the corpus refuses a driver
 * that claims a weakness its family does not permit AND one that exhibits a
 * weakness it did not claim. `no-native-steer` is on the row because opencode
 * has no steer verb; the argument, and the measurement behind it, are in
 * `../../permitted-failures.ts`.
 */

import type { SessionId } from '@podium/model'
import { describe, expect, it } from 'vitest'
// `assertAttachHonoursOneControlLease` is the assertion, not a copy of it: the
// refusal arm below is judged by the same corpus function the run judges its
// endpoint arm with. Imported from the module rather than the `testing/` barrel
// because the barrel is the corpus's surface to curate, and this file has no
// business widening it.
import { assertAttachHonoursOneControlLease } from '../../testing/conformance/suite.js'
import type { ConformanceControl, ConformanceTarget } from '../../testing/index.js'
import { runConformance } from '../../testing/index.js'
import { createOpencodeClient, type OpencodeClient } from './client.js'
import { SERVER_PERMITTED_FAILURES } from './permitted-failures.js'
import {
  createOpencodeRuntime,
  type OpencodeJournal,
  type OpencodeJournalEntry,
  type OpencodeRuntime,
  type OpencodeRuntimeHost,
  type OpencodeServerEndpoint,
} from './runtime.js'
import { type FakeOpencodeServer, startFakeOpencodeServer } from './test-support/fake-server.js'

/**
 * A server per session, started on demand and remembered.
 *
 * SYNCHRONOUS CONTROL OVER AN ASYNCHRONOUS WORLD is the only awkward part of
 * this fixture, and it is the corpus's shape rather than a defect: `askInteraction`
 * returns a `string`, not a promise. The fake's ask is therefore recorded in the
 * server's pending list SYNCHRONOUSLY (so a `GET /permission` immediately after
 * sees it) and ALSO announced on the SSE stream (so a live consumer sees it the
 * way opencode delivers it). The driver reconciles against the list before every
 * `send`/`interactions`/unknown `answer`, which is exactly why it does not
 * depend on the stream having arrived — and that reconciliation is not a test
 * affordance: it is what makes an ask raised while a socket was down, or
 * answered at an attached TUI, visible at all.
 */
interface WorldOptions {
  /** `false` is a machine with nowhere to run `opencode attach <url>`. The
   *  driver turns that into the corpus's typed refusal; see `attachClient`. */
  hostsClientTerminals?: boolean
}

function makeWorld(options: WorldOptions = {}): { target: ConformanceTarget } {
  const hostsClientTerminals = options.hostsClientTerminals !== false
  let runtime: OpencodeRuntime | undefined
  let seq = 0
  const servers = new Map<SessionId, FakeOpencodeServer>()
  const opencodeIds = new Map<SessionId, string>()
  const secretRefused = new Map<SessionId, boolean>()
  const started: FakeOpencodeServer[] = []
  const entries = new Map<SessionId, OpencodeJournalEntry>()

  const journal: OpencodeJournal = {
    read: (sessionId) => entries.get(sessionId),
    write: (entry) => {
      entries.set(entry.sessionId, entry)
      opencodeIds.set(entry.sessionId, entry.opencodeSessionId)
    },
    clear: (sessionId) => {
      entries.delete(sessionId)
    },
  }

  const endpointFor = (sessionId: SessionId, server: FakeOpencodeServer): OpencodeServerEndpoint => ({
    baseUrl: server.baseUrl,
    username: server.username,
    password: server.password,
    // EXACT identity. The corpus's `adopt` properties turn on this being stable
    // across a supervisor restart and unusable after a kill.
    process: { key: `fake-opencode-${sessionId}`, pid: server.pid, scopeUnit: `podium-${sessionId}.scope` },
    stop: async () => {
      server.alive = false
      await server.close()
    },
    kill: async () => {
      server.alive = false
      await server.close()
      servers.delete(sessionId)
    },
    memoryBytes: () => 128 * 1024 * 1024,
  })

  const host: OpencodeRuntimeHost = {
    async launch(input) {
      const server = await startFakeOpencodeServer({
        username: input.username,
        password: input.secret,
      })
      started.push(server)
      servers.set(input.sessionId, server)
      // THE REFUSAL, MEASURED AT LAUNCH. A real connection with no credentials,
      // against this session's real listener; the answer is cached because the
      // corpus's control surface for it is synchronous. Nothing about it is
      // simulated.
      secretRefused.set(input.sessionId, await server.probeWithoutSecret())
      return endpointFor(input.sessionId, server)
    },

    async adopt(binding) {
      const server = servers.get(binding.sessionId)
      // A killed server is gone from the map, so `adopt` correctly refuses —
      // which is the property "refuses to adopt a binding whose process did not
      // survive" reaching the code that decides it.
      if (!server || !server.alive) return undefined
      return endpointFor(binding.sessionId, server)
    },

    async attachClient(input) {
      /**
       * `opencode attach <url>` would run here on a real host — and on a host
       * with nowhere to run one, NOTHING would (POD-2059's shape).
       *
       * This used to return an endpoint unconditionally, and the comment that
       * stood here said why honestly: the fixture only had to prove the driver
       * produced the endpoint VARIANT its capability declares, because that was
       * the only thing the corpus asked. It is what made the corpus's refusal
       * arm dormant — every landed fixture hosted a client, so no target ever
       * reached it.
       *
       * `undefined` is the host contract's "this machine hosts no terminal", and
       * it is a per-MACHINE fact rather than a per-driver one: the capability
       * still declares `client`, because the variant this family produces does
       * not change with the host. What changes is whether this box can run one,
       * and the driver turns that into the typed refusal the corpus branches on.
       */
      if (!hostsClientTerminals) return undefined
      return { streamId: `oc-attach-${input.sessionId}`, warmTtlMs: 300_000 }
    },

    journal,
    now: () => Date.UTC(2026, 7, 14) + seq * 1000,
    randomSecret: () => `fake-secret-${++seq}`,
    mintSessionId: () => `oc-session-${++seq}` as SessionId,
    makeClient: (config) => createOpencodeClient(config) satisfies OpencodeClient,
  }

  const serverFor = (sessionId: SessionId): FakeOpencodeServer => {
    const server = servers.get(sessionId)
    if (!server) throw new Error(`no fake opencode server for ${sessionId}`)
    return server
  }
  const opencodeIdFor = (sessionId: SessionId): string => {
    const id = opencodeIds.get(sessionId)
    if (!id) throw new Error(`no opencode session id recorded for ${sessionId}`)
    return id
  }

  const control: ConformanceControl = {
    askInteraction(sessionId, spec) {
      const server = serverFor(sessionId)
      const opencodeId = opencodeIdFor(sessionId)
      const ask = typeof spec === 'string' ? { kind: spec } : spec
      if (ask.kind === 'question') {
        const payload = 'payload' in ask ? ask.payload : undefined
        const prompts =
          payload && 'questions' in payload
            ? payload.questions.map((question) => ({
                question: question.question,
                header: question.header ?? 'Choice',
                options: question.options.map((option) => ({
                  label: option.label,
                  description: option.description ?? '',
                })),
              }))
            : [
                {
                  question: 'Which way?',
                  header: 'Direction',
                  options: [
                    { label: 'Left', description: 'go left' },
                    { label: 'Right', description: 'go right' },
                  ],
                },
              ]
        return server.askQuestion({ sessionID: opencodeId, questions: prompts })
      }
      /**
       * EVERY OTHER KIND ARRIVES AS A PERMISSION, AND THAT IS HONEST RATHER
       * THAN CONVENIENT.
       *
       * opencode's protocol has two ask channels — permission and question — and
       * this driver DECLARES exactly those two in its capabilities. The corpus
       * now asks in a kind the driver declares (POD-2023 changed the
       * phase-independence property to read the declaration), so a bare
       * `'permission'` and the declared-kind path both land here. A spec naming
       * a kind opencode has no channel for would be a corpus asking a driver to
       * fabricate an ask its harness cannot produce, and the fixture would
       * rather raise the nearest REAL channel than invent a fake one.
       */
      const payload = 'payload' in ask ? (ask.payload as Record<string, unknown>) : {}
      const toolName = typeof payload.toolName === 'string' ? payload.toolName.toLowerCase() : 'bash'
      return server.askPermission({
        sessionID: opencodeId,
        permission: toolName,
        patterns: ['echo hello'],
        metadata: { command: 'echo hello' },
        always: payload.canAlwaysAllow === true ? ['echo *'] : [],
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
      serverFor(sessionId).goIdle(opencodeIdFor(sessionId))
    },

    processEvent(sessionId, ev) {
      if (ev.ev !== 'exited') return
      const server = serverFor(sessionId)
      server.alive = false
      void server.close()
    },

    textDeliveries(sessionId) {
      // COUNTED WHERE THE WORDS ARRIVE: one accepted `prompt_async` POST is one
      // delivery of the caller's turn. That satisfies the counting rules on
      // `ConformanceControl.textDeliveries` without a change, and the reason is
      // structural rather than lucky — this driver POSTs at the DRAIN
      // (`drainQueue` → `deliver`), never at the queued `send()`, and it has no
      // native steer to miss.
      return serverFor(sessionId).promptCount(opencodeIdFor(sessionId))
    },

    failNextVerification(sessionId) {
      // There is NO verification window in this family — the 204 either happens
      // or it does not. The corpus pushes a driver at the `unverified` outcome
      // here, and a server driver must answer with something else; making the
      // POST fail is the only honest way to push.
      serverFor(sessionId).failNextPrompt()
    },

    restartSupervisor() {
      // Handles die; the SERVERS do not. That is a daemon restart, and it is
      // what `adopt()` then has to find.
      for (const sessionId of [...servers.keys()]) runtime?.forget(sessionId)
    },

    connectWithoutSecret(sessionId) {
      // The cached result of a REAL credential-free request made at launch, to
      // this session's REAL listener. See `host.launch`.
      return { refused: secretRefused.get(sessionId) === true }
    },
  }

  return {
    target: {
      name: 'opencode-server',
      family: 'server',
      createDriver: () => {
        runtime = createOpencodeRuntime(host)
        return { driver: runtime.driver, control }
      },
      reset: () => {
        runtime?.dispose()
        runtime = undefined
        for (const server of started.splice(0)) void server.close()
        servers.clear()
        opencodeIds.clear()
        secretRefused.clear()
        entries.clear()
        seq = 0
      },
      spec: () => ({
        harness: 'opencode',
        selection: { auth: 'api-key', platform: 'linux', available: ['opencode-server'] },
        workdir: '/tmp/conformance-opencode',
        model: {},
        instructions: { supported: false, reason: 'fixture' },
        mcpServers: { supported: false, reason: 'fixture' },
      }),
    },
  }
}

const { target } = makeWorld()

/**
 * THE OTHER ARM OF THE SAME PROPERTY, ON A HOST THAT HOSTS NO TERMINAL.
 *
 * `assertAttachHonoursOneControlLease` classifies every answer before judging it
 * and then branches: an endpoint must be of a kind the capability DECLARES, and
 * a refusal must be TYPED — and a refused attach must not be holding the lease.
 * The run above takes the ENDPOINT branch from its first `peek` and never comes
 * back, which is correct for a machine that can host a client and is exactly why
 * the refusal branch had no landed target reaching it.
 *
 * So the refusal arm gets the world it describes rather than a flag inside the
 * other one: same real driver, same real loopback server, one host fact changed.
 * The corpus's own property does the judging — this file only supplies the
 * machine — which is what keeps the assertion shared rather than re-stated here.
 *
 * WHY NOT A SECOND FULL `runConformance`. Nothing else in the corpus reads
 * `attachClient`, so a second whole-corpus pass would re-prove ~90 properties to
 * reach one branch. The suite exports this assertion for precisely this — see
 * its own note about the teeth tests.
 */
describe('opencode-server on a host with nowhere to run a terminal', () => {
  it('refuses the attach, typed, and does not walk off with the lease', async () => {
    const world = makeWorld({ hostsClientTerminals: false })
    const { driver } = world.target.createDriver()
    try {
      const handle = await driver.create(world.target.spec())

      /**
       * THE ARM IS PINNED BEFORE THE PROPERTY RUNS, because the property is
       * satisfied by EITHER arm and would go green on this world without ever
       * reaching the refusal branch — which is the exact failure that made the
       * branch dormant in the first place, reproduced one level up. These two
       * assertions are what make the test below about the refusal.
       *
       * `supported` stays TRUE: this is a declared attach being refused by a
       * particular machine, not a family that has no terminal. The two reach
       * different branches of the property and only this one carries the
       * "a refused attach is not holding the lease" invariant.
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
  exemptions: SERVER_PERMITTED_FAILURES,
})
