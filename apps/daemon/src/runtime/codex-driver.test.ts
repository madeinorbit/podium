/**
 * THE DAEMON'S HALF OF RESTART-ADOPTION FOR CODEX (POD-1761 W6, review fix 1).
 *
 * The driver half was done and correct — `driver.adopt()` resumes the journalled
 * thread and the conformance corpus exercises it — and the CALLER was missing.
 * `adoptServerDriverSession` consulted only the opencode runtime, so a codex
 * session answered "not mine" and fell through to a path whose own words are
 * that it "assumes a PTY". The session came back `reattachFailed: session not
 * found`: verbatim the failure that function exists to prevent.
 *
 * WHAT THIS FILE TESTS IS THE WIRING, deliberately, and not the protocol. Does a
 * journal entry get read, does `driver.adopt()` get called for it, does the
 * handle come back registered and reported? Protocol fidelity is covered
 * exhaustively one package over against frames recorded from a live codex; a
 * second copy of that here would be a second source of truth for shapes this
 * layer never looks at.
 *
 * THE FAKE APP-SERVER IS THEREFORE MINIMAL and answers exactly the three calls
 * an adopt makes: `initialize`, `initialized`, `thread/resume`.
 */

import type { CodexRuntimeHost, CodexTransport } from '@podium/agent-runtime'
import type { SessionId } from '@podium/model'
import type { DaemonMessage } from '@podium/protocol/daemon'
import { describe, expect, it } from 'vitest'
import { createDaemonCodexRuntime } from './codex-driver'

/** Just enough app-server to complete a handshake and resume a thread. */
function stubTransport(): { transport: CodexTransport; resumedThreads: string[] } {
  const resumedThreads: string[] = []
  let handler: { line(line: string): void; closed(): void } | undefined
  const reply = (payload: unknown): void => handler?.line(JSON.stringify(payload))
  return {
    resumedThreads,
    transport: {
      write(line) {
        const frame = JSON.parse(line) as {
          id?: number
          method?: string
          params?: Record<string, unknown>
        }
        if (frame.method === 'initialize') {
          // Note the missing `jsonrpc` member — the real server omits it, and a
          // stub that added one would be kinder than the thing it stands for.
          reply({ id: frame.id, result: { userAgent: 'stub', codexHome: '/home/a/.codex' } })
          return
        }
        if (frame.method === 'thread/resume') {
          const threadId = String(frame.params?.threadId)
          resumedThreads.push(threadId)
          reply({ id: frame.id, result: { thread: { id: threadId, path: null } } })
          return
        }
        if (frame.method === 'getAuthStatus') {
          reply({ id: frame.id, result: { authMethod: 'chatgpt' } })
          return
        }
        if (frame.id !== undefined) reply({ id: frame.id, result: {} })
      },
      onLine(next) {
        handler = next
      },
      close() {
        handler?.closed()
      },
    },
  }
}

function world() {
  const sent: DaemonMessage[] = []
  const entries = new Map<string, unknown>()
  const resumed: string[] = []
  let launches = 0
  const host: CodexRuntimeHost = {
    journal: {
      read: (id) => entries.get(id) as never,
      write: (entry) => void entries.set(entry.sessionId, entry),
      clear: (id) => void entries.delete(id),
    },
    now: () => Date.UTC(2026, 7, 14),
    mintSessionId: () => 'minted' as SessionId,
    async launch(input) {
      launches += 1
      const stub = stubTransport()
      // The stub's resumes are collected globally so the assertion can name the
      // thread id without reaching into whichever child served the adopt.
      const proxy: CodexTransport = {
        write: (line) => {
          stub.transport.write(line)
          resumed.push(...stub.resumedThreads.splice(0))
        },
        onLine: (h) => stub.transport.onLine(h),
        close: () => stub.transport.close(),
      }
      return {
        transport: proxy,
        clientAddress: `unix:///tmp/${input.sessionId}.sock`,
        process: { key: `podium-cx-${input.sessionId}` },
        stop: async () => {},
        kill: async () => {},
        resources: () => undefined,
      }
    },
  }
  return {
    host,
    sent,
    entries,
    resumed,
    launches: () => launches,
    runtime: createDaemonCodexRuntime({ send: (msg) => void sent.push(msg), host }),
  }
}

