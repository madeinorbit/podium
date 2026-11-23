/**
 * A SESSION'S LIVE READINGS, AS TOPICS (POD-6764; ADR 7 Amendment 2 D26, D27).
 *
 * Two server-produced value topics carry what the session record used to mix
 * in from server memory:
 *
 * - `session.terminalState`: who controls the terminal, its size, and its exit.
 * - `session.condition`: busy, gated viewport requests, last input time and
 *   context use.
 *
 * None of them would be right when read from a saved copy tomorrow, so none is
 * a record field (ADR 12 D1). How many clients watch is the presence room's
 * occupancy, not a topic.
 *
 * WHERE A VALUE COMES FROM. A session that runs in this process answers from
 * its terminal. A session nothing here holds (stopped, parked, or not yet
 * restored) answers from its ROW: the stored size, the stored last input time
 * and the stored exit, with no controller and not busy. The size is a stored
 * column for exactly this: a client can show the cached terminal view at the
 * right size while the daemon is offline. Subscribing never makes a session
 * resident.
 *
 * WHEN A VALUE IS SENT. The terminal reports each move of a live reading
 * ({@link SessionLiveTopics.changed}), and every session broadcast rechecks the
 * held keys ({@link SessionLiveTopics.recheck}), which covers the moves that
 * are not the terminal's (an exit, a context reading, leaving the map). A key
 * nobody holds costs one map lookup; a value equal to the last one sent is not
 * sent again. This module keeps only what it last sent for HELD keys, and
 * forgets it when the last subscriber leaves.
 */

import type { Geometry, SessionId } from '@podium/model'
import type { SessionConditionPayload, SessionTerminalStatePayload } from '@podium/protocol'
import type { Session } from './session'

export type SessionLiveKind = 'session.terminalState' | 'session.condition'

type PayloadOf<K extends SessionLiveKind> = K extends 'session.terminalState'
  ? SessionTerminalStatePayload
  : SessionConditionPayload

/** What a session's row says about its terminal when nothing runs it. */
export interface StoredSessionLive {
  readonly geometry: Geometry | null | undefined
  readonly lastInputAt: string | null | undefined
  readonly status: Session['status']
  readonly exitCode: number | null | undefined
}

export interface SessionLiveTopicsDeps {
  /** The session as this process runs it; undefined when it is not resident. */
  readonly session: (sessionId: SessionId) => Session | undefined
  /** The row's facts; undefined for an unknown or deleted session. */
  readonly stored: (sessionId: SessionId) => Promise<StoredSessionLive | undefined>
  /** Hand the newest value to the topic routing (dropped when nobody holds it). */
  readonly publish: (kind: SessionLiveKind, sessionId: SessionId, value: unknown) => void
}

const DEFAULT_GEOMETRY: Geometry = { cols: 80, rows: 24 }

const exitOf = (
  status: Session['status'],
  exitCode: number | null | undefined,
): { exit: { code: number } } | Record<string, never> =>
  status === 'exited' && typeof exitCode === 'number' ? { exit: { code: exitCode } } : {}

/** A running session's terminal state, from its terminal. */
export function terminalStateOf(session: Session): SessionTerminalStatePayload {
  const terminal = session.terminal
  return {
    controller: terminal.controllerId,
    ...(terminal.controllerIdentity ? { controllerIdentity: terminal.controllerIdentity } : {}),
    geometry: { cols: terminal.geometry.cols, rows: terminal.geometry.rows },
    ...exitOf(session.status, session.exitCode),
  }
}

/** A running session's condition, from its terminal and its last context reading. */
export function conditionOf(session: Session): SessionConditionPayload {
  const terminal = session.terminal
  return {
    busy: terminal.busy,
    requestsGated: terminal.requestsGated,
    ...(terminal.lastInputAtMs > 0
      ? { lastInputAt: new Date(terminal.lastInputAtMs).toISOString() }
      : {}),
    ...(session.contextUsagePercent !== undefined
      ? { contextUsagePercent: session.contextUsagePercent }
      : {}),
  }
}

/** The terminal state of a session nothing runs: the stored size, nobody in control. */
export function storedTerminalState(row: StoredSessionLive): SessionTerminalStatePayload {
  return {
    controller: null,
    geometry: { ...(row.geometry ?? DEFAULT_GEOMETRY) },
    ...exitOf(row.status, row.exitCode),
  }
}

/** The condition of a session nothing runs: idle, with its stored last input time. */
export function storedCondition(row: StoredSessionLive): SessionConditionPayload {
  return {
    busy: false,
    requestsGated: 0,
    ...(row.lastInputAt ? { lastInputAt: row.lastInputAt } : {}),
  }
}

