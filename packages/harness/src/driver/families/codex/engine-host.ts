/**
 * `codex app-server`, ONE PER SESSION, UNDER A PODIUM-HOST (`--no-pty`) OWNED
 * BY THE SESSION LAYER'S DURABLE PROCESS (POD-1761 W6; plan §1; POD-4433).
 *
 * (Moved from apps/daemon/src/runtime/codex-app-server.ts in 1.5: the daemon
 * stops knowing this headless harness. The family is handed the engine
 * attachment by the session layer through the injected `engines` port and
 * never spawns, journals or kills the engine itself; argv/env compose here
 * off the adapter's sections, read through {@link CodexEngineFacts}.)
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE OWNS, AND WHY IT IS THE ONLY PART IN THE DAEMON
 * ---------------------------------------------------------------------------
 *
 * The driver itself — the JSON-RPC client, the mapping, the receipts, the
 * approval inversion — is in `@podium/harness/driver/host`, testable in-process. What
 * could not go there is everything below: composing the engine's argv and env
 * off the adapter's sections, binding the session-held engine over its
 * Unix listener, and re-attaching to the survivor after a restart. This is
 * the `CodexRuntimeHost` implementation and it is deliberately nothing but
 * that.
 *
 * THIS FAMILY NEVER FORKS, JOURNALS OR KILLS. Every process act — start,
 * re-attach, destroy — goes through the injected `SessionEngineOwner`, which
 * the session layer implements over its durable process; the binding record
 * is the session layer's too — this family reports `bound` / `released` and
 * reads back what was recorded. The engine outlives a supervisor
 * restart, so `adopt()` rebinds to the survivor — the in-flight turn is no
 * longer abandoned — and only falls back to a fresh engine plus
 * `thread/resume` when nothing survived. `grep child_process` in this file
 * must stay empty; process mechanics live behind the session-owned `engines`
 * port.
 *
 * ---------------------------------------------------------------------------
 * THE TRANSPORT IS A PER-SESSION UNIX LISTENER (spec §§5–6)
 * ---------------------------------------------------------------------------
 *
 * Pinned Codex 0.147.0 accepts JSON-RPC clients on `--listen unix://PATH`, and
 * its stock TUI connects with `codex resume <thread> --remote unix://PATH`.
 * Podium's driver and the TUI therefore share one harness server without
 * stopping or replacing it. The ADDRESS IS HANDED, NOT COMPOSED (POD-4611):
 * this family asks the session layer for a listener and receives
 * `unix://<path>`; the session layer mints the path under the instance's
 * private 0700 runtime root, clears a stale file, seals the socket to 0600
 * when it first answers and removes it when the engine is destroyed. This
 * file never touches the socket's filesystem entry.
 */

import { readFileSync } from 'node:fs'
import { access, readFile } from 'node:fs/promises'
import { createLogger } from '@podium/logger'
import type { HarnessAgent, SessionId } from '@podium/model'
import { asSessionId } from '@podium/model'
import { codexMcpArgs } from '../../../adapters/codex/index.js'
import {
  CODEX_VERSION_POLICY,
  gateHarnessVersion,
  harnessVersionDiagnostic,
} from '../../../version-policy.js'
import type { AttachmentStager } from '../../turns.js'
import type { ScopeResources } from '../../capabilities.js'
import type { CodexJournalEntry, CodexRuntimeHost, CodexServerEndpoint } from './runtime.js'
import type { CodexTransport } from './client.js'
import type { CodexVersionDiagnostic } from './version.js'
import type { CodexEngineFacts } from './engine-facts.js'
import type {
  EngineAttachment,
  EngineProcessOwner,
  EngineSupervisor,
  SessionEngineOwner,
} from '../engine-supervision.js'
import { bindingRecordsOf, EngineBindUnrecoverable } from '../engine-supervision.js'

const log = createLogger('harness:codex-engine-host')

// ---------------------------------------------------------------------------
// The version gate
// ---------------------------------------------------------------------------

/**
 * THE SHARED PROBE BUDGET, not a codex-specific one.
 *
 * This file had its own 60s constant, arrived at from measuring `codex
 * --version` at 26s on a loaded box. It now reads the ONE budget that lives
 * beside the opencode version gate — same number, single source — because
 * POD-2056 established what two numbers for one concept cost: a too-short
 * daemon budget silently downgraded an explicit server-driver override to a PTY
 * session, and a too-short TEST budget made a gating lane decide it could not
 * run and SKIP ITSELF, which is a green suite that quietly stopped testing the
 * thing.
 *
 * The constant's name says `OPENCODE` because that is where the gate it was
 * extracted from lives; the argument at its definition cites this driver's own
 * 26s codex measurement as the reason for the value. Reading an opencode-named
 * constant from the codex host is the lesser evil — a second constant that
 * merely happens to agree today is how the first bug happened.
 */
/** How long a SIGTERM stop waits for the child to take its stdin EOF before
 *  signalling. Short: the exit is a process teardown, not model work, and the
 *  only thing being waited for is the rollout file's last flush.
 *
 *  SHARED WITH THE REAP THAT HAS TO OUTLAST IT (POD-2775). This was a local
 *  `2_000` and `server-reap.ts` bounded the verb that spends it at `1_000`, so
 *  every healthy park reported a failed verb. The one declaration now carries
 *  both numbers and the inequality between them. */
