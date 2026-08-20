/**
 * A QUEUE THIS DRIVER LOSES SAYS SO (POD-2297).
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FAMILY'S FILE IS SHORTER THAN CODEX'S AND OPENCODE'S
 * ---------------------------------------------------------------------------
 *
 * Grok's drain is the one that was ALREADY honest about a failed send, and the
 * difference is worth stating rather than leaving as a missing test. `startPrompt`
 * opens the turn SYNCHRONOUSLY — epoch, `turn/started`, transcript item — and
 * hands the pending `session/prompt` to `finishPrompt`, so a rejected prompt
 * reaches the caller as a turn FAILURE. That is not the POD-2297 shape: a turn
 * really did open, and saying so is the truth.
 *
 * What this family shared with the other two is the DISPOSAL half: `stop`,
 * `kill`, `hibernate`, `forget`, `dispose` and a child that closes the link all
 * discarded whatever was parked, against callers holding a `queued` receipt that
 * POD-2291 made the ledger's last word. That is what is pinned here.
 */

import type { SessionId } from '@podium/model'
import { describe, expect, it } from 'vitest'
import type { SessionSpec } from '../../index.js'
import {
  createGrokAcpRuntime,
  type GrokAcpJournalEntry,
  type GrokAcpRuntimeHost,
} from './runtime.js'
import { type FakeGrokAcpServer, startFakeGrokAcpServer } from './test-support/fake-acp-server.js'

const spec = (): SessionSpec => ({
  harness: 'grok',
  selection: {
    auth: 'subscription',
    platform: 'linux',
    available: ['grok-acp'],
    preference: 'grok-acp',
  },
  workdir: '/tmp/grok-abandonment',
  model: {},
  instructions: { supported: false, reason: 'fixture' },
  mcpServers: { supported: false, reason: 'fixture' },
})

type Report = { turnIds: (string | undefined)[]; reason: string }

interface World {
  host: GrokAcpRuntimeHost
  reports: Report[]
  serverFor(sessionId: SessionId): FakeGrokAcpServer | undefined
}

function world(): World {
  let seq = 0
  const servers = new Map<SessionId, FakeGrokAcpServer>()
  const entries = new Map<SessionId, GrokAcpJournalEntry>()
  const reports: Report[] = []
  return {
    reports,
    serverFor: (sessionId) => servers.get(sessionId),
    host: {
      journal: {
        read: (id) => entries.get(id),
        write: (entry) => entries.set(entry.sessionId, entry),
        clear: (id) => {
          entries.delete(id)
        },
      },
      now: () => Date.UTC(2026, 7, 20) + ++seq * 1000,
      mintSessionId: () => `gk-abandon-${++seq}` as SessionId,
      onQueueAbandoned: ({ turns, reason }) => {
        reports.push({ turnIds: turns.map((turn) => turn.input.id), reason })
      },
      async launch(input) {
        const server = startFakeGrokAcpServer(`grok-native-${input.sessionId}`)
        servers.set(input.sessionId, server)
        return {
          transport: server.transport,
          process: { key: `podium-gk-${input.sessionId}`, pid: 4000 + seq },
          alive: () => server.alive,
          stop: async () => server.crash(),
          kill: async () => server.crash(),
          resources: () => undefined,
        }
      },
    },
  }
}

describe('a queue this driver loses says so — POD-2297', () => {
  it('reports the whole parked queue when the session is stopped under it', async () => {
    const w = world()
    const runtime = createGrokAcpRuntime(w.host)
    try {
      const handle = await runtime.driver.create(spec())
      // A human is driving, so these park and are TOLD they are parked — the
      // receipt that has to stop being true out loud.
      await handle.lease.acquire('operator', 'human-controller')
      const first = await handle.send(
        { id: 'nudge-1', text: 'when you are done' },
        { origin: 'steward', delivery: 'when-ready' },
      )
      const second = await handle.send(
        { id: 'nudge-2', text: 'and this' },
        { origin: 'steward', delivery: 'when-ready' },
      )
      expect(first.outcome).toBe('queued')
      expect(second.outcome).toBe('queued')

      await handle.stop()

      // ONE report, in queue order: the consumer dedupes by turn id and corrects
      // both receipts from a single durable frame.
      expect(w.reports).toEqual([{ turnIds: ['nudge-1', 'nudge-2'], reason: 'teardown' }])
    } finally {
      runtime.dispose()
    }
  })

  it('reports the queue when the child closes the link under the session', async () => {
    // `disposed` is deliberately NOT set by this arm — that is the handle
    // owner's call — but the parked turns are finished either way: the state has
    // just folded to `session_ended` and every later drain would prompt a link
    // that is gone.
    const w = world()
    const runtime = createGrokAcpRuntime(w.host)
    try {
      const handle = await runtime.driver.create(spec())
      await handle.lease.acquire('operator', 'human-controller')
      await handle.send(
        { id: 'orphan', text: 'orphan' },
        { origin: 'steward', delivery: 'when-ready' },
      )

      w.serverFor(handle.binding.sessionId)?.crash()
      await expect
        .poll(() => w.reports, { timeout: 2000 })
        .toEqual([{ turnIds: ['orphan'], reason: 'teardown' }])
    } finally {
      runtime.dispose()
    }
  })

  it('reports a queue the runtime forgets — a supervisor restart loses it too', async () => {
    // `forget` kills the HANDLE and leaves the PROCESS: a rebind finds the
    // session again, but never the in-memory queue. The turns were owed and are
    // now owed by nobody, which is the whole of what this report says.
    const w = world()
    const runtime = createGrokAcpRuntime(w.host)
    try {
      const handle = await runtime.driver.create(spec())
      await handle.lease.acquire('operator', 'human-controller')
      await handle.send(
        { id: 'forgotten', text: 'forgotten' },
        { origin: 'steward', delivery: 'when-ready' },
      )

      runtime.forget(handle.binding.sessionId)

      expect(w.reports).toEqual([{ turnIds: ['forgotten'], reason: 'teardown' }])
    } finally {
      runtime.dispose()
    }
  })

  it('says nothing when there is nothing to say', async () => {
    // An empty queue at teardown is not an abandonment. A report naming no turns
    // would put a frame on the daemon's durable outbox for every session that
    // ever ends.
    const w = world()
    const runtime = createGrokAcpRuntime(w.host)
    try {
      const handle = await runtime.driver.create(spec())
      await handle.stop()
      expect(w.reports).toEqual([])
    } finally {
      runtime.dispose()
    }
  })

  it('reports a parked turn once — the queue does not keep its own copy', async () => {
    const w = world()
    const runtime = createGrokAcpRuntime(w.host)
    try {
      const handle = await runtime.driver.create(spec())
      await handle.lease.acquire('operator', 'human-controller')
      await handle.send({ id: 'once', text: 'once' }, { origin: 'steward', delivery: 'when-ready' })

      await handle.stop()
      runtime.dispose()

      expect(w.reports).toEqual([{ turnIds: ['once'], reason: 'teardown' }])
    } finally {
      runtime.dispose()
    }
  })
})
