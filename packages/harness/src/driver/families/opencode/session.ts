/**
 * THE opencode SERVER SESSION, AS THE SUPERVISOR RUNS IT (POD-1761 W5; plan §3).
 *
 * (Moved from apps/daemon/src/runtime/opencode-driver.ts in 1.5: the daemon
 * stops knowing this headless harness. Ports and facts as in
 * ../codex/session.ts.)
 *
 * ---------------------------------------------------------------------------
 * A SESSION WITH NO PTY, RENDERING IN A UI BUILT FOR PTYs
 * ---------------------------------------------------------------------------
 *
 * This is where the epic's claim gets tested. A server-family session has no
 * bridge, no abduco master, no frames and no observer — and the acceptance
 * criterion is that it works from the existing web UI with NO UI redesign. The
 * only way both can be true is if the supervisor speaks, on this session's behalf,
 * the same small vocabulary of frames every other session speaks:
 *
 *   `bind`            — the session is live (what flips its status)
 *   `transcriptDelta` — chat
 *   `agentState`      — the state badge
 *   `agentExit`       — the process went away
 *
 * That translation is this file's main job, and it is deliberately a
 * TRANSLATION rather than a second source of truth. Which is also what
 * discharges the precondition W3's review recorded against the `runtime` message
 * family: `runtimeFineEvent` is the live-only delta frame on the argument that the
 * durable truth arrives by another path, and for a server-family session that
 * argument only holds if the daemon actually PUTS it on that path. It does, here.
 * (The second half of that precondition — a wire representation for `snapshot()`
 * so a server holding a gap can re-read — lands with the `runtimeSnapshot`
 * frames; see `packages/protocol/src/messages/runtime.ts`.)
 *
 * ---------------------------------------------------------------------------
 * WHAT IT DOES NOT DO
 * ---------------------------------------------------------------------------
 *
 * It does not touch the legacy spawn path. A session that did not ask for this
 * driver never reaches this file, and `launchSpawn` is byte-for-byte what it
 * was — which is the whole of the "default-path sessions are unchanged" claim.
 */

import type { AgentSessionHandle } from '../../driver.js'
import type { RuntimeEvent } from '../../events.js'
import type { PendingInteraction } from '../../interactions.js'
import { attachKindsForDriver, configureFieldsForDriver } from '../../configure-catalog.js'
import {
  OPENCODE_SERVER_DRIVER_ID,
  type OpencodeRuntime,
  type OpencodeRuntimeHost,
  createOpencodeRuntime,
} from './runtime.js'
import type { OpencodeEngineFlavor } from './engine-facts.js'
import { reportQueueAbandonment } from '../queue-report.js'
import type { ServerSessionFramePorts } from '../server-family.js'
import type { ServerFamilyJournalEntry } from '../server-family.js'
import { createLogger } from '@podium/logger'
import type { AgentRuntimeState, HarnessAgent, SessionId } from '@podium/model'
import { type DaemonMessage, isRuntimeFineEvent } from '@podium/protocol/daemon'

const log = createLogger('harness:opencode-session')

/**
 * What an opencode session adapter needs from whoever supervises it. Ports
 * and facts as in ../codex/session.ts.
 */
export interface OpencodeSessionDeps extends ServerSessionFramePorts {
  flavor: OpencodeEngineFlavor
  engine: OpencodeRuntimeHost
}

export interface OpencodeSessionLaunch {
  sessionId: SessionId
  cwd: string
  model?: string
  effort?: string
  env?: Readonly<Record<string, string>>
  initialPrompt?: string
}

