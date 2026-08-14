/**
 * THE CLIENT TERMINAL FOR A SERVER-FAMILY SESSION (POD-2059; spec §5).
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS, AND WHY IT IS A SEPARATE PROCESS FROM THE SESSION
 * ---------------------------------------------------------------------------
 *
 * A terminal-family session IS a terminal: `attach()` there is a typed
 * description of a frames path that already exists. A server-family session has
 * no PTY at all — it is an HTTP server the driver talks to — so `attach()` has to
 * PRODUCE the terminal. opencode ships exactly the one this needs
 * (`opencode attach <url>`), so the interactive surface for one of these sessions
 * is that client, run beside the session and pointed at the session's own
 * loopback server.
 *
 * Beside, never inside. The client is a convenience the user opened and closed;
 * the session is the work. Spec §5 makes that structural: the client runs under
 * abduco in a scope SIBLING to the session's, so it can be reclaimed on its own,
 * it dies when the session does, and — the rule with teeth — its memory never
 * counts against the agent's budget.
 *
 * ---------------------------------------------------------------------------
 * THE LABEL IS NOT A SUFFIX, AND THAT IS THE MEMORY RULE
 * ---------------------------------------------------------------------------
 *
 * `podium-oc-attach-<id>`, not `podium-oc-<id>-attach`. The daemon attributes a
 * session's memory by walking `/proc` and claiming every process whose cmdline
 * CONTAINS the session's label (`attributeMemory` in `../memory-breakdown.ts`) —
 * a substring test, because a durable master's label only ever appears inside a
 * longer argv. A `-attach` suffix contains the session's own label, so the whole
 * client TUI would be claimed as the agent's memory: the exact thing §5 forbids,
 * arrived at silently, in a number an operator reads as the agent being fat.
 * `opencode-attach.test.ts` pins it against the real attribution function.
 *
 * ---------------------------------------------------------------------------
 * WARM-PARKING, AND THE CLOCK THIS BUILD CAN ACTUALLY MEASURE
 * ---------------------------------------------------------------------------
 *
 * §5 wants a client that is PARKED on detach rather than killed, so bouncing
 * between sessions is an abduco reconnect and not a cold TUI start. The parked
 * thing is the abduco MASTER: it holds the running client, survives this daemon,
 * and a later attach reconnects to it (`spawnAbducoAgent` adopts a live master
 * that already owns the label).
 *
 * What this build cannot measure is DETACH. `attach` has no wire frame — nothing
 * remote negotiates one yet (see `runtime/handlers.ts`) — so there is no viewer
 * whose disconnect could start an idle clock. So the clock here is the one that
 * is real: time since the last `attach()`, re-armed by every later one. When
 * attach v2 lands a viewer connect/disconnect frame, THAT is what should re-arm
 * {@link OpencodeClientTerminals.attach}'s timer, and this comment is the place
 * that says so.
 *
 * ---------------------------------------------------------------------------
 * THE GAP THIS DELIBERATELY LEAVES: NOTHING TYPES BACK YET
 * ---------------------------------------------------------------------------
 *
 * Frames go OUT on the relay; nothing comes IN. The daemon's `input`/`resize`
 * handlers are keyed by session id off `ctx.bridges`, and this attachment is
 * deliberately NOT registered there — a bridge entry is also a memory-attribution
 * hint (`control/discovery.ts`), so registering one would publish a phantom
 * agent row for a "session" the server has never heard of. The stream id has no
 * viewer to receive input from anyway until attach v2 defines one.
 *
 * That is not cosmetic, and `opencode-attach.live.test.ts` records why: opencode's
 * TUI is opentui, which INTERROGATES the terminal (mode/capability queries) and
 * waits for the answers before it draws. With no input path, a live client
 * completes its handshake and then holds — the process, the scope, the warm
 * window and the stream are all real; the picture is what is missing. Wiring a
 * viewer's keystrokes and geometry to an attachment stream is attach v2's daemon
 * half, and it is filed rather than half-built here.
 */

import { randomUUID } from 'node:crypto'
import { createLogger } from '@podium/logger'
import type { Geometry, SessionId } from '@podium/model'
import {
  type AbducoSpawnOptions,
  type AgentSession,
  abducoSocketPath,
  killAbducoSession,
  spawnAbducoAgent,
} from '@podium/pty'

const log = createLogger('daemon:opencode-attach')

