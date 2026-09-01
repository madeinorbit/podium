/**
 * THE CLIENT TERMINAL FOR A SERVER-FAMILY SESSION (POD-2059; spec §5).
 *
 * ---------------------------------------------------------------------------
 * THIS FILE DOES NOT KNOW WHICH HARNESS IT IS RUNNING (POD-2823)
 * ---------------------------------------------------------------------------
 *
 * It used to. Nine times: twice to pick a label, twice to pick a launch
 * command, once to add codex's `--remote`, twice to add opencode's server
 * credentials, and twice to pick a credential strip list. Three harnesses, nine
 * branches, and a fourth driver would have meant finding all nine.
 *
 * They were four questions wearing nine faces, and every one of them is a fact
 * about a harness rather than a decision this layer gets to make:
 *
 *   which durable label a parked client holds   → `clientTerminal.labelToken`
 *   what to run to reopen this conversation     → `clientTerminal.launch()`
 *     …including the engine address on argv     → its `endpoint.address`
 *     …and the per-session server credentials   → its `endpoint` secret
 *   which env would let it inherit a foreign
 *     credential the session never chose        → `inventory.foreignCredentialEnv`
 *
 * The last one was already declared, per harness, and already applied by
 * `harnessChildStripEnv` — the branch had been redundant since POD-2296, and
 * the union it was folded into had been hiding a real drift in codex's two
 * copies of the list. That is the shape of this defect: not a decision made in
 * the wrong place, but a decision made TWICE, in a place where nobody would
 * think to reconcile it.
 *
 * WHAT IS DELIBERATELY NOT DECLARED. The architecture note that named this
 * defect (`docs/architecture/attachment-lifecycle.md` §3.2) sketched `parkable`
 * and `revokeOnRelease`. Neither is here, because neither would be READ: its own
 * correction block establishes that no driver parks today, and the release arm
 * closes every client terminal unconditionally for the reason codex gave it. A
 * field no code consults is the same defect as a name check — a property that
 * holds by accident rather than by declaration — with the accident moved
 * somewhere more flattering. They belong with the code that would honour them.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS, AND WHY IT IS A SEPARATE PROCESS FROM THE SESSION
 * ---------------------------------------------------------------------------
 *
 * A terminal-family session IS a terminal: `attach()` there is a typed
 * description of a frames path that already exists. A server-family session has
 * no PTY at all, so `attach()` has to PRODUCE the terminal. Each supported
 * harness ships the original UI this needs: `opencode attach`, `codex resume
 * --remote`, and `grok --resume`. The client runs beside the headless engine and
 * opens the same native conversation.
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
 * IDLE MEANS "NOBODY IS RENDERING NATIVE", AND THE DAEMON CAN SEE THAT.
 * `sessionPriority.nativeView` is aggregated from the live clients' visible
 * mode. So the clock is armed on Chat and held off while any visible pane
 * renders the attachment — {@link OpencodeClientTerminals.viewers}, called from
 * the daemon's `sessionPriority` handler.
 *
 * It is remembered per SESSION, not just per attachment, and a new attachment is
 * SEEDED from it. The frame is sent only on change, so a session already on
 * screen when its terminal is attached announces nothing — and an attachment
 * born unwatched under a live viewer is one the pressure sweep may close while
 * somebody is looking at it. Unwatched stays the default for a session nobody
 * has ever mentioned, which is the honest reading of silence.
 *
 * The signal is the attachment subscription: Chat may keep the parent session
 * open without keeping its sibling TUI hot. A timer from the last `attach()`
 * would instead kill a terminal under someone who used Native for thirty
 * minutes.
 *
 * ---------------------------------------------------------------------------
 * THE STREAM ID IS THE PARENT SESSION ID
 * ---------------------------------------------------------------------------
 *
 * Terminal transport is already keyed by Podium session id at the browser,
 * server, and daemon boundaries. Giving the client endpoint that same opaque id
 * makes its frames resolve through the existing session row, while the daemon's
 * input/resize/redraw handlers route the reverse direction here without
 * registering a phantom engine bridge. `sessionPriority.nativeView` creates the
 * client only while a browser renders Native and releases its control lease on
 * a switch back to Chat.
 */

