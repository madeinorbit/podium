/**
 * `codex app-server`, ONE PER SESSION, UNDER A SYSTEMD SCOPE (POD-1761 W6; plan §1).
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE OWNS, AND WHY IT IS THE ONLY PART IN THE DAEMON
 * ---------------------------------------------------------------------------
 *
 * The driver itself — the JSON-RPC client, the mapping, the receipts, the
 * approval inversion — is in `@podium/agent-runtime`, testable in-process. What
 * could not go there is everything below: spawning a child, cleaning its
 * environment, putting it in a transient cgroup, and writing the journal that
 * lets `adopt()` find the session again after the daemon dies. This is the
 * `CodexRuntimeHost` implementation and it is deliberately nothing but that.
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

import { spawn } from 'node:child_process'
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
  gateCodexVersion,
  OPENCODE_VERSION_PROBE_TIMEOUT_MS,
  STRIPPED_CODEX_CREDENTIALS,
} from '@podium/agent-runtime'
import { codexMcpArgs } from '@podium/harness'
import { createLogger } from '@podium/logger'
import type { SessionId } from '@podium/model'
import { asSessionId } from '@podium/model'
import {
  applySessionsSliceBudget,
  canScopeMaster,
  scopeReclaimArgvs,
  scopeUnitName,
  systemdScopeArgv,
} from '@podium/pty'
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
import { SERVER_GRACEFUL_EXIT_MS, SERVER_SYSTEMCTL_CALL_TIMEOUT_MS } from './server-teardown-budget'
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

/**
 * THREE ANSWERS, NOT TWO — adopted wholesale from POD-2023's review round, where
 * POD-2056 measured why it matters.
 *
 * "This machine's codex is too old" and "I could not find out" are different
 * facts and deserve different behaviour. The first is stable and about the
 * MACHINE: degrading an explicit override to the terminal driver is defensible,
 * because the driver genuinely cannot run here and will not start next time
 * either. The second is transient and about LOAD: degrading on it silently
 * converts a deliberate request into a different kind of session because a box
 * happened to be busy.
 *
 * That distinction is sharper here than it was for opencode, because this
 * binary is bigger and its probe is slower — a 26-second `codex --version` on a
 * loaded machine is an ordinary observation, not an anomaly.
 */
export type CodexProbeVerdict =
  | { drivable: true }
  /** The binary answered and the gate refused it. Stable; degrade is honest. */
  | { drivable: false; reason: 'unsupported'; diagnostic: CodexVersionDiagnostic }
  /** The binary did not answer at all — absent, or too slow under load. NOT a
   *  statement about the version, and cached only until the retry interval. */
  | { drivable: false; reason: 'unprobeable'; diagnostic: CodexVersionDiagnostic }

/**
 * MEMOIZED PERMANENTLY ONLY WHEN THE ANSWER IS DEFINITIVE.
 *
 * A version the gate accepted or refused cannot change under a running daemon,
 * so caching it saves a fork of a 250MB executable per session. A timeout is a
 * transient load fact and therefore uses the shared expiring cache instead.
 */