/** Only a version below the policy floor prevents full-driver admission. */
export type CodexProbeVerdict =
  | { drivable: true; reason?: 'unprobeable'; diagnostic?: CodexVersionDiagnostic }
  | { drivable: false; reason: 'unsupported'; diagnostic: CodexVersionDiagnostic }

/**
 * THE PURE ADMISSION EVALUATION. The supervisor owns the probe budget,
 * the memo and the child it forks (daemon `version-probe.ts`); this family
 * owns what the output MEANS — only a version below the policy floor
 * prevents full-driver admission. Failed probes cannot establish a floor
 * violation, even if stderr contains a version.
 */
export function evaluateCodexVersionProbe(output: string, ok: boolean): CodexProbeVerdict {
  const observed = ok ? output : ''
  const status = gateHarnessVersion(CODEX_VERSION_POLICY, observed)
  const diagnostic = harnessVersionDiagnostic('codex', CODEX_VERSION_POLICY, observed)
  if (status === 'too-old' && diagnostic) {
    return { drivable: false, reason: 'unsupported', diagnostic }
  }
  return {
    drivable: true,
    ...(status === 'unparseable' ? { reason: 'unprobeable' as const } : {}),
    ...(diagnostic ? { diagnostic } : {}),
  }
}

// ---------------------------------------------------------------------------
// The child's argv
// ---------------------------------------------------------------------------

/**
 * The `-c` overrides every app-server session carries.
 *
 * APPROVAL ROUTING IS DELIBERATELY ABSENT. Codex 0.149 removed the old
 * `approval_policy="untrusted"` config value and refuses to start when it is
 * present. The app-server's current default routes approval requests through
 * server→client JSON-RPC, which is the behaviour this driver consumes; pinning
 * a retired policy both duplicates the harness default and kills every session
 * before that protocol can open.
 *
 * `sandbox_mode=workspace-write` matches what a Podium session is for — an agent
 * that may edit the worktree it was pointed at — and keeps the network closed
 * unless the MCP mount opens it below.
 */
export function codexAppServerConfigArgs(input: {
  /** The session's MCP declaration, forwarded by the driver from `SessionSpec`. */
  mcpServers?: { transport: 'path'; path: string } | { transport: 'inline'; config: string }
  /** Reads a `transport: 'path'` config off disk. Injected so this stays a pure
   *  function of its inputs in tests. */
  readConfig?(path: string): string | undefined
}): { args: string[]; env: Record<string, string> } {
  /**
   * MCP MOUNTS THROUGH THE MANIFEST'S OWN MECHANISM, not a second translation.
   *
   * `codexMcpArgs` is the `-c mcp_servers."<name>".url=…` form verified against
   * codex 0.144.5, including the `bearer_token_env_var` detail without which
   * Codex runs OAuth discovery against a statically-authenticated server and
   * kills the turn. An app-server child mounts them exactly as an `exec` run
   * does, so it calls the same function rather than growing a copy that drifts.
   */
  const config =
    input.mcpServers?.transport === 'inline'
      ? input.mcpServers.config
      : input.mcpServers?.transport === 'path'
        ? input.readConfig?.(input.mcpServers.path)
        : undefined
  const mcp = config ? codexMcpArgs(config, 'app-server') : { args: [], env: {} }
  return {
    args: [
      '-c',
      'sandbox_mode="workspace-write"',
      ...(mcp.args.length > 0
        ? // The terminal launch already does this for the loopback CLI; an MCP
          // server Podium hosts on loopback is unreachable from a sandbox with
          // no network, so mounting one without this is mounting nothing.
          ['-c', 'sandbox_workspace_write.network_access=true']
        : []),
      ...mcp.args,
    ],
    env: mcp.env,
  }
}

// ---------------------------------------------------------------------------
// The host
// ---------------------------------------------------------------------------

/**
 * What the codex engine host needs from whoever owns processes and disks.
 *
 * Facts (adapter sections, read by the family) arrive as values; supervision
 * (spawn, re-attach, kill, env composition, version admission) arrives as
 * ports the supervisor implements. Nothing here names a harness literal in
 * the supervisor: the one harness-shaped value, `facts`, is built inside
 * this family.
 */
