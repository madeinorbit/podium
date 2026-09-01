/**
 * `opencode serve`, ONE PER SESSION, UNDER A SYSTEMD SCOPE (POD-1761 W5; plan §1).
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE OWNS, AND WHY IT IS THE ONLY PART IN THE DAEMON
 * ---------------------------------------------------------------------------
 *
 * The driver itself — client, SSE, receipts, interactions, events — is in
 * `@podium/agent-runtime`, testable in-process. What could not go there is
 * everything below: spawning a child, choosing its port, putting it in a
 * transient cgroup, and writing the journal that lets `adopt()` find it again
 * after the daemon dies. This is the `OpencodeRuntimeHost` implementation, and
 * it is deliberately nothing but that.
 *
 * ---------------------------------------------------------------------------
 * THE SECRET (spec §6) — THREE RULES, ALL LOAD-BEARING
 * ---------------------------------------------------------------------------
 *
 *   1. IT IS MANDATORY. Not configurable, not skippable on "just loopback". A
 *      loopback port is reachable by every local process and every local user,
 *      and this one fronts an agent with a shell and the filesystem.
 *   2. IT RIDES THE ENV, NEVER ARGV. `/proc/<pid>/cmdline` is world-readable; a
 *      secret in argv is a secret everyone on the box has.
 *   3. IT IS PERSISTED 0600 AND NOWHERE ELSE. `adopt()` after a daemon restart
 *      needs it to talk to a server that is still running, so it must survive —
 *      which means the journal file's mode is part of the mechanism, not
 *      hygiene.
 *
 * ---------------------------------------------------------------------------
 * WHY THE SCOPE RECLAIM IS NOT `reclaimStaleScope`
 * ---------------------------------------------------------------------------
 *
 * `packages/pty` exports the pure argv/name builders (`systemdScopeArgv`,
 * `scopeUnitName`, `scopeReclaimArgvs`) and this file reuses them directly. What
 * it does NOT reuse is `reclaimStaleScope`, whose liveness guard asks abduco
 * whether a master exists — an opencode server has no abduco socket, so that
 * guard would answer "no master" for a perfectly live server and stop its scope.
 * The guard here is the one that fits: health-probe the journalled port with the
 * journalled secret, and only reclaim a unit whose server does not answer.
 *
 * Without a reclaim at all, the documented failure is specific and nasty: the
 * unit name is deterministic, `systemd-run` refuses "unit already exists", the
 * child SILENTLY falls back into the daemon's own cgroup, and the next redeploy's
 * `KillMode=control-group` takes the agent down with the daemon.
 */

import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import type {
  AttachmentStager,
  OpencodeJournal,
  OpencodeJournalEntry,
  OpencodeRuntimeHost,
  OpencodeServerEndpoint,
  ScopeResources,
} from '@podium/agent-runtime'
import {
  gateOpencodeVersion,
  OPENCODE_VERSION_PROBE_TIMEOUT_MS,
  type OpencodeVersionDiagnostic,
} from '@podium/agent-runtime'
import { AGENT_MANIFESTS } from '@podium/harness'
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
import { stateDir } from '@podium/runtime/config'
import { serverChildEnv } from '../control/session-env'
import { SERVER_SYSTEMCTL_CALL_TIMEOUT_MS } from './server-teardown-budget'
import { stageRuntimeAttachment } from './attachment-staging'
import type { OpencodeClientTerminals } from './opencode-attach'
import {
  createVersionProbeCache,
  execVersionProbe,
  type VersionProbe,
  type VersionProbePolicy,
} from './version-probe'

const log = createLogger('daemon:opencode-server')

/** The account name the driver authenticates as. Constant because it is not a
 *  secret and not a principal — the PASSWORD is the credential. */
const USERNAME = 'podium'

/** How long to wait for `opencode serve` to answer `/global/health`. Generous:
 *  the binary is ~180MB and a cold start on a loaded box is seconds, not
 *  milliseconds. */
