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
 * IDLE MEANS "NOBODY IS WATCHING", AND THE DAEMON CAN SEE THAT. An attachment
 * belongs to a session, and the server already tells this machine when a
 * session's viewers come and go: `sessionPriority` (0 focused … 3 unwatched) is
 * computed from the live client set and sent on every change. So the clock here
 * is armed while the session is UNWATCHED and held off while a viewer has it
 * open — {@link OpencodeClientTerminals.viewers}, called from the daemon's
 * `sessionPriority` handler.
 *
 * It is remembered per SESSION, not just per attachment, and a new attachment is
 * SEEDED from it. The frame is sent only on change, so a session already on
 * screen when its terminal is attached announces nothing — and an attachment
 * born unwatched under a live viewer is one the pressure sweep may close while
 * somebody is looking at it. Unwatched stays the default for a session nobody
 * has ever mentioned, which is the honest reading of silence.
 *
 * The signal is an association, not a subscription: it says a viewer has the
 * SESSION open, not that anything is rendering this attachment's stream (see the
 * gap below). It is the right clock anyway — the alternative, a timer from the
 * last `attach()`, kills a terminal out from under someone who has watched it
 * for thirty minutes.
 *
 * ---------------------------------------------------------------------------
 * THE GAP THIS DELIBERATELY LEAVES: THE STREAM IS DEAD IN BOTH DIRECTIONS
 * ---------------------------------------------------------------------------
 *
 * Say it plainly, because "it streams" is the wrong picture: NOTHING RENDERS
 * THIS TERMINAL TODAY, and nothing types into it.
 *
 * OUT: `ports.frames` hands each frame to the daemon's relay under this
 * attachment's stream id. The server's handler looks the id up in its session
 * table (`sessions.get(msg.sessionId)`) and drops the batch when there is no row
 * — and there is no row, because a stream id is not a session id and nothing
 * anywhere resolves a `TerminalStreamRef`. The frames leave this machine and are
 * discarded one hop later.
 *
 * IN: the daemon's `input`/`resize` handlers are keyed by session id off
 * `ctx.bridges`, and this attachment is deliberately NOT registered there — a
 * bridge entry is also a memory-attribution hint (`control/discovery.ts`), so
 * registering one would publish a phantom agent row for a "session" the server
 * has never heard of. No viewer could reach it anyway, for the same missing
 * resolution.
 *
 * Why relay at all, then? Because the alternative is a stream ref that names
 * nothing at all: this is the daemon's half of the frames path, complete and
 * exercised, waiting on the registration that makes an id resolvable. What is
 * NOT claimed is that a picture arrives.
 *
 * And it is not cosmetic — `opencode-attach.live.test.ts` records why: opencode's
 * TUI is opentui, which INTERROGATES the terminal (mode/capability queries) and
 * waits for the answers before it draws. With no way back, a live client
 * completes its handshake and then holds. The process, the scope, the warm
 * window and this side of the relay are real; a rendered terminal is not.
 * Resolving a stream ref in the viewer plane — BOTH directions — is POD-2108.
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
import { STRIPPED_PROVIDER_KEYS } from './opencode-server'

const log = createLogger('daemon:opencode-attach')

/** §5's default idle window. Configurable through {@link OpencodeClientTerminalPorts}
 *  rather than an env knob: the only caller is the daemon's own wiring, and a
 *  setting nobody sets is a setting nobody maintains. */
export const WARM_TTL_MS = 30 * 60_000

