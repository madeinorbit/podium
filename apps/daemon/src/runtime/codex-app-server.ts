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
 * THE TRANSPORT IS THE CHILD'S STDIO (spec §6), AND THAT WAS MEASURED
 * ---------------------------------------------------------------------------
 *
 * The plan preferred a per-session unix socket at 0600. `codex app-server
 * --listen unix://PATH` exists on the pinned binary and does create one — and it
 * is NOT the client surface. It is a daemon CONTROL socket: a JSON-RPC
 * `initialize` written to it gets the connection closed, and so does the same
 * request sent through Codex's own `app-server proxy --sock` bridge. The
 * `daemon` subcommand puts one at a fixed, machine-GLOBAL path, which would
 * contradict this epic's process-per-session decision anyway.
 *
 * So the channel is the pipe pair the daemon holds from forking the child. That
 * satisfies spec §6 more strongly than the socket would, not less: there is no
 * filesystem object to find, no path to leak, no mode bits to get wrong, no
 * stale socket to reclaim, and no `SUN_LEN` limit — which is a real constraint,
 * since a socket under this instance's state dir is refused outright for path
 * length. A process that did not fork the child has no name by which to reach
 * it.
 *
 * THE PRICE IS THAT THE CHILD CANNOT OUTLIVE US. `codex app-server` exits
 * cleanly on stdin EOF (verified), so a daemon restart takes every session's
 * child with it. `adopt()` therefore resumes the thread in a fresh child rather
 * than rebinding a survivor — the argument is in the driver's own header, and
 * what makes it work is that Codex persists each thread to its own rollout file.
 */

import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  CodexJournal,
  CodexJournalEntry,
  CodexRuntimeHost,
  CodexServerEndpoint,
  CodexTransport,
  CodexVersionDiagnostic,
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
import { canScopeMaster, scopeReclaimArgvs, scopeUnitName, systemdScopeArgv } from '@podium/pty'
import { stateDir } from '@podium/runtime/config'

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
        const parsed = JSON.parse(
          readFileSync(journalPath(sessionId), 'utf8'),
        ) as CodexJournalEntry
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
 *  only thing being waited for is the rollout file's last flush. */
const GRACEFUL_EXIT_MS = 2_000

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
   *  statement about the version, and NOT memoized. */
  | { drivable: false; reason: 'unprobeable'; diagnostic: CodexVersionDiagnostic }

/**
 * MEMOIZED ONLY WHEN THE ANSWER IS DEFINITIVE.
 *
 * A version the gate accepted or refused cannot change under a running daemon,
 * so caching it saves a fork of a 250MB executable per session. A probe that
 * TIMED OUT is a fact about how loaded the box was in that moment — caching it
 * would disable the driver for the daemon's entire life because one spawn was
 * unlucky.
 */
let versionVerdict: CodexProbeVerdict | undefined

export function codexAppServerVersionProbe(
  probe: () => { output: string; ok: boolean } = defaultVersionProbe,
): CodexProbeVerdict {
  if (versionVerdict) return versionVerdict
  const { output, ok } = probe()
  if (!ok) {
    // Deliberately NOT cached. Retried on the next spawn, which on a quieter box
    // is the one that succeeds.
    const diagnostic: CodexVersionDiagnostic = {
      code: 'codex-app-server-version-unsupported',
      title: 'codex app-server driver needs review',
      body: `\`codex --version\` did not answer within ${VERSION_PROBE_TIMEOUT_MS}ms. That is a statement about this machine's load or PATH, NOT about the version — the app-server driver is not disabled, and the next spawn probes again. Observed: ${output || '(no output)'}`,
      observedVersion: output.trim() || '(probe failed)',
    }
    log.warn('could not probe the codex version', { output })
    return { drivable: false, reason: 'unprobeable', diagnostic }
  }
  const diagnostic = gateCodexVersion(output)
  const verdict: CodexProbeVerdict = diagnostic
    ? { drivable: false, reason: 'unsupported', diagnostic }
    : { drivable: true }
  versionVerdict = verdict
  if (diagnostic) log.warn('codex is outside the app-server driver range', { diagnostic })
  return verdict
}

/** Reset the memo. Tests only — a daemon never needs it. */
export function resetCodexAppServerVersionProbe(): void {
  versionVerdict = undefined
}

function defaultVersionProbe(): { output: string; ok: boolean } {
  const result = spawnSyncVersion()
  return { output: `${result.stdout}${result.stderr}`.trim(), ok: result.ok }
}

function spawnSyncVersion(): { stdout: string; stderr: string; ok: boolean } {
  // Imported lazily so a daemon that never spawns a codex session never pays for
  // the module.
  const { spawnSync } = require('node:child_process') as typeof import('node:child_process')
  const result = spawnSync('codex', ['--version'], {
    encoding: 'utf8',
    timeout: VERSION_PROBE_TIMEOUT_MS,
  })
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    // `ok` IS ABOUT THE SPAWN, not the version. A timeout sets `error`
    // (ETIMEDOUT) and a missing binary sets it to ENOENT; both mean we learned
    // nothing about the version, and only the CALLER can decide whether that
    // should degrade a session or refuse it.
    ok: result.error === undefined && result.status === 0,
  }
}

// ---------------------------------------------------------------------------
// The child's argv
// ---------------------------------------------------------------------------