const READY_TIMEOUT_MS = 60_000
const READY_POLL_MS = 250
/**
 * Every readiness probe is individually bounded.
 *
 * A probe with no timeout is how a readiness loop turns into a hang: a socket
 * that accepts and never answers holds the whole loop on its first iteration,
 * and the caller sees "spawn never returned" rather than "the server is not
 * ready".
 */
const PROBE_TIMEOUT_MS = 2000

/** Where a session's journal entry lives. Under the daemon's own state dir, so
 *  it moves with the instance and is swept with it. */
const journalDir = (namespace = 'opencode-servers'): string => join(stateDir(), namespace)
const journalPath = (sessionId: SessionId, namespace = 'opencode-servers'): string =>
  join(journalDir(namespace), `${encodeURIComponent(sessionId)}.json`)

/**
 * Provider credentials that MUST NOT reach the child.
 *
 * The opencode reference warns that a provider key in the environment OVERRIDES
 * the stored OAuth credential — so a daemon that happens to carry
 * `ANTHROPIC_API_KEY` would silently bill a different account than the one the
 * operator logged in as, and would do it invisibly. Stripping them makes the
 * session use exactly the credential `opencode auth login` stored.
 *
 * READ OFF THE MANIFEST since POD-2296, where the terminal spawn path needed the
 * same fact for every harness and the honest place to answer "which vars override
 * THIS CLI's login" turned out to be the CLI's own manifest. Same array, same
 * name, same importers — it just has one home now.
 */
export const STRIPPED_PROVIDER_KEYS = AGENT_MANIFESTS.opencode.inventory.foreignCredentialEnv

// ---------------------------------------------------------------------------
// The journal
// ---------------------------------------------------------------------------

/**
 * A file per session, 0600, because it holds the secret.
 *
 * SYNCHRONOUS ON PURPOSE. It is written on the turn-open path, where the value
 * it protects is the monotonic turn epoch: an async write that lost a race with
 * a daemon crash would rebind the session at an older epoch, which is the one
 * thing the causal envelope's monotonicity rule forbids. The payload is a few
 * hundred bytes.
 */
export function createOpencodeJournal(namespace = 'opencode-servers'): OpencodeJournal {
  const cache = new Map<SessionId, OpencodeJournalEntry>()
  return {
    read(sessionId) {
      const cached = cache.get(sessionId)
      if (cached) return cached
      try {
        const parsed = JSON.parse(
          readFileSync(journalPath(sessionId, namespace), 'utf8'),
        ) as OpencodeJournalEntry
        cache.set(sessionId, parsed)
        return parsed
      } catch {
        return undefined
      }
    },
    write(entry) {
      cache.set(entry.sessionId, entry)
      try {
        mkdirSync(journalDir(namespace), { recursive: true, mode: 0o700 })
        writeFileSync(journalPath(entry.sessionId, namespace), JSON.stringify(entry), {
          mode: 0o600,
        })
      } catch (err) {
        // A journal we cannot write costs `adopt()` after a daemon restart, and
        // nothing else — the live session is unaffected. Losing the session to
        // an ENOSPC would be the worse trade.
        log.warn('could not persist the opencode binding journal', {
          err,
          sessionId: entry.sessionId,
        })
      }
    },
    clear(sessionId) {
      cache.delete(sessionId)
      try {
        rmSync(journalPath(sessionId, namespace), { force: true })
      } catch {
        // Best effort: a stale entry whose server is gone fails its health probe
        // on the next adopt and is ignored anyway.
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Ports, readiness, liveness
// ---------------------------------------------------------------------------

/**
 * A free loopback port, chosen by the KERNEL and then handed to opencode.
 *
 * `opencode serve --port 0` exists, but reading back which port it chose means
 * parsing its stdout banner — and a driver whose binding depends on scraping a
 * log line has a binding that breaks when the log line changes. Binding a
 * throwaway listener and releasing it has a race window measured in
 * milliseconds, and losing that race is a clean failure (opencode fails to bind
 * and never becomes ready) rather than a silent misbinding.
 */
async function freeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      if (typeof address === 'object' && address) {
        const { port } = address
        probe.close(() => resolve(port))
        return
      }
      probe.close(() => reject(new Error('could not determine a free loopback port')))
    })
  })
}