/** §5's default idle window. Configurable through {@link OpencodeClientTerminalPorts}
 *  rather than an env knob: the only caller is the daemon's own wiring, and a
 *  setting nobody sets is a setting nobody maintains. */
export const WARM_TTL_MS = 30 * 60_000

/**
 * The size the client is BORN at, not the size it stays.
 *
 * No viewer has told us its grid — the attach request carries no geometry, for
 * the same reason there is no detach signal — so this is a readable default a
 * TUI renders sanely at. The first `resize` for this stream reflows it, once
 * attach v2 routes one.
 */
const DEFAULT_GEOMETRY: Geometry = { cols: 120, rows: 40 }

/** The durable label of a session's client terminal. See the header: the session's
 *  own label must NOT be a substring of it. */
export const opencodeAttachLabel = (sessionId: SessionId): string =>
  `podium-oc-attach-${sessionId}`

/** Everything the client needs to open the RIGHT conversation on the RIGHT server. */
export interface OpencodeClientTerminalTarget {
  /** The session's own loopback server. */
  url: string
  username: string
  secret: string
  /** opencode's id for the conversation the agent is running. Without it the TUI
   *  would open a different one, which is not an attach. */
  opencodeSessionId: string
  workdir: string
}

export interface OpencodeClientTerminals {
  /**
   * Start (or re-warm) this session's client terminal.
   *
   * ONE PER SESSION. `peek` and `takeover` get the same screen, because they are
   * the same screen — who may type into it is the control LEASE's question, which
   * the driver answers before it ever reaches this port, and "spectators are
   * unlimited" is the contract's own wording.
   */
  attach(input: {
    sessionId: SessionId
    target: OpencodeClientTerminalTarget
    mode: 'takeover' | 'peek'
  }): Promise<{ streamId: string; warmTtlMs: number }>
  /**
   * Take responsibility for a client terminal that outlived this daemon.
   *
   * The master is in its own scope, so a daemon restart leaves it running with
   * nobody holding its idle clock. Adopting it puts it back under the reaper;
   * without this it would sit resident until the machine rebooted.
   */
  adopt(sessionId: SessionId): void
  /** The session is going away, or the idle window closed. Attachments are
   *  strictly subordinate: stop/hibernate/kill the session and its client dies. */
  close(sessionId: SessionId): Promise<void>
}

export interface OpencodeClientTerminalPorts {
  /**
   * Where the client's frames go: the daemon's own relay, keyed by the stream id
   * this module minted. The SAME path the engine variant's endpoint names — an
   * attach endpoint that pointed at a transport nobody serves would be a promise
   * this build cannot keep.
   */
  frames(streamId: string, frameBase64: string): void
  /** Injection seams. The defaults are the real abduco. */
  spawn?(opts: AbducoSpawnOptions): Promise<AgentSession>
  reclaim?(label: string): Promise<void>
  /** Is a durable master still holding this label? A socket-dir read, not an
   *  `abduco` fork — this runs on the session teardown path. */
  hasMaster?(label: string): boolean
  geometry?: Geometry
  warmTtlMs?: number
  setTimer?(fn: () => void, ms: number): unknown
  clearTimer?(handle: unknown): void
}

interface Attachment {
  streamId: string
  label: string
  /** The client PTY. Absent between the master being adopted and a viewer's
   *  first attach — and after the client exits while the master lives on. */
  session?: AgentSession
  /** In-flight start, so two concurrent attaches produce ONE client. */
  starting?: Promise<AgentSession>
  timer?: unknown
}