import {
  CLIENT_TERMINAL_HARNESSES,
  type ClientTerminalEndpoint,
  type HarnessEnvironment,
  clientTerminalFor,
} from '@podium/harness'
import { createLogger } from '@podium/logger'
import type { Geometry, SessionId } from '@podium/model'
import type { BuiltinHarnessKind } from '@podium/protocol'
import {
  type AbducoSpawnOptions,
  type AgentSession,
  abducoSocketPath,
  killAbducoSession,
  spawnAbducoAgent,
} from '@podium/pty'
import {
  harnessChildStripEnv,
  harnessCompatEnv,
  harnessInstanceEnv,
  spawnEnv,
} from '../control/session-env'
import { driverTiming } from './driver-timing'

const log = createLogger('daemon:opencode-attach')

/** §5's default idle window. Configurable through {@link OpencodeClientTerminalPorts}
 *  rather than an env knob: the only caller is the daemon's own wiring, and a
 *  setting nobody sets is a setting nobody maintains. */
export const WARM_TTL_MS = 30 * 60_000

/**
 * The size the client is BORN at, not the size it stays.
 *
 * No viewer has told us its grid: the attach request carries no geometry, and
 * the viewer signal that creates the client may arrive before its resize. So
 * this is a readable birth size; the daemon applies the latest pending geometry
 * immediately after attach.
 */
const DEFAULT_GEOMETRY: Geometry = { cols: 120, rows: 40 }

export const CLIENT_TERMINAL_INPUT_MAX_MESSAGES = 64
export const CLIENT_TERMINAL_INPUT_MAX_BYTES = 256 * 1024

/** Cursor home, clear screen, clear scrollback: the anchor a cold-started client
 *  terminal draws onto. Matches the server's `SCREEN_RESET`, so it also truncates
 *  the replay log the next attach rebuilds from. */
const CLIENT_GENERATION_RESET = '\x1b[H\x1b[2J\x1b[3J'

/**
 * The durable label of a session's client terminal. See the header: the
 * session's own label must NOT be a substring of it.
 *
 * PODIUM OWNS THE SHAPE, THE HARNESS OWNS ITS TOKEN. This file used to hold the
 * three whole labels and pick between them by name; what actually varies is the
 * two-letter slot, and that is now declared where the harness is defined. A
 * harness that declares no client terminal has no label — `undefined`, so a
 * caller cannot accidentally reclaim under a name nothing ever spawned.
 */
export const clientTerminalLabel = (
  sessionId: SessionId,
  kind: ClientTerminalKind,
  driverId?: import('@podium/harness').DriverId,
): string | undefined => {
  const token = clientTerminalFor(kind, driverId)?.labelToken
  return token === undefined ? undefined : `podium-${token}-attach-${sessionId}`
}

/** The three server-family labels by name, for the callers and tests that hold
 *  one harness in mind. Each is the SAME composition every other kind gets;
 *  these three exist because their harnesses declare a client terminal, and the
 *  throw says so rather than handing back a label nothing answers to. */
const requireLabel = (sessionId: SessionId, kind: ClientTerminalKind): string => {
  const label = clientTerminalLabel(sessionId, kind)
  if (label === undefined) throw new Error(`${kind} declares no client terminal`)
  return label
}

export const opencodeAttachLabel = (sessionId: SessionId): string =>
  requireLabel(sessionId, 'opencode')
export const codexAttachLabel = (sessionId: SessionId): string => requireLabel(sessionId, 'codex')
export const grokAttachLabel = (sessionId: SessionId): string => requireLabel(sessionId, 'grok')

export type ClientTerminalKind = BuiltinHarnessKind

/**
 * Everything the client needs to open the RIGHT conversation on the RIGHT
 * engine — in ONE shape for every harness (POD-2823).
 *
 * It used to be a union of three per-harness payloads, and that union was the
 * reason this file branched: a `url`/`username`/`secret`/`opencodeSessionId`
 * arm, a `threadId`/`clientAddress` arm and a `grokSessionId` arm cannot be read
 * without asking which one you have. The two things they were all carrying are a
 * CONVERSATION to reopen and an ENGINE to reach, and both are declared shapes —
 * so the daemon carries those, and the harness's own adapter turns them into
 * argv.
 */
