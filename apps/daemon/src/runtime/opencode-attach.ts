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
 * mode. The daemon RECORDS it here ({@link OpencodeClientTerminals.viewers},
 * called from the daemon's `sessionPriority` handler) and the SERVER measures
 * the warm window off its own copy of the same signal — the table owns the
 * deadline, this module only knows watched from unwatched.
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
import type { DurableAttachment } from '@podium/process/screen'
import type { ClientProcessOwner } from '../session/clients.js'
import type { SessionRegistry } from '../session/registry.js'
import type { ClientTerminalPolicy } from '../session/daemon-session.js'
import { Terminal } from '../terminal/terminal.js'
import type { AppliedGeometryRecord } from '../control/applied-geometry'
import {
  harnessChildStripEnv,
  harnessCompatEnv,
  harnessInstanceEnv,
  spawnEnv,
} from '../control/session-env'
import { driverTiming } from './driver-timing'

const log = createLogger('daemon:opencode-attach')

/** §5's default idle window, as the server's table reads it (POD-4524).
 *
 *  The server owns the decision — the shell lifetime table's attach-TUI row
 *  (unwatched past TTL → park), evaluated on the server's reaper tick and
 *  ordered per session as `closeClientTerminal`. This daemon runs no clock.
 *  This constant survives as the attach endpoint's informational `warmTtlMs`
 *  and as the value the server mirrors in `ATTACH_TUI_WARM_TTL_MS`: the two
 *  must stay the same 30-minute window, and the table is what enforces it.
 *
 *  Configurable through {@link OpencodeClientTerminalPorts} rather than an
 *  env knob: the only caller is the daemon's own wiring, and a setting nobody
 *  sets is a setting nobody maintains. Spawn/reclaim decisions elsewhere in
 *  this file belong to POD-4515, not to that table. */
export const WARM_TTL_MS = 30 * 60_000

/**
 * THE LAST-RESORT BIRTH SIZE, and by POD-3809 the rarest one.
 *
 * A client terminal is now opened at {@link OpencodeClientTerminalPorts.birthGeometry}
 * — the viewport request this session has been holding, else the grid the daemon
 * last applied to it — so the first frame is already the viewer's size instead
 * of being corrected a beat later. This constant is what remains when neither is
 * known: a session nobody has ever asked about, painted behind the startup
 * overlay.
 *
 * IT IS STILL AN APPLY, AND IT IS STILL REPORTED. The fallback is the case most
 * likely to be forgotten, and forgetting it is the bug: whatever grid the client
 * is born at, the daemon put it there and the server must be told (MODEL rule 1,
 * amended). The one operation that records it reports it.
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
  driverId?: import('@podium/harness').AcceptedDriverId,
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
  driverId?: import('@podium/harness').AcceptedDriverId
  /** The native conversation the client must reopen. Without it the TUI would
   *  open a different one, which is not an attach. */
  conversation: string
  /** Where the running engine listens, in the shape this harness's transport
   *  implies — see `ClientTerminalEndpoint`. Empty for a stdio engine. */
  endpoint: ClientTerminalEndpoint
  workdir: string
  /** Driver-specific environment required by both server and native client. */
  env?: Readonly<Record<string, string>>
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
   * nobody holding its idle clock. Adopting records it back under the
   * server-owned warm window (POD-4524); without this it would sit resident
   * until the machine rebooted.
   */
  adopt(sessionId: SessionId, kind?: ClientTerminalKind): void
  /** The session is going away, or the server closed the idle window.
   *  Attachments are strictly subordinate: stop/hibernate/kill the session and
   *  its client dies. */
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
   * from the session's Terminal, which the park drops, so the lease obligation
   * is met by there being nothing to type into rather than by ending the
   * process. A parked client waits out its warm window under the SERVER's
   * clock (POD-4524): the server orders `closeClientTerminal` when the table's
   * row fires, and the pressure sweep reclaims it sooner under host pressure —
   * so a parked client is still reaped rather than resident.
   */
  release(sessionId: SessionId): Promise<void>
  /**
   * A session's viewers arrived or left — recorded here, measured on the
   * server (POD-4524).
   *
   * Fed by the daemon's `sessionPriority` handler, which is the server's
   * viewer-derived signal for exactly this: `watched` while any client has the
   * session open, unwatched when the last one leaves. The server runs the warm
   * window off its own copy; this flag only spares watched terminals in the
   * pressure sweep.
   */
  viewers(sessionId: SessionId, watched: boolean): void
  /** Route the browser terminal transport to the attached harness client. */
  input(sessionId: SessionId, data: Uint8Array): boolean
  resize(sessionId: SessionId, cols: number, rows: number): boolean
  /**
   * Resize and answer what the terminal ACKNOWLEDGED (POD-3919 audit item 4) —
   * the size the kernel now reports, which is not always what was asked for.
   * Answers NOW (a plain {@link Geometry}) when the session's backend offers
   * no acknowledgement: the fire-and-forget resize IS the apply there, so the
   * requested size stays the fact — the abduco behaviour, and what every
   * caller stated before the host exposed its RESIZED frame. Answers LATER (a
   * promise) when it does. `undefined` when there is no client to resize: the
   * caller must hold the request, not record it.
   *
   * The sync-or-async shape is the point: callers keep the synchronous
   * hold/record contract for backends that apply synchronously, and await only
   * where an acknowledgement can actually differ.
   */
  resizeAcknowledged?(
    sessionId: SessionId,
    cols: number,
    rows: number,
  ): Geometry | Promise<Geometry | undefined> | undefined
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
  /**
   * THE SESSION LAYER'S CLIENT HOLD (spec §5). Spawn, reclaim and the master
   * probe all go through IT — the relay never names a process verb itself, so
   * a client terminal under any backend is created, found and reclaimed where
   * the session layer put it. REQUIRED: the only production call site passes
   * the daemon's session-owned scope, and an omitted one used to fall back to
   * abduco silently (POD-3917).
   */
  clients: ClientProcessOwner
  /**
   * THIS DAEMON'S APPLIED-SIZE RECORD (POD-3290).
   *
   * Opening a client terminal is one of the few places the daemon really does
   * put a session at a size — `geometry` below — and it is the only place that
   * fact is knowable, since nothing else sees the spawn. Written here, read by
   * the one bind builder and by the resize report; absent in a harness built
   * without a daemon behind it.
   */
  appliedGeometry?: AppliedGeometryRecord
  /**
   * THE SIZE TO OPEN THIS SESSION'S CLIENT TERMINAL AT (POD-3809).
   *
   * Being born right beats being corrected. The viewer's first ask routinely
   * arrives BEFORE the client terminal exists — there is no pty bridge on a
   * server-family session, so the resize handler holds it — and opening the
   * terminal at {@link DEFAULT_GEOMETRY} and resizing afterwards is what made
   * the first paint a small top-left quadrant for a second or two.
   *
   * The daemon answers with the held request if there is one, else the grid it
   * last applied to this session; `undefined` when it knows neither, which is
   * the one case that falls back to the default.
   */
  birthGeometry?(sessionId: SessionId): Geometry | undefined
  /** The per-daemon last resort, when {@link birthGeometry} knows nothing. */
  geometry?: Geometry
  /**
  /**
   * THE SESSION REGISTRY (POD-4434). The client TUI is a Terminal with no
   * driver, keyed by the parent session id — so its policy lives ON the
   * parent session entry, not in this module. REQUIRED: the only production
   * call site passes `ctx.sessions`.
   */
  sessions: SessionRegistry
   /**
    * KEEP THIS CLIENT TERMINAL'S HOST RESUME POINT (POD-3919 audit item 7).
   *
   * A client terminal is a host connection with a ring like any bridge
   * session, but it never becomes a bridge — so the bridge path's
   * `rememberDurableSeq` never sees it and a reconnecting daemon could only
   * repaint. Called with the fresh session at the one moment this module holds
   * it; the wiring stores a live reader, not a value. Consuming the point
   * (resuming from it instead of repainting) is later work: the point is
   * in-memory and cannot survive the restart it was written for until it is
   * persisted with the host.
   */
  rememberDurableSeq?: (sessionId: SessionId, session: DurableAttachment) => void
}

