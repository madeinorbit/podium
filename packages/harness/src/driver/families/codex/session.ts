/**
 * THE codex app-server SESSION, AS THE SUPERVISOR RUNS IT (POD-1761 W6; plan §4).
 *
 * (Moved from apps/daemon/src/runtime/codex-driver.ts in 1.5: the daemon
 * stops knowing this headless harness. The session adapter translates the
 * contract event stream onto the supervisor's frame stream; every
 * supervisor facility it touches — send, bind, timing, mail continuation —
 * arrives as an injected port, and every harness-shaped value arrives
 * through the family's facts.)
 *
 * ---------------------------------------------------------------------------
 * THE SAME TRANSLATION THE opencode DRIVER MAKES, FOR THE SAME REASON
 * ---------------------------------------------------------------------------
 *
 * A server-family session has no bridge, no abduco master, no frames and no
 * observer — and the acceptance criterion is that it works from the existing web
 * UI with NO UI redesign. So the supervisor speaks, on this session's behalf,
 * the same small vocabulary every other session speaks: `bind`,
 * `transcriptDelta`, `agentState`, `agentExit`. This file is that translation
 * and deliberately nothing else.
 *
 * IT IS DERIVED FROM `./opencode-driver.ts` ON PURPOSE. The plan says to mirror
 * W5 file for file where it fits, and this fits exactly: the two drivers differ
 * in protocol, not in what the daemon owes the UI. Keeping the shape identical
 * is what makes a reader who knows one able to read the other, and it is why the
 * divergences below are worth calling out rather than being lost in a rewrite.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT DOES NOT DO (plan §1, "channel exclusivity")
 * ---------------------------------------------------------------------------
 *
 * It does NOT inject the Codex hook env, and it does NOT start the manifest
 * rollout observer. JSON-RPC events are the SOLE state channel for this family.
 * A session reporting through both would double-report every state change —
 * `turn/completed` from the protocol and a `Stop` hook from the same turn — and
 * the two would race to describe one fact. Global hooks stay fail-open-dormant:
 * they are keyed to an env var this spawn never sets.
 */

import { createLogger } from '@podium/logger'
import type { AgentRuntimeState, HarnessAgent, SessionId } from '@podium/model'
import { type DaemonMessage, isRuntimeFineEvent } from '@podium/protocol/daemon'
import { attachKindsForDriver, configureFieldsForDriver } from '../../configure-catalog.js'
import type { AgentSessionHandle } from '../../driver.js'
import type { RuntimeEvent } from '../../events.js'
import type { PendingInteraction } from '../../interactions.js'
import {
  CODEX_APP_SERVER_DRIVER_ID,
  type CodexJournal,
  type CodexRuntime,
  type CodexRuntimeHost,
  createCodexRuntime,
} from './runtime.js'
import type { CodexEngineFacts } from './engine-facts.js'
import { reportQueueAbandonment } from '../queue-report.js'
import type { ServerSessionFramePorts } from '../server-family.js'
import type { SessionDriverSlots } from '../session-slots.js'
import type { ServerFamilyJournalEntry } from '../server-family.js'

const log = createLogger('harness:codex-session')

/**
 * What a codex session adapter needs from whoever supervises it.
 *
 * The engine (protocol transport over the supervisor-held child) arrives as
 * `engine`; the frame stream, bind emission, timing and mail continuation
 * arrive as narrow ports; harness-shaped values arrive through `facts`. The
 * supervisor owns processes, disks and the wire — this adapter owns the
 * translation between the contract and the frames.
 */
export interface CodexSessionDeps extends ServerSessionFramePorts {
  /** The supervisor's per-session driver slots (POD-4610): the family binds
   *  each session's handle into its entry and keeps no handle index of its own. */
  driverSlots: SessionDriverSlots
  facts: CodexEngineFacts
  engine: CodexRuntimeHost
}

export interface CodexSessionLaunch {
  sessionId: SessionId
  cwd: string
  model?: string
  effort?: string
  env?: Readonly<Record<string, string>>
  initialPrompt?: string
  /**
   * Podium's MCP configuration for this session, as Claude-shaped JSON.
   *
   * OPTIONAL AND CURRENTLY NEVER SET, which is a declared gap rather than dead
   * code. The mount itself is implemented and tested end to end — the host turns
   * this into `-c mcp_servers.…` overrides via the manifest's own verified
   * `codexMcpArgs` — but the interactive `spawn` frame carries no MCP config
   * field, because interactive sessions have always mounted MCP through the
   * CLI's own config file. The field is here so that adding the wire field is a
   * one-line change at the caller rather than a re-plumbing, and the reason it
   * is unset is recorded at that caller in `control/session.ts`.
   */
  mcpConfig?: string
}