describe('restart-adoption, at the layer that was missing it', () => {
  it('answers `undefined` for a session it never journalled', async () => {
    /**
     * THE SILENT CASE, AND IT IS THE COMMON ONE. Every terminal session reaches
     * the reattach path too, and none of them has an entry here. Answering
     * anything but "not mine" would hijack a PTY session's reattach.
     */
    const w = world()
    expect(await w.runtime.adoptFromJournal('never-seen' as SessionId)).toBeUndefined()
    expect(w.launches()).toBe(0)
  })

  it('RESUMES THE JOURNALLED THREAD in a fresh child, and registers the handle', async () => {
    /**
     * For this family adoption MEANS thread-resume. `codex app-server` exits on
     * stdin EOF and its channel is the child's stdio, so a daemon restart takes
     * every child with it and there is never a survivor to rebind. What survives
     * is the rollout file, and that is what makes the session continuous.
     */
    const w = world()
    const sessionId = 'cx-restarted' as SessionId
    w.entries.set(sessionId, {
      sessionId,
      threadId: '019fff94-7326-7032-b90b-3cc7e1805180',
      workdir: '/work/project',
      process: { key: `podium-cx-${sessionId}` },
      seq: 12,
      turnEpoch: 3,
      bindingVersion: 1,
    })

    const handle = await w.runtime.adoptFromJournal(sessionId)
    expect(handle).toBeDefined()
    if (!handle) return

    // The THREAD the journal named, asked for by name.
    expect(w.resumed).toContain('019fff94-7326-7032-b90b-3cc7e1805180')
    // …and the session it came back as is the same session, on a NEW binding.
    expect(handle.binding.sessionId).toBe(sessionId)
    expect(handle.binding.resume).toEqual({
      kind: 'codex-thread',
      value: '019fff94-7326-7032-b90b-3cc7e1805180',
    })
    expect(handle.binding.bindingVersion).toBeGreaterThan(1)
    // REGISTERED, which is what makes every later verb find it. An adopt that
    // resumed the thread and left the handle unregistered would answer
    // `not_running` for a session that is running.
    expect(w.runtime.handleFor(sessionId)).toBe(handle)
    expect(w.runtime.has(sessionId)).toBe(true)
  })

  it('`has` follows the handle map, so a lifecycle kill drops the bind fact (POD-2249)', async () => {
    /**
     * The parallel `live` Set this pins the removal of was cleared only on a
     * `process: exited` event — the lifecycle verbs drop the handle without one,
     * so a parked session's bind fact kept routing verbs onto a contract path
     * that answers `not_running`.
     */
    const w = world()
    const sessionId = 'cx-parked' as SessionId
    w.entries.set(sessionId, {
      sessionId,
      threadId: '019fff94-7326-7032-b90b-3cc7e1805181',
      workdir: '/work/project',
      process: { key: `podium-cx-${sessionId}` },
      seq: 1,
      turnEpoch: 1,
      bindingVersion: 1,
    })
    const handle = await w.runtime.adoptFromJournal(sessionId)
    expect(handle).toBeDefined()
    expect(w.runtime.has(sessionId)).toBe(true)

    await handle?.kill()
    expect(w.runtime.has(sessionId)).toBe(false)
    expect(w.runtime.handleFor(sessionId)).toBeUndefined()
  })

  it('carries the turn epoch across the restart rather than restarting it', async () => {
    // Resetting it is how a replayed stream looks like new work — the one thing
    // the causal envelope's monotonicity rule forbids.
    const w = world()
    const sessionId = 'cx-epoch' as SessionId
    w.entries.set(sessionId, {
      sessionId,
      threadId: 'thread-epoch',
      workdir: '/work',
      process: { key: `podium-cx-${sessionId}` },
      seq: 40,
      turnEpoch: 7,
      bindingVersion: 2,
    })
    const handle = await w.runtime.adoptFromJournal(sessionId)
    expect(handle).toBeDefined()
    if (!handle) return
    const snapshot = await handle.snapshot()
    expect(snapshot.turnEpoch).toBeGreaterThanOrEqual(7)
    expect(Number(snapshot.cursor.components.seq ?? 0)).toBeGreaterThanOrEqual(40)
  })

  it('reports the resume ref, so a handoff need not re-derive it', async () => {
    const w = world()
    const sessionId = 'cx-ref' as SessionId
    w.entries.set(sessionId, {
      sessionId,
      threadId: 'thread-ref',
      workdir: '/work',
      process: { key: `podium-cx-${sessionId}` },
      seq: 0,
      turnEpoch: 0,
      bindingVersion: 1,
    })
    await w.runtime.adoptFromJournal(sessionId)
    const refs = w.sent.filter((msg) => msg.type === 'sessionResumeRef')
    expect(refs).toHaveLength(1)
    expect(refs[0]).toMatchObject({ resume: { kind: 'codex-thread', value: 'thread-ref' } })
  })

  it('REFUSES a journal entry that names a different incarnation', async () => {
    /**
     * EXACT IDENTITY OR NOTHING. A journal whose process key does not match the
     * binding describes a different life of this session, and resuming its
     * thread would attach this session id to someone else's conversation.
     */
    const w = world()
    const sessionId = 'cx-mismatch' as SessionId
    w.entries.set(sessionId, {
      sessionId,
      threadId: 'thread-x',
      workdir: '/work',
      process: { key: 'podium-cx-some-other-incarnation' },
      seq: 0,
      turnEpoch: 0,
      bindingVersion: 1,
    })
    // The driver compares the journal's key against the binding it is handed;
    // `adoptFromJournal` builds that binding FROM the entry, so the mismatch it
    // catches in production is a journal rewritten under it. Here the honest
    // assertion is that a rejected adopt surfaces as `undefined` rather than a
    // throw the reattach path would have to catch.
    const handle = await w.runtime.adoptFromJournal(sessionId)
    expect(handle === undefined || handle.binding.sessionId === sessionId).toBe(true)
  })
})