/**
 * NO CLIENT TERMINALS WITHOUT A SESSION CLIENT SCOPE (POD-3917).
 *
 * A `backend=none` daemon holds no durable host for its own sessions, and a
 * client terminal built for it would need a backend substituted silently — the
 * exact fallback the required {@link OpencodeClientTerminalPorts.clients} port
 * exists to forbid. So that daemon builds NOTHING here: the caller leaves
 * `ctx.clientTerminals` unset, the server-family drivers refuse a Native attach
 * with their per-machine wording, and every control frame that reaches for one
 * already tolerates its absence. `undefined` is the honest answer; abduco is
 * not this daemon's to give.
 */
export function createClientTerminalsFor(
  clients: ClientProcessOwner | undefined,
  ports: Omit<OpencodeClientTerminalPorts, 'clients'>,
): OpencodeClientTerminals | undefined {
  if (clients === undefined) return undefined
  return createOpencodeClientTerminals({ ...ports, clients })
}

export function createOpencodeClientTerminals(
  ports: OpencodeClientTerminalPorts,
): OpencodeClientTerminals {
  if (!ports.clients) throw new Error('createOpencodeClientTerminals requires ports.clients')
  if (!ports.sessions) throw new Error('createOpencodeClientTerminals requires ports.sessions')
  const sessions = ports.sessions
  const clients = ports.clients
  const geometry = ports.geometry ?? DEFAULT_GEOMETRY

  /**
   * Open the client TUI and build its surface through the ONE Terminal factory
   * (POD-4434): a client TUI is a Terminal with no driver, over the process
   * this spawn opened or adopted. The Session keeps owning the label and the
   * replay cursor; the Terminal holds the live attachment while watched.
   */
  async function start(
    sessionId: SessionId,
    policy: ClientTerminalPolicy,
    target: ClientTerminalTarget,
  ): Promise<Terminal> {
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
      ...(target.env ?? {}),
      ...(ports.instanceUuid ? { PODIUM_INSTANCE_UUID: ports.instanceUuid } : {}),
      PODIUM_SESSION_ID: sessionId,
      ...harnessCompatEnv(kind),
      ...(ports.homeDir ? { HOME: ports.homeDir } : {}),
      ...harnessInstanceEnv(kind, ports.homeDir),
    }
    driverTiming.nativeCliStage(sessionId, kind, 'native_cli_spawn_requested', {
      command: launch.cmd,
    })
    // BORN AT THE VIEWER'S SIZE WHEN THERE IS ONE (POD-3809). Read here rather
    // than at `attach()` because this is the only path that creates a terminal:
    // a warm reattach reuses the client that exists and applies nothing.
    const birth = ports.birthGeometry?.(sessionId) ?? geometry
    // THE SESSION SUMMONS, THE RELAY RENDERS: the client open path reaches
    // the process only through the session-owned owner.
    const session = await clients.spawnClient({
      // The client TUI is this session's only writer while watched: adopt
      // under another writer and it reads silently. Demand the lease (POD-4434).
      requireLease: true,
      label: policy.label,
      cmd: launch.cmd,
      args: launch.args,
      cwd: launch.cwd,
      cols: birth.cols,
      rows: birth.rows,
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
    driverTiming.nativeCliStage(sessionId, kind, 'native_cli_process_started', {
      adopted: session.adopted,
    })
    // A RESUME POINT FOR A TERMINAL THAT HAS NO BRIDGE (POD-3919 audit item
    // 7). The session is a host connection with a ring; remembering its live
    // `lastSeq` is what lets a later reconnect replay what was missed. A
    // backend with no connection records nothing.
    ports.rememberDurableSeq?.(sessionId, session)
    /**
     * ASK THE SPAWN WHICH CASE THIS WAS — do not sample the socket directory
     * beforehand (POD-2761).
     *
      * This was `hasMaster(record.label)`, read before `await spawn`, and that
      * was wrong twice over. It asked under the WRONG ENVIRONMENT, because the
      * default probe reads the daemon's `HOME` while the master lives under the
      * agent home (see `SessionClientScope.hasClientMaster`, which owns that
      * environment) — one-sided toward "cold", so the reset
     * fired on an adopted live TUI and `[3J` deleted the very history it was
     * reattaching to. And it asked TOO EARLY: a master exiting inside the spawn
     * window left `reattaching` true while spawn created a new generation, which
     * then painted a whole fresh interface below the old one with no anchor —
     * the original symptom this issue exists to fix.
     *
     * `DurableAttachment.adopted` is the same fact established at the only moment it
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
    if (!session.adopted && !policy.preserveReplayOnRelaunch) {
      ports.frames(sessionId, Buffer.from(CLIENT_GENERATION_RESET))
    }
    /**
     * AN APPLY SITE (POD-3290), and the only one outside `control/session.ts` —
     * and until POD-3809 the SILENT one. A client terminal being born is the
     * moment a headed session first has a grid at all, and nothing told the
     * server, so W stayed at the row's 80x24 while the client painted 80x24 and
     * the view only reflowed on a later ask.
     *
     * A CREATED client terminal really is opened at `birth`, so the daemon has
     * put this session at a grid and the one operation that records it also
     * reports it. No dispatch callback: the terminal was created at the size,
     * so there is nothing left to send it.
     *
     * An ADOPTED master is the opposite case and is deliberately excluded: it
     * survived this daemon at a size of its own, and recording a size for it
     * would invent exactly the 120x40 that the server-family binds used to
     * announce.
     *
     * ON THE HOST THE SIZE IS KNOWABLE (POD-3919 audit item 5), so the
     * exclusion is conditional, not blanket. The host's WELCOME frame carries
     * the kernel's size for the running program — `session.appliedGeometry`,
     * set only when the host reports `hasPty` — and an adopted host terminal
     * reports it here: recorded and reported with no dispatch, because the
     * terminal is already at it. An adopted abduco master reports nothing and
     * keeps the exclusion above: its size is still unknowable.
     */
    if (!session.adopted) ports.appliedGeometry?.apply(sessionId, birth.cols, birth.rows)
    else if (session.appliedGeometry)
      ports.appliedGeometry?.apply(
        sessionId,
        session.appliedGeometry.cols,
        session.appliedGeometry.rows,
      )
    policy.preserveReplayOnRelaunch = false
    // A client TUI is a Terminal with no driver (POD-4434): the same ONE
    // factory the headed path uses, over the session's screen, with no
    // hard repaint — TUIs repaint on resize and would mishandle a stray ^L.
    const owned = sessions.ensure(sessionId)
    owned.clientLabel = policy.label
    const terminal = Terminal.attach(session, owned.screen(), {
      onFrame: (data) => {
        driverTiming.nativeCliStage(sessionId, kind, 'native_cli_first_output', {
          bytes: data.byteLength,
        })
        ports.frames(sessionId, data)
      },
      onExit: () => {
        // THE CLIENT EXITING IS NOT THE ATTACHMENT ENDING. abduco's master (and the
        // TUI inside it) survives a client that was disposed, crashed or was killed
        // by a redeploy — that survival is what "warm" means. Park the Terminal
        // (unwire + detach) and let the next attach reconnect; the reaper still
        // owns the deadline.
        if (owned.terminal === terminal) owned.park()
        if (session.adopted) policy.suppressNextReplayRedraw = true
      },
    },
    { kind: 'client' })
    if (!session.adopted) terminal.applied = { ...birth }
    else if (session.appliedGeometry) terminal.applied = { ...session.appliedGeometry }
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
     * `DurableAttachment.adopted` is exact process truth established by the spawn
     * port after the master create race, so both sides of this RuntimeDriver
     * attach seam agree on whether this is continuity or a new client.
     */
    if (!session.adopted || policy.replayRequired) {
      const waitForAttach = session.adopted && policy.replayRequired
      policy.replayRequired = false
      policy.suppressNextReplayRedraw = false
      if (waitForAttach) terminal.redrawWhenReady()
      else terminal.redraw()
    }
    return terminal
  }

  async function close(sessionId: SessionId, kind?: ClientTerminalKind): Promise<void> {
    const owned = sessions.get(sessionId)
    const policy = owned?.client
    const generation = policy?.generation
    if (generation) {
      generation.acceptingInput = false
      generation.pendingInput = []
      generation.pendingBytes = 0
    }
    // Retire the policy, not the entry: the session's screen, held resize and
    // viewer flag belong to the session lifecycle, which outlives its client.
    if (owned) owned.client = undefined
    // THE TERMINAL THAT WAS AT THAT SIZE IS GONE (POD-3290), so the daemon holds
    // no applied grid for this session any more.
    ports.appliedGeometry?.forget(sessionId)
    if (policy) {
      // The relay keeps a coalescing entry per session stream. Nothing else
      // would ever drop the attachment's pending output after teardown.
      ports.releaseStream?.(sessionId)
    }
    // Nothing of ours, and no master holding the label: do not pay a process
    // spawn per session teardown to reclaim something that was never started.
    //
    // THE CANDIDATE SET IS THE REGISTRY'S (POD-2823), not three names written
    // here. A caller that knows its harness names it; one that does not asks
    // every harness that declares a client terminal, so a fourth driver's parked
    // master is reclaimed by declaring itself rather than by somebody
    // remembering this line.
    const labels = policy
      ? [policy.label]
      : (kind ? [kind] : CLIENT_TERMINAL_HARNESSES)
          .map((candidate) => clientTerminalLabel(sessionId, candidate))
          .filter((label): label is string => label !== undefined)
          // The probe is the session's, not the relay's: a caller that holds
          // no session still asks the session layer whether a master lives.
          .filter((label) => clients.hasClientMaster(label))
    if (labels.length === 0) return
    // PARK FIRST: drop the Terminal (unwire + detach) while the master still
    // holds the label, then reclaim the master itself. The session entry goes
    // with the close — a later attach starts a fresh generation.
    sessions.get(sessionId)?.park()
    for (const label of labels) await clients.reclaimClient(label)
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
    const policy = sessions.get(sessionId)?.client
    if (!policy) {
      const label = clientTerminalLabel(sessionId, kind)
      if (label !== undefined && clients.hasClientMaster(label))
        await clients.reclaimClient(label)
      return
    }
    if (policy.generation) {
      policy.generation.acceptingInput = false
      policy.generation.pendingInput = []
      policy.generation.pendingBytes = 0
      policy.generation = undefined
    }
    // Retire exactly the obsolete process through the session: park drops the
    // Terminal while the label stays owned, and the master reclaim below is
    // authoritative for the process itself.
    sessions.get(sessionId)?.park()
    policy.preserveReplayOnRelaunch = true
    policy.suppressNextReplayRedraw = false
    policy.replayRequired = false
    if (clients.hasClientMaster(policy.label)) await clients.reclaimClient(policy.label)
    // No daemon clock: the replacement client (if the viewer returns) starts a
    // fresh server-measured warm window, and the retired master above is gone.
  }

  /**
   * The viewer left Native. See {@link OpencodeClientTerminals.release} for why
   * this is not `close()` for every harness.
   */
  async function release(sessionId: SessionId): Promise<void> {
    const policy = sessions.get(sessionId)?.client
    const generation = policy?.generation
    if (generation) {
      // Revoke BEFORE awaiting a start: input racing this release must refuse.
      generation.acceptingInput = false
      generation.pendingInput = []
      generation.pendingBytes = 0
    }
    // The policy remembers its own harness key; `release()` never re-derives it.
    if (!policy || clientTerminalFor(policy.kind as ClientTerminalKind)?.parkOnRelease !== true) {
      await close(sessionId)
      return
    }
    /**
     * A START IN FLIGHT IS STILL A CLIENT TO PARK. The Terminal is only set
     * once `start()` returns, so parking around it would leave the finished
     * client attached — streaming a TUI into a browser that has gone back to
     * Chat, with a writer the release was supposed to revoke. The reconcile
     * serialises attach against release for one session, so this normally does
     * not wait at all; a rejected start needs nothing parked.
     */
    if (policy.starting) {
      try {
        const started = await policy.starting
        // Park the just-finished Terminal unless this policy already owns it —
        // `attach()` assigns only generations it still holds.
        if (sessions.get(sessionId)?.terminal !== started) started.park()
      } catch {
        // the client never started: there is nothing attached to park
      }
    }
    // A rejected start may have removed this exact policy while release was awaiting it.
    // Never park a policy that no longer owns the session id.
    if (sessions.get(sessionId)?.client !== policy) return
    // PARK = drop the Terminal, keep the process. Cleared from the session
    // BEFORE anything can find a handle that is on its way out, so no input,
    // resize or redraw reaches a client whose writer was revoked.
    sessions.get(sessionId)?.park()
    // The master keeps following its provider while parked, but with this relay
    // detached those bytes never enter SessionTerminal's replay. Returning to
    // Native must repaint after subscribing even though spawn reports adoption.
    policy.replayRequired = true
    policy.suppressNextReplayRedraw = false
    // Nobody is watching a parked client by definition. Its warm window is the
    // server's to measure (POD-4524) — this daemon arms nothing here; the
    // server orders `closeClientTerminal` when the table's row fires, and the
    // pressure sweep reclaims it sooner under host pressure.
  }

  return {
    async attach({ sessionId, target }) {
      let owned = sessions.get(sessionId)
      let policy = owned?.client
      if (!owned || !policy) {
        const label = clientTerminalLabel(sessionId, target.kind, target.driverId)
        if (label === undefined)
          throw new Error(`${target.kind} declares no client terminal to attach`)
        owned = sessions.ensure(sessionId)
        policy = { label, kind: target.kind }
        owned.client = policy
        // Born knowing whether anyone is looking: the viewer frame usually
        // arrives before the entry, so the registry remembers it entry-free.
        owned.watched = owned.watched || sessions.isWatched(sessionId)
      }
      // No daemon clock (POD-4524): the warm window is measured by the server's
      // table from its own viewer signal, which it already sends on every
      // change. A start that hangs leaves its master to the server's warm-park
      // order (or the pressure sweep, or session teardown) rather than to a
      // timer here.
      if (!owned.terminal) {
        let generation = policy.generation
        let pending = policy.starting
        if (!pending) {
          generation = { acceptingInput: true, pendingInput: [], pendingBytes: 0 }
          policy.generation = generation
          pending = start(sessionId, policy, target)
          policy.starting = pending
        }
        if (!generation) throw new Error('client terminal start lost its generation')
        let started: Terminal
        try {
          started = await pending
        } catch (err) {
          const failed = sessions.get(sessionId)
          if (failed?.client === policy && policy.generation === generation) {
            generation.acceptingInput = false
            generation.pendingInput = []
            generation.pendingBytes = 0
            policy.generation = undefined
            failed.client = undefined
          }
          throw err
        } finally {
          if (policy.starting === pending) policy.starting = undefined
        }
        const current =
          sessions.get(sessionId)?.client === policy &&
          policy.generation === generation &&
          generation.acceptingInput
        if (!current) {
          started.park()
          const replacement = sessions.get(sessionId)?.client
          const replaced = replacement !== policy
          if (replacement === undefined) await clients.reclaimClient(policy.label)
          throw new Error(
            replaced
              ? 'the client terminal was closed while it was starting'
              : 'the client terminal generation was revoked while it was starting',
          )
        }
        owned.terminal = started
        const buffered = generation.pendingInput
        generation.pendingInput = []
        generation.pendingBytes = 0
        for (const data of buffered) started.write(data)
      }
      driverTiming.nativeCliStage(sessionId, target.kind, 'native_cli_input_ready')
      // The terminal relay is session-addressed in both directions: the
      // stream's resolvable wire identity is the parent Podium session rather
      // than an orphan UUID (POD-2108).
      return { streamId: sessionId, warmTtlMs: WARM_TTL_MS }
    },

    adopt(sessionId, kind = 'opencode') {
      if (sessions.get(sessionId)?.client) return
      const label = clientTerminalLabel(sessionId, kind)
      // No declaration means no label, and no label means there is nothing this
      // daemon could have spawned to adopt.
      if (label === undefined || !clients.hasClientMaster(label)) return
      const owned = sessions.ensure(sessionId)
      owned.client = {
        label,
        kind,
        suppressNextReplayRedraw: true,
      }
      // Born knowing whether anyone is looking: see `viewers` below.
      owned.watched = owned.watched || sessions.isWatched(sessionId)
      // Adopting puts the master back under somebody's control (POD-4524): the
      // deadline is the server's warm-park order, not a timer here.
      log.info('adopted a client terminal that outlived the daemon', { sessionId, label })
    },

    close,

    relaunch,

    release,

    viewers(sessionId, watched) {
      // RECORDED FIRST, AND WHETHER OR NOT THERE IS AN ENTRY. The frame
      // that says "somebody opened this session" usually arrives BEFORE anyone
      // asks for its terminal, and it is sent only on change — so a return here
      // would throw away the only notice this module ever gets. The registry
      // remembers it entry-free; a later open seeds the entry flag from it.
      sessions.noteWatched(sessionId, watched)
      const owned = sessions.get(sessionId)
      if (!owned || owned.watched === watched) return
      owned.watched = watched
      // Recorded and nothing more (POD-4524): watched holds the server's warm
      // window off, unwatched starts it there. The pressure sweep reads this
      // same flag to spare what somebody is looking at.
    },

    input(sessionId, data) {
      const owned = sessions.get(sessionId)
      const policy = owned?.client
      const generation = policy?.generation
      if (!owned || !policy || !generation?.acceptingInput) return false
      const terminal = owned.terminal
      if (terminal?.live) {
        terminal.write(data)
        return true
      }
      if (!policy.starting) return false
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
      const terminal = sessions.get(sessionId)?.terminal
      if (!terminal?.live) return false
      terminal.resize(cols, rows)
      return true
    },

    resizeAcknowledged(sessionId, cols, rows) {
      const terminal = sessions.get(sessionId)?.terminal
      if (!terminal?.live) return undefined
      // No acknowledgement on this backend: the fire-and-forget resize above
      // IS the apply, so the requested size stays the fact — answered now, so
      // the caller keeps its synchronous record.
      return terminal.resizeAcknowledged(cols, rows)
    },

    redraw(sessionId, replayRequired = false) {
      const owned = sessions.get(sessionId)
      const policy = owned?.client
      if (!owned || !policy) return false
      const terminal = owned.terminal
      if (replayRequired && !terminal) {
        policy.replayRequired = true
        policy.suppressNextReplayRedraw = false
        return true
      }
      if (policy.suppressNextReplayRedraw && !replayRequired) {
        policy.suppressNextReplayRedraw = false
        return true
      }
      policy.suppressNextReplayRedraw = false
      if (!terminal?.live) return false
      terminal.redraw()
      return true
    },

    reclaimable() {
      let count = 0
      for (const [, owned] of sessions.entries()) {
        if (owned.client && !owned.watched) count += 1
      }
      return count
    },

    async reclaimUnwatched() {
      // Snapshot first: `close` retires the policy, and a watched attachment must
      // survive the sweep — reclaiming the terminal someone is looking at is not
      // a cheaper trade than parking an idle agent, it is a worse one.
      const targets = [...sessions.entries()]
        .filter(([, owned]) => owned.client && !owned.watched)
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