const basicAuth = (secret: string): string =>
  `Basic ${Buffer.from(`${USERNAME}:${secret}`).toString('base64')}`

/** One bounded health probe. `false` covers dead, not-yet-listening AND wrong
 *  secret — all three mean "not usable", which is the only question here.
 *  EXPORTED for the teardown reap (POD-2249): the journalled secret is the
 *  exact-identity proof that a journalled pid is still THIS session's server —
 *  the same guard the launch path documents below ("Stopping a live server
 *  here would kill a session we were about to adopt"). */
export async function probeHealth(baseUrl: string, secret: string): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl}/global/health`, {
      headers: { authorization: basicAuth(secret) },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
    return response.ok
  } catch {
    return false
  }
}

async function waitForReady(baseUrl: string, secret: string, deadlineMs: number): Promise<boolean> {
  const deadline = Date.now() + deadlineMs
  while (Date.now() < deadline) {
    if (await probeHealth(baseUrl, secret)) return true
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, READY_POLL_MS)
      timer.unref?.()
    })
  }
  return false
}

// ---------------------------------------------------------------------------
// The version gate
// ---------------------------------------------------------------------------

/**
 * Probe `opencode --version` asynchronously and cache the verdict.
 *
 * Definitive answers live for the daemon lifetime. An inconclusive answer is
 * retained only for a short retry interval: long enough that a spawn burst pays
 * for one child, not long enough to turn load or ENOENT into a permanent refusal.
 */
/**
 * THREE ANSWERS, NOT TWO — and the third one is why this is a union (POD-2056's
 * measurement, reported on POD-2023).
 *
 * "This machine's opencode is too old" and "I could not find out" are different
 * facts and deserve different behaviour, and collapsing them cost a real
 * debugging session. The first is stable and about the MACHINE: degrading an
 * explicit override to the terminal driver is defensible, because the driver
 * genuinely cannot run here and will not start next time either. The second is
 * transient and about LOAD: degrading on it silently converts a deliberate
 * request into a different kind of session, on a box that happened to be busy.
 */
export type OpencodeProbeVerdict =
  | { drivable: true }
  /** The binary answered and the gate refused it. Stable; degrade is honest. */
  | { drivable: false; reason: 'unsupported'; diagnostic: OpencodeVersionDiagnostic }
  /** The binary did not answer at all — absent, or too slow under load. NOT a
   *  statement about the version, and cached only until the retry interval. */
  | { drivable: false; reason: 'unprobeable'; diagnostic: OpencodeVersionDiagnostic }

/**
 * MEMOIZED PERMANENTLY ONLY WHEN THE ANSWER IS DEFINITIVE.
 *
 * A version the gate accepted or refused cannot change under a running daemon,
 * so caching it saves a process spawn per session. A probe that timed out is a
 * fact about load in that moment, so it uses the shared expiring cache instead.
 */
const versionProbeCache = createVersionProbeCache<OpencodeProbeVerdict>({
  evaluate: ({ output, ok }) => {
    if (!ok) {
      const diagnostic: OpencodeVersionDiagnostic = {
        code: 'opencode-version-unsupported',
        title: 'opencode server driver needs review',
        body: `\`opencode --version\` did not answer within ${VERSION_PROBE_TIMEOUT_MS}ms. That is a statement about this machine's load or PATH, NOT about the version — the server driver is not disabled, and a later spawn will probe again. Observed: ${output || '(no output)'}`,
        observedVersion: output.trim() || '(probe failed)',
      }
      log.warn('could not probe the opencode version', { output })
      return { drivable: false, reason: 'unprobeable', diagnostic }
    }
    const diagnostic = gateOpencodeVersion(output)
    const verdict: OpencodeProbeVerdict = diagnostic
      ? { drivable: false, reason: 'unsupported', diagnostic }
      : { drivable: true }
    if (diagnostic) log.warn('opencode is outside the server driver range', { diagnostic })
    return verdict
  },
})

