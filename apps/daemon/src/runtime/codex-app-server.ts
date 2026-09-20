/**
 * `codex app-server`, ONE PER SESSION, UNDER A PODIUM-HOST (`--no-pty`) OWNED
 * BY THE DAEMON'S DURABLE PROCESS (POD-1761 W6; plan §1; POD-4433).
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE OWNS, AND WHY IT IS THE ONLY PART IN THE DAEMON
 * ---------------------------------------------------------------------------
 *
 * The driver itself — the JSON-RPC client, the mapping, the receipts, the
 * approval inversion — is in `@podium/agent-runtime`, testable in-process. What
 * could not go there is everything below: composing the engine's argv and env,
 * spawning it headless under podium-host, and writing the journal that lets
 * `adopt()` find the session again after the daemon dies. This is the
 * `CodexRuntimeHost` implementation and it is deliberately nothing but that.
 *
 * THE DAEMON NEVER FORKS HERE. Every process act — spawn, re-attach, kill —
 * goes through the injected `DurableProcess`, whose host adapter owns the
 * child. The engine outlives a daemon restart, so `adopt()` rebinds to the
 * survivor — the in-flight turn is no longer abandoned — and only falls back
 * to a fresh engine plus `thread/resume` when nothing survived. `grep
 * child_process` in this file must stay empty; process mechanics live in
 * `@podium/process`.
 *
 * ---------------------------------------------------------------------------
 * THE TRANSPORT IS A PER-SESSION UNIX LISTENER (spec §§5–6)
 * ---------------------------------------------------------------------------
 *
 * Pinned Codex 0.147.0 accepts JSON-RPC clients on `--listen unix://PATH`, and
 * its stock TUI connects with `codex resume <thread> --remote unix://PATH`.
 * Podium's driver and the TUI therefore share one harness server without
 * stopping or replacing it. The socket lives directly under the instance's private runtime root,
 * which is 0700; its mode is forced to 0600 before the endpoint is exposed. A short random
 * incarnation suffix prevents a stale pathname from being reused across child incarnations.
 * The journal remains in the state root because it is durable metadata, not a socket.
 */

import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { access, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  AttachmentStager,
  CodexJournal,
  CodexJournalEntry,
  CodexRuntimeHost,
  CodexServerEndpoint,
  CodexTransport,
  CodexVersionDiagnostic,
  ScopeResources,
} from '@podium/agent-runtime'
import {
  OPENCODE_VERSION_PROBE_TIMEOUT_MS,
  STRIPPED_CODEX_CREDENTIALS,
} from '@podium/agent-runtime'
import {
  CODEX_VERSION_POLICY,
  codexMcpArgs,
  gateHarnessVersion,
  harnessVersionDiagnostic,
} from '@podium/harness'
import { createLogger } from '@podium/logger'
import type { SessionId } from '@podium/model'
import { asSessionId } from '@podium/model'
import {
  scopeUnitName,
  type DurableAdapter,
  type DurableProcess,
  type HostAgentSession,
} from '@podium/process/durable'
import {
  ABDUCO_SUN_PATH_MAX,
  instanceRuntimeSocketRoot,
  unixSocketPathBytes,
  unixSocketPathFits,
} from '@podium/runtime/abduco-socket'
import { stateDir } from '@podium/runtime/config'
import { resolveInstanceId } from '@podium/runtime/instance'
import WebSocket, { type RawData } from 'ws'
import { serverChildEnv } from '../control/session-env'
import { stageRuntimeAttachment } from './attachment-staging'
import { SERVER_GRACEFUL_EXIT_MS } from './server-teardown-budget'
import {
  createVersionProbeCache,
  execVersionProbe,
  type VersionProbe,
  type VersionProbePolicy,
} from './version-probe'

const log = createLogger('daemon:codex-app-server')

/**
 * RE-EXPORTED, NOT RESTATED (POD-2024 review, finding 8).
 *
 * The list lives beside the version gate in `@podium/agent-runtime` so that this
 * host and the live test read ONE array. It was declared here and restated in
 * `live.test.ts`, and the restatement had already lost `OPENAI_ORG_ID` — while
 * that test's header promised it mirrored the daemon exactly. Existing importers
 * keep this name.
 */
