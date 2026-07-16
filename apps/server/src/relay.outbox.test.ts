import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ControlMessage, ServerMessage, SessionMeta } from '@podium/protocol'
import { describe, expect, it, vi } from 'vitest'
import { SessionRegistry } from './relay'
import { SessionStore } from './store'

// Outbox write path at the registry seam (docs/spec/outbox-write-path.md §2.1-2.2):
// queueText wake + durable delivery, restart survival, FIFO + spacing, the
// withMutation idempotency wrapper, failed-drain row retention, and the
// queuedMessageCount surfacing on the wire (snapshot meta + P2 delta stream).
// The settle-heuristic behaviors themselves (floor/quiet/max) are covered by
// relay.test.ts's 'queueText drain' describe — not duplicated here.

const G = { cols: 80, rows: 24 }
const bind = (sessionId: string) =>
  ({
    type: 'bind',
    sessionId,
    cmd: 'claude',
    cwd: '/',
    agentKind: 'claude-code',
    geometry: G,
  }) as const

const decodedInputs = (daemon: ControlMessage[]): string[] =>
  daemon
    .filter((m) => m.type === 'input')
    .map((m) => Buffer.from((m as { data: string }).data, 'base64').toString())

const pastesContaining = (daemon: ControlMessage[], text: string): string[] =>
  decodedInputs(daemon).filter((t) => t.includes(text))

/** live claude session with a resume ref, parked via hibernate. */
function hibernatedSession(reg: SessionRegistry): string {
  const { sessionId } = reg.modules.sessions.createSession({ agentKind: 'claude-code', cwd: '/w' })
  reg.modules.sessions.onDaemonMessageFrom('local', bind(sessionId))
  reg.modules.sessions.onDaemonMessageFrom('local', {
    type: 'sessionResumeRef',
    sessionId,
    resume: { kind: 'claude-session', value: 'abc-123' },
  })
  expect(reg.modules.sessions.hibernateSession({ sessionId })).toEqual({ ok: true })
  return sessionId
}

/** Drive the readiness engine to 'settled' after a bind: a short burst of output,
 *  then quiet long enough to clear the floor(800)+quiet(600) window (fake timers). */
function settle(reg: SessionRegistry, sessionId: string): void {
  let seq = 0
  for (let i = 0; i < 5; i += 1) {
    reg.modules.sessions.onDaemonMessageFrom('local', {
      type: 'agentFrame',
      sessionId,
      seq: seq++,
      data: 'eA==',
    })
    vi.advanceTimersByTime(200)
  }
  vi.advanceTimersByTime(1400)
}