export interface CodexEngineHostDeps {
  facts: CodexEngineFacts
  /**
   * The session layer's ownership of every engine: start, re-attach and
   * destroy go through it, it mints the listener address, and it holds the
   * binding record this family reports into. This family composes argv/env
   * and binds protocol, never forks. Absent (tests that never launch) =
   * launch/adopt/stop/kill refuse loudly rather than forking a child no
   * restart could re-adopt, and nothing is recorded.
   */
  engines?: SessionEngineOwner<CodexJournalEntry>
  /**
   * The session's transient scope unit, where the platform has one. Only
   * `scopeUnitFor` is read here — never a process verb: spawning, attaching
   * and killing are the session owner's job, delivered through `engines`.
   */
  supervision?: Pick<EngineSupervisor, 'scopeUnitFor'>
  stageAttachment: AttachmentStager
  /** Resource truth for a session's scope — memory, tasks and the kernel's own
   *  OOM-kill counter, from the supervisor's one cgroup observer. */
  resources(input: {
    sessionId: SessionId
    label: string
    pid?: number
    scopeUnit?: string
  }): ScopeResources | undefined
  /** Start Codex's own TUI against a thread, for `attach()`. `undefined` from
   *  the whole function = this machine cannot host one. */
  attachClient?(input: {
    sessionId: SessionId
    threadId: string
    clientAddress: string
    workdir: string
    mode: 'takeover' | 'peek'
  }): Promise<{ streamId: string; warmTtlMs: number } | undefined>
  /** Stop Codex's stock TUI when its parent session ends. */
  detachClient?(input: { sessionId: SessionId }): Promise<void>
  /**
   * The instance agent home, overriding the child's `HOME` the same way the
   * PTY path does (POD-2247). Absent = default instance, supervisor env
   * unchanged. Without it a named instance's `codex app-server` reads and
   * writes the operator's REAL `~/.codex` auth and session state.
   */
  homeDir?: string
  now?: () => number
  /** Immutable supervisor ownership stamp for orphan attribution. */
  instanceUuid?: string
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
  /** How long a SIGTERM stop waits for the rollout's last flush. Shared with
   *  the reap that has to outlast it — the one declaration carries both
   *  numbers, so it arrives as a value rather than living here twice. */
  gracefulExitMs: number
  /** Version admission: only the floor can refuse a launch. The supervisor
   *  owns the probe budget, the memo and the fork; this family owns the
   *  evaluation (see `evaluateCodexVersionProbe`). */
  checkVersion(): Promise<CodexProbeVerdict>
  /** Open one WebSocket client to the engine's listener, by the address the
   *  session layer handed. The supervisor owns the socket library and the
   *  socket file; the retry loop and the transport adapter below are this
   *  family's protocol edge. */
  dialSocket(address: string): Promise<CodexRawSocket>
}

/** The narrow socket surface the transport adapter needs. */
export interface CodexRawSocket {
  send(payload: string, cb?: (err?: Error) => void): void
  on(event: 'message', cb: (message: { toString(): string }, binary: boolean) => void): void
  on(event: 'error', cb: () => void): void
  once(event: 'open' | 'close' | 'error', cb: (...args: never[]) => void): void
  off(event: 'open' | 'close' | 'error' | 'message', cb: (...args: never[]) => void): void
  terminate(): void
}

/** The label a session's scope unit is named from. Same shape as the PTY and
 *  opencode sides' so an operator reading `systemctl --user list-units` sees
 *  one convention: `podium-<token>-<sessionId>`, where the token is the
 *  client-terminal section's label token read through the facts. It contains
 *  the session id, which is also what charges the host-held engine to the
 *  session in `/proc` attribution. */
export const codexScopeLabel = (facts: CodexEngineFacts, sessionId: SessionId): string =>
  `podium-${facts.scopeToken}-${sessionId}`

/** The writer lease held by a daemon that did not die. A new generation must
 *  refuse loudly — log line naming the session — not read along silently. */
export class CodexEngineLeaseRefused extends Error {
  override readonly name = 'CodexEngineLeaseRefused'

  constructor(sessionId: SessionId, label: string) {
    super(
      `codex engine for ${sessionId} is still driven: another daemon holds the writer lease on '${label}'`,
    )
  }
}

/**
 * The session layer's ownership of this session's engine. Engines are never
 * terminal sessions and never follow the terminal backend; a family without
 * an owner cannot summon one at all. Loud, naming the session — a refused
 * launch beats a child no restart could re-adopt.
 */
function engineOwner(engines: EngineProcessOwner | undefined, sessionId: SessionId): EngineProcessOwner {
  if (!engines) {
    throw new Error(
      `codex engine for ${sessionId} requires the session engine owner: this family never spawns its own engine`,
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
      `codex engine for ${sessionId} requires the session scope port: this family never spawns its own engine`,
    )
  }
  return supervision
}

/** What the family holds for a live engine: the supervision attachment plus
 *  what the host has told us since. The EXITED frame lands in `exit` — the
 *  exit status reaches the family through the host, never inferred from a
 *  dead pipe. */
interface HeldEngine {
  session: EngineAttachment
  childPid: number | undefined
  exit: { code: number; signal: number } | undefined
  banner: string
}

/** What the WS connect loop needs of an engine; fed by the host's EXITED frame. */
interface EngineLiveness {
  exitCode: number | null
  signalCode: NodeJS.Signals | number | null
  alive(): boolean
}