export { STRIPPED_CODEX_CREDENTIALS }

/** Where a session's journal entry lives. Under the daemon's own state dir, so
 *  it moves with the instance and is swept with it. */
const journalDir = (): string => join(stateDir(), 'codex-app-servers')
const journalPath = (sessionId: SessionId): string =>
  join(journalDir(), `${encodeURIComponent(sessionId)}.json`)

/** The socket directory is itself the instance-private runtime namespace. */
const socketDir = (): string => instanceRuntimeSocketRoot(resolveInstanceId())

/** A short basename preserves room under Unix's sockaddr limit. */
export function codexClientSocketPath(sessionId: SessionId, nonce: string = randomUUID()): string {
  const session = createHash('sha256').update(sessionId).digest('hex').slice(0, 12)
  const incarnation = nonce.replaceAll('-', '').slice(0, 12)
  const path = join(socketDir(), `${session}-${incarnation}.sock`)
  if (!unixSocketPathFits(path)) {
    throw new Error(
      `codex app-server socket path is ${unixSocketPathBytes(path)} bytes; ` +
        `Unix socket paths must be shorter than ${ABDUCO_SUN_PATH_MAX} bytes: ${path}`,
    )
  }
  return path
}

/**
 * A file per session.
 *
 * 0600 LIKE ITS OPENCODE SIBLING, THOUGH IT HOLDS NO SECRET — and the reason to
 * keep the mode rather than relax it is that the entry names the thread id and
 * the rollout path, which together are the whole conversation. Read access to
 * this file is read access to where the transcript lives.
 *
 * SYNCHRONOUS ON PURPOSE, same as opencode's: it is written on the turn-open
 * path, where the value it protects is the monotonic turn epoch. An async write
 * that lost a race with a daemon crash would rebind the session at an older
 * epoch, which the causal envelope's monotonicity rule forbids.
 */
export function createCodexJournal(): CodexJournal {
  const cache = new Map<SessionId, CodexJournalEntry>()
  return {
    read(sessionId) {
      const cached = cache.get(sessionId)
      if (cached) return cached
      try {
        const parsed = JSON.parse(readFileSync(journalPath(sessionId), 'utf8')) as CodexJournalEntry
        cache.set(sessionId, parsed)
        return parsed
      } catch {
        return undefined
      }
    },
    write(entry) {
      cache.set(entry.sessionId, entry)
      try {
        mkdirSync(journalDir(), { recursive: true, mode: 0o700 })
        writeFileSync(journalPath(entry.sessionId), JSON.stringify(entry), { mode: 0o600 })
      } catch (err) {
        // A journal we cannot write costs `adopt()` after a daemon restart and
        // nothing else — the live session is unaffected. Losing the session to
        // an ENOSPC would be the worse trade.
        log.warn('could not persist the codex binding journal', {
          err,
          sessionId: entry.sessionId,
        })
      }
    },
    clear(sessionId) {
      cache.delete(sessionId)
      try {
        rmSync(journalPath(sessionId), { force: true })
      } catch {
        // Best effort: a stale entry is ignored by `adopt` anyway.
      }
    },
  }
}

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
const VERSION_PROBE_TIMEOUT_MS = OPENCODE_VERSION_PROBE_TIMEOUT_MS

/** How long a SIGTERM stop waits for the child to take its stdin EOF before
 *  signalling. Short: the exit is a process teardown, not model work, and the
 *  only thing being waited for is the rollout file's last flush.
 *
 *  SHARED WITH THE REAP THAT HAS TO OUTLAST IT (POD-2775). This was a local
 *  `2_000` and `server-reap.ts` bounded the verb that spends it at `1_000`, so
 *  every healthy park reported a failed verb. The one declaration now carries
 *  both numbers and the inequality between them. */
const GRACEFUL_EXIT_MS = SERVER_GRACEFUL_EXIT_MS

/** Only a version below the policy floor prevents full-driver admission. */
export type CodexProbeVerdict =
  | { drivable: true; reason?: 'unprobeable'; diagnostic?: CodexVersionDiagnostic }
  | { drivable: false; reason: 'unsupported'; diagnostic: CodexVersionDiagnostic }

