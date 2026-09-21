/**
 * `claude` IN STREAMING-INPUT MODE, ONE PER SESSION, UNDER A PODIUM-HOST
 * (`--no-pty`) OWNED BY THE SESSION LAYER'S DURABLE PROCESS (POD-4499).
 *
 * The family is handed the engine attachment by the session layer through the
 * injected `engines` port and never spawns, journals or kills the engine
 * itself; argv/env compose here off the handed facts, read through
 * {@link ClaudeEngineFacts}, and the stream-json wire is spoken by
 * ./protocol.js over a line transport. The protocol client lives in the
 * daemon's address space but loads no SDK — `grep child_process` in this
 * file must stay empty; process mechanics live behind the session-owned
 * `engines` port.
 *
 * ---------------------------------------------------------------------------
 * WHY STREAMING-INPUT, AND WHAT SURVIVES A RESTART
 * ---------------------------------------------------------------------------
 *
 * One `claude --input-format stream-json --output-format stream-json` child
 * per session, held open across turns: the first turn's user line goes out
 * once `initialize` is answered, later turns ride the same stdin, context
 * never leaves the child. A daemon restart re-attaches to the same pipes by
 * durable label instead of replacing the child (adopt = attach at the tail +
 * a fresh `initialize`, the SDK's own `reinitialize()` shape for transport
 * gaps, including the pending-permission redelivery), so the in-flight turn
 * completes on the adopted channel. Only when nothing survived does a fresh
 * child start with `--resume` off the journalled harness session id, whose
 * JSONL outlived the process.
 */

import { createLogger } from '@podium/logger'
import type { HarnessAgent, SessionId } from '@podium/model'
import type { ScopeResources } from '../../capabilities.js'
import type { ProcessIdentity } from '../../binding.js'
import {
  EngineBindUnrecoverable,
  type EngineAttachment,
  type EngineProcessOwner,
  type EngineSupervisor,
} from '../engine-supervision.js'
import { claudeEngineProcessKey, type ClaudeEngineFacts } from './engine-facts.js'
import {
  buildClaudeStreamInvocation,
  claudeStreamEnvOverlay,
  createClaudeStreamClient,
  type ClaudeStreamClient,
  type ClaudeStreamTransport,
  type ClaudeStreamTurnSpec,
} from './protocol.js'
import { HeadlessTurnFailure } from '../turn-error.js'
import type { ClaudeSdkRuntimeHost, ClaudeSdkTurnHandle } from './runtime.js'

const log = createLogger('harness:claude-engine-host')

/** The writer lease held by a daemon that did not die. A new generation must
 *  refuse loudly — log line naming the session — not read along silently. */
export class ClaudeEngineLeaseRefused extends Error {
  override readonly name = 'ClaudeEngineLeaseRefused'

  constructor(sessionId: SessionId, label: string) {
    super(
      `claude engine for ${sessionId} is still driven: another daemon holds the writer lease on '${label}'`,
    )
  }
}

export interface ClaudeEngineJournalEntry {
  sessionId: SessionId
  /** The harness-native session id (`--resume` material when no engine survived). */
  claudeSessionId: string
  workdir: string
  process: ProcessIdentity
  model?: string
  effort?: string
  env?: Record<string, string>
  /** What the next turn's engine spawn reads: instruction text and raw MCP
   *  config, so an adopted session's later turns keep their channel. */
  instructions?: string
  mcpConfig?: string
  bindingVersion: number
}

export interface ClaudeEngineJournal {
  read(sessionId: SessionId): ClaudeEngineJournalEntry | undefined
  write(entry: ClaudeEngineJournalEntry): void
  clear(sessionId: SessionId): void
}

/**
 * What the claude engine host needs from whoever owns processes and disks.
 * Facts arrive as values (handed sections, read by the family); engine
 * ownership arrives as the session layer's port, the scope answer as the
 * supervisor's.
 */