export interface ClientTerminalTarget {
  /** Which harness's client to run. A REGISTRY KEY, not a branch: it is only
   *  ever used to look the declaration up. */
  kind: ClientTerminalKind
  /** Selects the server declaration when a harness offers more than one. */
  driverId?: import('@podium/harness').DriverId
  /** The native conversation the client must reopen. Without it the TUI would
   *  open a different one, which is not an attach. */
  conversation: string
  /** Where the running engine listens, in the shape this harness's transport
   *  implies — see `ClientTerminalEndpoint`. Empty for a stdio engine. */
  endpoint: ClientTerminalEndpoint
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
    target: ClientTerminalTarget
  }): Promise<{ streamId: string; warmTtlMs: number }>
  /**
   * Take responsibility for a client terminal that outlived this daemon.
   *
   * The master is in its own scope, so a daemon restart leaves it running with
   * nobody holding its idle clock. Adopting it puts it back under the reaper;
   * without this it would sit resident until the machine rebooted.
   */
  adopt(sessionId: SessionId, kind?: ClientTerminalKind): void
  /** The session is going away, or the idle window closed. Attachments are
   *  strictly subordinate: stop/hibernate/kill the session and its client dies. */
  close(sessionId: SessionId, kind?: ClientTerminalKind): Promise<void>
  /** Retire a client whose engine died while keeping its session-addressed
   * replay for the replacement client. Ordinary close must still drop it. */
  relaunch(sessionId: SessionId, kind: ClientTerminalKind): Promise<void>
  /**
   * THE VIEWER WENT BACK TO CHAT — which is not the session going away, and
   * that difference is the whole of POD-3045.
   *
   * This used to be `close()`, so every switch out of Native reclaimed the
   * master and every switch back in cold-started the harness's TUI. For
   * opencode that silently cost the CLI its keyboard: its startup discards
   * stdin part-way through, so the keystrokes of a viewer who has just switched
   * land in the window where they are swallowed — no echo, on a terminal that
   * is visibly painting a fresh interface.
   *
   * So the harness decides, through `clientTerminal.parkOnRelease`. Parking
   * drops the daemon's client handle and leaves the master and its TUI running;
   * the next attach reconnects to that same generation, past its startup and
   * with its scrollback intact. Where the harness says its client may NOT
   * outlive the view — codex, whose TUI holds a direct writer to the engine —
   * this is exactly the old unconditional teardown.
   *
   * A PARKED CLIENT HAS NO WRITER. `input`, `resize` and `redraw` all answer
   * from `record.session`, which the park clears, so the lease obligation is
   * met by there being nothing to type into rather than by ending the process.
   * The warm clock is (re)armed on the way out, so a parked client is still
   * reaped rather than resident.
   */
  release(sessionId: SessionId): Promise<void>
  /**
   * A session's viewers arrived or left — the idle clock this module runs on.
   *
   * Fed by the daemon's `sessionPriority` handler, which is the server's
   * viewer-derived signal for exactly this: `watched` while any client has the
   * session open, unwatched when the last one leaves.
   */
  viewers(sessionId: SessionId, watched: boolean): void
  /** Route the browser terminal transport to the attached harness client. */
  input(sessionId: SessionId, data: Uint8Array): boolean
  resize(sessionId: SessionId, cols: number, rows: number): boolean
  redraw(sessionId: SessionId, replayRequired?: boolean): boolean
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
   * Where the client's frames go: the daemon's existing session-addressed relay.
   * The endpoint's stream id equals the parent Podium session id, so the server
   * resolves the same row its browser terminal is already attached to.
   */
  frames(streamId: string, frame: Uint8Array): void
  /** Drop this stream's coalescing state when the attachment ends. Without it a
   *  daemon accumulates one pending entry per attachment for its whole life, and
   *  every live session. */
  releaseStream?(streamId: string): void
  /**
   * The instance agent home (`ctx.homeDir`), overriding the client's `HOME`
   * exactly as the serve half does (POD-2247). Same binary, same config reads:
   * a client left on the daemon's `HOME` renders against the operator's real
   * opencode state while the server it attaches to runs against the instance's.
   */
  homeDir?: string
  /** Immutable daemon ownership stamp for orphan attribution. */
  instanceUuid?: string
  /** Current machine command environment used to resolve the client executable. */
  commandEnvironment?: () => Promise<HarnessEnvironment>
  /** Injection seams. The defaults are the real abduco. */
  spawn?(opts: AbducoSpawnOptions): Promise<AgentSession>
  reclaim?(label: string): Promise<void>
  /**
   * Is a durable master still holding this label? A socket-dir read, not an
   * `abduco` fork — this runs on the session teardown path.
   *
   * ONLY FOR THE CALLERS THAT HOLD NO SESSION: `close()`, which reclaims a
   * parked master nothing is attached to, and `adopt()`, which takes one that
   * outlived the daemon back under a deadline. The generation reset does NOT
   * ask this — see `start()` — because a spawn can answer the same question
   * later and better.
   */
  hasMaster?(label: string): boolean
  geometry?: Geometry
  warmTtlMs?: number
  setTimer?(fn: () => void, ms: number): unknown
  clearTimer?(handle: unknown): void
}