export function createOpencodeClientTerminals(
  ports: OpencodeClientTerminalPorts,
): OpencodeClientTerminals {
  const spawn = ports.spawn ?? spawnAbducoAgent
  const reclaim = ports.reclaim ?? ((label: string) => killAbducoSession(label))
  const hasMaster = ports.hasMaster ?? ((label: string) => abducoSocketPath(label) !== undefined)
  const geometry = ports.geometry ?? DEFAULT_GEOMETRY
  const warmTtlMs = ports.warmTtlMs ?? WARM_TTL_MS
  const setTimer =
    ports.setTimer ??
    ((fn: () => void, ms: number) => {
      const timer = setTimeout(fn, ms)
      timer.unref?.()
      return timer
    })
  const clearTimer =
    ports.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>))

  const attachments = new Map<SessionId, Attachment>()

  const disarm = (record: Attachment): void => {
    if (record.timer !== undefined) clearTimer(record.timer)
    record.timer = undefined
  }

  const arm = (sessionId: SessionId, record: Attachment): void => {
    disarm(record)
    record.timer = setTimer(() => {
      log.info('reaping a client terminal whose warm window closed', {
        sessionId,
        label: record.label,
      })
      void close(sessionId)
    }, warmTtlMs)
  }

  async function start(
    record: Attachment,
    target: OpencodeClientTerminalTarget,
  ): Promise<AgentSession> {
    const session = await spawn({
      label: record.label,
      cmd: 'opencode',
      // The session id is NOT a secret and belongs in argv — an operator reading
      // `ps` should be able to see which conversation this TUI is showing.
      args: ['attach', target.url, '--session', target.opencodeSessionId],
      cwd: target.workdir,
      cols: geometry.cols,
      rows: geometry.rows,
      env: {
        // THE SECRET RIDES THE ENV, NEVER ARGV — the same rule, for the same
        // reason, as the server it is connecting to (see `opencode-server.ts`
        // §6 rule 2): `/proc/<pid>/cmdline` is world-readable and this credential
        // fronts an agent with a shell. `opencode attach` reads both of these.
        OPENCODE_SERVER_USERNAME: target.username,
        OPENCODE_SERVER_PASSWORD: target.secret,
      },
    })
    record.session = session
    session.onFrame((frame) => ports.frames(record.streamId, frame.data))
    session.onExit(() => {
      // THE CLIENT EXITING IS NOT THE ATTACHMENT ENDING. abduco's master (and the
      // TUI inside it) survives a client that was disposed, crashed or was killed
      // by a redeploy — that survival is what "warm" means. Drop the handle and
      // let the next attach reconnect; the reaper still owns the deadline.
      record.session = undefined
    })
    return session
  }

  async function close(sessionId: SessionId): Promise<void> {
    const record = attachments.get(sessionId)
    const label = record?.label ?? opencodeAttachLabel(sessionId)
    attachments.delete(sessionId)
    if (record) disarm(record)
    // Nothing of ours, and no master holding the label: do not pay three process
    // spawns per session teardown to reclaim something that was never started.
    if (!record && !hasMaster(label)) return
    try {
      record?.session?.dispose()
    } catch {
      // the client is already gone; the master below is the reclaim that matters
    }
    await reclaim(label)
  }

  return {
    async attach({ sessionId, target }) {
      let record = attachments.get(sessionId)
      if (!record) {
        record = { streamId: randomUUID(), label: opencodeAttachLabel(sessionId) }
        attachments.set(sessionId, record)
      }
      // Armed BEFORE the spawn: a start that hangs must not leave an unreaped
      // master behind if the caller gives up on it.
      arm(sessionId, record)
      if (!record.session) {
        const pending = record.starting ?? start(record, target)
        record.starting = pending
        let started: AgentSession
        try {
          started = await pending
        } catch (err) {
          // A client that never started is not an attachment. Drop the record so
          // the next attach retries rather than handing back a stream that
          // carries nothing, and let the caller turn this into the refusal.
          if (attachments.get(sessionId) === record) {
            disarm(record)
            attachments.delete(sessionId)
          }
          throw err
        } finally {
          record.starting = undefined
        }
        /**
         * EVICTED WHILE STARTING — the rare case that would otherwise leak.
         *
         * `close()` (the reaper, or the session going away) can land between the
         * spawn being issued and its client coming back. The record it deleted
         * cannot be resurrected: its reclaim already SIGTERMed the master this
         * spawn was about to hand back. So take the process down rather than
         * return a stream to a client nothing is tracking, and let the caller
         * ask again.
         */
        if (attachments.get(sessionId) !== record) {
          started.dispose()
          await reclaim(record.label)
          throw new Error('the client terminal was closed while it was starting')
        }
      }
      return { streamId: record.streamId, warmTtlMs }
    },

    adopt(sessionId) {
      if (attachments.has(sessionId)) return
      const label = opencodeAttachLabel(sessionId)
      if (!hasMaster(label)) return
      const record: Attachment = { streamId: randomUUID(), label }
      attachments.set(sessionId, record)
      arm(sessionId, record)
      log.info('adopted a client terminal that outlived the daemon', { sessionId, label })
    },

    close,
  }
}