const versionProbeCache = createVersionProbeCache<CodexProbeVerdict>({
  evaluate: ({ output, ok }) => {
    // Failed probes cannot establish a floor violation, even if stderr contains a version.
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
  },
})

export function codexAppServerVersionProbe(
  probe: VersionProbe = defaultVersionProbe,
  policy?: VersionProbePolicy,
): Promise<CodexProbeVerdict> {
  return versionProbeCache.probe(probe, policy)
}

/** Reset the memo. Tests only — a daemon never needs it. */
export function resetCodexAppServerVersionProbe(): void {
  versionProbeCache.reset()
}

function defaultVersionProbe(): Promise<{ output: string; ok: boolean }> {
  // Deliberately the daemon's own env, NOT the instance composition: the probe
  // asks "what can this MACHINE run" and reads no per-user state — see
  // `serverChildEnv` for the env-class record (POD-2247).
  return execVersionProbe('codex', VERSION_PROBE_TIMEOUT_MS)
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

export interface CodexHostDeps {
  stageAttachment?: AttachmentStager
  /** Resource truth for a session's scope — memory, tasks and the kernel's own
   *  OOM-kill counter, from the daemon's one cgroup observer. */
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
   * The instance agent home (`ctx.homeDir`), overriding the child's `HOME` the
   * same way the PTY path does (POD-2247). Absent = default instance, daemon
   * env unchanged. Without it a named instance's `codex app-server` reads and
   * writes the operator's REAL `~/.codex` auth and session state.
   */
  homeDir?: string
  /** Immutable daemon ownership stamp for orphan attribution. */
  instanceUuid?: string
  journal?: CodexJournal
  now?(): number
  /**
   * THE DURABLE OWNER OF EVERY ENGINE (POD-4433). Spawn, re-attach and kill go
   * through it; this file composes argv/env and journals, never forks. Absent
   * (tests that never launch) = launch/adopt/stop/kill refuse loudly rather
   * than forking a child no restart could re-adopt.
   */
  durable?: DurableProcess
}

/** The label a session's scope unit is named from. Same shape as the PTY and
 *  opencode sides' so an operator reading `systemctl --user list-units` sees one
 *  convention. It contains the session id, which is also what charges the
 *  host-held engine to the session in `/proc` attribution. */
export const codexScopeLabel = (sessionId: SessionId): string => `podium-cx-${sessionId}`

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
 * Pick the host adapter out of the daemon's durable object. Engines are never
 * terminal sessions, so they never follow the terminal backend: abduco has no
 * pty-less mode, and a daemon without a host adapter cannot own an engine at
 * all. Loud, naming the session — a refused launch beats a child no restart
 * could re-adopt.
 */
function engineAdapter(durable: DurableProcess | undefined, sessionId: SessionId): DurableAdapter {
  const found = durable?.all.find((a) => a.kind === 'host') ?? durable?.primary
  if (!found || found.kind !== 'host') {
    throw new Error(
      `codex engine for ${sessionId} requires the podium-host backend: this daemon runs ${
        durable ? `backend '${durable.backend}' with no host adapter` : 'with no durable backend'
      }`,
    )
  }
  return found
}

/** Absent on macOS, honestly so: there is no transient scope there, and a
 *  fabricated unit name would make `health()` report a cgroup nothing owns. */
const engineScopeUnit = (label: string): string | undefined =>
  process.platform === 'linux' ? scopeUnitName(label) : undefined

/** What the daemon holds for a live engine: the host attachment plus what the
 *  host has told us since. The EXITED frame lands in `exit` — the exit status
 *  reaches the daemon through the host, never inferred from a dead pipe. */
interface HeldEngine {
  session: HostAgentSession
  childPid: number | undefined
  exit: { code: number; signal: number } | undefined
  banner: string
}

/** `process.env`-shaped composition into the string map a headless spawn takes. */
function stringEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) if (value !== undefined) out[key] = value
  return out
}

/** What the WS connect loop needs of an engine; fed by the host's EXITED frame. */
interface EngineLiveness {
  exitCode: number | null
  signalCode: NodeJS.Signals | number | null
  alive(): boolean
}