interface ClientTerminalGeneration {
  acceptingInput: boolean
  pendingInput: Uint8Array[]
  pendingBytes: number
}

interface Attachment {
  streamId: SessionId
  label: string
  /** Which harness's client this is — the registry key `release()` asks about
   *  parking. Remembered rather than re-derived, because the record outlives
   *  the attach request that carried the target. */
  kind: ClientTerminalKind
  /** The client PTY. Absent between the master being adopted and a viewer's
   *  first attach — and after the client exits while the master lives on. */
  session?: AgentSession
  /** In-flight start, so two concurrent attaches produce ONE client. */
  starting?: Promise<AgentSession>
  /** The one Native generation allowed to accept input. Replaced on every start. */
  generation?: ClientTerminalGeneration
  /**
   * The browser's full-replay attach asks for one redraw after receiving the
   * retained byte log. An adopted master must acknowledge that request without
   * forwarding it: its viewport-clearing repaint would replace the replay that
   * still contains older Native content. Consumed once, so later explicit
   * redraws remain real.
   */
  suppressNextReplayRedraw?: boolean
  /** The server replay cannot rebuild the surviving TUI: either the server
   *  restarted empty, or the parked master evolved while no attach client was
   *  relaying frames. Survives the race with recreating the adopted handle. */
  replayRequired?: boolean
  /** The next client is a new process continuing the same Native surface. Its
   * first paint must not clear retained scrollback. */
  preserveReplayOnRelaunch?: boolean
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
  /**
   * THE PROBE MUST LOOK WHERE THE SPAWN PUT IT (POD-2761).
   *
   * `abducoSocketDirs` falls back to `$HOME/.abduco` when `ABDUCO_SOCKET_DIR` is
   * unset, and the master is created against the CLIENT's environment — whose
   * `HOME` is the instance agent home (`ports.homeDir`), not the daemon's. A
   * default probe on `process.env` therefore reads a different directory and
   * answers "no master" for one that is running.
   *
   * WHICH CONFIGURATION IS EXPOSED, precisely: a named instance is safe, because
   * `applyInstanceRuntimeEnv` pins `ABDUCO_SOCKET_DIR` on the daemon's own env
   * and the child inherits that same value — both sides then resolve one root
   * and `HOME` never enters it. What is exposed is an agent home that differs
   * from the daemon's `HOME` with no such pin: `PODIUM_AGENT_HOME` or
   * `config.agentHome` on the default instance.
   *
   * The error is ONE-SIDED toward "absent", so both callers fail open in the
   * expensive direction: `close()` reclaims nothing and the master leaks until
   * the machine reboots, and `adopt()` never takes back a client that outlived
   * the daemon — which is the same orphan by the other road.
   *
   * `process.env` is read PER CALL rather than captured, because the instance
   * env is applied to it during boot and this module is built on that path.
   */
  const hasMaster =
    ports.hasMaster ??
    ((label: string) =>
      abducoSocketPath(
        label,
        ports.homeDir ? { ...process.env, HOME: ports.homeDir } : process.env,
      ) !== undefined)
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