/**
 * The size the client is BORN at, not the size it stays.
 *
 * No viewer has told us its grid: the attach request carries no geometry, and
 * the viewer signal this module does receive (`sessionPriority`) carries none
 * either. So this is a readable default a TUI renders sanely at, and the first
 * `resize` routed to an attachment stream reflows it — POD-2108.
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
   * ONE PER SESSION, AND NO `mode`. `peek` and `takeover` get the same screen,
   * because it is the same screen — who may type into it is the control LEASE's
   * question, and the driver settles that before it ever reaches this port
   * (`attach()` refuses a take-over the lease already holds). A `mode` parameter
   * here would be one no code consults, which reads as a branch someone forgot
   * to write.
   */
  attach(input: {
    sessionId: SessionId
    target: OpencodeClientTerminalTarget
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
  /**
   * A session's viewers arrived or left — the idle clock this module runs on.
   *
   * Fed by the daemon's `sessionPriority` handler, which is the server's
   * viewer-derived signal for exactly this: `watched` while any client has the
   * session open, unwatched when the last one leaves.
   */
  viewers(sessionId: SessionId, watched: boolean): void
  /**
   * What could be reclaimed right now WITHOUT touching a session (spec §5:
   * attachments are the first thing reclaimed under pressure, because they are
   * pure convenience and the session engine is untouched).
   *
   * A COUNT of the attachments nobody is watching. Watched ones are excluded:
   * "reclaim the terminal someone is looking at" is not a cheaper trade than
   * parking an idle agent, it is a worse one.
   */
  reclaimable(): number
  /** Close every attachment nobody is watching, newest last. The machine's
   *  answer to host pressure, ordered by the server that owns the threshold. */
  reclaimUnwatched(): Promise<number>
}

export interface OpencodeClientTerminalPorts {
  /**
   * Where the client's frames go: the daemon's own relay, keyed by the stream id
   * this module minted — the same path and the same sink the engine variant's
   * endpoint names.
   *
   * THIS SIDE IS COMPLETE; THE OTHER END IS NOT. The server drops a batch whose
   * id matches no session row, and a stream id matches none, so today these
   * frames are relayed and discarded (see the header's gap note). Keeping the
   * daemon's half real, rather than buffering into a sink of our own, is what
   * makes POD-2108 a registration rather than a rewrite.
   */
  frames(streamId: string, frameBase64: string): void
  /** Drop this stream's coalescing state when the attachment ends. Without it a
   *  daemon accumulates one pending entry per attachment for its whole life, and
   *  every close/adopt cycle mints a fresh id. */
  releaseStream?(streamId: string): void
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
  /** Does a client have this session open? Drives the idle clock, and keeps a
   *  watched terminal out of the reclaim inventory. */
  watched?: boolean
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

  /**
   * SESSIONS A VIEWER CURRENTLY HAS OPEN, remembered whether or not they have an
   * attachment yet.
   *
   * Without this the seeding is backwards in the one case that matters. Viewer
   * state arrives as `sessionPriority`, which the server sends ONLY ON CHANGE —
   * so a session already on screen when its terminal is attached produces no
   * frame at all, `watched` stays unset, and the attachment is born armed and
   * counted as reclaimable. Under host pressure that is a terminal closed while
   * somebody is looking at it: the exact guarantee the reclaim-first design was
   * accepted on.
   *
   * SEEDED FROM THIS SET, NEVER FROM THE OUTPUT SCHEDULER's priority. That map
   * defaults a session it has never heard of to tier 1, so an unopened session
   * would read as watched and its terminal would never arm at all — a leak
   * dressed as caution.
   *
   * Only the watched are stored, so a viewer leaving REMOVES the entry and the
   * set stays the size of what is on screen. A session that ends while watched
   * can leave one behind; session ids are never reused, so a stale entry can
   * only ever describe the session it was recorded for, and no later attachment
   * can inherit it.
   */
  const watchedSessions = new Set<SessionId>()

  const disarm = (record: Attachment): void => {
    if (record.timer !== undefined) clearTimer(record.timer)
    record.timer = undefined
  }

  /**
   * Start the idle countdown, unless somebody is watching.
   *
   * The one place the clock's meaning lives: WATCHED IS NOT IDLE. A viewer with
   * the session open holds the window off entirely rather than extending it,
   * which is what makes this an idle TTL and not a lifetime — the alternative
   * kills a terminal out from under someone at the thirty-minute mark.
   */
  const arm = (sessionId: SessionId, record: Attachment): void => {
    disarm(record)
    if (record.watched) return
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
      /**
       * THE SAME PROVIDER KEYS THE SERVE HALF DELETES, deleted here too.
       *
       * It is the same binary reading the same config, and abduco hands the app
       * the daemon's whole environment — so a daemon carrying `ANTHROPIC_API_KEY`
       * would have this client resolve a provider the session never chose. The
       * client is thin today and may never call one, which is exactly why the
       * asymmetry would go unnoticed: two processes of one binary, opposite
       * treatment, for no stated reason.
       */
      stripEnv: STRIPPED_PROVIDER_KEYS,
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
    if (record) {
      disarm(record)
      // The relay keeps a coalescing entry per stream id, and every attachment
      // mints a new one. Nothing else would ever drop it.
      ports.releaseStream?.(record.streamId)
    }
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
        record = {
          streamId: randomUUID(),
          label: opencodeAttachLabel(sessionId),
          // Born knowing whether anyone is looking: see `watchedSessions`.
          watched: watchedSessions.has(sessionId),
        }
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
      const record: Attachment = {
        streamId: randomUUID(),
        label,
        watched: watchedSessions.has(sessionId),
      }
      attachments.set(sessionId, record)
      arm(sessionId, record)
      log.info('adopted a client terminal that outlived the daemon', { sessionId, label })
    },

    close,

    viewers(sessionId, watched) {
      // RECORDED FIRST, AND WHETHER OR NOT THERE IS AN ATTACHMENT. The frame
      // that says "somebody opened this session" usually arrives BEFORE anyone
      // asks for its terminal, and it is sent only on change — so a return here
      // would throw away the only notice this module ever gets.
      if (watched) watchedSessions.add(sessionId)
      else watchedSessions.delete(sessionId)
      const record = attachments.get(sessionId)
      if (!record || record.watched === watched) return
      record.watched = watched
      // Both directions run through `arm`, which knows that watched means no
      // timer: arriving holds the window off, leaving starts it from now.
      arm(sessionId, record)
    },

    reclaimable() {
      let count = 0
      for (const record of attachments.values()) if (!record.watched) count += 1
      return count
    },

    async reclaimUnwatched() {
      // Snapshot first: `close` mutates the map, and a watched attachment must
      // survive the sweep — reclaiming the terminal someone is looking at is not
      // a cheaper trade than parking an idle agent, it is a worse one.
      const targets = [...attachments.entries()]
        .filter(([, record]) => !record.watched)
        .map(([sessionId]) => sessionId)
      for (const sessionId of targets) await close(sessionId)
      if (targets.length > 0) {
        log.info('reclaimed unwatched client terminals under host pressure', {
          count: targets.length,
        })
      }
      return targets.length
    },
  }
}
