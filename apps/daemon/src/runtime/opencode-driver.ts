/**
 * THE opencode SERVER SESSION, AS THE DAEMON RUNS IT (POD-1761 W5; plan §3).
 *
 * ---------------------------------------------------------------------------
 * A SESSION WITH NO PTY, RENDERING IN A UI BUILT FOR PTYs
 * ---------------------------------------------------------------------------
 *
 * This is where the epic's claim gets tested. A server-family session has no
 * bridge, no abduco master, no frames and no observer — and the acceptance
 * criterion is that it works from the existing web UI with NO UI redesign. The
 * only way both can be true is if the daemon speaks, on this session's behalf,
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

import {
  type AgentSessionHandle,
  createOpencodeRuntime,
  OPENCODE_SERVER_DRIVER_ID,
  type OpencodeRuntime,
  type OpencodeRuntimeHost,
  type PendingInteraction,
  type RuntimeEvent,
} from '@podium/agent-runtime'
import { createLogger } from '@podium/logger'
import type { AgentRuntimeState, SessionId } from '@podium/model'
import type { DaemonMessage } from '@podium/protocol/daemon'
import { reportQueueAbandonment } from './queue-abandonment'

const log = createLogger('daemon:opencode-driver')

/** The narrow slice of the daemon this driver's session lifecycle needs. */
export interface OpencodeSessionHost {
  send(msg: DaemonMessage): void
  host: OpencodeRuntimeHost
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
}

export function createDaemonOpencodeRuntime(deps: OpencodeSessionHost): DaemonOpencodeRuntime {
  const runtime = createOpencodeRuntime({
    ...deps.host,
    // A queue this driver loses becomes a durable server-side receipt
    // correction, so the port is wired HERE, next to `send` (POD-2297).
    onQueueAbandoned: reportQueueAbandonment('opencode', deps.send),
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
        for await (const event of handle.events('bootstrap')) {
          translate(sessionId, event)
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

  function translate(sessionId: SessionId, event: RuntimeEvent): void {
    // THE CONTRACT STREAM GOES OUT AS ITSELF TOO. A consumer that speaks the
    // contract (W4's migrated callers) reads this; the legacy frames below are
    // for the surfaces that do not, and both describe the same fact.
    if (event.t === 'item' && event.item.kind === 'delta') {
      deps.send({ type: 'runtimeFineEvent', sessionId, event: { ...event, item: event.item } })
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
        // `turn`, `workspace` and `open-url` have no legacy frame that carries
        // them for this family, and inventing one would be a second unreconciled
        // writer for facts the contract stream above already delivers.
        return
    }
  }

  return {
    ...runtime,

    /**
     * `has` COMES STRAIGHT FROM THE RUNTIME, and this comment is here because a
     * parallel Set used to live at this line (POD-2023 review addendum).
     *
     * It tracked launches and was cleared only on a `process: exited` event, so
     * `hibernate`/`stop`/`kill` — which all drop the handle — left it saying
     * `true` for a session with nobody home. The daemon reports that as
     * `bind.runtimeContract`, so a reattached parked session would have been
     * routed onto a contract path where every verb answers `not_running`: the
     * same shape as the bind-fact bug one layer up, which is what made it worth
     * deleting the Set rather than fixing its bookkeeping.
     */
    async adoptFromJournal(sessionId) {
      const entry = runtime.journal.read(sessionId)
      if (!entry) return undefined
      let handle: AgentSessionHandle
      try {
        handle = await runtime.driver.adopt({
          sessionId: entry.sessionId,
          driver: OPENCODE_SERVER_DRIVER_ID,
          family: 'server',
          harness: 'opencode',
          workdir: entry.workdir,
          resume: { kind: 'opencode-session', value: entry.opencodeSessionId },
          process: entry.process,
          bindingVersion: entry.bindingVersion,
        })
      } catch {
        // `adopt()` REJECTS for a process that did not survive — that is the
        // contract's own wording and its exactness is the point. Here it simply
        // means "gone", and the caller turns it into an honest reattach failure.
        return undefined
      }
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
        harness: 'opencode',
        selection: {
          auth: 'api-key',
          platform: process.platform,
          available: ['opencode-server'],
          preference: 'opencode-server',
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
       * The geometry is nominal: nothing renders frames for this family, and the
       * field is required by the frame. It is the size an `opencode attach`
       * client would open at.
       */
      deps.send({
        type: 'bind',
        sessionId: input.sessionId,
        cmd: `opencode serve (${handle.binding.driver})`,
        cwd: input.cwd,
        agentKind: 'opencode',
        geometry: { cols: 120, rows: 40 },
        /**
         * THE BIND FACT, AND FOR THIS FAMILY IT IS NOT OPTIONAL (POD-2023).
         *
         * The server records this on the row and W4's migrated senders branch on
         * it to decide between the contract and the legacy PTY path. A terminal
         * session that got this wrong would take a slower route to the same
         * place; a SERVER session that got it wrong would be handed to a path
         * that types at a PTY this session does not have — the write would go
         * nowhere and report success.
         *
         * Hardcoded `true` rather than probed, because reaching this line IS the
         * proof: the handle above was constructed and registered.
         */
        runtimeContract: true,
        driverId: handle.binding.driver,
      })
      // …and the first state, so the badge is right before the first event
      // rather than after it.
      deps.send({ type: 'agentState', sessionId: input.sessionId, state: await handle.state() })
      reportResumeRef(input.sessionId, handle)
    },
  }
}