  async function start(record: Attachment, target: ClientTerminalTarget): Promise<AgentSession> {
    const kind = target.kind
    /**
     * THE HARNESS SAYS WHAT TO RUN; THIS FUNCTION NEVER LEARNS ITS NAME
     * (POD-2823).
     *
     * Four of the nine name checks this file used to carry lived in the next
     * twenty lines: which command, which resume-ref shape the conversation goes
     * in, whether an engine address rides on argv, and whether per-session
     * server credentials ride in the env. All four are one question — "how is
     * this harness's stock TUI pointed at a running session?" — and it is now
     * asked of the harness's own declaration.
     *
     * REFUSED, NOT DEFAULTED, when a harness declares none. Falling back to some
     * other harness's client would open a terminal running the wrong CLI against
     * the wrong conversation; the caller turns this into the per-machine refusal
     * an attach already knows how to report.
     */
    const client = clientTerminalFor(kind, target.driverId)
    if (!client) throw new Error(`${kind} declares no client terminal to attach`)
    /**
     * A NEW CLIENT MUST NOT PAINT INTO THE OLD ONE'S SCROLLBACK (POD-2761),
     * BUT A REATTACHED CLIENT MUST KEEP THE SCROLLBACK IT ALREADY OWNS.
     *
     * `start()` serves both cases. A view-switch reclaims the abduco master, so
     * no master exists and spawn creates a new TUI generation. After a daemon
     * restart or lost client handle, the master and its TUI survive; spawn
     * reconnects to that same generation instead. The reset below is emitted for
     * the first case and withheld for the second, so which one just happened is
     * the whole question — see the spawn call for where it is answered.
     */
    const launch = client.launch({
      cwd: target.workdir,
      conversation: target.conversation,
      endpoint: target.endpoint,
      // The client terminal does not pass through the generation binder used by
      // ordinary launches. Give its manifest the current machine command
      // environment so it can resolve the installed CLI; the child overlay below
      // still receives the isolated instance HOME for credentials.
      env: await ports.commandEnvironment?.(),
    })
    const podiumEnv = {
      // Whatever the harness's own declaration put there — for opencode that is
      // the per-session server credentials, which stay in the ENV and out of
      // argv exactly as its server half requires.
      ...(launch.env ?? {}),
      ...(ports.instanceUuid ? { PODIUM_INSTANCE_UUID: ports.instanceUuid } : {}),
      PODIUM_SESSION_ID: record.streamId,
      ...harnessCompatEnv(kind),
      ...(ports.homeDir ? { HOME: ports.homeDir } : {}),
      ...harnessInstanceEnv(kind, ports.homeDir),
    }
    driverTiming.nativeCliStage(record.streamId, kind, 'native_cli_spawn_requested', {
      command: launch.cmd,
    })
    const session = await spawn({
      label: record.label,
      cmd: launch.cmd,
      args: launch.args,
      cwd: launch.cwd,
      cols: geometry.cols,
      rows: geometry.rows,
      /**
       * A CLIENT TERMINAL IS SIZED AS ONE (POD-2413). Its scope gets the attach
       * budget — a terminal's worth of memory and tasks, not an agent's — so a
       * warm attachment nobody is watching can never be what pushes the
       * instance's sessions slice over its aggregate throttle. It is also the
       * first thing given back under pressure (§5), which is the same ordering
       * viewed from the other end.
       */
      scopeRole: 'attach',
      /**
       * A surviving client master already has browser-owned replay. Its initial
       * PTY attach must not resize/repaint the TUI before spawn can report
       * `adopted`; fresh generations still use the default initial repaint.
       */
      preserveReplayOnAdopt: true,

      /**
       * THE SAME PROVIDER KEYS THE SERVE HALF DELETES, deleted here too.
       *
       * It is the same binary reading the same config, and abduco hands the app
       * the daemon's whole environment — so a daemon carrying `ANTHROPIC_API_KEY`
       * would have this client resolve a provider the session never chose. The
       * client is thin today and may never call one, which is exactly why the
       * asymmetry would go unnoticed: two processes of one binary, opposite
       * treatment, for no stated reason.
       *
       * THE BRANCH THAT WAS HERE WAS ALREADY REDUNDANT (POD-2823). It picked
       * between three constants by harness name and then UNIONED the result with
       * `harnessChildStripEnv(kind)` — which reads exactly the same fact off the
       * manifest. For opencode and grok the two sides were the identical array;
       * for codex they were not, and the difference was a real drift the union
       * had been quietly papering over (see the codex manifest). The property
       * this branch wanted has been declared per harness since POD-2296; the
       * helper is how you ask for it.
       */
      stripEnv: harnessChildStripEnv(kind),
      // The overlay abduco layers over the daemon env — composed through the
      // same `spawnEnv` the PTY path uses, so an instance home overrides HOME
      // (and prepends its bin roots to PATH) here exactly as it does for the
      // serve half (POD-2247).
      env: spawnEnv({ podiumEnv }),
    })
    driverTiming.nativeCliStage(record.streamId, kind, 'native_cli_process_started', {
      adopted: session.adopted,
    })
    /**
     * ASK THE SPAWN WHICH CASE THIS WAS — do not sample the socket directory
     * beforehand (POD-2761).
     *
     * This was `hasMaster(record.label)`, read before `await spawn`, and that
     * was wrong twice over. It asked under the WRONG ENVIRONMENT, because the
     * default probe reads the daemon's `HOME` while the master lives under the
     * agent home (see `hasMaster` above) — one-sided toward "cold", so the reset
     * fired on an adopted live TUI and `[3J` deleted the very history it was
     * reattaching to. And it asked TOO EARLY: a master exiting inside the spawn
     * window left `reattaching` true while spawn created a new generation, which
     * then painted a whole fresh interface below the old one with no anchor —
     * the original symptom this issue exists to fix.
     *
     * `AgentSession.adopted` is the same fact established at the only moment it
     * is knowable. Spawn sets it when it found a live master owning the label
     * and attached to that instead of creating one, resolved with the child's
     * own environment and AFTER the create race it just ran.
     *
     * WHAT THE TWO BRANCHES PROTECT. A new generation draws into a browser
     * terminal addressed by SESSION, not by attachment (POD-2108), so one stream
     * outlives every client generation; without a reset the next full interface
     * lands below the first. A reattach is the opposite: `[3J` would delete the
     * surviving TUI's history from both the browser and the replay log, while
     * its resize redraw restores only the viewport.
     *
     * Emitted only after spawn succeeds, so a refusal cannot blank a terminal,
     * and before subscribing to client frames, so every observable byte from a
     * new generation follows its anchor. The pair also matches the server's
     * reset test, so the replay log re-anchors with the browser.
     */
    if (!session.adopted && !record.preserveReplayOnRelaunch) {
      ports.frames(record.streamId, Buffer.from(CLIENT_GENERATION_RESET))
    }
    record.preserveReplayOnRelaunch = false
    session.onFrame((frame) => {
      driverTiming.nativeCliStage(record.streamId, kind, 'native_cli_first_output', {
        bytes: frame.data.byteLength,
      })
      ports.frames(record.streamId, frame.data)
    })
    session.onExit(() => {
      // THE CLIENT EXITING IS NOT THE ATTACHMENT ENDING. abduco's master (and the
      // TUI inside it) survives a client that was disposed, crashed or was killed
      // by a redeploy — that survival is what "warm" means. Drop the handle and
      // let the next attach reconnect; the reaper still owns the deadline.
      if (record.session === session) {
        record.session = undefined
        if (session.adopted) record.suppressNextReplayRedraw = true
      }
    })
    /**
     * SUBSCRIBE, THEN REPLAY THE ATTACH-TIME REDRAW.
     *
     * A fresh browser attach asks the daemon to redraw from `SessionTerminal`,
     * but a server-family client is created later, from the viewer-priority
     * frame. If that redraw arrives before this spawn finishes,
     * `clientTerminals.redraw(sessionId)` correctly returns false: there is no
     * client PTY yet, and nothing replays the request when one appears.
     *
     * Reissue it after the relay consumer exists only for a fresh generation.
     * An adopted master already painted before this daemon existed, and the
     * session-addressed replay log already holds those bytes. Redrawing it here
     * clears and repaints only the current viewport, destroying older Native
     * content while the provider conversation and Chat transcript survive.
     *
     * `AgentSession.adopted` is exact process truth established by the spawn
     * port after the master create race, so both sides of this RuntimeDriver
     * attach seam agree on whether this is continuity or a new client.
     */
    if (!session.adopted || record.replayRequired) {
      const waitForAttach = session.adopted && record.replayRequired
      record.replayRequired = false
      record.suppressNextReplayRedraw = false
      if (waitForAttach && session.redrawWhenReady) session.redrawWhenReady()
      else session.redraw()
    }
    return session
  }