/**
 * The `-c` overrides every app-server session carries.
 *
 * `approval_policy` IS THE LOAD-BEARING ONE and the plan says so explicitly:
 * it must be a policy that ROUTES approvals to server→client requests. `never`
 * silences them, which would make the whole approval half of this driver dead
 * code and the acceptance item impossible to demonstrate. `untrusted` is the
 * policy that asks about everything it has not been told is safe; it is what the
 * live approval was captured under.
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
      'approval_policy="untrusted"',
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
  /** Whole-subtree RSS for a session, from the daemon's own attribution. */
  memoryBytes(input: { sessionId: SessionId; label: string; pid?: number }): number | undefined
  /** Start Codex's own TUI against a thread, for `attach()`. `undefined` from
   *  the whole function = this machine cannot host one. */
  attachClient?(input: {
    sessionId: SessionId
    threadId: string
    mode: 'takeover' | 'peek'
  }): Promise<{ streamId: string; warmTtlMs: number } | undefined>
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
   * This was a `Map<SessionId, child>`, on the assumption that a session has one
   * app-server at a time. `upgradeToFine` breaks that assumption on purpose: it
   * launches a SECOND child for a session whose first is still live and still
   * serving, then swaps and stops the old one. With a single-slot map the second
   * launch overwrote the entry, so `stop()` on the OLD endpoint resolved to the
   * NEW child and killed the session it had just adopted.
   *
   * A set per session fixes that half and is also what makes the scope guards
   * below answerable: "is any child of this session still running" is a question
   * a single slot cannot answer once two exist.
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
    if (!canScopeMaster()) return
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
      const timer = setTimeout(done, 8000)
      timer.unref?.()
    })
  }

  return {
    journal,
    now: deps.now ?? (() => Date.now()),
    mintSessionId: () => asSessionId(crypto.randomUUID()),

    async launch(input) {
      const verdict = codexAppServerVersionProbe()
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
      const scoped = canScopeMaster()
      const unit = scopeUnitName(label)
      /**
       * RECLAIM A SQUATTED UNIT — BUT NEVER ONE THIS DAEMON IS STILL USING.
       *
       * The reclaim used to be unconditional, justified by "an app-server child
       * cannot outlive the daemon that forked it, so a unit still squatting this
       * name belongs to a process that is already gone". That is true of a
       * DAEMON RESTART and false of an in-daemon relaunch: `upgradeToFine`
       * launches a second child for a session whose first is still live, and
       * both share this unit, so `systemctl --user stop` took the whole cgroup
       * and killed the session the upgrade was serving.
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
      const argv = ['codex', 'app-server', ...config.args]
      const [command, ...args] = scoped ? ['systemd-run', ...systemdScopeArgv(unit, argv)] : argv

      const env: NodeJS.ProcessEnv = { ...process.env, ...input.env, ...config.env }
      for (const key of STRIPPED_CODEX_CREDENTIALS) delete env[key]

      const child = spawn(command ?? 'codex', args, {
        cwd: input.workdir,
        env,
        /**
         * ALL THREE PIPED, and stdin is not optional: it IS the request channel.
         * stderr is captured because Codex writes its diagnostics there, and a
         * child that dies during the handshake has nothing else to explain
         * itself with.
         */
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: false,
      })
      liveChildren(input.sessionId).add(child)
      // A child that exits on its own leaves the set, so a later `stop()` of a
      // SIBLING can tell whether it was the last one and reclaim the scope.
      child.once('exit', () => {
        children.get(input.sessionId)?.delete(child)
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

      const transport = childTransport(child, () => banner)
      const endpoint: CodexServerEndpoint = {
        transport,
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
        // THIS endpoint's child, captured — not "whatever is registered for this
        // session", which after an upgrade is a different process entirely.
        stop: async () => {
          await terminate(input.sessionId, 'SIGTERM', child)
        },
        kill: async () => {
          await terminate(input.sessionId, 'SIGKILL', child)
          journal.clear(input.sessionId)
        },
        memoryBytes: () =>
          deps.memoryBytes({
            sessionId: input.sessionId,
            label,
            ...(child.pid !== undefined ? { pid: child.pid } : {}),
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
      return (
        (await deps.attachClient?.({
          sessionId: input.sessionId,
          threadId: input.threadId,
          mode: input.mode,
        })) ?? undefined
      )
    },
  }
}

/**
 * A child's stdio as the driver's transport.
 *
 * THE LINE SPLITTING LIVES HERE, not in the client, because framing is a
 * property of the pipe: a chunk boundary can land anywhere, including mid-frame,
 * and a client that assumed one chunk was one line would corrupt every large
 * payload — which for this protocol means every turn carrying a real transcript.
 */
function childTransport(
  child: ReturnType<typeof spawn>,
  banner: () => string,
): CodexTransport {
  let buffer = ''
  let closed = false
  return {
    write(line) {
      if (closed) return
      try {
        child.stdin?.write(line)
      } catch (err) {
        // A write to a dead pipe is the child being gone; the `close` handler
        // below is what reports it, and throwing here would surface the same
        // fact twice in two vocabularies.
        log.warn('could not write to the codex app-server child', { err })
      }
    },
    onLine(handler) {
      child.stdout?.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8')
        let boundary = buffer.indexOf('\n')
        while (boundary >= 0) {
          const line = buffer.slice(0, boundary)
          buffer = buffer.slice(boundary + 1)
          boundary = buffer.indexOf('\n')
          if (line.trim()) handler.line(line)
        }
      })
      const ended = (): void => {
        if (closed) return
        closed = true
        const tail = banner().trim()
        if (tail) log.warn('codex app-server child ended', { stderr: tail.slice(-500) })
        handler.closed()
      }
      child.once('exit', ended)
      child.stdout?.once('end', ended)
      child.once('error', ended)
    },
    close() {
      if (closed) return
      closed = true
      try {
        child.stdin?.end()
      } catch {
        // Already closed; that is the state we wanted.
      }
    },
  }
}