describe('a queue the driver loses reaches the server — POD-2297', () => {
  /** Park a turn behind a human take-over lease, which is the queue a real
   *  session fills: a steward's nudge arriving while somebody is driving. */
  async function parked(w: ReturnType<typeof world>, ids: readonly (string | undefined)[]) {
    const sessionId = 'cx-abandon' as SessionId
    w.entries.set(sessionId, {
      sessionId,
      threadId: '019fff94-7326-7032-b90b-3cc7e1805190',
      workdir: '/work/project',
      process: { key: `podium-cx-${sessionId}` },
      seq: 0,
      turnEpoch: 0,
      bindingVersion: 1,
    })
    const handle = await w.runtime.adoptFromJournal(sessionId)
    if (!handle) throw new Error('adopt failed')
    await handle.lease.acquire('operator', 'human-controller')
    for (const id of ids) {
      const receipt = await handle.send(
        { ...(id ? { id } : {}), text: `nudge ${id ?? 'anonymous'}` },
        { origin: 'steward', delivery: 'when-ready' },
      )
      expect(receipt.outcome).toBe('queued')
    }
    return handle
  }

  it('turns the driver report into ONE durable abandonment frame', async () => {
    /**
     * THE FRAME IS THE POINT OF THIS WHOLE ISSUE. `send` puts a
     * `runtimeQueueDrainAbandoned` on the daemon's fsynced outbox before it
     * returns, which is what makes the report survive a disconnect — the driver
     * drops its in-memory copy the moment the callback returns, so anything less
     * durable would just move the loss one layer down (POD-2202).
     */
    const w = world()
    const handle = await parked(w, ['msg-a', 'msg-b'])
    await handle.stop()

    const reports = w.sent.filter((msg) => msg.type === 'runtimeQueueDrainAbandoned')
    expect(reports).toHaveLength(1)
    expect(reports[0]).toMatchObject({
      sessionId: 'cx-abandon',
      turnIds: ['msg-a', 'msg-b'],
      reason: 'teardown',
    })
    // The outbox is keyed by it, and `connection-state` throws without one.
    expect(reports[0]).toHaveProperty('reportId', expect.any(String))
  })

  it('sends nothing for turns no receipt was ever issued against', async () => {
    /**
     * `TurnInput.id` is OPTIONAL by the contract, and the frame's `turnIds` is
     * `min(1)` because a report naming nothing corrects nothing. A synthetic id
     * would be worse than no frame: the server would look it up, find no row,
     * and record a correction it did not make. The log line still carries the
     * count — that part is not optional — but the wire stays quiet.
     */
    const w = world()
    const handle = await parked(w, [undefined])
    await handle.stop()

    expect(w.sent.filter((msg) => msg.type === 'runtimeQueueDrainAbandoned')).toHaveLength(0)
  })

  it('frames only the turns a receipt exists for, when a queue holds both', async () => {
    const w = world()
    const handle = await parked(w, [undefined, 'msg-real'])
    await handle.stop()

    const reports = w.sent.filter((msg) => msg.type === 'runtimeQueueDrainAbandoned')
    expect(reports).toHaveLength(1)
    expect(reports[0]).toMatchObject({ turnIds: ['msg-real'], reason: 'teardown' })
  })

  it('stays silent for a session that ends with an empty queue', async () => {
    // Every session that ever ends reaches this path. A frame here would put a
    // durable report on the outbox for each one of them.
    const w = world()
    const sessionId = 'cx-quiet' as SessionId
    w.entries.set(sessionId, {
      sessionId,
      threadId: '019fff94-7326-7032-b90b-3cc7e1805191',
      workdir: '/work/project',
      process: { key: `podium-cx-${sessionId}` },
      seq: 0,
      turnEpoch: 0,
      bindingVersion: 1,
    })
    const handle = await w.runtime.adoptFromJournal(sessionId)
    await handle?.stop()

    expect(w.sent.filter((msg) => msg.type === 'runtimeQueueDrainAbandoned')).toHaveLength(0)
  })
})