export function opencodeVersionProbe(
  probe: VersionProbe = defaultVersionProbe,
  policy?: VersionProbePolicy,
): Promise<OpencodeProbeVerdict> {
  return versionProbeCache.probe(probe, policy)
}

export function opencodeVersionProbeForExecutable(
  executablePath: string,
  policy?: VersionProbePolicy,
): Promise<OpencodeProbeVerdict> {
  return opencodeVersionProbe(
    () => execVersionProbe(executablePath, VERSION_PROBE_TIMEOUT_MS),
    policy,
  )
}

/** The old shape, kept for the callers that only ask "may I drive it". A probe
 *  that could not answer reads as "no" here, which is right for an availability
 *  LIST — the distinction that matters is at the spawn site, which asks the
 *  verdict directly. */

export function opencode2VersionProbe(
  probe: VersionProbe = () => execVersionProbe('opencode2', VERSION_PROBE_TIMEOUT_MS),
  policy?: VersionProbePolicy,
): Promise<OpencodeProbeVerdict> {
  return createVersionProbeCache<OpencodeProbeVerdict>({
    evaluate: ({ output, ok }) => {
      const match = /0\.0\.0-(?:beta|dev)-(\d+)/u.exec(output)
      if (ok && match && Number(match[1]) >= 18743) return { drivable: true }
      const diagnostic: OpencodeVersionDiagnostic = {
        code: 'opencode-version-unsupported',
        title: 'opencode server driver needs review',
        body: ok
          ? `opencode2 ${output.trim()} is outside the preview build range exercised by this driver (beta-18743 or newer).`
          : `opencode2 --version did not answer within ${VERSION_PROBE_TIMEOUT_MS}ms: ${output || '(no output)'}`,
        observedVersion: output.trim() || '(probe failed)',
      }
      return { drivable: false, reason: ok ? 'unsupported' : 'unprobeable', diagnostic }
    },
  }).probe(probe, policy)
}

export function opencode2VersionDiagnostic(
  probe?: VersionProbe,
): Promise<OpencodeVersionDiagnostic | null> {
  return opencode2VersionProbe(probe).then((verdict) =>
    verdict.drivable ? null : verdict.diagnostic,
  )
}

export function opencodeVersionDiagnostic(
  probe?: VersionProbe,
): Promise<OpencodeVersionDiagnostic | null> {
  return (probe ? opencodeVersionProbe(probe) : opencodeVersionProbe()).then((verdict) =>
    verdict.drivable ? null : verdict.diagnostic,
  )
}

/** Reset the memo. Tests only — a daemon never needs it. */
export function resetOpencodeVersionProbe(): void {
  versionProbeCache.reset()
}

/** The shared probe budget — see `OPENCODE_VERSION_PROBE_TIMEOUT_MS` for the
 *  measurement behind it and for why all three probe sites read one constant. */
const VERSION_PROBE_TIMEOUT_MS = OPENCODE_VERSION_PROBE_TIMEOUT_MS

function defaultVersionProbe(): Promise<{ output: string; ok: boolean }> {
  // Deliberately the daemon's own env, NOT the instance composition: the probe
  // asks "what can this MACHINE run" and reads no per-user state — see
  // `serverChildEnv` for the env-class record (POD-2247).
  return execVersionProbe('opencode', VERSION_PROBE_TIMEOUT_MS)
}

// ---------------------------------------------------------------------------
// The host
// ---------------------------------------------------------------------------