  async function close(sessionId: SessionId, kind?: ClientTerminalKind): Promise<void> {
    const record = attachments.get(sessionId)
    if (record?.generation) {
      record.generation.acceptingInput = false
      record.generation.pendingInput = []
      record.generation.pendingBytes = 0
    }
    attachments.delete(sessionId)
    if (record) {
      disarm(record)
      // The relay keeps a coalescing entry per session stream. Nothing else
      // would ever drop the attachment's pending output after teardown.
      ports.releaseStream?.(record.streamId)
    }
    // Nothing of ours, and no master holding the label: do not pay a process
    // spawn per session teardown to reclaim something that was never started.
    //
    // THE CANDIDATE SET IS THE REGISTRY'S (POD-2823), not three names written
    // here. A caller that knows its harness names it; one that does not asks
    // every harness that declares a client terminal, so a fourth driver's parked
    // master is reclaimed by declaring itself rather than by somebody
    // remembering this line.
    const labels = record
      ? [record.label]
      : (kind ? [kind] : CLIENT_TERMINAL_HARNESSES)
          .map((candidate) => clientTerminalLabel(sessionId, candidate))
          .filter((label): label is string => label !== undefined)
          .filter(hasMaster)
    if (labels.length === 0) return
    try {
      record?.session?.dispose()
    } catch {
      // the client is already gone; the master below is the reclaim that matters
    }
    for (const label of labels) await reclaim(label)
  }