export interface DaemonOpencodeRuntime extends OpencodeRuntime {
  /** Start a session on this driver and put it behind the contract. Resolves
   *  when the server is up and the opencode session exists. */
  launch(input: OpencodeSessionLaunch): Promise<void>
  /**
   * Re-bind a session whose SERVER survived this daemon, from the journal alone.
   *
   * `undefined` when nothing is answering — the entry is stale and the caller
   * reports the session gone rather than falling through to a PTY path that
   * would look for an abduco master this family never had.
   *
   * Distinct from the contract's `adopt(binding)`, which takes a live
   * `SessionBinding` a caller already holds. After a daemon restart nobody holds
   * one: the journal IS the binding, which is why it records the process key,
   * the port and the secret.
   */
  adoptFromJournal(sessionId: SessionId): Promise<AgentSessionHandle | undefined>
  /** Uniform server-family shape: the supervisor composes families without
   *  naming them. Satisfied by the members below (describe/journalEntry/
   *  clearJournal) plus the spread runtime above. */
  readonly describe: string
  journalEntry(sessionId: SessionId): ServerFamilyJournalEntry | undefined
  clearJournal(sessionId: SessionId): void
}

export function createOpencodeSessionRuntime(deps: OpencodeSessionDeps): DaemonOpencodeRuntime {
  const runtime = createOpencodeRuntime({
    ...deps.engine,
    // A queue this driver loses becomes a durable server-side receipt
    // correction, so the port is wired HERE, next to `send` (POD-2297).
    onQueueAbandoned: reportQueueAbandonment(deps.flavor.harnessKind, deps.send),
    reportObservedConfiguration: ({ sessionId, model, effort }) =>
      deps.send({
        type: 'agentModel',
        sessionId,
        model,
        ...(effort ? { effort } : {}),
      }),
  })

  /**
   * Fan one session's contract events out onto the daemon's frame stream.
   *
   * ONE READER PER SESSION, started at launch and ending when the stream does.
   * It reads from `'bootstrap'` so nothing that happened between the handle
   * being built and this loop starting is missed — the events() contract is
   * explicit that exactly one snapshot opens a stream, and taking it here is
   * what makes that snapshot ours.
   */
  function pump(sessionId: SessionId): void {
    const handle = runtime.handleFor(sessionId)
    if (!handle) return
    void (async () => {
      try {
        const boundary = deps.startMailContinuation(
          handle,
          () => runtime.handleFor(sessionId) === handle,
        )
        for await (const event of handle.events('bootstrap')) {
          translate(sessionId, event)
          boundary(event)
        }
      } catch (err) {
        log.warn('opencode runtime event stream ended', { err, sessionId })
      }
    })()
  }

  /**
   * TELL THE SERVER WHICH opencode SESSION THIS IS (POD-2114).
   *
   * Without this the transcript is structurally empty, and it took a test drive
   * on a real instance to see it. `sessions.read` does NOT read the live delta
   * buffer — it reads through the harness transcript source, which for opencode
   * is keyed on the row's `resume.value`. The terminal path populates that from
   * three places in the PTY/observer machinery; a server-family session goes
   * through none of them, so the row's `resume` stayed null, the source had no
   * session to open, and chat returned `items: []` while opencode's own store
   * held the whole exchange.
   *
   * `confidence: 'exact'` is the truth rather than a default: the id came back
   * from `POST /session` in this process. It is reported on LAUNCH and on ADOPT
   * because a rebound session's row may predate the ref or have lost it.
   */
  function reportResumeRef(sessionId: SessionId, handle: AgentSessionHandle): void {
    const resume = handle.binding.resume
    if (!resume) return
    deps.send({ type: 'sessionResumeRef', sessionId, resume, confidence: 'exact' })
  }

  function sendState(sessionId: SessionId): void {
    void runtime
      .handleFor(sessionId)
      ?.state()
      .then((state: AgentRuntimeState) => {
        deps.send({ type: 'agentState', sessionId, state })
      })
      .catch(() => {
        // A state read that fails leaves the last badge in place, which is
        // the last thing we actually observed. Better than clearing it.
      })
  }

  function translate(sessionId: SessionId, event: RuntimeEvent): void {
    const timingHandle = runtime.handleFor(sessionId)
    if (timingHandle) deps.traceRuntimeEvent(timingHandle.binding, event)
    // THE CONTRACT STREAM GOES OUT AS ITSELF TOO. A consumer that speaks the
    // contract (W4's migrated callers) reads this; the legacy frames below are
    // for the surfaces that do not, and both describe the same fact.
    if (isRuntimeFineEvent(event)) {
      deps.send({ type: 'runtimeFineEvent', sessionId, event })
    } else {
      deps.send({ type: 'runtimeEvent', sessionId, event })
    }

    switch (event.t) {
      case 'item': {
        // Only COMPLETE items become transcript deltas. A `delta` fragment is a
        // fine-watch token stream, and the durable transcript path has never
        // carried partial items — pushing them there would write a message into
        // chat one character at a time and then again in full.
        if (event.item.kind !== 'complete') return
        deps.send({
          type: 'transcriptDelta',
          sessionId,
          items: [event.item.item],
        })
        return
      }
      case 'state': {
        // The badge. `state()` is the driver's own folded projection, so the
        // frame carries the same value a `snapshot()` would — rather than this
        // file re-folding the event vocabulary into a second reducer.
        sendState(sessionId)
        return
      }
      case 'turn': {
        // `deliver` folds the accepted prompt into `working` before emitting
        // this edge. The server's later `session.status` event is not the
        // source of truth for the badge: on opencode it can arrive seconds
        // after the prompt was accepted. Completion still arrives through the
        // normal `state` event, so only publish the immediate start edge here.
        // Bootstrap replays prior turn edges; those must not overwrite the
        // current projection.
        if (event.provenance !== 'live' || event.ev.ev !== 'started') return
        sendState(sessionId)
        return
      }
      case 'interaction': {
        // THE ASK GOES TO THE SERVER AGGREGATE, not to a driver-local list. W2
        // owns the durable row, and every surface — web, mobile, CLI — reads it
        // from there. A driver that kept its own list would make an ask visible
        // only to whoever happened to hold the handle.
        if (event.ev.ev !== 'asked') return
        const interaction: PendingInteraction = event.ev.interaction
        deps.send({ type: 'runtimeInteractionAsked', sessionId, interaction })
        return
      }
      case 'process': {
        if (event.ev.ev !== 'exited') return
        deps.send({ type: 'agentExit', sessionId, code: event.ev.code ?? 0 })
        return
      }
      default:
        // `workspace` and `open-url` have no legacy frame that carries them for
        // this family, and inventing one would be a second unreconciled writer
        // for facts the contract stream above already delivers.
        return
    }
  }

  return {
    ...runtime,
    describe: `${deps.flavor.executableName} serve`,
    journalEntry(sessionId) {
      const entry = deps.engine.journal.read(sessionId)
      if (!entry) return undefined
      return {
        workdir: entry.workdir,
        process: entry.process,
        bindingVersion: entry.bindingVersion,
        probe: {
          baseUrl: entry.baseUrl,
          secret: entry.secret,
          ...(entry.username ? { username: entry.username } : {}),
          healthPath: deps.flavor.healthPath,
        },
      }
    },
    clearJournal(sessionId) {
      deps.engine.journal.clear(sessionId)
    },

    /**
     * `has` COMES STRAIGHT FROM THE RUNTIME, and this comment is here because a
     * parallel Set used to live at this line (POD-2023 review addendum).
     *
     * It tracked launches and was cleared only on a `process: exited` event, so
     * `hibernate`/`stop`/`kill` — which all drop the handle — left it saying
     * `true` for a session with nobody home. The daemon reports that as
     * `bind.driverId`, so a reattached parked session would have been
     * routed onto a contract path where every verb answers `not_running`: the
     * same shape as the bind-fact bug one layer up, which is what made it worth
     * deleting the Set rather than fixing its bookkeeping.
     */
    async adoptFromJournal(sessionId) {
      const entry = deps.engine.journal.read(sessionId)
      // No entry is "not mine". A journalled entry whose driver then refuses
      // is reported, not swallowed (§4.8): the cause tells the operator why
      // and lets the lifecycle invalidate pending turns, rather than a
      // generic "could not be rebound".
      if (!entry) return undefined
      const handle = await runtime.driver.adopt({
        sessionId: entry.sessionId,
        driver: deps.flavor.driverId,
        family: 'server',
        harness: deps.flavor.harnessKind,
        workdir: entry.workdir,
        resume: { kind: 'opencode-session', value: entry.opencodeSessionId },
        process: entry.process,
        bindingVersion: entry.bindingVersion,
      })
      pump(sessionId)
      reportResumeRef(sessionId, handle)
      return handle
    },

    async launch(input) {
      /**
       * THE SERVER'S ID, NOT A FRESH ONE.
       *
       * `driver.create()` mints its own — that is right at the contract's
       * altitude, where the driver is what brings a session into existence. Here
       * the session row already exists and its id is on the spawn frame, so
       * registering the handle under anything else makes every subsequent verb
       * answer `not_running` for a session that is running perfectly.
       */
      const handle = await runtime.createWithId(input.sessionId, {
        harness: deps.flavor.harnessKind,
        selection: {
          auth: 'api-key',
          platform: process.platform,
          available: [deps.flavor.driverId],
          preference: deps.flavor.driverId,
        },
        workdir: input.cwd,
        model: {
          ...(input.model && input.model !== 'auto' ? { model: input.model } : {}),
          ...(input.effort && input.effort !== 'auto' ? { effort: input.effort } : {}),
        },
        instructions: {
          supported: false,
          reason: 'opencode takes its instructions from OPENCODE_CONFIG_CONTENT at spawn',
        },
        mcpServers: { supported: false, reason: 'opencode MCP config rides its own config file' },
        ...(input.env ? { env: input.env } : {}),
        ...(input.initialPrompt ? { initialPrompt: input.initialPrompt } : {}),
      })
      pump(input.sessionId)
      /**
       * `bind` IS WHAT MARKS THE SESSION LIVE, and it is sent with the truth
       * rather than with a plausible imitation of a PTY spawn. `cmd` names the
       * server this session actually is; a fake `abduco -a …` would put a lie in
       * the one field an operator reads to find out what is running.
       *
       * NO GEOMETRY (POD-3290). What stood here was `{ cols: 120, rows: 40 }`,
       * described in this very comment as "nominal" — the size an `opencode
       * attach` client WOULD open at, for a launch that opens none. The server
       * had no way to tell that from a report and marked W `current` on it. The
       * grid is now the applied-size record's to state, through the one builder,
       * and at launch this family has applied nothing.
       */
      deps.sessionReady(handle.binding)
      deps.emitBind({
          sessionId: input.sessionId,
          cmd: `opencode serve (${handle.binding.driver})`,
          cwd: input.cwd,
          agentKind: deps.flavor.harnessKind,
          /**
           * THE BIND FACT, AND FOR THIS FAMILY IT IS NOT OPTIONAL (POD-2023).
           *
           * The server records `driverId` on the row and keys its senders on
           * its presence to decide the contract path. A terminal session that
           * omitted it would take a slower route to the same place; a SERVER
           * session that omitted it would be handed to a path that types at a
           * PTY this session does not have — the write would go nowhere and
           * report success.
           *
           * Stated outright rather than probed, because reaching this line IS
           * the proof: the handle above was constructed and registered.
           */
          driverId: handle.binding.driver,
          // POD-3087: what this driver's configure() can change, read off its own
          // declaration so no consumer has to keep a second copy of it.
          configureFields: [...configureFieldsForDriver(handle.binding.driver)],
          attachKinds: [...attachKindsForDriver(handle.binding.driver)],
      })
      // …and the first state, so the badge is right before the first event
      // rather than after it.
      deps.send({ type: 'agentState', sessionId: input.sessionId, state: await handle.state() })
      reportResumeRef(input.sessionId, handle)
    },
  }
}