export function createCodexEngineHost(deps: CodexEngineHostDeps): CodexRuntimeHost {
  /**
   * EVERY LIVE ENGINE OF A SESSION, NOT "THE" ENGINE (POD-2024 review,
   * finding 3, carried over from the child-process era).
   *
   * An endpoint must stop the engine it captured, even when lifecycle work
   * overlaps an older engine's retirement with a successor's launch. What is
   * held is the host attachment rather than a pid: the child belongs to the
   * host, and only the attachment observes its EXITED frame.
   */
  const engines = new Map<SessionId, HeldEngine>()
  const records = bindingRecordsOf(deps.engines)

  const adapterFor = (sessionId: SessionId): EngineProcessOwner =>
    engineOwner(deps.engines, sessionId)

  /**
   * Tap a host attachment: the merged stdout/stderr ring feeds the launch
   * banner, and the host's EXITED frame records the real status. A previous
   * attachment for the session is released first — one holder per engine, so a
   * re-attach never strands a lease. The tap stays registered for the
   * attachment's life; `engines.delete` before signalling is what keeps an
   * EXPECTED ending (stop/kill) from logging as a crash.
   */
  function tapEngine(sessionId: SessionId, session: EngineAttachment): HeldEngine {
    const prev = engines.get(sessionId)
    if (prev && prev.session !== session) prev.session.dispose()
    const held: HeldEngine = { session, childPid: undefined, exit: undefined, banner: '' }
    engines.set(sessionId, held)
    session.connection.onData((_seq, data) => {
      held.banner = `${held.banner}${data.toString('utf8')}`.slice(-2000)
    })
    session.connection.onExit((code, signal) => {
      held.exit = { code, signal }
      if (engines.get(sessionId) === held) {
        log.warn('codex engine exited on its own', { sessionId, code, signal })
      }
    })
    return held
  }

  /**
   * Re-attach to the host holding this session's engine, as the writer, with
   * the address the session layer recorded for it. `undefined` when no host
   * answers (nothing to rebind to); THROWS when a stale daemon still holds the
   * writer lease — the new generation refuses loudly rather than driving half
   * of an engine.
   */
  async function attachEngine(
    owner: EngineProcessOwner,
    sessionId: SessionId,
    label: string,
  ): Promise<{ held: HeldEngine; address: string | undefined } | undefined> {
    let hold
    try {
      hold = await owner.reattachEngine({ label, fromSeq: 'tail', sessionId })
    } catch (err) {
      log.warn('could not re-attach to the codex engine host', { err, sessionId, label })
      return undefined
    }
    const held = await claimEngine(sessionId, label, hold.attachment)
    return held ? { held, address: hold.address } : undefined
  }

  /**
   * Take ownership of a host attachment: confirm the writer lease, then tap.
   * A lease held elsewhere is a stale daemon still driving this engine — loud
   * refusal, never silent read-along. A welcome that never arrives degrades to
   * `undefined` for adopt paths; launch turns it into a throw. A fresh spawn
   * passes through here too: adopting a live host whose lease is held is the
   * two-daemons case even on the launch path.
   */
  async function claimEngine(
    sessionId: SessionId,
    label: string,
    session: EngineAttachment,
  ): Promise<HeldEngine | undefined> {
    let welcome
    try {
      welcome = await session.ready
    } catch (err) {
      log.warn('codex engine host never welcomed its attach', { err, sessionId, label })
      session.dispose()
      engines.delete(sessionId)
      return undefined
    }
    if (!welcome.lease) {
      session.dispose()
      engines.delete(sessionId)
      log.error('refusing a codex engine whose writer lease is held elsewhere', {
        sessionId,
        label,
      })
      throw new CodexEngineLeaseRefused(sessionId, label)
    }
    const held = tapEngine(sessionId, session)
    held.childPid = welcome.childPid
    return held
  }

  /** The liveness box behind a launch or rebind, fed by the host's EXITED frame. */
  function livenessFor(held: HeldEngine): EngineLiveness {
    const box: EngineLiveness = {
      exitCode: null,
      signalCode: null,
      alive: () => box.exitCode === null && box.signalCode === null,
    }
    held.session.connection.onExit((code, signal) => {
      box.exitCode = code
      box.signalCode = signal
    })
    if (held.exit) {
      box.exitCode = held.exit.code
      box.signalCode = held.exit.signal
    }
    return box
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
      const off = held.session.connection.onExit(() => {
        clearTimeout(timer)
        resolve(true)
      })
    })

  /**
   * End ONE engine — the one this endpoint owns — and sweep its scope.
   *
   * THE HELD ATTACHMENT IS PASSED IN RATHER THAN LOOKED UP, which carries over
   * the fix for the swap case: an endpoint must terminate the engine it was
   * built for, not whatever is currently registered under its session id.
   *
   * There is no stdin-EOF graceful stop any more: the host owns the child's
   * stdin, so SIGTERM carries the grace the old EOF attempt used to spend,
   * bounded by the shared budget. The sweep itself is the session owner's:
   * this family signals its held attachment and releases it, and the owner
   * ends the process. It matters for this family specifically —
   * the thing the engine writes on its way out is the rollout JSONL, the only
   * thing `resume()` and `adopt()` have to work from — and the rollout is
   * flushed incrementally during turns, not only at exit.
   */
  async function terminate(sessionId: SessionId, signal: 'SIGTERM' | 'SIGKILL', held: HeldEngine | undefined): Promise<void> {
    engines.delete(sessionId)
    if (held) {
      if (signal === 'SIGTERM') {
        try {
          held.session.connection.signal(15)
        } catch {
          // Already gone; the sweep below is still owed its scope.
        }
        await engineExited(held, deps.gracefulExitMs)
      }
      held.session.dispose()
    }
    await adapterFor(sessionId).destroyEngine(codexScopeLabel(deps.facts, sessionId), sessionId)
  }

  /**
   * One endpoint over a held engine — shared by launch (fresh engine, fresh
   * address) and adopt (surviving engine, recorded address). THIS endpoint's
   * engine, captured: stop/kill terminate what this endpoint was built for,
   * never whatever is currently registered under the session id.
   */
  const endpointFor = (input: {
    sessionId: SessionId
    clientAddress: string
    held: HeldEngine
    transport: CodexTransport
  }): CodexServerEndpoint => {
    const pid = input.held.childPid
    const label = codexScopeLabel(deps.facts, input.sessionId)
    const scopeUnit = engineScope(deps.supervision, input.sessionId).scopeUnitFor(label)
    return {
      transport: input.transport,
      clientAddress: input.clientAddress,
      reconnect: async () => {
        const socket = await connectCodexWebSocket(
          deps.dialSocket,
          input.clientAddress,
          livenessFor(input.held),
          () => input.held.banner,
        )
        return websocketTransport(socket, input.held, () => input.held.banner)
      },
      process: {
        /**
         * THE SESSION'S IDENTITY, NOT THE INCARNATION'S.
         *
         * Deliberately the scope label rather than the pid: `adopt()` compares
         * this against the journal to prove a binding describes THIS session
         * rather than a different one, and it must survive the engine being
         * replaced — which, for this family, is what adopting a dead engine IS.
         */
        key: label,
        ...(pid !== undefined ? { pid } : {}),
        ...(scopeUnit ? { scopeUnit } : {}),
      },
      stop: async () => {
        input.transport.close()
        await terminate(input.sessionId, 'SIGTERM', input.held)
      },
      kill: async () => {
        input.transport.close()
        await terminate(input.sessionId, 'SIGKILL', input.held)
        records.released(input.sessionId)
      },
      resources: () =>
        deps.resources({
          sessionId: input.sessionId,
          label,
          ...(pid !== undefined ? { pid } : {}),
          ...(scopeUnit ? { scopeUnit } : {}),
        }),
      /** The host's EXITED frame, when the engine has reported its own exit. */
      engineExit: () => input.held.exit ?? engines.get(input.sessionId)?.exit,
    }
  }

  return {
    bindings: records,
    stageAttachment: deps.stageAttachment,
    now: deps.now ?? (() => Date.now()),
    mintSessionId: () => asSessionId(crypto.randomUUID()),

    async launch(input) {
      const verdict = await deps.checkVersion()
      if (!verdict.drivable) {
        // Only the floor can refuse a Codex launch.
        throw new Error(`${verdict.diagnostic.title}: ${verdict.diagnostic.body}`)
      }

      const label = codexScopeLabel(deps.facts, input.sessionId)
      const owner = adapterFor(input.sessionId)

      const config = codexAppServerConfigArgs({
        ...(input.mcpServers ? { mcpServers: input.mcpServers } : {}),
        readConfig: (path) => {
          try {
            return readFileSync(path, 'utf8')
          } catch (err) {
            // A config we cannot read is a TOOL-LESS session, and saying so is
            // the point: `codexMcpArgs` throws on a malformed config rather than
            // yielding a silent tool-less run, and a missing file deserves the
            // same treatment rather than a quieter one.
            log.warn('could not read the codex MCP config', { err, path })
            return undefined
          }
        },
      })
      const argv = [deps.facts.command, ...deps.facts.serverArgs, ...config.args]
      const [command, ...args] = argv

      const env = deps.buildEnv({
        ...(deps.instanceUuid ? { instanceUuid: deps.instanceUuid } : {}),
        sessionId: input.sessionId,
        agentKind: deps.facts.harnessKind,
        ...(deps.homeDir ? { homeDir: deps.homeDir } : {}),
        ...(input.env ? { sessionEnv: input.env } : {}),
        harnessEnv: config.env,
      })

      /**
       * THE ENGINE, UNDER THE HOST. The session owner starts `codex app-server`
       * under podium-host `--no-pty` in the session's transient scope: the host
       * — not this daemon — holds the child's stdin, so a daemon restart no
       * longer closes the lifetime tether and the engine survives. JSON-RPC
       * still rides WebSocket text frames over the Unix listener; the merged
       * stdout/stderr ring feeds the startup banner below. This family hands
       * the owner its composed spec and binds the attachment it gets back;
       * summoning the process is the owner's job, never this family's.
       */
      let held: HeldEngine | undefined
      let clientAddress: string | undefined
      try {
        const started = await owner.startEngine({
          sessionId: input.sessionId,
          label,
          cmd: command ?? deps.facts.command,
          args,
          // The engine is TOLD its address by flag; the session layer mints it.
          listen: { argv: (address) => ['--listen', address] },
          cwd: input.workdir,
          env,
          stripEnv: deps.facts.stripEnv,
        })
        clientAddress = started.address
        held = await claimEngine(input.sessionId, label, started.attachment)
      } catch (err) {
        engines.delete(input.sessionId)
        throw err
      }
      if (!held) {
        engines.delete(input.sessionId)
        throw new Error(`codex engine host for ${input.sessionId} never welcomed its spawn`)
      }
      if (clientAddress === undefined) {
        // Never expected: this request asked for a listener. Loud rather than
        // a transport to nowhere; the engine is kept like any bind failure.
        engines.delete(input.sessionId)
        held.session.dispose()
        throw new EngineBindUnrecoverable(
          input.sessionId,
          'launch',
          undefined,
          new Error('the session layer handed no listener address'),
        )
      }
      const banner = (): string => held.banner
      const liveness = livenessFor(held)
      if (process.platform !== 'linux') {
        // DECLARED, NOT HIDDEN. Without a systemd user manager the session runs
        // in the daemon's cgroup: it still works, but per-session memory
        // accounting and OOM isolation are gone.
        log.warn('codex app-server session is running unscoped', { sessionId: input.sessionId })
      }

      let transport: CodexTransport
      try {
        const socket = await connectCodexWebSocket(deps.dialSocket, clientAddress, liveness, banner)
        transport = websocketTransport(socket, held, banner)
      } catch (err) {
        // §4.8: THE ENGINE IS UP BUT THE PROTOCOL WILL NOT BIND. Our hold is
        // released (engines.delete + dispose) so a later generation can
        // adopt, but the engine is KEPT — killing a process the supervisor
        // never journalled would orphan it silently, and killing one it did
        // would destroy what adopt could still rebind. Report, keep, decide
        // later; never silently orphaned.
        engines.delete(input.sessionId)
        held.session.dispose()
        log.warn('codex engine is up but its listener did not bind; keeping the engine', {
          sessionId: input.sessionId,
          clientAddress,
        })
        throw new EngineBindUnrecoverable(input.sessionId, 'launch', clientAddress, err)
      }
      return endpointFor({ sessionId: input.sessionId, clientAddress, held, transport })
    },

    /**
     * Rebind to the SURVIVING engine after a daemon restart — or `undefined`
     * when nothing survived. Exact identity first (recorded binding vs
     * binding), then host liveness, then the address itself: a WS that opens
     * on the address the session layer recorded for this engine. The thread
     * never closed, so the driver attaches to it WITHOUT a `thread/resume` —
     * and an in-flight turn continues on the engine instead of being
     * abandoned with a fresh child. A lease held elsewhere throws
     * (loud) rather than returning a transport the driver cannot own.
     */
    async adopt(binding) {
      const entry = records.recorded(binding.sessionId)
      if (!entry || entry.process.key !== binding.process.key) return undefined
      // Records written before the address was recorded predate durable
      // engines: nothing to rebind to, fall back to fresh-start.
      if (!entry.address) return undefined
      const owner = adapterFor(binding.sessionId)
      const label = codexScopeLabel(deps.facts, binding.sessionId)
      if (!(await owner.engineAlive(label))) return undefined
      const attached = await attachEngine(owner, binding.sessionId, label)
      if (!attached) return undefined
      const { held, address } = attached
      const banner = (): string => held.banner
      try {
        if (address === undefined) throw new Error('the session layer handed no listener address')
        const socket = await connectCodexWebSocket(deps.dialSocket, address, livenessFor(held), banner)
        const transport = websocketTransport(socket, held, banner)
        return endpointFor({
          sessionId: binding.sessionId,
          clientAddress: address,
          held,
          transport,
        })
      } catch {
        held.session.dispose()
        engines.delete(binding.sessionId)
        return undefined
      }
    },

    async readRollout(path) {
      try {
        return new Uint8Array(await readFile(path))
      } catch (err) {
        // `undefined`, never an empty array: an archive that silently shipped
        // zero bytes would import as an empty conversation.
        log.warn('could not read a codex rollout for export', { err, path })
        return undefined
      }
    },

    async rolloutExists(path) {
      try {
        await access(path)
        return true
      } catch {
        return false
      }
    },

    reportAuthMode({ sessionId, authMethod, subscription }) {
      if (subscription) {
        log.info('codex session is on the ChatGPT subscription', { sessionId, authMethod })
        return
      }
      /**
       * THE ACCEPTANCE ITEM'S NEGATIVE CASE. Not an error — an API-key session
       * is legitimate — but it is exactly the silent substitution the env strip
       * exists to prevent, so it is said out loud rather than left to be
       * discovered on a bill.
       */
      log.warn(
        'codex session is NOT on the ChatGPT subscription; an inherited credential may be winning over ~/.codex/auth.json',
        { sessionId, authMethod },
      )
    },

    async attachClient(input) {
      const entry = records.recorded(input.sessionId)
      if (!entry) return undefined
      return (
        (await deps.attachClient?.({
          sessionId: input.sessionId,
          threadId: input.threadId,
          clientAddress: input.clientAddress,
          workdir: entry.workdir,
          mode: input.mode,
        })) ?? undefined
      )
    },

    async detachClient(input) {
      await deps.detachClient?.(input)
    },
  }
}