export interface OpencodeHostDeps {
  stageAttachment?: AttachmentStager
  /** Resource truth for a session's scope — memory, tasks and the kernel's own
   *  OOM-kill counter, from the daemon's one cgroup observer. */
  resources(input: {
    sessionId: SessionId
    label: string
    pid?: number
    scopeUnit?: string
  }): ScopeResources | undefined
  /**
   * Where `opencode attach <url>` actually runs, for `attach()` (POD-2059).
   *
   * OPTIONAL, AND ITS ABSENCE IS AN ANSWER. A daemon built without one hosts no
   * client terminals, `attachClient` below returns `undefined`, and the driver
   * refuses with "this machine cannot host a client terminal" — a per-machine
   * fact, not a capability lie: the endpoint VARIANT the opencode capability
   * declares is still the one this family produces wherever it CAN produce one.
   */
  clientTerminals?: OpencodeClientTerminals
  /** Exact OpenCode executable resolved by this daemon generation. */
  executablePath?: string
  /** Hermetic effect seams for proving the launch boundary without a child. */
  versionProbe?: VersionProbe
  spawnProcess?: typeof spawn
  canScope?: typeof canScopeMaster
  runSystemctl?: (args: readonly string[]) => Promise<void>
  freePort?: () => Promise<number>
  /**
   * The instance agent home (`ctx.homeDir`), overriding the child's `HOME` the
   * same way the PTY path does (POD-2247). Absent = default instance, daemon
   * env unchanged. Without it a named instance's `opencode serve` reads and
   * writes the operator's REAL `~/.local/share/opencode` state.
   */
  homeDir?: string
  /** Immutable daemon ownership stamp for orphan attribution. */
  instanceUuid?: string
  journal?: OpencodeJournal
  now?(): number
  variant?: {
    driverId: 'opencode2-server'
    executable: string
    username: string
    healthPath: string
    scopeToken: string
    journalNamespace: string
    versionDiagnostic(probe?: VersionProbe): Promise<OpencodeVersionDiagnostic | null>
  }
}

/** The label a session's scope unit is named from. Same shape as the PTY side's
 *  so an operator reading `systemctl --user list-units` sees one convention. */
export const opencodeScopeLabel = (sessionId: SessionId): string => `podium-oc-${sessionId}`

export function opencodeServeArgv(executablePath: string, port: number): string[] {
  return [executablePath, 'serve', '--port', String(port), '--hostname', '127.0.0.1']
}

