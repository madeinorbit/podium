/**
 * THE codex app-server SESSION, AS THE DAEMON RUNS IT (POD-1761 W6; plan §4).
 *
 * ---------------------------------------------------------------------------
 * THE SAME TRANSLATION THE opencode DRIVER MAKES, FOR THE SAME REASON
 * ---------------------------------------------------------------------------
 *
 * A server-family session has no bridge, no abduco master, no frames and no
 * observer — and the acceptance criterion is that it works from the existing web
 * UI with NO UI redesign. So the daemon speaks, on this session's behalf, the
 * same small vocabulary every other session speaks: `bind`, `transcriptDelta`,
 * `agentState`, `agentExit`. This file is that translation and deliberately
 * nothing else.
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

import {
  CODEX_APP_SERVER_DRIVER_ID,
  type CodexJournal,
  type CodexRuntime,
  type CodexRuntimeHost,
  createCodexRuntime,
  type PendingInteraction,
  type RuntimeEvent,
} from '@podium/agent-runtime'
import type { AgentSessionHandle } from '@podium/agent-runtime'
import { createLogger } from '@podium/logger'
import type { AgentRuntimeState, SessionId } from '@podium/model'
import type { DaemonMessage } from '@podium/protocol'

const log = createLogger('daemon:codex-driver')

/** The narrow slice of the daemon this driver's session lifecycle needs. */
export interface CodexSessionHost {
  send(msg: DaemonMessage): void
  host: CodexRuntimeHost
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
   * FOR THIS FAMILY THAT MEANS RESUMING THE THREAD, NOT REBINDING A PROCESS,
   * and the difference is measured rather than stylistic: `codex app-server`
   * exits cleanly on stdin EOF, and its channel IS the child's stdio, so when
   * the daemon dies its pipes close and every codex child dies with it. There is
   * never a survivor to find.
   *
   * What survives is the conversation — codex writes each thread to its own
   * rollout JSONL — so `driver.adopt()` starts a fresh child and resumes the
   * journalled thread id. Session id, thread id, transcript, resume ref, turn
   * epoch and event seq all hold; the process is new and says so by bumping the
   * binding version. `undefined` when there is nothing to rebind from.
   */
  adoptFromJournal(sessionId: SessionId): Promise<AgentSessionHandle | undefined>
}

export function createDaemonCodexRuntime(deps: CodexSessionHost): DaemonCodexRuntime {
  const runtime = createCodexRuntime(deps.host)
  const live = new Set<SessionId>()

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
        for await (const event of handle.events('bootstrap')) translate(sessionId, event)
      } catch (err) {
        log.warn('codex runtime event stream ended', { err, sessionId })
      }
    })()
  }

  function translate(sessionId: SessionId, event: RuntimeEvent): void {
    // THE CONTRACT STREAM GOES OUT AS ITSELF TOO. A consumer that speaks the
    // contract reads this; the legacy frames below are for the surfaces that do
    // not, and both describe the same fact.
    deps.send({ type: 'runtimeEvent', sessionId, event })

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
        live.delete(sessionId)
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

    has: (sessionId) => live.has(sessionId),

    journal: deps.host.journal,

    async adoptFromJournal(sessionId) {
      const entry = deps.host.journal.read(sessionId)
      if (!entry) return undefined
      let handle: AgentSessionHandle
      try {
        handle = await runtime.driver.adopt({
          sessionId: entry.sessionId,
          driver: CODEX_APP_SERVER_DRIVER_ID,
          family: 'server',
          harness: 'codex',
          workdir: entry.workdir,
          resume: { kind: 'codex-thread', value: entry.threadId },
          process: entry.process,
          bindingVersion: entry.bindingVersion,
        })
      } catch {
        // `adopt()` REJECTS when it cannot rebind — for this family that means
        // the journal is missing or names a different incarnation, or codex
        // would not resume the thread. Either way it is "gone" to the caller,
        // which turns it into an honest reattach failure rather than a fall
        // through to a PTY path that would go looking for an abduco socket.
        return undefined
      }
      live.add(sessionId)
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
        harness: 'codex',
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
      live.add(input.sessionId)
      pump(input.sessionId)
      reportResumeRef(input.sessionId, handle)
      /**
       * `bind` IS WHAT MARKS THE SESSION LIVE, sent with the truth rather than a
       * plausible imitation of a PTY spawn. `cmd` names the process this session
       * actually is; a fake `abduco -a …` would put a lie in the one field an
       * operator reads to find out what is running.
       *
       * The geometry is nominal: nothing renders frames for this family, and the
       * field is required by the frame.
       */
      deps.send({
        type: 'bind',
        sessionId: input.sessionId,
        cmd: `codex app-server (${handle.binding.driver})`,
        cwd: input.cwd,
        agentKind: 'codex',
        geometry: { cols: 120, rows: 40 },
        /**
         * THE BIND FACT, AND FOR THIS FAMILY IT IS NOT OPTIONAL (POD-2023's
         * lesson, unchanged here). The server records it on the row and W4's
         * migrated senders branch on it to choose between the contract and the
         * legacy PTY path. A SERVER session that got it wrong would be handed to
         * a path that types at a PTY this session does not have — the write
         * would go nowhere and report success.
         *
         * Hardcoded `true` rather than probed, because reaching this line IS the
         * proof: the handle above was constructed and registered.
         */
        runtimeContract: true,
      })
      // …and the first state, so the badge is right before the first event
      // rather than after it.
      deps.send({ type: 'agentState', sessionId: input.sessionId, state: await handle.state() })
    },
  }
}
