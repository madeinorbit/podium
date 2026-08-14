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
import { runConformance } from '../../testing/index.js'
import type { ConformanceControl, ConformanceTarget } from '../../testing/index.js'
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
function makeWorld(): { target: ConformanceTarget } {
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
      // `opencode attach <url>` would run here on a real host. The fixture only
      // has to prove the driver produces the endpoint VARIANT its capability
      // declares.
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