const CODEX_SOCKET_CONNECT_TIMEOUT_MS = 20_000

/**
 * ONE ATTEMPT'S BOUND, WELL UNDER THE WHOLE WAIT'S.
 *
 * A `connect` that is refused because nothing is listening yet fails in
 * microseconds, and a local handshake completes in milliseconds. What has no
 * bound of its own is the case in between: a listener that ACCEPTS and then
 * never finishes the upgrade. `ws` will wait on that forever, and an `await`
 * with no timeout inside the retry loop meant the deadline below was only ever
 * consulted between attempts — so the first stalled attempt was also the last,
 * and `launch()` never settled either way. A connection that cannot complete
 * must fail, not hang (POD-2484).
 *
 * WHY 5s, AND WHY NOT LESS. This is a CEILING ON HANDSHAKE LATENCY, so the
 * value is a real trade and it was argued down from 2s in review. Two things
 * make the low end dangerous:
 *
 *   - A listener that has bound and is ACCEPTING but has not yet answered the
 *     upgrade is a third state, between "unbound" and "serving", and it lands
 *     squarely on this timer — `connect` succeeds immediately there. A codex
 *     that binds early and finishes initialising afterwards looks exactly like
 *     that, so "a slow child never reaches this timer" is true only of a child
 *     slow to BIND (`connect` on an unbound socket is refused in microseconds,
 *     and the loop simply retries).
 *   - Retries do not rescue it. Attempts are not independent draws: whatever
 *     makes one attempt slow — a descheduled process, swap, a starved box — is
 *     a sustained condition, so ten retries against a peer that is slow FOR A
 *     REASON buy nothing. Measured in review at a 12s deadline: a peer whose
 *     handshake takes 3s never connects under a 2s bound, though it would have
 *     opened at 3s and had 17s to spare.
 *
 * The costs are asymmetric, and that decides it. Too low loses a session that
 * would have worked and blames the peer for it, in front of a user. Too high
 * only delays noticing a dead child, inside the same 20s wait, invisibly. When
 * one side of the error is user-visible and the other is not, take the invisible
 * one. 5s still leaves three to four attempts inside the deadline.
 *
 * Real codex binds in 395–628ms here, so this is headroom, not a measured need.
 * `codex-app-server.transport.test.ts` pins the band and pins the low end
 * behaviourally — a correct handshake that takes 2s must still OPEN.
 */