const versionProbeCache = createVersionProbeCache<CodexProbeVerdict>({
  evaluate: ({ output, ok }) => {
    if (!ok) {
      const diagnostic: CodexVersionDiagnostic = {
        code: 'codex-app-server-version-unsupported',
        title: 'codex app-server driver needs review',
        body: `\`codex --version\` did not answer within ${VERSION_PROBE_TIMEOUT_MS}ms. That is a statement about this machine's load or PATH, NOT about the version — the app-server driver is not disabled, and a later spawn will probe again. Observed: ${output || '(no output)'}`,
        observedVersion: output.trim() || '(probe failed)',
      }
      log.warn('could not probe the codex version', { output })
      return { drivable: false, reason: 'unprobeable', diagnostic }
    }
    const diagnostic = gateCodexVersion(output)
    const verdict: CodexProbeVerdict = diagnostic
      ? { drivable: false, reason: 'unsupported', diagnostic }
      : { drivable: true }
    if (diagnostic) log.warn('codex is outside the app-server driver range', { diagnostic })
    return verdict
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
}

/** The label a session's scope unit is named from. Same shape as the PTY and
 *  opencode sides' so an operator reading `systemctl --user list-units` sees one
 *  convention. */
export const codexScopeLabel = (sessionId: SessionId): string => `podium-cx-${sessionId}`

export function createCodexHost(deps: CodexHostDeps): CodexRuntimeHost {
  const journal = deps.journal ?? createCodexJournal()
  /**
   * EVERY LIVE CHILD OF A SESSION, NOT "THE" CHILD (POD-2024 review, finding 3).
   *
   * An endpoint must terminate the child it captured, even when lifecycle work
   * overlaps an older child's retirement with a successor's launch. A
   * `Map<SessionId, child>` retargeted an old endpoint's `stop()` to whichever
   * child was registered most recently and could kill the successor instead.
   *
   * A set per session preserves exact ownership and also makes the scope guard
   * below answerable: "is any child of this session still running" is a question
   * a single slot cannot answer during an overlap. The current Unix fine-watch
   * path opens another connection to the same child, so it does not normally add
   * a second entry here.
   */
  const children = new Map<SessionId, Set<ReturnType<typeof spawn>>>()

  const liveChildren = (sessionId: SessionId): Set<ReturnType<typeof spawn>> => {
    const existing = children.get(sessionId)
    if (existing) return existing
    const created = new Set<ReturnType<typeof spawn>>()
    children.set(sessionId, created)
    return created
  }

  /**
   * End ONE child — the one this endpoint owns — and reclaim the scope only when
   * it was the last of its session.
   *
   * THE CHILD IS PASSED IN RATHER THAN LOOKED UP, which is the whole fix for the
   * swap case: an endpoint must terminate the process it was built for, not
   * whatever is currently registered under its session id.
   */
  async function terminate(
    sessionId: SessionId,
    signal: 'SIGTERM' | 'SIGKILL',
    child: ReturnType<typeof spawn> | undefined,
  ): Promise<void> {
    const live = liveChildren(sessionId)
    if (child) live.delete(child)
    /**
     * CLOSING STDIN IS THE GRACEFUL STOP, and it is tried FIRST because it is
     * the ending Codex itself defines: the child exits cleanly (code 0) on EOF.
     * A signal is the fallback for a child that is wedged, not the primary move
     * — so a SIGTERM stop gives the EOF a moment to be taken before signalling,
     * and skips the signal entirely for a child that has already gone.
     *
     * It matters for this family specifically: the thing the child is writing on
     * its way out is the rollout JSONL, and that file is the only thing
     * `resume()` and `adopt()` have to work from.
     */
    if (signal === 'SIGTERM') {
      try {
        child?.stdin?.end()
      } catch {
        // A stdin that is already closed is the state we wanted.
      }
      if (child && (await exited(child, GRACEFUL_EXIT_MS))) {
        // It took the EOF. Signalling now would be signalling a corpse.
        await reclaimIfLast(sessionId, live)
        return
      }
    }
    child?.kill(signal)
    /**
     * AND THE SCOPE — BUT ONLY IF NOTHING ELSE OF THIS SESSION IS IN IT.
     *
     * Signalling the direct child leaves its cgroup, and any grandchild the
     * agent spawned, behind — the state that squats the deterministic unit name
     * and pushes the next spawn into the daemon's own cgroup. But both children
     * of an in-daemon upgrade share ONE unit, so reclaiming while the sibling is
     * still serving stops the whole cgroup and takes the live session with it.
     */
    await reclaimIfLast(sessionId, live)
  }

  async function reclaimIfLast(
    sessionId: SessionId,
    live: Set<ReturnType<typeof spawn>>,
  ): Promise<void> {
    if (live.size > 0) return
    children.delete(sessionId)
    if (!(await canScopeMaster())) return
    const unit = scopeUnitName(codexScopeLabel(sessionId))
    for (const args of scopeReclaimArgvs(unit)) await runSystemctl(args)
  }

  /** Did this child exit within the window? Resolves `false` on timeout rather
   *  than waiting forever for a wedged process to notice its stdin. */
  const exited = (child: ReturnType<typeof spawn>, ms: number): Promise<boolean> =>
    new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve(true)
        return
      }
      const timer = setTimeout(() => {
        child.off('exit', onExit)
        resolve(false)
      }, ms)
      timer.unref?.()
      function onExit(): void {
        clearTimeout(timer)
        resolve(true)
      }
      child.once('exit', onExit)
    })

  async function runSystemctl(args: readonly string[]): Promise<void> {
    await new Promise<void>((resolve) => {
      const child = spawn('systemctl', [...args], { stdio: 'ignore' })
      const done = (): void => resolve()
      child.once('exit', done)
      child.once('error', done)
      const timer = setTimeout(done, SERVER_SYSTEMCTL_CALL_TIMEOUT_MS)
      timer.unref?.()
    })
  }

  return {
    journal,
    stageAttachment: deps.stageAttachment ?? stageRuntimeAttachment,
    now: deps.now ?? (() => Date.now()),
    mintSessionId: () => asSessionId(crypto.randomUUID()),

    async launch(input) {
      const verdict = await codexAppServerVersionProbe()
      if (!verdict.drivable) {
        // REFUSED, NOT DEGRADED. A driver written against methods this binary
        // may not speak fails by never receiving an approval — the session
        // simply hangs on its first tool call, and the operator reads it as a
        // Podium bug. Both non-drivable reasons refuse HERE, because by this
        // point a driver was already chosen: the place where `unprobeable` gets
        // its softer treatment is the SELECTION path, not the spawn.
        throw new Error(`${verdict.diagnostic.title}: ${verdict.diagnostic.body}`)
      }

      const label = codexScopeLabel(input.sessionId)
      const scoped = await canScopeMaster()
      const unit = scopeUnitName(label)
      /**
       * RECLAIM A SQUATTED UNIT — BUT NEVER ONE THIS DAEMON IS STILL USING.
       *
       * The reclaim used to be unconditional, justified by "an app-server child
       * cannot outlive the daemon that forked it, so a unit still squatting this
       * name belongs to a process that is already gone". That is true of a
       * DAEMON RESTART and false while this daemon still owns a live child. A
       * successor launch can overlap the older child's retirement, and both
       * share this unit, so `systemctl --user stop` would take the whole cgroup
       * and kill the session the successor is serving.
       *
       * The guard is our own bookkeeping rather than a liveness probe, and that
       * is the honest instrument here: a child this process forked is a child
       * this process is holding, so `children` knows. `packages/pty`'s
       * `reclaimStaleScope` carries the same discipline in writing — "we only
       * ever clear a zombie scope held open by orphaned grandchildren, never a
       * live agent."
       */
      if (scoped && liveChildren(input.sessionId).size === 0) {
        for (const args of scopeReclaimArgvs(unit)) await runSystemctl(args)
      }

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
      const [command, ...args] = scoped ? ['systemd-run', ...systemdScopeArgv(unit, argv)] : argv

      const env: NodeJS.ProcessEnv = serverChildEnv({
        instanceUuid: deps.instanceUuid,
        sessionId: input.sessionId,
        agentKind: 'codex',
        ...(deps.homeDir ? { homeDir: deps.homeDir } : {}),
        ...(input.env ? { sessionEnv: input.env } : {}),
        harnessEnv: config.env,
      })
      for (const key of STRIPPED_CODEX_CREDENTIALS) delete env[key]

      const child = spawn(command ?? 'codex', args, {
        cwd: input.workdir,
        env,
        // stdout/stderr remain captured for startup diagnostics. JSON-RPC rides
        // WebSocket text frames over the Unix listener; stdin stays open because
        // Codex treats its EOF as the app-server lifetime boundary.
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: false,
      })
      // The instance's sessions slice exists now that a scope named it, so its
      // aggregate throttle can be set (POD-2413). Fire and forget, memoized on
      // success: a session must never wait on a best-effort budget call.
      if (scoped) void applySessionsSliceBudget()
      liveChildren(input.sessionId).add(child)
      // A child that exits on its own leaves the set, so a later `stop()` of a
      // SIBLING can tell whether it was the last one and reclaim the scope.
      child.once('exit', () => {
        children.get(input.sessionId)?.delete(child)
        rmSync(socketPath, { force: true })
      })

      let banner = ''
      child.stderr?.on('data', (chunk: Buffer) => {
        banner = `${banner}${chunk.toString('utf8')}`.slice(-2000)
      })
      child.once('error', (err) => {
        log.warn('codex app-server child errored', { err, sessionId: input.sessionId })
      })
      if (!scoped) {
        // DECLARED, NOT HIDDEN. Without a systemd user manager the session runs
        // in the daemon's cgroup: it still works, but per-session memory
        // accounting and OOM isolation are gone.
        log.warn('codex app-server session is running unscoped', { sessionId: input.sessionId })
      }

      let transport: CodexTransport
      try {
        const socket = await connectCodexWebSocket(socketPath, child, () => banner)
        chmodSync(socketPath, 0o600)
        transport = websocketTransport(socket, child, () => banner)
      } catch (err) {
        await terminate(input.sessionId, 'SIGKILL', child)
        rmSync(socketPath, { force: true })
        throw err
      }
      const endpoint: CodexServerEndpoint = {
        transport,
        clientAddress,
        reconnect: async () => {
          const socket = await connectCodexWebSocket(socketPath, child, () => banner)
          return websocketTransport(socket, child, () => banner)
        },
        process: {
          /**
           * THE SESSION'S IDENTITY, NOT THE INCARNATION'S.
           *
           * Deliberately the scope label rather than the pid: `adopt()` compares
           * this against the journal to prove a binding describes THIS session
           * rather than a different one, and it must survive the child being
           * replaced — which, for this family, is what adopting IS.
           */
          key: label,
          ...(child.pid !== undefined ? { pid: child.pid } : {}),
          ...(scoped ? { scopeUnit: unit } : {}),
        },
        // THIS endpoint's child, captured — never "whatever is registered for
        // this session" at the moment stop happens.
        stop: async () => {
          transport.close()
          await terminate(input.sessionId, 'SIGTERM', child)
          rmSync(socketPath, { force: true })
        },
        kill: async () => {
          transport.close()
          await terminate(input.sessionId, 'SIGKILL', child)
          rmSync(socketPath, { force: true })
          journal.clear(input.sessionId)
        },
        resources: () =>
          deps.resources({
            sessionId: input.sessionId,
            label,
            ...(child.pid !== undefined ? { pid: child.pid } : {}),
            ...(scoped ? { scopeUnit: unit } : {}),
          }),
      }
      return endpoint
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

/** What the connect loop needs of a child; a test supplies it without spawning. */
export interface CodexChildLiveness {
  exitCode: number | null
  signalCode: NodeJS.Signals | null
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
  child: ReturnType<typeof spawn>,
  banner: () => string,
): CodexTransport {
  let closed = false
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
        if (tail) log.warn('codex app-server child ended', { stderr: tail.slice(-500) })
        handler.closed()
      }
      child.once('exit', ended)
      socket.once('close', ended)
      child.once('error', ended)
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