export interface ClaudeEngineHostDeps {
  facts: ClaudeEngineFacts
  /**
   * The session layer's ownership of every engine: start, re-attach and
   * destroy go through it; this family composes argv/env and binds protocol,
   * never forks. Absent (tests that never launch) = launch/stop/kill refuse
   * loudly rather than forking a child no restart could re-adopt.
   */
  engines?: EngineProcessOwner
  /**
   * The session's transient scope unit, where the platform has one. Only
   * `scopeUnitFor` is read here — never a process verb: spawning, attaching
   * and killing are the session owner's job, delivered through `engines`.
   */
  supervision?: Pick<EngineSupervisor, 'scopeUnitFor'>
  /** The binding journal, persisted by the supervisor (0600, sync). */
  journal: ClaudeEngineJournal
  /** Resource truth for a session's scope — reserved for the health path;
   *  the contract runtime does not read it today. */
  resources?(input: {
    sessionId: SessionId
    label: string
    pid?: number
    scopeUnit?: string
  }): ScopeResources | undefined
  /**
   * The instance agent home (`ctx.homeDir`), overriding the child's `HOME`
   * the same way the PTY path does (POD-2247). Absent = default instance,
   * daemon env unchanged. Without it a named instance's `claude` reads and
   * writes the operator's REAL `~/.claude` credentials and session stores.
   */
  homeDir?: string
  /** Installed Claude executable captured from this supervisor generation. */
  executablePath?: string
  /**
   * Compose the engine child's environment (stored-login precedence, instance
   * overlay, managed credentials). Owned by the supervisor — the same merge
   * every other child gets — so this family never re-derives it.
   */
  buildEnv(input: {
    sessionId: SessionId
    agentKind: HarnessAgent
    homeDir?: string
    sessionEnv?: Readonly<Record<string, string>>
    harnessEnv?: Readonly<Record<string, string>>
    instanceUuid?: string
  }): Record<string, string>
  /** Immutable supervisor ownership stamp for orphan attribution. */
  instanceUuid?: string
  /** How long a SIGTERM stop waits for the child to exit. Shared with the
   *  reap that has to outlast it — arrives as a value rather than living
   *  here twice. */
  gracefulExitMs: number
}

/** What the family holds for a live engine: the supervision attachment plus
 *  the stream client over it. The EXITED frame lands in `exit` — the exit
 *  status reaches the family through the host, never inferred from a dead
 *  pipe. */
interface HeldEngine {
  attachment: EngineAttachment
  client: ClaudeStreamClient
  childPid: number | undefined
  exit: { code: number; signal: number } | undefined
  banner: string
}

type StartTurnInput = Parameters<ClaudeSdkRuntimeHost['startTurn']>[0]

/**
 * The session layer's ownership of this session's engine. Engines are never
 * terminal sessions and never follow the terminal backend; a family without
 * an owner cannot summon one at all. Loud, naming the session — a refused
 * launch beats a child no restart could re-adopt.
 */
function engineOwner(engines: EngineProcessOwner | undefined, sessionId: SessionId): EngineProcessOwner {
  if (!engines) {
    throw new Error(
      `claude engine for ${sessionId} requires the session engine owner: this family never spawns its own engine`,
    )
  }
  return engines
}

/**
 * The session's transient scope unit, where the platform has one. Only the
 * scope answer is read here — never a process verb.
 */
function engineScope(
  supervision: Pick<EngineSupervisor, 'scopeUnitFor'> | undefined,
  sessionId: SessionId,
): Pick<EngineSupervisor, 'scopeUnitFor'> {
  if (!supervision) {
    throw new Error(
      `claude engine for ${sessionId} requires the session scope port: this family never spawns its own engine`,
    )
  }
  return supervision
}

/**
 * The stream-json line channel over a host attachment: the merged ring IS
 * the engine's stdout (line-split here, the way a direct pipe would be),
 * stdin arrives through the connection's WRITE, and closing drops this
 * generation's channel without ending the engine — `stopEngine` owns that. A
 * daemon restart attaches a FRESH channel at the tail: pre-restart control
 * request ids died with the old client, so replaying stale responses into
 * new ones would be fabrication, and a fresh `initialize` re-establishes the
 * conversation instead.
 */
function hostLineTransport(
  sessionId: SessionId,
  attachment: EngineAttachment,
  banner: { text: string },
): ClaudeStreamTransport {
  const write = attachment.connection.write
  if (!write) {
    throw new Error(
      `claude engine for ${sessionId} has no host write channel: the attachment cannot drive a stdio engine`,
    )
  }
  const send = write.bind(attachment.connection)
  let buffer = ''
  let closed = false
  return {
    writeLine(line) {
      if (closed) return
      send(Buffer.from(`${line}\n`)).catch(() => {
        // A write to a dead channel is the engine being gone; the close path
        // reports it, and throwing here would surface the fact twice.
      })
    },
    onLine(handler) {
      return attachment.connection.onData((_seq, chunk) => {
        if (closed) return
        banner.text = `${banner.text}${chunk.toString('utf8')}`.slice(-2000)
        buffer += chunk.toString('utf8')
        let boundary = buffer.indexOf('\n')
        while (boundary >= 0) {
          const line = buffer.slice(0, boundary)
          buffer = buffer.slice(boundary + 1)
          if (line.trim()) handler(line)
          boundary = buffer.indexOf('\n')
        }
      })
    },
    onExit(handler) {
      return attachment.connection.onExit((code, signal) =>
        handler(code, signal === 0 ? null : String(signal)),
      )
    },
    close() {
      if (closed) return
      closed = true
    },
  }
}