export interface DaemonCodexRuntime extends CodexRuntime {
  /** Start a session on this driver and put it behind the contract. Resolves
   *  when the child is up, the handshake is done and the thread exists. */
  launch(input: CodexSessionLaunch): Promise<void>
  /** Every session this runtime currently holds. */
  has(sessionId: SessionId): boolean
  /**
   * THE BINDING JOURNAL, so the reattach path can ask whether a session was
   * ours before it tries to adopt it.
   *
   * Exposed for the same reason the opencode runtime exposes its own: the
   * ENTRY'S EXISTENCE is the statement that this session was server-driven.
   * Every terminal session reaches the reattach path too, and none of them has
   * one, so this is what keeps the adopt attempt silent for sessions it has no
   * business touching.
   */
  journal: CodexJournal
  /**
   * Re-bind a session after a daemon restart, from the journal alone.
   *
   * FOR THIS FAMILY THAT USUALLY MEANS REBINDING THE SURVIVOR, NOT RESUMING
   * THE THREAD (POD-4433): the engine runs under podium-host `--no-pty`, so a
   * daemon restart leaves it running and `driver.adopt()` opens a second
   * protocol client on the journalled listener — the in-flight turn continues
   * rather than being abandoned. Only when nothing survived does adopt fall
   * back to a fresh child plus `thread/resume` of the journalled thread id,
   * whose rollout JSONL outlived the process. `undefined` when there is
   * nothing to rebind from.
   */
  adoptFromJournal(sessionId: SessionId): Promise<AgentSessionHandle | undefined>
  /** Uniform server-family shape: the supervisor composes families without
   *  naming them. Satisfied by the members below (describe/journalEntry/
   *  clearJournal) plus the spread runtime above. */
  readonly describe: string
  journalEntry(sessionId: SessionId): ServerFamilyJournalEntry | undefined
  clearJournal(sessionId: SessionId): void
}