describe('queueText (durable outbox sends)', () => {
  it('wakes a hibernated resumable session, shows the count, and delivers exactly once after bind + settle', () => {
    vi.useFakeTimers()
    try {
      const reg = new SessionRegistry()
      const daemon: ControlMessage[] = []
      reg.modules.sessions.attachDaemon('local', (m) => daemon.push(m))
      const sessionId = hibernatedSession(reg)
      daemon.length = 0

      expect(reg.modules.sessions.queueText({ sessionId, text: 'wake-up-msg' })).toEqual({
        ok: true,
        queued: true,
      })
      // The wake: a spawn under the same id carrying the resume ref.
      expect(daemon).toContainEqual(
        expect.objectContaining({
          type: 'spawn',
          sessionId,
          resume: { kind: 'claude-session', value: 'abc-123' },
        }),
      )
      // The queued count rides the session meta while the message waits...
      expect(reg.modules.sessions.listSessions()[0]?.queuedMessageCount).toBe(1)
      // ...and nothing is typed while the respawn is still starting.
      expect(pastesContaining(daemon, 'wake-up-msg')).toHaveLength(0)

      reg.modules.sessions.onDaemonMessageFrom('local', bind(sessionId))
      settle(reg, sessionId)

      // Exactly ONE bracketed-paste input containing the text (no double-type).
      expect(pastesContaining(daemon, 'wake-up-msg')).toEqual(['\x1b[200~wake-up-msg\x1b[201~'])
      // Delivered: the count leaves the meta and the durable row is gone.
      expect(reg.modules.sessions.listSessions()[0]?.queuedMessageCount).toBeUndefined()
      expect(reg.sessionStore.sync.listQueuedMessages(sessionId)).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('a due one-off wakes a hibernated target and delivers its message exactly once', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-16T22:00:00.000Z'))
    const reg = new SessionRegistry()
    try {
      const daemon: ControlMessage[] = []
      reg.modules.sessions.attachDaemon('local', (message) => daemon.push(message))
      const sessionId = hibernatedSession(reg)
      daemon.length = 0
      const runAt = '2026-07-16T22:02:00.000Z'
      const automation = reg.modules.automations.create({
        name: 'Night quota wake',
        scheduleKind: 'once',
        runAt,
        targetSessionId: sessionId,
        repoPath: '/w',
        agentKind: 'claude-code',
        prompt: 'continue-night-work',
        enabled: true,
        sessionMode: 'resume',
      })

      vi.setSystemTime(new Date('2026-07-16T22:02:01.000Z'))
      reg.modules.automations.tick()

      expect(daemon).toContainEqual(
        expect.objectContaining({
          type: 'spawn',
          sessionId,
          resume: { kind: 'claude-session', value: 'abc-123' },
        }),
      )
      expect(pastesContaining(daemon, 'continue-night-work')).toHaveLength(0)

      reg.modules.sessions.onDaemonMessageFrom('local', bind(sessionId))
      settle(reg, sessionId)

      expect(pastesContaining(daemon, 'continue-night-work')).toEqual([
        '\x1b[200~continue-night-work\x1b[201~',
      ])
      expect(reg.modules.automations.runs(automation.id)).toEqual([
        expect.objectContaining({ outcome: 'spawned', sessionId }),
      ])
      expect(reg.modules.automations.list()[0]).toMatchObject({
        enabled: false,
        nextRunAt: null,
        lastRunAt: runAt,
      })

      reg.modules.automations.tick()
      expect(reg.modules.automations.runs(automation.id)).toHaveLength(1)
      expect(pastesContaining(daemon, 'continue-night-work')).toHaveLength(1)
    } finally {
      reg.dispose()
      vi.useRealTimers()
    }
  })

  it('refuses a parked agent with no resume ref and queues NOTHING', () => {
    const reg = new SessionRegistry()
    const daemon: ControlMessage[] = []
    reg.modules.sessions.attachDaemon('local', (m) => daemon.push(m))
    const { sessionId } = reg.modules.sessions.createSession({
      agentKind: 'claude-code',
      cwd: '/w',
    })
    reg.modules.sessions.onDaemonMessageFrom('local', bind(sessionId))
    reg.modules.sessions.onDaemonMessageFrom('local', { type: 'agentExit', sessionId, code: 1 })
    daemon.length = 0

    expect(reg.modules.sessions.queueText({ sessionId, text: 'into-the-void' })).toEqual({
      ok: false,
      reason: 'no resume ref',
    })
    // No durable row, no count on the meta, no wake attempt.
    expect(reg.sessionStore.sync.listQueuedMessages(sessionId)).toEqual([])
    expect(reg.modules.sessions.listSessions()[0]?.queuedMessageCount).toBeUndefined()
    expect(daemon.filter((m) => m.type === 'spawn')).toEqual([])
  })

  it('survives a server restart: count re-seeds from the table and delivery happens after the wake', () => {
    vi.useFakeTimers()
    try {
      const file = join(mkdtempSync(join(tmpdir(), 'podium-outbox-relay-')), 'podium.db')
      const storeA = new SessionStore(file)
      const regA = new SessionRegistry(storeA)
      const daemonA: ControlMessage[] = []
      regA.modules.sessions.attachDaemon('local', (m) => daemonA.push(m))
      const sessionId = hibernatedSession(regA)
      expect(regA.modules.sessions.queueText({ sessionId, text: 'survive-restart' })).toEqual({
        ok: true,
        queued: true,
      })
      expect(pastesContaining(daemonA, 'survive-restart')).toHaveLength(0)
      regA.dispose()
      storeA.close()

      // Restart: fresh store + registry over the same DB file.
      const storeB = new SessionStore(file)
      const regB = new SessionRegistry(storeB)
      expect(
        regB.modules.sessions.listSessions().find((s) => s.sessionId === sessionId)
          ?.queuedMessageCount,
      ).toBe(1)

      const daemonB: ControlMessage[] = []
      regB.modules.sessions.attachDaemon('local', (m) => daemonB.push(m))
      regB.modules.sessions.onDaemonMessageFrom('local', bind(sessionId))
      // Silent respawn: no output at all — the READY_MAX fallback (6s) delivers.
      vi.advanceTimersByTime(7_000)
      expect(pastesContaining(daemonB, 'survive-restart')).toHaveLength(1)
      expect(regB.sessionStore.sync.listQueuedMessages(sessionId)).toEqual([])
      expect(
        regB.modules.sessions.listSessions().find((s) => s.sessionId === sessionId)
          ?.queuedMessageCount,
      ).toBeUndefined()
      regB.dispose()
      storeB.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('delivers two queued messages FIFO, spaced, each as its own input', () => {
    vi.useFakeTimers()
    try {
      const reg = new SessionRegistry()
      const daemon: ControlMessage[] = []
      reg.modules.sessions.attachDaemon('local', (m) => daemon.push(m))
      const { sessionId } = reg.modules.sessions.createSession({
        agentKind: 'claude-code',
        cwd: '/w',
      })
      reg.modules.sessions.onDaemonMessageFrom('local', bind(sessionId))

      reg.modules.sessions.queueText({ sessionId, text: 'first-msg' })
      reg.modules.sessions.queueText({ sessionId, text: 'second-msg' })
      expect(reg.modules.sessions.listSessions()[0]?.queuedMessageCount).toBe(2)

      // Silent TUI → READY_MAX fallback delivers the head at ~6.2s...
      vi.advanceTimersByTime(6_400)
      expect(pastesContaining(daemon, 'first-msg')).toHaveLength(1)
      // ...but the second waits out the spacing gap (never fused onto the same tick).
      expect(pastesContaining(daemon, 'second-msg')).toHaveLength(0)
      vi.advanceTimersByTime(600)

      // Both delivered, in enqueue order, as SEPARATE bracketed-paste inputs.
      const pastes = decodedInputs(daemon).filter((t) => t.startsWith('\x1b[200~'))
      expect(pastes).toEqual(['\x1b[200~first-msg\x1b[201~', '\x1b[200~second-msg\x1b[201~'])
      expect(reg.modules.sessions.listSessions()[0]?.queuedMessageCount).toBeUndefined()
      expect(reg.sessionStore.sync.listQueuedMessages(sessionId)).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('a failed drain (never live before the deadline) keeps the rows; the next bind delivers', () => {
    vi.useFakeTimers()
    try {
      const reg = new SessionRegistry()
      const daemon: ControlMessage[] = []
      reg.modules.sessions.attachDaemon('local', (m) => daemon.push(m))
      // No bind: the session sits in 'starting' past the 25s drain deadline.
      const { sessionId } = reg.modules.sessions.createSession({
        agentKind: 'claude-code',
        cwd: '/w',
      })
      reg.modules.sessions.queueText({ sessionId, text: 'patient-msg' })

      vi.advanceTimersByTime(26_000)
      expect(pastesContaining(daemon, 'patient-msg')).toHaveLength(0)
      // The attempt gave up but the ROWS REMAIN — nothing was dropped.
      expect(reg.sessionStore.sync.listQueuedMessages(sessionId)).toHaveLength(1)
      expect(reg.modules.sessions.listSessions()[0]?.queuedMessageCount).toBe(1)

      // The PTY finally binds → a fresh attempt re-arms and delivers after settle.
      reg.modules.sessions.onDaemonMessageFrom('local', bind(sessionId))
      settle(reg, sessionId)
      expect(pastesContaining(daemon, 'patient-msg')).toHaveLength(1)
      expect(reg.sessionStore.sync.listQueuedMessages(sessionId)).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('surfaces the queued count on the P2 delta stream (session upsert with queuedMessageCount 1)', () => {
    const reg = new SessionRegistry()
    reg.modules.sessions.attachDaemon('local', () => {})
    const sessionId = hibernatedSession(reg)

    const inbox: ServerMessage[] = []
    const clientId = reg.modules.sessions.attachClient((m) => inbox.push(m))
    reg.modules.sessions.onClientMessage(clientId, {
      type: 'hello',
      clientId: '',
      viewport: { cols: 80, rows: 24, dpr: 1 },
      caps: ['metadataDelta'],
    })
    const before = inbox.length

    reg.modules.sessions.queueText({ sessionId, text: 'queued-while-parked' })
    reg.modules.sessions.flushBroadcasts() // earlier setup broadcasts armed the coalescer — run the pending pipeline

    const changes = inbox
      .slice(before)
      .flatMap((m) => (m.type === 'metadataDelta' ? m.changes : []))
    const upserts = changes.filter(
      (c) => c.entity === 'session' && c.id === sessionId && c.op === 'upsert',
    )
    expect(upserts.length).toBeGreaterThanOrEqual(1)
    expect(upserts.some((c) => (c.value as SessionMeta).queuedMessageCount === 1)).toBe(true)
  })

  it('clears an existing snooze when a message is queued (fresh user intent)', () => {
    const reg = new SessionRegistry()
    reg.modules.sessions.attachDaemon('local', () => {})
    const sessionId = hibernatedSession(reg)
    reg.modules.sessions.setSnooze({ sessionId, until: null })
    expect(reg.modules.sessions.listSessions()[0]?.snoozedUntil).toBeNull()

    reg.modules.sessions.queueText({ sessionId, text: 'un-snooze' })
    expect('snoozedUntil' in (reg.modules.sessions.listSessions()[0] ?? {})).toBe(false)
    expect(reg.sessionStore.sessions.listSnoozes()).toEqual({})
  })
})

describe('withMutation (idempotency wrapper)', () => {
  it('runs once per id; a replay returns the recorded result without re-running', () => {
    const reg = new SessionRegistry()
    let runs = 0
    const first = reg.modules.sessions.withMutation('m-1', 'test.proc', () => {
      runs += 1
      return { ok: true, ids: ['a', 'b'] }
    })
    const replay = reg.modules.sessions.withMutation('m-1', 'test.proc', () => {
      runs += 1
      return { ok: true, ids: ['DIFFERENT'] }
    })
    expect(runs).toBe(1)
    expect(first).toEqual({ ok: true, ids: ['a', 'b'] })
    expect(replay).toEqual(first) // deep-equal via the JSON round-trip

    // A different id runs again.
    const other = reg.modules.sessions.withMutation('m-2', 'test.proc', () => {
      runs += 1
      return { ok: true, ids: ['c'] }
    })
    expect(runs).toBe(2)
    expect(other).toEqual({ ok: true, ids: ['c'] })

    // No id at all = today's behavior: always runs.
    reg.modules.sessions.withMutation(undefined, 'test.proc', () => {
      runs += 1
      return 1
    })
    reg.modules.sessions.withMutation(undefined, 'test.proc', () => {
      runs += 1
      return 1
    })
    expect(runs).toBe(4)
  })

  it('records the RESOLVED value of an async proc, not the pending Promise (issues.create shape)', async () => {
    // Regression guard: JSON.stringify(promise) === '{}', which would poison every
    // replay of an async proc with an empty object.
    const reg = new SessionRegistry()
    let runs = 0
    const fn = async () => {
      runs += 1
      return { id: 'issue-1', title: 'once' }
    }
    const first = await reg.modules.sessions.withMutation('m-async', 'issues.create', fn)
    const replay = await reg.modules.sessions.withMutation('m-async', 'issues.create', fn)
    expect(runs).toBe(1)
    expect(first).toEqual({ id: 'issue-1', title: 'once' })
    expect(replay).toEqual(first)
  })

  it('a replayed sendText types exactly one input frame (no double-type into the PTY)', () => {
    vi.useFakeTimers()
    try {
      const reg = new SessionRegistry()
      const daemon: ControlMessage[] = []
      reg.modules.sessions.attachDaemon('local', (m) => daemon.push(m))
      const { sessionId } = reg.modules.sessions.createSession({
        agentKind: 'claude-code',
        cwd: '/w',
      })
      reg.modules.sessions.onDaemonMessageFrom('local', bind(sessionId))

      const send = () =>
        reg.modules.sessions.withMutation('send-1', 'sessions.sendText', () =>
          reg.modules.sessions.sendText({ sessionId, text: 'only-once' }),
        )
      expect(send()).toEqual({ ok: true })
      expect(send()).toEqual({ ok: true }) // recorded result, fn not re-run
      vi.advanceTimersByTime(200) // flush the deferred submit CR

      expect(pastesContaining(daemon, 'only-once')).toHaveLength(1)
      // One paste + one CR — nothing else went to the PTY.
      expect(decodedInputs(daemon)).toEqual(['\x1b[200~only-once\x1b[201~', '\r'])
    } finally {
      vi.useRealTimers()
    }
  })
})
