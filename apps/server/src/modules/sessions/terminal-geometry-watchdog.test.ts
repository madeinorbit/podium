/**
 * THE WATCHDOG ON THE OTHER HALF OF THE SIZING PATH (POD-3809, stage 7 of
 * POD-3190).
 *
 * Stage 7 fixed a daemon path that APPLIED a grid and never reported it. What
 * made that cost two visible seconds rather than two minutes of debugging is
 * that nothing anywhere said a word: the daemon logged nothing, the server
 * logged nothing, and the viewer just rendered the wrong size until some later
 * ask happened to go down a branch that did report.
 *
 * The server is the only place that holds BOTH halves — "I forwarded a request"
 * and "a report came back" — so it is the only place the liveness of the whole
 * path is observable at all. This suite is that observation, and it is
 * deliberately mode-blind: it knows nothing about ptys, client terminals or
 * harnesses, so it covers modes nobody has written yet.
 *
 * BOTH DIRECTIONS ARE EXECUTED. An answered request must log nothing and count
 * nothing — a watchdog that fires on healthy traffic is worse than none, because
 * it teaches everyone to ignore the line.
 */

import { addSink, configureLevelsFromEnv, createRingBufferSink, resetLogging } from '@podium/logger'
import {
  asSessionId,
  asUserId,
  firstAdminMemberId,
  type Geometry,
  SessionMeta,
} from '@podium/model'
import type { ServerMessage } from '@podium/protocol'
import type { ControlMessage } from '@podium/protocol/daemon'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClientPrincipal } from '../../gateway/client-principal'
import { userClientPrincipal } from '../../gateway/client-principal'
import type { ClientConn } from '../../gateway/client-registry'
import { SessionTerminal } from './terminal'

const SESSION = asSessionId('s-watchdog')
const OWNER = asUserId(firstAdminMemberId())
const GEO: Geometry = { cols: 80, rows: 24 }
const ASKED: Geometry = { cols: 203, rows: 51 }

/** Comfortably past the server's deadline; the test never waits in real time. */
const PAST_THE_DEADLINE_MS = 5000

type Sent = ClientConn & { sent: ServerMessage[]; principal: ClientPrincipal }

/** The real log pipeline into a ring buffer: what the journal would receive,
 *  asserted as records rather than as strings a console sink happened to
 *  format. */
let logs = createRingBufferSink({ capacity: 32 })

function warnings(): Array<Record<string, unknown>> {
  return (logs.snapshot() as Array<Record<string, unknown>>).filter(
    (record) => record.level === 'warn',
  )
}

function makeClient(id: string): Sent {
  const sent: ServerMessage[] = []
  return {
    id,
    principal: userClientPrincipal(id, OWNER, 'admin'),
    send: (m: ServerMessage) => sent.push(m),
    viewports: new Map(),
    viewportSeq: new Map(),
    attached: new Set(),
    caps: new Set(),
    wireVersion: 1,
    transcriptSubs: new Set(),
    visible: true,
    viewVisible: new Set(),
    focused: null,
    viewModes: {},
    sent,
  } as unknown as Sent
}

/** The real SessionTerminal, over a recording daemon channel, on a daemon that
 *  REPORTS — the only configuration where the server waits for an answer. */
function harness(daemonReports = true): {
  terminal: SessionTerminal
  /** Only the resizes: attaching a client also sends a `redraw`, and this suite
   *  is about what was FORWARDED as an ask. */
  resizes(): ControlMessage[]
  ask(geometry: Geometry, seq?: number): void
} {
  const toDaemon: ControlMessage[] = []
  const terminal = new SessionTerminal({
    sessionId: SESSION,
    agentKind: 'claude-code',
    geometry: { ...GEO },
    toDaemon: (m) => toDaemon.push(m),
    daemonReportsGeometry: () => daemonReports,
  })
  const client = makeClient('c1')
  client.viewVisible.add(SESSION)
  client.viewModes = { [SESSION]: 'native' }
  terminal.attachClient(client)
  expect(terminal.controllerId).toBe(client.id)
  return {
    terminal,
    resizes: () => toDaemon.filter((m) => m.type === 'resize'),
    ask: (geometry, seq = 1) =>
      terminal.handleViewportRequest(client.id, {
        geometry,
        visible: true,
        mode: 'native',
        // Not a claim: this client is already the controller, and a claim takes
        // a different road through `requestControl`. The plain ask is the one
        // that ends in `driveGeometry`.
        claimControl: false,
        seq,
      }),
  }
}