  /**
   * REPLACE THE CLIENT PROCESS, NOT ITS NATIVE SURFACE.
   *
   * A daemon restart adopts a surviving engine and client, so neither replay
   * nor process is replaced. Hibernate/resurrection is different: the old
   * client still targets the dead engine and must be reaped, but its output is
   * the only byte-faithful copy of Native scrollback. `close()` used here erased
   * that replay, after which the new TUI could reconstruct Chat history but only
   * its current clipped viewport. Keep the attachment record and stream while
   * retiring exactly the obsolete process; the next cold client paints without
   * the cold-generation clear-scrollback anchor.
   */
  async function relaunch(sessionId: SessionId, kind: ClientTerminalKind): Promise<void> {
    let record = attachments.get(sessionId)
    if (!record) {
      const label = clientTerminalLabel(sessionId, kind)
      if (label !== undefined && hasMaster(label)) await reclaim(label)
      return
    }
    if (record.generation) {
      record.generation.acceptingInput = false
      record.generation.pendingInput = []
      record.generation.pendingBytes = 0
      record.generation = undefined
    }
    disarm(record)
    try {
      record.session?.dispose()
    } catch {
      // The master reclaim below is authoritative.
    }
    record.session = undefined
    record.preserveReplayOnRelaunch = true
    record.suppressNextReplayRedraw = false
    record.replayRequired = false
    if (hasMaster(record.label)) await reclaim(record.label)
    arm(sessionId, record)
  }

  /**
   * The viewer left Native. See {@link OpencodeClientTerminals.release} for why
   * this is not `close()` for every harness.
   */
  async function release(sessionId: SessionId): Promise<void> {
    const record = attachments.get(sessionId)
    if (record?.generation) {
      // Revoke BEFORE awaiting a start: input racing this release must refuse.
      record.generation.acceptingInput = false
      record.generation.pendingInput = []
      record.generation.pendingBytes = 0
    }
    if (!record || clientTerminalFor(record.kind)?.parkOnRelease !== true) {
      await close(sessionId)
      return
    }
    /**
     * A START IN FLIGHT IS STILL A CLIENT TO PARK. `record.session` is only set
     * once `start()` returns, so parking around it would leave the finished
     * client attached — streaming a TUI into a browser that has gone back to
     * Chat, with a writer the release was supposed to revoke. The reconcile
     * serialises attach against release for one session, so this normally does
     * not wait at all; a rejected start needs nothing parked.
     */
    if (record.starting) {
      try {
        await record.starting
      } catch {
        // the client never started: there is nothing attached to park
      }
    }
    // A rejected start may have removed this exact generation while release was awaiting it.
    // Never park or arm a record that no longer owns the session id.
    if (attachments.get(sessionId) !== record) return
    const client = record.session
    // Cleared BEFORE the dispose, so no input, resize or redraw can find a
    // handle that is on its way out.
    record.session = undefined
    // The master keeps following its provider while parked, but with this relay
    // detached those bytes never enter SessionTerminal's replay. Returning to
    // Native must repaint after subscribing even though spawn reports adoption.
    record.replayRequired = true
    record.suppressNextReplayRedraw = false

    try {
      client?.dispose()
    } catch {
      // the client is already gone; the master it left behind is what parks
    }
    // Nobody is watching a parked client by definition, so this starts the warm
    // window rather than merely re-arming it.
    arm(sessionId, record)
  }