export function createCodexSessionRuntime(deps: CodexSessionDeps): DaemonCodexRuntime {
  const runtime = createCodexRuntime({
    ...deps.engine,
    // A queue this driver loses becomes a durable server-side receipt
    // correction, so the port is wired HERE, next to `send` (POD-2297).
    onQueueAbandoned: reportQueueAbandonment(deps.facts.harnessKind, deps.send),
  }, deps.driverSlots)

  /**
   * Fan one session's contract events out onto the daemon's frame stream.
   *
   * ONE READER PER SESSION, started at launch and ending when the stream does.
   * It reads from `'bootstrap'` so nothing between the handle being built and
   * this loop starting is missed — the `events()` contract is explicit that
   * exactly one snapshot opens a stream, and taking it here is what makes that
   * snapshot ours.
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
        log.warn('codex runtime event stream ended', { err, sessionId })
      }
    })()
  }

  function translate(sessionId: SessionId, event: RuntimeEvent): void {
    const timingHandle = runtime.handleFor(sessionId)
    if (timingHandle) deps.traceRuntimeEvent(timingHandle.binding, event)
    // THE CONTRACT STREAM GOES OUT AS ITSELF TOO. A consumer that speaks the
    // contract reads this; the legacy frames below are for the surfaces that do
    // not, and both describe the same fact.
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
        deps.send({ type: 'transcriptDelta', sessionId, items: [event.item.item] })
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
        // owns the durable row, and every surface reads it from there. A driver
        // that kept its own list would make an ask visible only to whoever
        // happened to hold the handle — which for THIS family would be worse
        // than for opencode's, because a codex approval is a blocked JSON-RPC
        // request with no timeout behind it.
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
        // them for this family, and inventing one would be a second
        // unreconciled writer for facts the contract stream above delivers.
        return
    }
  }

  /** Tell the server the harness-native id this session resumes from, so a
   *  handoff or a later resume does not have to re-derive it. */
  function reportResumeRef(sessionId: SessionId, handle: AgentSessionHandle): void {
    const resume = handle.binding.resume
    if (!resume) return
    deps.send({ type: 'sessionResumeRef', sessionId, resume, confidence: 'exact' })
  }

  return {
    ...runtime,
    describe: [deps.facts.command, ...deps.facts.serverArgs].join(' '),
    journalEntry(sessionId) {
      const entry = deps.engine.journal.read(sessionId)
      if (!entry) return undefined
      return {
        workdir: entry.workdir,
        process: entry.process,
        bindingVersion: entry.bindingVersion,
      }
    },
    clearJournal(sessionId) {
      deps.engine.journal.clear(sessionId)
    },

    /**
     * STRAIGHT FROM THE RUNTIME'S HANDLE MAP, never a parallel Set (POD-2249;
     * the same repair `opencode-driver.ts` documents at its own `has`). The Set
     * this replaced was cleared only on a `process: exited` event, and the
     * lifecycle verbs — which drop the handle without one — left it saying
     * `true` for a session with nobody home, so a parked session's bind fact
     * routed every verb onto a contract path that answers `not_running`.
     */
    has: (sessionId) => runtime.handleFor(sessionId) !== undefined,

    journal: deps.engine.journal,

    async adoptFromJournal(sessionId) {
      const entry = deps.engine.journal.read(sessionId)
      // No entry is "not mine" — every terminal session reaches this path
      // too, and answering anything else would hijack a PTY session's
      // reattach. But a JOURNALLED entry whose driver then refuses is
      // reported, not swallowed: §4.8 needs the cause (unrecoverable protocol
      // state, a lease held elsewhere) to invalidate pending turns and to
      // tell the operator why, rather than a generic "could not be rebound".
      if (!entry) return undefined
      const handle = await runtime.driver.adopt({
        sessionId: entry.sessionId,
        driver: CODEX_APP_SERVER_DRIVER_ID,
        family: 'server',
        harness: deps.facts.harnessKind,
        workdir: entry.workdir,
        resume: { kind: 'codex-thread', value: entry.threadId },
        process: entry.process,
        bindingVersion: entry.bindingVersion,
      })
      pump(sessionId)
      reportResumeRef(sessionId, handle)
      return handle
    },

    async launch(input) {
      /**
       * THE SERVER'S ID, NOT A FRESH ONE. `driver.create()` mints its own — right
       * at the contract's altitude, where the driver is what brings a session
       * into existence. Here the session row already exists and its id is on the
       * spawn frame, so registering the handle under anything else makes every
       * subsequent verb answer `not_running` for a session that is running.
       */
      const handle = await runtime.createWithId(input.sessionId, {
        harness: deps.facts.harnessKind,
        selection: {
          // THE HARNESS WHERE SUBSCRIPTION AUTH WORKS HEADLESS, which is the
          // whole payoff of this driver: `~/.codex/auth.json` serves the
          // app-server exactly as it serves `codex exec`.
          auth: 'subscription',
          platform: process.platform,
          available: ['codex-app-server'],
          preference: 'codex-app-server',
        },
        workdir: input.cwd,
        model: {
          ...(input.model && input.model !== 'auto' ? { model: input.model } : {}),
          ...(input.effort && input.effort !== 'auto' ? { effort: input.effort } : {}),
        },
        instructions: {
          supported: false,
          reason:
            'codex takes developer instructions as a thread-start config override, which this driver does not yet set',
        },
        mcpServers: input.mcpConfig
          ? { supported: true, value: { transport: 'inline', config: input.mcpConfig } }
          : {
              supported: false,
              reason:
                'the interactive spawn frame carries no MCP config; this session mounts whatever ~/.codex/config.toml declares',
            },
        ...(input.env ? { env: input.env } : {}),
        ...(input.initialPrompt ? { initialPrompt: input.initialPrompt } : {}),
      })
      pump(input.sessionId)
      reportResumeRef(input.sessionId, handle)
      /**
       * `bind` IS WHAT MARKS THE SESSION LIVE, sent with the truth rather than a
       * plausible imitation of a PTY spawn. `cmd` names the process this session
       * actually is; a fake `abduco -a …` would put a lie in the one field an
       * operator reads to find out what is running.
       *
       * NO GEOMETRY (POD-3290). What stood here was `{ cols: 120, rows: 40 }`,
       * called "nominal" by this very comment and justified by the field being
       * required — which it no longer is (stage 3). Launching an app-server puts
       * nothing at a size, so the applied-size record is empty and the one bind
       * builder states nothing about the grid.
       */
      deps.sessionReady(handle.binding)
      deps.emitBind({
          sessionId: input.sessionId,
          cmd: `codex app-server (${handle.binding.driver})`,
          cwd: input.cwd,
          agentKind: deps.facts.harnessKind,
          /**
           * THE BIND FACT, AND FOR THIS FAMILY IT IS NOT OPTIONAL (POD-2023's
           * lesson, unchanged here). The server records `driverId` on the row
           * and keys its senders on its presence to choose the contract path.
           * A SERVER session that omitted it would be handed to a path that
           * types at a PTY this session does not have — the write would go
           * nowhere and report success.
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
    },
  }
}