export const CODEX_HANDSHAKE_ATTEMPT_TIMEOUT_MS = 5_000

/** What the connect loop needs of an engine; a test supplies it without spawning.
 *  `signalCode` stays wide because the host reports the wait status numerically. */
export interface CodexChildLiveness {
  exitCode: number | null
  signalCode: NodeJS.Signals | number | null
}

/**
 * One attempt's bound elapsing — kept distinguishable from a connect failure
 * because only one of the two is evidence about the peer. See the catch below.
 */
class HandshakeTimeout extends Error {}

/** A child configuration Codex rejected before its listener could open. */
export interface CodexAppServerLaunchRefusal {
  reason: 'unsupported-setting'
  setting: string
}

/**
 * A DISCRIMINATED STARTUP REFUSAL, not a stderr-shaped process crash.
 *
 * Codex validates configuration before binding its listener. When a setting is
 * retired, the only protocol available is the child's stderr; classify that
 * narrow diagnostic here so callers can branch on `refusal.reason` and show the
 * actionable setting name without publishing an arbitrary stderr tail.
 */
export class CodexAppServerLaunchRefused extends Error {
  override readonly name = 'CodexAppServerLaunchRefused'

  constructor(readonly refusal: CodexAppServerLaunchRefusal) {
    super(
      `codex app-server refused unsupported setting '${refusal.setting}'; remove that setting from its launch configuration`,
    )
  }
}

