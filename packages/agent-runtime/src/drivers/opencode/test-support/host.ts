/**
 * A MINIMAL `OpencodeRuntimeHost` OVER THE FAKE SERVER.
 *
 * The conformance target builds its own, richer host inline — it has to, because
 * the corpus needs a control surface that can nudge the world. This one exists
 * for the driver-level tests that only need a session to exist: it starts a real
 * loopback fake per launch, keeps them for teardown, and lets a test observe the
 * one thing those tests care about (whether a client terminal was started).
 *
 * DELIBERATELY NOT SHARED WITH THE CONFORMANCE FIXTURE. That fixture is owned by
 * the corpus's needs and changes with them; a helper factored to serve both would
 * make every driver-level test a hostage to a corpus edit.
 */

import type { SessionId } from '@podium/model'
import type { OpencodeRuntimeHost, OpencodeServerEndpoint } from '../runtime.js'
import { type FakeOpencodeServer, startFakeOpencodeServer } from './fake-server.js'

export interface OpencodeTestHostOptions {
  /** Wrap the client the driver builds, so a test can make a specific call
   *  misbehave — a health probe that fails once, for instance. */
  wrapClient?(client: import('../client.js').OpencodeClient): import('../client.js').OpencodeClient
  /** Called when the driver asks for a client terminal. Return `false` to make
   *  the host answer "this machine hosts none", which is the refusal path. */
  onAttachClient?(input: { sessionId: SessionId; url: string; mode: 'takeover' | 'peek' }): void
  hostsClientTerminals?: boolean
}

/** The host, plus a handle on the fake servers it started — a test that wants to
 *  drop an SSE stream needs to reach the server behind a session. */
export type OpencodeTestHost = OpencodeRuntimeHost & {
  serverFor(sessionId: SessionId): FakeOpencodeServer | undefined
}

export function makeOpencodeTestHost(options: OpencodeTestHostOptions = {}): OpencodeTestHost {
  const servers: FakeOpencodeServer[] = []
  const bySession = new Map<SessionId, FakeOpencodeServer>()
  const entries = new Map<SessionId, Parameters<OpencodeRuntimeHost['journal']['write']>[0]>()
  let seq = 0

  return {
    serverFor: (sessionId) => bySession.get(sessionId),

    async launch(input) {
      const server = await startFakeOpencodeServer({
        username: input.username,
        password: input.secret,
      })
      servers.push(server)
      bySession.set(input.sessionId, server)
      const endpoint: OpencodeServerEndpoint = {
        baseUrl: server.baseUrl,
        username: server.username,
        password: server.password,
        process: { key: `test-opencode-${input.sessionId}`, pid: server.pid },
        stop: async () => {
          server.alive = false
          await server.close()
        },
        kill: async () => {
          server.alive = false
          await server.close()
        },
        resources: () => undefined,
      }
      return endpoint
    },

    // Nothing in the driver-level tests restarts a supervisor; a host that
    // answered anything here would be describing a capability these tests do not
    // exercise.
    async adopt() {
      return undefined
    },

    async attachClient(input) {
      options.onAttachClient?.(input)
      if (options.hostsClientTerminals === false) return undefined
      return { streamId: `test-attach-${input.sessionId}`, warmTtlMs: 60_000 }
    },

    journal: {
      read: (sessionId) => entries.get(sessionId),
      write: (entry) => {
        entries.set(entry.sessionId, entry)
      },
      clear: (sessionId) => {
        entries.delete(sessionId)
      },
    },

    ...(options.wrapClient
      ? {
          makeClient: (config) => {
            const { createOpencodeClient } = require('../client.js') as typeof import('../client.js')
            return options.wrapClient?.(createOpencodeClient(config)) ?? createOpencodeClient(config)
          },
        }
      : {}),

    now: () => Date.UTC(2026, 7, 14) + seq * 1000,
    randomSecret: () => `test-secret-${++seq}`,
    mintSessionId: () => `test-session-${++seq}` as SessionId,
  }
}