export interface ClaudeEngineHost {
  journal: ClaudeEngineJournal
  startTurn(input: StartTurnInput): ClaudeSdkTurnHandle
  stopEngine(sessionId: SessionId, retire: boolean): Promise<void>
  releaseEngines(): void
}

export function createClaudeEngineHost(deps: ClaudeEngineHostDeps): ClaudeEngineHost {
  /** Every engine this daemon generation currently holds a host attachment
   *  for. A daemon restart empties this map without touching the engines —
   *  the next generation re-attaches by label through `ensureEngine`, which
   *  adopts a live host instead of spawning beside it. */
  const engines = new Map<SessionId, HeldEngine>()

  const adapterFor = (sessionId: SessionId): EngineProcessOwner =>
    engineOwner(deps.engines, sessionId)

  const scopeFor = (sessionId: SessionId): Pick<EngineSupervisor, 'scopeUnitFor'> =>
    engineScope(deps.supervision, sessionId)

  /**
   * Tap a host attachment: the host's EXITED frame records the real status. A
   * previous attachment for the session is released first — one holder per
   * engine, so a re-attach never strands a lease. `engines.delete` before
   * signalling is what keeps an EXPECTED ending (stop/kill) from logging as
   * a crash.
   */
  function tapEngine(sessionId: SessionId, attachment: EngineAttachment): HeldEngine {
    const prev = engines.get(sessionId)
    if (prev && prev.attachment !== attachment) prev.attachment.dispose()
    const held: HeldEngine = {
      attachment,
      client: undefined as unknown as ClaudeStreamClient,
      childPid: undefined,
      exit: undefined,
      banner: '',
    }
    engines.set(sessionId, held)
    attachment.connection.onExit((code, signal) => {
      held.exit = { code, signal }
      if (engines.get(sessionId) === held) {
        log.warn('Claude stream engine exited on its own', { sessionId, code, signal })
      }
    })
    return held
  }

  /**
   * Take ownership of a host attachment: confirm the writer lease, then tap.
   * A lease held elsewhere is a stale daemon still driving this engine — loud
   * refusal, never silent read-along. A welcome that never arrives degrades
   * to `undefined` for adopt paths; launch turns it into a throw.
   */
  async function claimEngine(
    sessionId: SessionId,
    label: string,
    attachment: EngineAttachment,
  ): Promise<HeldEngine | undefined> {
    let welcome
    try {
      welcome = await attachment.ready
    } catch (err) {
      log.warn('claude engine host never welcomed its attach', { err, sessionId, label })
      attachment.dispose()
      engines.delete(sessionId)
      return undefined
    }
    if (!welcome.lease) {
      attachment.dispose()
      engines.delete(sessionId)
      log.error('refusing a claude engine whose writer lease is held elsewhere', {
        sessionId,
        label,
      })
      throw new ClaudeEngineLeaseRefused(sessionId, label)
    }
    const held = tapEngine(sessionId, attachment)
    held.childPid = welcome.childPid
    return held
  }

  /** Did this engine report its own exit within the window? The host's EXITED
   *  frame, never a dead-pipe inference. */
  const engineExited = (held: HeldEngine, ms: number): Promise<boolean> =>
    new Promise((resolve) => {
      if (held.exit) {
        resolve(true)
        return
      }
      const timer = setTimeout(() => {
        off()
        resolve(false)
      }, ms)
      timer.unref?.()
      const off = held.attachment.connection.onExit(() => {
        clearTimeout(timer)
        resolve(true)
      })
    })

  /**
   * End ONE engine — the one this session owns — and sweep its scope. The
   * sweep itself is the session owner's: this family signals its held
   * attachment and releases it, and the owner ends the process. The label's
   * scope is swept so MCP grandchildren die with it (the orphaned-MCP
   * pitfall the host's scope kill covers — assert it in the survival test).
   */
  async function terminate(sessionId: SessionId, retire: boolean): Promise<void> {
    const held = engines.get(sessionId)
    engines.delete(sessionId)
    if (held) {
      try {
        held.client.close()
      } catch {
        // Already gone; the sweep below is still owed its scope.
      }
      try {
        held.attachment.connection.signal(15)
      } catch {
        // Already gone; the sweep below is still owed its scope.
      }
      await engineExited(held, deps.gracefulExitMs)
      held.attachment.dispose()
    }
    await adapterFor(sessionId).destroyEngine(claudeEngineProcessKey(deps.facts, sessionId))
    if (retire) deps.journal.clear(sessionId)
  }

  function spawnSpec(input: StartTurnInput): ClaudeStreamTurnSpec {
    const instructions = input.spec.instructions.supported
      ? input.spec.instructions.value.instructions.map((entry) => entry.content).join('\n\n')
      : undefined
    const mcpConfig =
      input.spec.mcpServers.supported && input.spec.mcpServers.value.transport === 'inline'
        ? input.spec.mcpServers.value.config
        : undefined
    const model =
      input.turn.overrides?.supported && input.turn.overrides.value.model
        ? input.turn.overrides.value.model
        : input.spec.model.model
    const effort =
      input.turn.overrides?.supported && input.turn.overrides.value.effort
        ? input.turn.overrides.value.effort
        : input.spec.model.effort
    return {
      prompt: input.turn.text,
      cwd: input.spec.workdir,
      ...(input.newConversation ? { sessionUuid: input.resumeValue } : { resumeValue: input.resumeValue }),
      structuredPermissions: true,
      ...(model && model !== 'auto' ? { model } : {}),
      ...(effort && effort !== 'auto' ? { effort } : {}),
      ...(instructions ? { systemPrompt: instructions } : {}),
      ...(mcpConfig ? { mcpConfig } : {}),
    }
  }

  function bindClient(
    sessionId: SessionId,
    held: HeldEngine,
    spec: ClaudeStreamTurnSpec,
  ): Promise<string> {
    const banner = { text: held.banner }
    const transport = hostLineTransport(sessionId, held.attachment, {
      get text() {
        return banner.text
      },
      set text(value: string) {
        banner.text = value
        held.banner = value
      },
    })
    held.client = createClaudeStreamClient(transport, {
      ...(spec.systemPrompt ? { systemPrompt: spec.systemPrompt } : {}),
      ...(spec.contextPrompt ? { contextPrompt: spec.contextPrompt } : {}),
    })
    return held.client.ready
  }

  /**
   * THE ENGINE, UNDER THE HOST — HELD, ADOPTED, OR SPAWNED.
   *
   * Held (same generation, later turn): reuse the client — context never left
   * the child. Adopt (a live host owns the label, i.e. the daemon-restart
   * case): attach at the tail and send a fresh `initialize`, the SDK's own
   * `reinitialize()` shape for transport gaps; the in-flight turn completes
   * on the adopted channel. Fresh: spawn under podium-host `--no-pty` in the
   * session's transient scope, `--resume` when a harness session id names a
   * conversation, `--session-id` to mint the first turn deterministically.
   */
  async function ensureEngine(
    sessionId: SessionId,
    spec: ClaudeStreamTurnSpec,
    workdir: string,
    env: Record<string, string>,
  ): Promise<HeldEngine> {
    const held = engines.get(sessionId)
    if (held && held.exit === undefined) return held
    if (held) engines.delete(sessionId)

    const label = claudeEngineProcessKey(deps.facts, sessionId)
    const owner = adapterFor(sessionId)

    // ADOPT: a live host owns this label. The child's conversation survived;
    // only the channel is new — claude adopts by label, and only a fresh
    // spawn below carries `--resume` off the journalled harness session id.
    // A host that dies between the probe and the re-attach falls through to
    // a fresh spawn below — except a lease refusal, which is a live driver
    // elsewhere and must stay loud.
    if (await owner.engineAlive(label)) {
      try {
        const attached = await claimEngine(
          sessionId,
          label,
          await owner.reattachEngine({ label, fromSeq: 'tail' }),
        )
        if (attached) {
          try {
            await bindClient(sessionId, attached, spec)
          } catch (err) {
            // §4.8: THE ENGINE IS UP BUT THE PROTOCOL WILL NOT BIND. Our hold
            // is released so a later generation can adopt, but the engine is
            // KEPT — the conversation may be mid-turn, and killing it would
            // destroy what adopt could still rebind. Report, keep, decide later.
            engines.delete(sessionId)
            attached.attachment.dispose()
            log.warn('claude engine is up but its protocol did not bind; keeping the engine', {
              sessionId,
              label,
            })
            throw new EngineBindUnrecoverable(sessionId, 'adopt', label, err)
          }
          return attached
        }
      } catch (err) {
        if (err instanceof ClaudeEngineLeaseRefused) throw err
        log.warn('claude engine adopt failed; falling back to a fresh engine', {
          sessionId,
          label,
          err: err instanceof Error ? err.message : String(err),
        })
      }
    }

    // FRESH: the session owner starts the streaming child under the host and
    // this family binds the attachment it gets back; summoning the process
    // is the owner's job, never this family's.
    const executable = deps.executablePath ?? deps.facts.command
    const { cmd, args } = buildClaudeStreamInvocation(spec, executable)
    const spawned = await claimEngine(
      sessionId,
      label,
      await owner.startEngine({
        label,
        cmd,
        args,
        cwd: workdir,
        env,
        stripEnv: deps.facts.stripEnv,
      }),
    )
    if (!spawned) {
      engines.delete(sessionId)
      throw new Error(`claude engine host for ${sessionId} never welcomed its spawn`)
    }
    if (process.platform !== 'linux') {
      log.warn('Claude stream session is running unscoped', { sessionId })
    }
    try {
      await bindClient(sessionId, spawned, spec)
    } catch (err) {
      // A stillborn engine holds no conversation (initialize never answered,
      // so no session id exists to `--resume`): kill it rather than keeping a
      // process every later turn would adopt only to fail on again. Loud —
      // the scope sweep names the label — never silently orphaned.
      engines.delete(sessionId)
      try {
        spawned.attachment.dispose()
      } catch {
        // Already gone.
      }
      await owner.destroyEngine(label).catch(() => {})
      log.warn('claude engine never bound its protocol; reaped the stillborn engine', {
        sessionId,
        label,
      })
      throw new EngineBindUnrecoverable(sessionId, 'launch', label, err)
    }
    return spawned
  }

  return {
    journal: deps.journal,

    startTurn(input) {
      const sessionId = input.sessionId
      const spec = spawnSpec(input)
      /**
       * The instance-owned overlay, layered LAST so it outranks the spawn
       * frame's env. `CLAUDE_CONFIG_DIR` rides along because the CLI honours
       * it over `HOME` for its config root while the reader knows only
       * `HOME`: pinning it to this home's own `.claude` keeps a value
       * inherited from the daemon's environment from re-opening the
       * reader/child home split (POD-3057).
       */
      const instanceEnv = deps.homeDir
        ? { HOME: deps.homeDir, CLAUDE_CONFIG_DIR: `${deps.homeDir}/.claude` }
        : undefined
      const sessionEnv = { ...input.spec.env, ...instanceEnv }
      const env = {
        ...deps.buildEnv({
          ...(deps.instanceUuid ? { instanceUuid: deps.instanceUuid } : {}),
          sessionId,
          agentKind: deps.facts.harnessKind,
          ...(deps.homeDir ? { homeDir: deps.homeDir } : {}),
          ...(Object.keys(sessionEnv).length > 0 ? { sessionEnv } : {}),
        }),
        ...claudeStreamEnvOverlay({
          isRoot: process.getuid?.() === 0,
        }),
      }

      return startTurnAsync(sessionId, input, spec, env, sessionEnv)
    },

    async stopEngine(sessionId, retire) {
      await terminate(sessionId, retire)
    },

    releaseEngines() {
      // Daemon shutdown/dispose: drop every hold WITHOUT ending the engines
      // — the host owns them now, and the journals stay so the next
      // generation adopts the survivors.
      for (const [sessionId, held] of [...engines]) {
        engines.delete(sessionId)
        try {
          held.attachment.dispose()
        } catch {
          // The connection is already gone; the master it left behind is
          // what the next generation adopts.
        }
      }
    },
  }

  function startTurnAsync(
    sessionId: SessionId,
    input: StartTurnInput,
    spec: ClaudeStreamTurnSpec,
    env: Record<string, string>,
    sessionEnv: Record<string, string>,
  ): ClaudeSdkTurnHandle {
    let resolveDone!: (value: { resumeValue: string; output: string; observedModel?: string; observedEffort?: string }) => void
    let rejectDone!: (error: Error) => void
    const done = new Promise<{ resumeValue: string; output: string; observedModel?: string; observedEffort?: string }>(
      (res, rej) => {
        resolveDone = res
        rejectDone = rej
      },
    )
    // The runtime always awaits `done`, but a turn that fails inside
    // `ensureEngine` before any owner attached must not become an unhandled
    // rejection when the owner only interrupts.
    done.catch(() => {})

    let streamTurn: ReturnType<ClaudeStreamClient['turn']> | undefined
    let tornDown = false

    void (async () => {
      let held: HeldEngine
      try {
        held = await ensureEngine(sessionId, spec, input.spec.workdir, env)
      } catch (error) {
        rejectDone(error instanceof Error ? error : new Error(String(error)))
        return
      }
      if (tornDown) {
        // Torn down while the engine was binding: the turn never started.
        // Fail it; the engine stays owned by the session.
        rejectDone(new HeadlessTurnFailure('turn torn down while the engine was binding'))
        return
      }
      try {
        streamTurn = held.client.turn(input.turn.text, {
          onPartialText: input.onPartialText,
          onPermission: input.onPermission,
          onToolCall: input.onToolCall,
          onToolResult: input.onToolResult,
          // Status badges (`starting`/`running`/`tool`) were already dropped
          // at the session layer before this change — only partial text
          // travels up through `onPartialText`.
          emit: () => {},
        })
      } catch (error) {
        rejectDone(error instanceof Error ? error : new Error(String(error)))
        return
      }
      // The harness session id lands in the journal once the CLI names it: a
      // daemon restart between turns adopts the survivor, and a dead engine
      // falls back to `--resume` off exactly this id.
      const bound = held
      void bound.client.ready
        .then((claudeSessionId) => {
          const scopeUnit = scopeFor(sessionId).scopeUnitFor(
            claudeEngineProcessKey(deps.facts, sessionId),
          )
          deps.journal.write({
            sessionId,
            claudeSessionId,
            workdir: input.spec.workdir,
            process: {
              key: claudeEngineProcessKey(deps.facts, sessionId),
              ...(bound.childPid !== undefined ? { pid: bound.childPid } : {}),
              ...(scopeUnit ? { scopeUnit } : {}),
            },
            ...(spec.model ? { model: spec.model } : {}),
            ...(spec.effort ? { effort: spec.effort } : {}),
            ...(Object.keys(sessionEnv).length > 0 ? { env: sessionEnv } : {}),
            ...(spec.systemPrompt ? { instructions: spec.systemPrompt } : {}),
            ...(spec.mcpConfig ? { mcpConfig: spec.mcpConfig } : {}),
            bindingVersion: 1,
          })
        })
        .catch(() => {
          // Journal loss costs adopt-after-restart and nothing else — the
          // live turn is unaffected.
        })
      void streamTurn.done.then(
        (outcome) => {
          resolveDone({
            resumeValue: outcome.harnessSessionId,
            output: outcome.output,
            ...(outcome.observedModel ? { observedModel: outcome.observedModel } : {}),
            ...(outcome.observedEffort ? { observedEffort: outcome.observedEffort } : {}),
          })
        },
        (error) => {
          rejectDone(error instanceof Error ? error : new Error(String(error)))
        },
      )
    })()

    return {
      done,
      interrupt: () => {
        tornDown = true
        try {
          streamTurn?.interrupt()
        } catch {
          // Teardown's poke is fire-and-forget by contract.
        }
      },
      requestInterrupt: async () => {
        const turn = streamTurn
        if (!turn) {
          return {
            outcome: 'unconfirmed' as const,
            detail: 'the Claude stream turn had not started when the interrupt arrived',
          }
        }
        const ack = await turn.requestInterrupt()
        if (ack.outcome === 'unconfirmed') {
          // A wedged CLI never acks (synara): SIGINT via the host is the
          // escalation, and `unconfirmed` stays the honest answer — the
          // signal was sent, not confirmed.
          try {
            engines.get(sessionId)?.attachment.connection.signal(2)
          } catch {
            // The engine is already gone; the answer stands.
          }
        }
        return ack
      },
      answerPermission(interactionId, answer) {
        engines.get(sessionId)?.client.answerPermission(interactionId, answer)
      },
      dispose: () => {
        // Per-turn teardown releases NOTHING: the engine is per-session and
        // outlives every turn. Session end goes through stopEngine.
      },
    }
  }
}