export function createCodexHost(deps: CodexHostDeps): CodexRuntimeHost {
  const journal = deps.journal ?? createCodexJournal()
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

  const adapterFor = (sessionId: SessionId): DurableAdapter =>
    engineAdapter(deps.durable, sessionId)

  /**
   * Tap a host attachment: the merged stdout/stderr ring feeds the launch
   * banner, and the host's EXITED frame records the real status. The tap stays
   * registered for the attachment's life; `engines.delete` before signalling
   * is what keeps an EXPECTED ending (stop/kill) from logging as a crash.
   */
  function tapEngine(sessionId: SessionId, session: HostAgentSession): HeldEngine {
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
   * Re-attach to the host holding this session's engine, as the writer.
   * `undefined` when no host answers (nothing to rebind to); THROWS when a
   * stale daemon still holds the writer lease — the new generation refuses
   * loudly rather than driving half of an engine.
   */
  async function attachEngine(
    adapter: DurableAdapter,
    sessionId: SessionId,
    label: string,
  ): Promise<HeldEngine | undefined> {
    let session: HostAgentSession
    try {
      session = await adapter.attachHeadless({ label, fromSeq: 'tail' })
    } catch (err) {
      log.warn('could not re-attach to the codex engine host', { err, sessionId, label })
      return undefined
    }
    const held = tapEngine(sessionId, session)
    let welcome
    try {
      welcome = await session.ready
    } catch (err) {
      log.warn('codex engine host never welcomed its re-attach', { err, sessionId, label })
      session.dispose()
      engines.delete(sessionId)
      return undefined
    }
    held.childPid = welcome.childPid
    if (!welcome.lease) {
      session.dispose()
      engines.delete(sessionId)
      log.error('refusing a codex engine whose writer lease is held elsewhere', {
        sessionId,
        label,
      })
      throw new CodexEngineLeaseRefused(sessionId, label)
    }
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
   * bounded by the shared budget. It matters for this family specifically —
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
        await engineExited(held, GRACEFUL_EXIT_MS)
      }
      held.session.dispose()
    }
    await adapterFor(sessionId).kill(codexScopeLabel(sessionId))
  }

  /**
   * One endpoint over a held engine — shared by launch (fresh engine, fresh
   * socket) and adopt (surviving engine, journalled socket). THIS endpoint's
   * engine, captured: stop/kill terminate what this endpoint was built for,
   * never whatever is currently registered under the session id.
   */
  const endpointFor = (input: {
    sessionId: SessionId
    socketPath: string
    clientAddress: string
    held: HeldEngine
    transport: CodexTransport
  }): CodexServerEndpoint => {
    const pid = input.held.childPid
    const label = codexScopeLabel(input.sessionId)
    const scopeUnit = engineScopeUnit(label)
    return {
      transport: input.transport,
      clientAddress: input.clientAddress,
      reconnect: async () => {
        const socket = await connectCodexWebSocket(
          input.socketPath,
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
        rmSync(input.socketPath, { force: true })
      },
      kill: async () => {
        input.transport.close()
        await terminate(input.sessionId, 'SIGKILL', input.held)
        rmSync(input.socketPath, { force: true })
        journal.clear(input.sessionId)
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
    journal,
    stageAttachment: deps.stageAttachment ?? stageRuntimeAttachment,
    now: deps.now ?? (() => Date.now()),
    mintSessionId: () => asSessionId(crypto.randomUUID()),

    async launch(input) {
      const verdict = await codexAppServerVersionProbe()
      if (!verdict.drivable) {
        // Only the floor can refuse a Codex launch.
        throw new Error(`${verdict.diagnostic.title}: ${verdict.diagnostic.body}`)
      }

      const label = codexScopeLabel(input.sessionId)
      const adapter = adapterFor(input.sessionId)

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
      const socketPath = codexClientSocketPath(input.sessionId)
      mkdirSync(socketDir(), { recursive: true, mode: 0o700 })
      chmodSync(socketDir(), 0o700)
      rmSync(socketPath, { force: true })
      const clientAddress = `unix://${socketPath}`
      const argv = ['codex', 'app-server', ...config.args, '--listen', clientAddress]
      const [command, ...args] = argv

      const env: NodeJS.ProcessEnv = serverChildEnv({
        instanceUuid: deps.instanceUuid,
        sessionId: input.sessionId,
        agentKind: 'codex',
        ...(deps.homeDir ? { homeDir: deps.homeDir } : {}),
        ...(input.env ? { sessionEnv: input.env } : {}),
        harnessEnv: config.env,
      })

      /**
       * THE ENGINE, UNDER THE HOST. `spawnHeadless` puts `codex app-server`
       * under podium-host `--no-pty` in the session's transient scope: the host
       * — not this daemon — holds the child's stdin, so a daemon restart no
       * longer closes the lifetime tether and the engine survives. JSON-RPC
       * still rides WebSocket text frames over the Unix listener; the merged
       * stdout/stderr ring feeds the startup banner below.
       */
      let held: HeldEngine
      try {
        held = tapEngine(
          input.sessionId,
          await adapter.spawnHeadless({
            label,
            cmd: command ?? 'codex',
            args,
            cwd: input.workdir,
            env: stringEnv(env),
            stripEnv: STRIPPED_CODEX_CREDENTIALS,
          }),
        )
        held.childPid = (await held.session.ready).childPid
      } catch (err) {
        engines.delete(input.sessionId)
        throw err
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
        const socket = await connectCodexWebSocket(socketPath, liveness, banner)
        chmodSync(socketPath, 0o600)
        transport = websocketTransport(socket, held, banner)
      } catch (err) {
        await terminate(input.sessionId, 'SIGKILL', held)
        rmSync(socketPath, { force: true })
        throw err
      }
      return endpointFor({ sessionId: input.sessionId, socketPath, clientAddress, held, transport })
    },

    /**
     * Rebind to the SURVIVING engine after a daemon restart — or `undefined`
     * when nothing survived. Exact identity first (journal vs binding), then
     * host liveness, then the address itself: a WS that opens on the journalled
     * socket. The thread never closed, so the driver attaches to it WITHOUT a
     * `thread/resume` — and an in-flight turn continues on the engine instead
     * of being abandoned with a fresh child. A lease held elsewhere throws
     * (loud) rather than returning a transport the driver cannot own.
     */
    async adopt(binding) {
      const entry = journal.read(binding.sessionId)
      if (!entry || entry.process.key !== binding.process.key) return undefined
      // Entries written before the socket address was journalled predate
      // durable engines: nothing to rebind to, fall back to fresh-start.
      if (!entry.clientAddress) return undefined
      const adapter = deps.durable?.all.find((a) => a.kind === 'host') ?? deps.durable?.primary
      if (!adapter || adapter.kind !== 'host') return undefined
      const label = codexScopeLabel(binding.sessionId)
      if (!(await adapter.has(label))) return undefined
      const held = await attachEngine(adapter, binding.sessionId, label)
      if (!held) return undefined
      const socketPath = entry.clientAddress.slice('unix://'.length)
      const banner = (): string => held.banner
      try {
        const socket = await connectCodexWebSocket(socketPath, livenessFor(held), banner)
        const transport = websocketTransport(socket, held, banner)
        return endpointFor({
          sessionId: binding.sessionId,
          socketPath,
          clientAddress: entry.clientAddress,
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
      const entry = journal.read(input.sessionId)
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
  path: string,
  child: CodexChildLiveness,
  banner: () => string,
  timeoutMs: number = CODEX_SOCKET_CONNECT_TIMEOUT_MS,
  attemptTimeoutMs: number = CODEX_HANDSHAKE_ATTEMPT_TIMEOUT_MS,
): Promise<WebSocket> {
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
      const socket = await new Promise<WebSocket>((resolve, reject) => {
        const candidate = new WebSocket(`ws+unix://${path}:/rpc`, {
          maxPayload: 128 << 20,
          perMessageDeflate: false,
        })
        // Listener startup is polled by opening real connections. `ws` can emit
        // another error after the first failed attempt is terminated; keep one
        // durable listener so that expected retry cleanup cannot become an
        // unhandled EventEmitter `error` under Bun.
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
  socket: WebSocket,
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
      socket.on('message', (message: RawData, binary: boolean) => {
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