beforeEach(() => {
  resetLogging()
  configureLevelsFromEnv({})
  logs = createRingBufferSink({ capacity: 32 })
  addSink(logs)
  vi.useFakeTimers()
})
afterEach(() => {
  resetLogging()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('a forwarded request the daemon never answers', () => {
  it('logs once and counts once, naming the size that went unanswered', () => {
    const h = harness()

    h.ask(ASKED)
    // ARMED: the request really was forwarded, so what follows is about the
    // ANSWER and not about a request the server refused on its own.
    expect(h.resizes()).toMatchObject([{ type: 'resize', cols: 203, rows: 51 }])
    // …and nothing has been said yet: a resize in flight is not a fault.
    expect(h.terminal.requestsUnanswered).toBe(0)
    expect(warnings()).toEqual([])

    vi.advanceTimersByTime(PAST_THE_DEADLINE_MS)

    expect(h.terminal.requestsUnanswered).toBe(1)
    expect(warnings()).toHaveLength(1)
    // Everything a reader needs off ONE journal line: which session, what was
    // asked for, what W actually is, what that W is worth, and how long it has
    // been. Anything missing here sends the reader back to the code.
    expect(warnings()[0]).toMatchObject({
      ns: 'server:sessions:terminal',
      msg: 'request:unanswered',
      sessionId: SESSION,
      requested: { cols: 203, rows: 51 },
      geometry: GEO,
      geometryState: 'unknown',
      requestsUnanswered: 1,
    })
    expect(warnings()[0]?.elapsedMs).toBeGreaterThanOrEqual(0)
    // W never moved — which is the whole complaint.
    expect(h.terminal.geometry).toEqual(GEO)
  })

  it('fires ONCE per unanswered request, not once per timer tick', () => {
    const h = harness()
    h.ask(ASKED)
    vi.advanceTimersByTime(PAST_THE_DEADLINE_MS * 4)
    expect(h.terminal.requestsUnanswered).toBe(1)
    expect(warnings()).toHaveLength(1)
  })

  it('counts the LATEST request only — a newer ask supersedes the one in flight', () => {
    const h = harness()
    h.ask(ASKED, 1)
    h.ask({ cols: 100, rows: 30 }, 2)

    vi.advanceTimersByTime(PAST_THE_DEADLINE_MS)

    // One session, one W, one thing to be waiting for. Two timers here would
    // turn a viewer dragging a window edge into a wall of warnings.
    expect(h.terminal.requestsUnanswered).toBe(1)
    expect(warnings()[0]).toMatchObject({ requested: { cols: 100, rows: 30 } })
  })
})

describe('a forwarded request the daemon DOES answer', () => {
  it('logs nothing and counts nothing', () => {
    const h = harness()

    h.ask(ASKED)
    h.terminal.applyDaemonGeometry(ASKED)

    vi.advanceTimersByTime(PAST_THE_DEADLINE_MS)

    expect(h.terminal.requestsUnanswered).toBe(0)
    expect(warnings()).toEqual([])
    // And the report did what a report does: W moved and is now confirmed.
    expect(h.terminal.geometry).toEqual(ASKED)
    expect(h.terminal.geometryKnown).toBe(true)
  })

  it('is answered by ANY report, not only one at the size asked for', () => {
    const h = harness()

    h.ask(ASKED)
    // The daemon reports what it APPLIED. A daemon that applied something else
    // has still spoken, and the fault this watches for is silence.
    h.terminal.applyDaemonGeometry({ cols: 199, rows: 50 })

    vi.advanceTimersByTime(PAST_THE_DEADLINE_MS)

    expect(h.terminal.requestsUnanswered).toBe(0)
    expect(warnings()).toEqual([])
  })
})

describe('the watchdog only exists where an answer is owed', () => {
  it('arms nothing on a daemon that does not report — the server writes W itself', () => {
    const h = harness(false)

    h.ask(ASKED)
    vi.advanceTimersByTime(PAST_THE_DEADLINE_MS)

    // The compatibility branch moved W on the request, so there is nothing to
    // wait for. Warning here would fire on every resize an old daemon serves.
    expect(h.terminal.geometry).toEqual(ASKED)
    expect(h.terminal.requestsUnanswered).toBe(0)
    expect(warnings()).toEqual([])
  })

  it('arms nothing for a request equal to W, which is never forwarded', () => {
    const h = harness()

    h.ask(GEO)
    vi.advanceTimersByTime(PAST_THE_DEADLINE_MS)

    expect(h.resizes()).toEqual([])
    expect(h.terminal.requestsUnanswered).toBe(0)
    expect(warnings()).toEqual([])
  })
})

describe('the count reaches the session row', () => {
  it('is absent at zero and present once something has gone unanswered', () => {
    // The row is the only place a human sees this without a journal. Absent at
    // zero keeps it additive for a reader that has never heard of it.
    const zero = SessionMeta.shape.requestsUnanswered.safeParse(undefined)
    expect(zero.success).toBe(true)
    expect(SessionMeta.shape.requestsUnanswered.safeParse(3).success).toBe(true)
    expect(SessionMeta.shape.requestsUnanswered.safeParse(-1).success).toBe(false)
  })
})