function unsupportedSettingRefusal(stderr: string): CodexAppServerLaunchRefusal | undefined {
  const setting =
    /\b([A-Za-z][A-Za-z0-9_.-]*)\s*=\s*(?:"[^"]*"|'[^']*'|\S+)\s+is no longer supported;\s*remove this setting\b/i.exec(
      stderr,
    )?.[1]
  return setting ? { reason: 'unsupported-setting', setting } : undefined
}

/**
 * THE REASON A FAILED CONNECT CARRIES, WHATEVER SHAPE IT ARRIVES IN.
 *
 * `ws` under Node rejects with an `Error`; Bun's `ws` rejects with a DOM-style
 * `ErrorEvent`, which is not an `Error` at all. An `instanceof Error` test and a
 * `String()` fallback therefore printed `[object ErrorEvent]` on the runtime the
 * daemon actually runs — throwing away the reason ("… failed: Failed to
 * connect") that was sitting one property away. The ordinary failure is the one
 * an operator reads, so it is the one that must name its cause.
 */
function connectFailureReason(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'object' && err !== null) {
    const event = err as { message?: unknown; error?: unknown }
    if (event.error instanceof Error) return event.error.message
    if (typeof event.message === 'string' && event.message.length > 0) return event.message
  }
  return String(err ?? 'timeout')
}

/**
 * Wait for Codex's Unix listener, then complete its WebSocket upgrade.
 *
 * The pinned remote client uses `ws://localhost/rpc` as the HTTP handshake URI
 * while carrying those bytes over the Unix socket. `ws`'s `ws+unix` URL is the
 * same arrangement. Compression must stay off: Codex's tungstenite acceptor
 * deliberately offers plain text frames only.
 *
 * BOUNDED BY CONSTRUCTION. Listener startup is polled by opening real
 * connections, and each attempt carries its own timeout clamped to what is left
 * of the deadline. This returns a socket or throws; it cannot outlive the wait.
 *
 * BOTH BOUNDS ARE INJECTABLE, and the second one had to become so. A test that
 * derives its deadline from `CODEX_HANDSHAKE_ATTEMPT_TIMEOUT_MS` and then
 * asserts against that same constant is scale-invariant — every value rides
 * through together, which is how a version of this suite came to pass with the
 * constant raised fourfold while claiming to pin it. Separating the two lets the
 * clamping LOGIC be pinned against fixed numbers, and leaves the constant's
 * VALUE to the band and slow-peer assertions that actually speak to it.
 */