export function createOpencodeHost(deps: OpencodeHostDeps): OpencodeRuntimeHost {
  const variant = deps.variant
  const journal = deps.journal ?? createOpencodeJournal(variant?.journalNamespace)
  const driverId = variant?.driverId ?? 'opencode-server'
  const spawnProcess = deps.spawnProcess ?? spawn
  const scopeAvailable = deps.canScope ?? canScopeMaster
  const username = variant?.username ?? USERNAME
  const healthPath = variant?.healthPath ?? '/global/health'
  const scopeLabel = (sessionId: SessionId): string =>
    `podium-${variant?.scopeToken ?? 'oc'}-${sessionId}`
  const health = async (baseUrl: string, secret: string): Promise<boolean> => {
    try {
      const response = await fetch(`${baseUrl}${healthPath}`, {
        headers: {
          authorization: `Basic ${Buffer.from(`${username}:${secret}`).toString('base64')}`,
        },
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      })
      return response.ok
    } catch {
      return false
    }
  }
  const children = new Map<SessionId, ReturnType<typeof spawn>>()

  const endpointFor = (input: {
    sessionId: SessionId
    baseUrl: string
    secret: string
    pid: number | undefined
    scopeUnit: string | undefined
  }): OpencodeServerEndpoint => ({
    baseUrl: input.baseUrl,
    username,
    password: input.secret,
    process: {
      /**
       * EXACT IDENTITY, and deliberately not the port.
       *
       * A port is recycled by the kernel within seconds; a binding keyed on one
       * would let `adopt()` bind to whatever process happened to inherit it —
       * "a session that reports someone else's work", which the contract calls
       * worse than not adopting. The key is the scope label, which is unique to
       * this session for the machine's lifetime.
       */
      key: scopeLabel(input.sessionId),
      ...(input.pid !== undefined ? { pid: input.pid } : {}),
      ...(input.scopeUnit ? { scopeUnit: input.scopeUnit } : {}),
    },
    stop: async () => {
      await terminate(input.sessionId, 'SIGTERM')
    },
    kill: async () => {
      await terminate(input.sessionId, 'SIGKILL')
      journal.clear(input.sessionId)
    },
    resources: () =>
      deps.resources({
        sessionId: input.sessionId,
        label: scopeLabel(input.sessionId),
        ...(input.pid !== undefined ? { pid: input.pid } : {}),
        ...(input.scopeUnit ? { scopeUnit: input.scopeUnit } : {}),
      }),
  })

  async function terminate(sessionId: SessionId, signal: 'SIGTERM' | 'SIGKILL'): Promise<void> {
    children.get(sessionId)?.kill(signal)
    children.delete(sessionId)
    // AND THE CLIENT TERMINAL. Attachment lifecycle is strictly subordinate to
    // the session (spec §5): a client left alive against a server that just died
    // shows a frozen screen and holds its memory for the warm TTL, for a session
    // nobody can reach any more.
    await deps.clientTerminals?.close(sessionId, 'opencode')
    // AND THE SCOPE. Signalling the direct child leaves its cgroup — and any
    // grandchild the agent spawned — behind, which is exactly the state that
    // squats the deterministic unit name and pushes the NEXT spawn into the
    // daemon's own cgroup.
    if (!(await scopeAvailable())) return
    const unit = scopeUnitName(scopeLabel(sessionId))
    for (const args of scopeReclaimArgvs(unit)) {
      await runSystemctl(args)
    }
  }

  async function runSystemctl(args: readonly string[]): Promise<void> {
    if (deps.runSystemctl) return deps.runSystemctl(args)
    await new Promise<void>((resolve) => {
      const child = spawnProcess('systemctl', [...args], { stdio: 'ignore' })
      const done = (): void => resolve()
      child.once('exit', done)
      child.once('error', done)
      const timer = setTimeout(done, SERVER_SYSTEMCTL_CALL_TIMEOUT_MS)
      timer.unref?.()
    })
  }

  return {
    driverId,
    journal,
    stageAttachment: deps.stageAttachment ?? stageRuntimeAttachment,
    now: deps.now ?? (() => Date.now()),
    /** 32 bytes from the CSPRNG. Not a uuid, not a timestamp: this is the only
     *  thing between a local process and a credentialed agent. */
    randomSecret: () => randomBytes(32).toString('hex'),
    mintSessionId: () => asSessionId(crypto.randomUUID()),

    async launch(input) {
      const executablePath = deps.executablePath ?? variant?.executable ?? 'opencode'
      const diagnostic = await (variant?.versionDiagnostic ?? opencodeVersionDiagnostic)(
        deps.versionProbe ?? (() => execVersionProbe(executablePath, VERSION_PROBE_TIMEOUT_MS)),
      )
      if (diagnostic) {
        // REFUSED, NOT DEGRADED. A driver written against shapes this binary may
        // not speak would fail somewhere deep in a mapping, and the operator
        // would read it as a Podium bug.
        throw new Error(`${diagnostic.title}: ${diagnostic.body}`)
      }

      // A client terminal from a PREVIOUS life of this session is pointed at a
      // server that is about to be replaced by one on a different port. It cannot
      // be re-used and would sit warm showing a dead connection, so it goes now
      // rather than at its TTL.
      await deps.clientTerminals?.close(input.sessionId, 'opencode')

      const port = await (deps.freePort ?? freeLoopbackPort)()
      const baseUrl = `http://127.0.0.1:${port}`
      const label = scopeLabel(input.sessionId)
      const scoped = await scopeAvailable()
      const unit = scopeUnitName(label)

      if (scoped) {
        // Free a unit name a previous life of this session left squatted, but
        // ONLY when nothing is answering behind it — the journalled entry is
        // what tells us. Stopping a live server here would kill a session we
        // were about to adopt.
        const previous = journal.read(input.sessionId)
        const stillAlive = previous ? await health(previous.baseUrl, previous.secret) : false
        if (!stillAlive) {
          for (const args of scopeReclaimArgvs(unit)) await runSystemctl(args)
        }
      }

      // LOOPBACK, NOT A SETTING. The host is fixed and not configurable.
      const serveArgv = opencodeServeArgv(executablePath, port)
      const [command, ...args] = scoped
        ? ['systemd-run', ...systemdScopeArgv(unit, serveArgv)]
        : serveArgv

      const env: NodeJS.ProcessEnv = serverChildEnv({
        instanceUuid: deps.instanceUuid,
        sessionId: input.sessionId,
        agentKind: 'opencode',
        ...(deps.homeDir ? { homeDir: deps.homeDir } : {}),
        ...(input.env ? { sessionEnv: input.env } : {}),
      })
      for (const key of STRIPPED_PROVIDER_KEYS) delete env[key]
      env.OPENCODE_SERVER_USERNAME = username
      // RULE 2: the secret is HERE. It appears in `serveArgv` nowhere, and this
      // is the assertion `opencode-server.test.ts` pins.
      env.OPENCODE_SERVER_PASSWORD = input.secret
      // opencode only publishes `question.asked` when its question tool is on,
      // and a driver that maps question interactions but never receives one is
      // a feature that exists only in the type system.
      env.OPENCODE_ENABLE_QUESTION_TOOL = env.OPENCODE_ENABLE_QUESTION_TOOL ?? '1'

      const child = spawnProcess(command ?? 'opencode', args, {
        cwd: input.workdir,
        env,
        /**
         * PIPED, NOT IGNORED, and this is a bug that cost an hour: with
         * `stdio: 'ignore'` the child was observed not to come up on this host.
         * The banner is also the only thing a "did not become ready" failure has
         * to report, so it is captured rather than dropped.
         */
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false,
      })
      children.set(input.sessionId, child)
      let banner = ''
      child.stdout?.on('data', (chunk: Buffer) => {
        banner = `${banner}${chunk.toString('utf8')}`.slice(-2000)
      })
      child.stderr?.on('data', (chunk: Buffer) => {
        banner = `${banner}${chunk.toString('utf8')}`.slice(-2000)
      })

      // The instance's sessions slice exists now that a scope named it, so its
      // aggregate throttle can be set (POD-2413). Fire and forget, memoized on
      // success: a session must never wait on a best-effort budget call.
      if (scoped) void applySessionsSliceBudget()

      const ready = await (async () => {
        const deadline = Date.now() + READY_TIMEOUT_MS
        while (Date.now() < deadline) {
          if (await health(baseUrl, input.secret)) return true
          await new Promise((resolve) => setTimeout(resolve, READY_POLL_MS))
        }
        return false
      })()
      if (!ready) {
        child.kill('SIGKILL')
        children.delete(input.sessionId)
        throw new Error(
          `opencode serve did not answer /global/health on ${baseUrl} within ${READY_TIMEOUT_MS}ms${banner ? `: ${banner.trim()}` : ''}`,
        )
      }
      if (!scoped) {
        // DECLARED, NOT HIDDEN. Without a systemd user manager the session runs
        // in the daemon's cgroup: it still works, but per-session memory
        // accounting and OOM isolation are gone, and a redeploy's
        // KillMode=control-group reaches it.
        log.warn('opencode session is running unscoped', { sessionId: input.sessionId })
      }
      return endpointFor({
        sessionId: input.sessionId,
        baseUrl,
        secret: input.secret,
        pid: child.pid,
        scopeUnit: scoped ? unit : undefined,
      })
    },

    async adopt(binding) {
      /**
       * A SESSION THAT DID NOT SURVIVE TAKES ITS CLIENT TERMINAL WITH IT.
       *
       * Every refusal below means this binding has no live server on this
       * machine — no journal entry, a different incarnation, or nothing
       * answering. A client terminal for it is pointed at something gone, and it
       * is in its OWN scope, so nothing else on this machine would ever reap it:
       * the durable census only matches labels against session rows and never
       * kills. That is the "resident until the machine rebooted" outcome the
       * success path's `adopt` exists to prevent, arrived at through the door
       * where the client is guaranteed useless. `close()` costs nothing when
       * there is nothing there — it asks `hasMaster` before spending a signal.
       */
      const abandon = async (): Promise<undefined> => {
        await deps.clientTerminals?.relaunch(binding.sessionId, 'opencode')
        return undefined
      }
      const entry = journal.read(binding.sessionId)
      if (!entry) return abandon()
      /**
       * EXACT IDENTITY BEFORE LIVENESS. A journal entry whose process key does
       * not match the binding describes a DIFFERENT incarnation of this session,
       * and adopting it would rebind to a server that may be running someone
       * else's conversation.
       */
      if (entry.process.key !== binding.process.key) return abandon()
      // …and then: is anything still answering, with the secret we stored? A
      // port that has been recycled answers nothing on this credential, which is
      // exactly the discrimination we need.
      if (!(await health(entry.baseUrl, entry.secret))) return abandon()
      // The session survived this daemon, and so may its client terminal: the
      // attachment is in its own scope precisely so a redeploy cannot reach it.
      // Nobody is holding its idle clock any more, so put it back under the
      // reaper — an unadopted one would stay resident until the machine rebooted.
      deps.clientTerminals?.adopt(binding.sessionId)
      return endpointFor({
        sessionId: binding.sessionId,
        baseUrl: entry.baseUrl,
        secret: entry.secret,
        pid: entry.process.pid,
        scopeUnit: entry.process.scopeUnit,
      })
    },

    /**
     * THE CLIENT TERMINAL: `opencode attach <url>` against THIS session's server
     * (POD-2059). The process itself, its scope and its warm window are
     * `opencode-attach.ts`'s; what belongs here is which server and which
     * conversation it must open.
     *
     * THE URL COMES FROM THE DRIVER, THE REST FROM THE JOURNAL. The driver holds
     * the live binding, so its `url` is the authoritative one; the journal is
     * where the conversation id and the credential for it were persisted, and
     * they are written together on every bind so they cannot disagree with it.
     *
     * WHICH MEANS THIS PATH NEVER CONSULTS THE SESSION ROW, and that is a
     * decision rather than an accident of where the fields live (POD-2086
     * measured a server that outlived the row that describes it: scope active,
     * `/global/health` answering 200, the row saying 'exited' — POD-2114). An
     * attach is a request to see A RUNNING SERVER, and the journal plus a live
     * credential is the only evidence on this machine of whether one is running.
     * Refusing because the server's bookkeeping has written the session off
     * would deny the operator the terminal most likely to explain WHY, at
     * exactly the moment they need it.
     *
     * `mode` IS DELIBERATELY NOT FORWARDED. Peek and take-over are the same
     * screen; who may type is the control lease's question, and the driver has
     * already settled it (it refuses a take-over the lease holds) before this is
     * called. Passing a parameter the client host would not read is how a branch
     * nobody wrote comes to look intentional.
     */
    async attachClient(input) {
      const terminals = deps.clientTerminals
      if (!terminals) return undefined
      const entry = journal.read(input.sessionId)
      /**
       * NO CONVERSATION ID, NO ATTACH. `opencode attach` without `--session`
       * opens a DIFFERENT conversation on the same server, which is a terminal
       * the user did not ask for — and a screen showing someone else's chat is
       * worse than a refusal. A bound session always has one; this is the
       * pre-bind window, not a supported degradation.
       */
      if (!entry?.opencodeSessionId) return undefined
      try {
        return await terminals.attach({
          sessionId: input.sessionId,
          target: {
            kind: 'opencode',
            driverId,
            conversation: entry.opencodeSessionId,
            // Loopback TCP with a mandatory per-session secret: the URL and the
            // credential travel together because the transport says they must.
            endpoint: { address: input.url, username: entry.username, secret: entry.secret },
            workdir: entry.workdir,
          },
        })
      } catch (err) {
        // A client that would not start is a machine that cannot host one right
        // now, which is exactly what `undefined` says. The CAUSE only exists
        // here, so it is logged here rather than lost in the refusal's wording.
        log.warn('could not host a client terminal for the session', {
          err,
          sessionId: input.sessionId,
        })
        return undefined
      }
    },
  }
}