/** What a session that left this process reads as, from the last value it sent. */
function atRest<K extends SessionLiveKind>(kind: K, last: PayloadOf<K>): PayloadOf<K> {
  if (kind === 'session.terminalState') {
    const { geometry, exit } = last as SessionTerminalStatePayload
    return { controller: null, geometry, ...(exit ? { exit } : {}) } as PayloadOf<K>
  }
  const { lastInputAt } = last as SessionConditionPayload
  return { busy: false, requestsGated: 0, ...(lastInputAt ? { lastInputAt } : {}) } as PayloadOf<K>
}

interface Sent {
  /** The last value handed to a subscriber, and its JSON for the equality check. */
  value?: unknown
  json?: string
}

const KINDS: readonly SessionLiveKind[] = ['session.terminalState', 'session.condition']

export class SessionLiveTopics {
  /** Per HELD key: what was last sent. Emptied by {@link stop}. */
  private readonly held: Record<SessionLiveKind, Map<SessionId, Sent>> = {
    'session.terminalState': new Map(),
    'session.condition': new Map(),
  }
  private recheckQueued = false

  constructor(private readonly deps: SessionLiveTopicsDeps) {}

  /** The key's first subscriber arrived. Nothing is loaded for it. */
  start(kind: SessionLiveKind, sessionId: SessionId): void {
    if (!this.held[kind].has(sessionId)) this.held[kind].set(sessionId, {})
  }

  /** The key's last subscriber left. */
  stop(kind: SessionLiveKind, sessionId: SessionId): void {
    this.held[kind].delete(sessionId)
  }

  /**
   * The current value. Synchronous for a session this process runs; a row read
   * otherwise. Undefined (the snapshot `unknown`) for a session that is gone.
   */
  snapshot<K extends SessionLiveKind>(
    kind: K,
    sessionId: SessionId,
  ): PayloadOf<K> | undefined | Promise<PayloadOf<K> | undefined> {
    const session = this.deps.session(sessionId)
    if (session) return this.remember(kind, sessionId, this.live(kind, session))
    return this.deps.stored(sessionId).then((row) => {
      // It may have become resident while the row was read: the terminal wins.
      const now = this.deps.session(sessionId)
      if (now) return this.remember(kind, sessionId, this.live(kind, now))
      if (!row) return undefined
      const value = (
        kind === 'session.terminalState' ? storedTerminalState(row) : storedCondition(row)
      ) as PayloadOf<K>
      return this.remember(kind, sessionId, value)
    })
  }

  /** A live reading of this session moved (its terminal's listener). */
  changed(sessionId: SessionId): void {
    for (const kind of KINDS) if (this.held[kind].has(sessionId)) this.send(kind, sessionId)
  }

  /**
   * Something about some session changed (the session broadcast): look at every
   * held key once, on the next microtask, however many broadcasts asked.
   */
  recheck(): void {
    if (this.recheckQueued) return
    if (KINDS.every((kind) => this.held[kind].size === 0)) return
    this.recheckQueued = true
    queueMicrotask(() => this.recheckNow())
  }

  /** Deterministic test seam for {@link recheck}. */
  recheckNow(): void {
    this.recheckQueued = false
    for (const kind of KINDS)
      for (const sessionId of [...this.held[kind].keys()]) this.send(kind, sessionId)
  }

  private live<K extends SessionLiveKind>(kind: K, session: Session): PayloadOf<K> {
    return (
      kind === 'session.terminalState' ? terminalStateOf(session) : conditionOf(session)
    ) as PayloadOf<K>
  }

  private remember<K extends SessionLiveKind>(
    kind: K,
    sessionId: SessionId,
    value: PayloadOf<K>,
  ): PayloadOf<K> {
    const sent = this.held[kind].get(sessionId)
    if (sent) {
      sent.value = value
      sent.json = JSON.stringify(value)
    }
    return value
  }

  private send(kind: SessionLiveKind, sessionId: SessionId): void {
    const sent = this.held[kind].get(sessionId)
    if (!sent) return
    const session = this.deps.session(sessionId)
    // A session that left the map keeps its stored facts; only what needed the
    // process (control, busy, the gated count) goes. Before any value was sent
    // there is nothing to derive from, and the snapshot's row read answers.
    const value = session
      ? this.live(kind, session)
      : sent.value !== undefined
        ? atRest(kind, sent.value as PayloadOf<typeof kind>)
        : undefined
    if (value === undefined) return
    const json = JSON.stringify(value)
    if (json === sent.json) return
    sent.value = value
    sent.json = json
    this.deps.publish(kind, sessionId, value)
  }
}