export async function connectCodexWebSocket(
  dial: (path: string) => Promise<CodexRawSocket>,
  path: string,
  child: CodexChildLiveness,
  banner: () => string,
  timeoutMs: number = CODEX_SOCKET_CONNECT_TIMEOUT_MS,
  attemptTimeoutMs: number = CODEX_HANDSHAKE_ATTEMPT_TIMEOUT_MS,
): Promise<CodexRawSocket> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      const detail = banner().trim()
      const refusal = unsupportedSettingRefusal(detail)
      if (refusal) throw new CodexAppServerLaunchRefused(refusal)
      throw new Error(
        `codex app-server exited before its Unix listener was ready${detail ? `: ${detail.slice(-500)}` : ''}`,
      )
    }
    // Floored at 1ms: the deadline can lapse between the loop's test and here,
    // and a negative timer is a warning on some runtimes and immediate on all.
    const remaining = deadline - Date.now()
    const attemptMs = Math.max(1, Math.min(attemptTimeoutMs, remaining))
    const clipped = attemptMs < attemptTimeoutMs
    try {
      const socket = await new Promise<CodexRawSocket>((resolve, reject) => {
        // Listener startup is polled by opening real connections. The dial
        // port owns the socket library (and its options: no compression, a
        // large payload ceiling); a library that errors after the first
        // failed attempt is terminated must not surface that cleanup as an
        // unhandled `error`, so the port keeps one durable listener for it.
        dial(path).then(
          (candidate) => {
            candidate.on('error', () => undefined)
            let timer: ReturnType<typeof setTimeout>
            const failed = (err: Error): void => {
              clearTimeout(timer)
              candidate.off('open', opened)
              candidate.terminate()
              reject(err)
            }
            const opened = (): void => {
              clearTimeout(timer)
              candidate.off('error', failed)
              resolve(candidate)
            }
            timer = setTimeout(
              () =>
                failed(
                  new HandshakeTimeout(
                    `the listener did not complete the upgrade within ${attemptMs}ms`,
                  ),
                ),
              attemptMs,
            )
            candidate.once('open', opened)
            candidate.once('error', failed)
          },
          reject,
        )
      })
      return socket
    } catch (err) {
      /**
       * PREFER THE CAUSE THAT SAYS SOMETHING ABOUT THE PEER.
       *
       * The last attempt of a lapsing wait gets a sliver of the deadline, and
       * its timer can beat an otherwise-instant connect refusal. Letting that
       * overwrite the real cause would report "the listener did not complete the
       * upgrade within 1ms" — a stalled handshake — for a socket nothing ever
       * bound, sending the reader to the wrong end of the problem. A timeout on
       * an attempt the DEADLINE shortened is just the wait ending, so it only
       * becomes the reported cause when there is nothing better to report.
       *
       * DEFENSIVE, NOT OBSERVED. The race did not reproduce on Bun, where a
       * connect rejection arrives in a microtask ahead of any timer — which is
       * also why no test pins it: one would pass with this guard removed. The
       * guard stays because the ordering it assumes is a runtime's to change.
       */
      if (!(clipped && err instanceof HandshakeTimeout) || lastError === undefined) lastError = err
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }
  const reason = lastError === undefined ? 'timeout' : connectFailureReason(lastError)
  throw new Error(`codex app-server Unix listener was not ready at ${path}: ${reason}`)
}

/**
 * One WebSocket-over-Unix client as the driver's transport.
 *
 * THE LINE SPLITTING LIVES HERE, not in the client, because framing is a
 * `CodexTransport` calls its unit a line because stdio needs newline framing;
 * the remote listener instead carries exactly one JSON-RPC document per text
 * frame. This adapter removes/adds that framing difference at the host edge.
 */
function websocketTransport(
  socket: CodexRawSocket,
  held: HeldEngine,
  banner: () => string,
): CodexTransport {
  let closed = false
  const onEngineEnd = (cb: () => void): void => {
    held.session.connection.onExit(() => cb())
  }
  return {
    write(line) {
      if (closed) return
      try {
        const payload = line.endsWith('\n') ? line.slice(0, -1) : line
        socket.send(payload, (err) => {
          if (err) log.warn('could not write to the codex app-server Unix listener', { err })
        })
      } catch (err) {
        // A write to a dead connection is the child being gone; the close handler
        // below is what reports it, and throwing here would surface the same
        // fact twice in two vocabularies.
        log.warn('could not write to the codex app-server Unix listener', { err })
      }
    },
    onLine(handler) {
      socket.on('message', (message, binary) => {
        if (binary) return
        const frame = message.toString()
        if (frame.trim()) handler.line(frame)
      })
      const ended = (): void => {
        if (closed) return
        closed = true
        const tail = banner().trim()
        if (tail) log.warn('codex app-server engine ended', { stderr: tail.slice(-500) })
        handler.closed()
      }
      // The engine's end arrives through the host's EXITED frame, which the
      // held attachment observes — never inferred from the WS closing alone.
      onEngineEnd(ended)
      socket.once('close', ended)
      socket.once('error', ended)
    },
    close() {
      if (closed) return
      closed = true
      try {
        socket.terminate()
      } catch {
        // Already closed; that is the state we wanted.
      }
    },
  }
}