  return {
    async attach({ sessionId, target }) {
      let record = attachments.get(sessionId)
      if (!record) {
        const label = clientTerminalLabel(sessionId, target.kind, target.driverId)
        if (label === undefined)
          throw new Error(`${target.kind} declares no client terminal to attach`)
        record = {
          // The terminal relay is session-addressed in both directions. The
          // stream ref remains typed, but its resolvable wire identity is the
          // parent Podium session rather than an orphan UUID (POD-2108).
          streamId: sessionId,
          label,
          kind: target.kind,
          // Born knowing whether anyone is looking: see `watchedSessions`.
          watched: watchedSessions.has(sessionId),
        }
        attachments.set(sessionId, record)
      }
      // Armed BEFORE the spawn: a start that hangs must not leave an unreaped
      // master behind if the caller gives up on it.
      arm(sessionId, record)
      if (!record.session) {
        let generation = record.generation
        let pending = record.starting
        if (!pending) {
          generation = { acceptingInput: true, pendingInput: [], pendingBytes: 0 }
          record.generation = generation
          pending = start(record, target)
          record.starting = pending
        }
        if (!generation) throw new Error('client terminal start lost its generation')
        let started: AgentSession
        try {
          started = await pending
        } catch (err) {
          if (attachments.get(sessionId) === record && record.generation === generation) {
            generation.acceptingInput = false
            generation.pendingInput = []
            generation.pendingBytes = 0
            record.generation = undefined
            disarm(record)
            attachments.delete(sessionId)
          }
          throw err
        } finally {
          if (record.starting === pending) record.starting = undefined
        }
        const current =
          attachments.get(sessionId) === record &&
          record.generation === generation &&
          generation.acceptingInput
        if (!current) {
          started.dispose()
          const replacement = attachments.get(sessionId)
          const replaced = replacement !== record
          if (replacement === undefined) await reclaim(record.label)
          throw new Error(
            replaced
              ? 'the client terminal was closed while it was starting'
              : 'the client terminal generation was revoked while it was starting',
          )
        }
        record.session = started
        const buffered = generation.pendingInput
        generation.pendingInput = []
        generation.pendingBytes = 0
        for (const data of buffered) started.writeBytes(data)
      }
      driverTiming.nativeCliStage(sessionId, target.kind, 'native_cli_input_ready')
      return { streamId: record.streamId, warmTtlMs }
    },

    adopt(sessionId, kind = 'opencode') {
      if (attachments.has(sessionId)) return
      const label = clientTerminalLabel(sessionId, kind)
      // No declaration means no label, and no label means there is nothing this
      // daemon could have spawned to adopt.
      if (label === undefined || !hasMaster(label)) return
      const record: Attachment = {
        streamId: sessionId,
        label,
        kind,
        watched: watchedSessions.has(sessionId),
        suppressNextReplayRedraw: true,
      }
      attachments.set(sessionId, record)
      arm(sessionId, record)
      log.info('adopted a client terminal that outlived the daemon', { sessionId, label })
    },

    close,

    relaunch,

    release,

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

    input(sessionId, data) {
      const record = attachments.get(sessionId)
      const generation = record?.generation
      if (!record || !generation?.acceptingInput) return false
      if (record.session) {
        record.session.writeBytes(data)
        return true
      }
      if (!record.starting) return false
      if (
        generation.pendingInput.length >= CLIENT_TERMINAL_INPUT_MAX_MESSAGES ||
        generation.pendingBytes + data.byteLength > CLIENT_TERMINAL_INPUT_MAX_BYTES
      )
        return false
      const copy = Uint8Array.from(data)
      generation.pendingInput.push(copy)
      generation.pendingBytes += copy.byteLength
      return true
    },

    resize(sessionId, cols, rows) {
      const session = attachments.get(sessionId)?.session
      if (!session) return false
      session.resize(cols, rows)
      return true
    },

    redraw(sessionId, replayRequired = false) {
      const record = attachments.get(sessionId)
      if (!record) return false
      if (replayRequired && !record.session) {
        record.replayRequired = true
        record.suppressNextReplayRedraw = false
        return true
      }
      if (record.suppressNextReplayRedraw && !replayRequired) {
        record.suppressNextReplayRedraw = false
        return true
      }
      record.suppressNextReplayRedraw = false
      const session = record.session
      if (!session) return false
      session.redraw()
      return true
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
