import {
  gateHarnessVersion,
  harnessVersionDiagnostic,
  OPENCODE_VERSION_POLICY,
} from '@podium/harness'
/**
 * `opencode serve`, ONE PER SESSION, UNDER A PODIUM-HOST (`--no-pty`) OWNED BY
 * THE DAEMON'S DURABLE PROCESS (POD-1761 W5; plan §1; POD-4433).
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE OWNS, AND WHY IT IS THE ONLY PART IN THE DAEMON
 * ---------------------------------------------------------------------------
 *
 * The driver itself — client, SSE, receipts, interactions, events — is in
 * `@podium/agent-runtime`, testable in-process. What could not go there is
 * everything below: composing the engine's argv and env, spawning it headless
 * under podium-host, and writing the journal that lets `adopt()` find it again
 * after the daemon dies. This is the `OpencodeRuntimeHost` implementation, and
 * it is deliberately nothing but that.
 *
 * THE DAEMON NEVER FORKS HERE. Every process act — spawn, re-attach, kill —
 * goes through the injected `DurableProcess`, whose host adapter owns the
 * child. That is what makes a daemon restart leave the server running: the
 * child is the HOST's, not the daemon's, so the driver's `adopt()` rebinds to
 * the survivor instead of starting over. `grep child_process` in this file
 * must stay empty; process mechanics live in `@podium/process`.
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
 * `podium-host create` reclaims a stale scope squatting the label's unit name
 * itself, guarded on no live host — the liveness guard that fits a host-owned
 * child. The guard that stays HERE is the one that fits the SERVER: health-probe
 * the journalled port with the journalled secret. A unit whose server answers
 * is adopted, never reclaimed; only a server that does not answer is replaced.
 *
 * Without that distinction, the documented failure is specific and nasty: the
 * unit name is deterministic, `systemd-run` refuses "unit already exists", the
 * child SILENTLY falls back into the daemon's own cgroup, and the next redeploy's
 * `KillMode=control-group` takes the agent down with the daemon.
 */

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
  OPENCODE_VERSION_PROBE_TIMEOUT_MS,
  type OpencodeVersionDiagnostic,
} from '@podium/agent-runtime'
import { AGENT_MANIFESTS } from '@podium/harness'
import { createLogger } from '@podium/logger'
import type { SessionId } from '@podium/model'
import { asSessionId } from '@podium/model'
import {
  scopeUnitName,
  type DurableAdapter,
  type DurableProcess,
  type HostAgentSession,
} from '@podium/process/durable'
import { stateDir } from '@podium/runtime/config'
import { serverChildEnv } from '../control/session-env'
import { stageRuntimeAttachment } from './attachment-staging'
import type { OpencodeClientTerminals } from './opencode-attach'
import { SERVER_GRACEFUL_EXIT_MS } from './server-teardown-budget'
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

const basicAuth = (secret: string, username = USERNAME): string =>
  `Basic ${Buffer.from(`${username}:${secret}`).toString('base64')}`

/** One bounded health probe. `false` covers dead, not-yet-listening AND wrong
 *  secret — all three mean "not usable", which is the only question here.
 *  EXPORTED for the teardown reap (POD-2249): the journalled secret is the
 *  exact-identity proof that a journalled pid is still THIS session's server —
 *  the same guard the launch path documents below ("Stopping a live server
 *  here would kill a session we were about to adopt"). */
export async function probeHealth(
  baseUrl: string,
  secret: string,
  username = USERNAME,
  healthPath = '/global/health',
): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl}${healthPath}`, {
      headers: { authorization: basicAuth(secret, username) },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
    return response.ok
  } catch {
    return false
  }
}
async function waitForReady(
  health: (baseUrl: string, secret: string) => Promise<boolean>,
  baseUrl: string,
  secret: string,
  deadlineMs: number,
): Promise<boolean> {
  const deadline = Date.now() + deadlineMs
  while (Date.now() < deadline) {
    if (await health(baseUrl, secret)) return true
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
/** Only a version below the policy floor prevents full-driver admission. */
export type OpencodeProbeVerdict =
  | { drivable: true; reason?: 'unprobeable'; diagnostic?: OpencodeVersionDiagnostic }
  | {
      drivable: false
      reason: 'unsupported' | 'unprobeable'
      diagnostic: OpencodeVersionDiagnostic
    }

const versionProbeCache = createVersionProbeCache<OpencodeProbeVerdict>({
  evaluate: ({ output, ok }) => {
    // Failed probes cannot establish a floor violation, even if stderr contains a version.
    const observed = ok ? output : ''
    const status = gateHarnessVersion(OPENCODE_VERSION_POLICY, observed)
    const diagnostic = harnessVersionDiagnostic('opencode', OPENCODE_VERSION_POLICY, observed)
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

const opencode2VersionProbeCache = createVersionProbeCache<OpencodeProbeVerdict>({
  evaluate: ({ output, ok }) => {
    const match = /0\.0\.0-beta-(\d+)/u.exec(output)
    if (ok && match && [18743, 18866].includes(Number(match[1]))) return { drivable: true }
    const diagnostic: OpencodeVersionDiagnostic = {
      code: 'opencode-version-unsupported',
      title: 'opencode server driver needs review',
      body: ok
        ? `opencode2 ${output.trim()} is outside the preview builds exercised by this driver (beta-18743 and beta-18866).`
        : `opencode2 --version did not answer within ${VERSION_PROBE_TIMEOUT_MS}ms: ${
            output || '(no output)'
          }`,
      observedVersion: output.trim() || '(probe failed)',
    }
    return {
      drivable: false,
      reason: ok ? 'unsupported' : 'unprobeable',
      diagnostic,
    }
  },
})

export function opencode2VersionProbe(
  probe: VersionProbe = () => execVersionProbe('opencode2', VERSION_PROBE_TIMEOUT_MS),
  policy?: VersionProbePolicy,
): Promise<OpencodeProbeVerdict> {
  return opencode2VersionProbeCache.probe(probe, policy)
}
export function opencode2VersionProbeForExecutable(
  executablePath: string,
  policy?: VersionProbePolicy,
): Promise<OpencodeProbeVerdict> {
  return opencode2VersionProbe(
    () => execVersionProbe(executablePath, VERSION_PROBE_TIMEOUT_MS),
    policy,
  )
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
export function resetOpencode2VersionProbe(): void {
  opencode2VersionProbeCache.reset()
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
  /**
   * THE DURABLE OWNER OF EVERY ENGINE (POD-4433). Spawn, re-attach and kill go
   * through it; this file composes argv/env and journals, never forks. Absent
   * (tests that never launch) = launch/adopt/stop/kill refuse loudly rather
   * than forking a child no restart could re-adopt.
   */
  durable?: DurableProcess
  /** Hermetic effect seams for proving the launch boundary without a child. */
  versionProbe?: VersionProbe
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
    /** Environment shared by the server and its native client. */
    env?: Readonly<Record<string, string>>
    versionDiagnostic(probe?: VersionProbe): Promise<OpencodeVersionDiagnostic | null>
  }
}

/** The writer lease held by a daemon that did not die. A new generation must
 *  refuse loudly — log line naming the session — not read along silently. */
export class OpencodeEngineLeaseRefused extends Error {
  override readonly name = 'OpencodeEngineLeaseRefused'

  constructor(sessionId: SessionId, label: string) {
    super(
      `opencode engine for ${sessionId} is still driven: another daemon holds the writer lease on '${label}'`,
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
      `opencode engine for ${sessionId} requires the podium-host backend: this daemon runs ${
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

/** The label a session's scope unit is named from. Same shape as the PTY side's
 *  so an operator reading `systemctl --user list-units` sees one convention.
 *  It contains the session id, which is also what charges the host-held engine
 *  to the session in `/proc` attribution. */
export const opencodeScopeLabel = (sessionId: SessionId): string => `podium-oc-${sessionId}`

export function opencodeServeArgv(executablePath: string, port: number): string[] {
  return [executablePath, 'serve', '--port', String(port), '--hostname', '127.0.0.1']
}

export function createOpencodeHost(deps: OpencodeHostDeps): OpencodeRuntimeHost {
  const variant = deps.variant
  const journal = deps.journal ?? createOpencodeJournal(variant?.journalNamespace)
  const driverId = variant?.driverId ?? 'opencode-server'
  const username = variant?.username ?? USERNAME
  const healthPath = variant?.healthPath ?? '/global/health'
  const scopeLabel = (sessionId: SessionId): string =>
    `podium-${variant?.scopeToken ?? 'oc'}-${sessionId}`
  const health = (baseUrl: string, secret: string): Promise<boolean> =>
    probeHealth(baseUrl, secret, username, healthPath)
  /** Every engine this daemon generation currently holds a host attachment for.
   *  A daemon restart empties this map without touching the engines — the next
   *  generation re-attaches by label through `attachEngine`. */
  const engines = new Map<SessionId, HeldEngine>()

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
        log.warn('opencode engine exited on its own', { sessionId, code, signal })
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
      log.warn('could not re-attach to the opencode engine host', { err, sessionId, label })
      return undefined
    }
    const held = tapEngine(sessionId, session)
    let welcome
    try {
      welcome = await session.ready
    } catch (err) {
      log.warn('opencode engine host never welcomed its re-attach', { err, sessionId, label })
      session.dispose()
      engines.delete(sessionId)
      return undefined
    }
    held.childPid = welcome.childPid
    if (!welcome.lease) {
      session.dispose()
      engines.delete(sessionId)
      log.error('refusing an opencode engine whose writer lease is held elsewhere', {
        sessionId,
        label,
      })
      throw new OpencodeEngineLeaseRefused(sessionId, label)
    }
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
      const off = held.session.connection.onExit(() => {
        clearTimeout(timer)
        resolve(true)
      })
    })

  const adapterFor = (sessionId: SessionId): DurableAdapter =>
    engineAdapter(deps.durable, sessionId)

  const endpointFor = (input: {
    sessionId: SessionId
    baseUrl: string
    secret: string
    pid: number | undefined
    scopeUnit: string | undefined
    held: HeldEngine | undefined
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
      const held = input.held ?? engines.get(input.sessionId)
      engines.delete(input.sessionId)
      // SIGTERM is the graceful stop. There is no stdin-EOF equivalent under
      // the host — the host owns the child's stdin — so the signal carries the
      // grace the old EOF attempt used to spend, bounded by the shared budget.
      if (held) {
        try {
          held.session.connection.signal(15)
        } catch {
          // Already gone; the sweep below is still owed its scope.
        }
        await engineExited(held, SERVER_GRACEFUL_EXIT_MS)
        held.session.dispose()
      }
      // AND THE CLIENT TERMINAL. Attachment lifecycle is strictly subordinate to
      // the session (spec §5): a client left alive against a server that just died
      // shows a frozen screen and holds its memory for the warm TTL, for a session
      // nobody can reach any more.
      await deps.clientTerminals?.close(input.sessionId, 'opencode')
      // AND THE SCOPE. On an exited engine this only sweeps the lingering host
      // and the squatted unit name; on a wedged one the host escalates past
      // SIGTERM on its own.
      await adapterFor(input.sessionId).kill(scopeLabel(input.sessionId))
    },
    kill: async () => {
      const held = input.held ?? engines.get(input.sessionId)
      engines.delete(input.sessionId)
      held?.session.dispose()
      await deps.clientTerminals?.close(input.sessionId, 'opencode')
      await adapterFor(input.sessionId).kill(scopeLabel(input.sessionId))
      journal.clear(input.sessionId)
    },
    resources: () =>
      deps.resources({
        sessionId: input.sessionId,
        label: scopeLabel(input.sessionId),
        ...(input.pid !== undefined ? { pid: input.pid } : {}),
        ...(input.scopeUnit ? { scopeUnit: input.scopeUnit } : {}),
      }),
    /** The host's EXITED frame, when the engine has reported its own exit. */
    engineExit: () => input.held?.exit ?? engines.get(input.sessionId)?.exit,
  })

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
      const adapter = adapterFor(input.sessionId)

      /**
       * A journalled server that still answers IS this session's engine.
       *
       * Before the host owned the child this guard only skipped the scope
       * reclaim; the launch then started a SECOND server and orphaned the
       * first. Now the live server is adopted in place — same port, same
       * secret, same conversation — and no second engine ever exists under one
       * label. The health probe with the journalled secret is still the exact-
       * identity proof: a recycled port answers nothing on this credential.
       */
      const previous = journal.read(input.sessionId)
      if (previous && (await health(previous.baseUrl, previous.secret))) {
        // A lease held elsewhere throws out of here: spawning a second server
        // beside one another daemon drives would be a split brain, so the
        // refusal propagates instead of falling through to a fresh spawn.
        const held = await attachEngine(adapter, input.sessionId, label)
        if (held) {
          return endpointFor({
            sessionId: input.sessionId,
            baseUrl: previous.baseUrl,
            secret: previous.secret,
            pid: held.childPid ?? previous.process.pid,
            scopeUnit: engineScopeUnit(label),
            held,
          })
        }
        // The server answers but no host holds it — a host crash orphaned it.
        // Drivable is drivable: adopt without exit reporting (said out loud)
        // rather than leak a live server beside a fresh one.
        log.warn('adopting an opencode server its host no longer holds', {
          sessionId: input.sessionId,
          baseUrl: previous.baseUrl,
        })
        return endpointFor({
          sessionId: input.sessionId,
          baseUrl: previous.baseUrl,
          secret: previous.secret,
          pid: previous.process.pid,
          scopeUnit: previous.process.scopeUnit,
          held: undefined,
        })
      }

      // LOOPBACK, NOT A SETTING. The host is fixed and not configurable.
      const serveArgv = opencodeServeArgv(executablePath, port)

      const env: NodeJS.ProcessEnv = serverChildEnv({
        instanceUuid: deps.instanceUuid,
        sessionId: input.sessionId,
        agentKind: 'opencode',
        ...(deps.homeDir ? { homeDir: deps.homeDir } : {}),
        ...(input.env ? { sessionEnv: input.env } : {}),
      })
      Object.assign(env, variant?.env)
      env.OPENCODE_SERVER_USERNAME = username
      // RULE 2: the secret is HERE. It appears in `serveArgv` nowhere, and this
      // is the assertion `opencode-server.test.ts` pins.
      env.OPENCODE_SERVER_PASSWORD = input.secret
      // opencode only publishes `question.asked` when its question tool is on,
      // and a driver that maps question interactions but never receives one is
      // a feature that exists only in the type system.
      env.OPENCODE_ENABLE_QUESTION_TOOL = env.OPENCODE_ENABLE_QUESTION_TOOL ?? '1'

      /**
       * THE ENGINE, UNDER THE HOST. `spawnHeadless` puts `opencode serve` under
       * podium-host `--no-pty` in the session's transient scope: pipes, not a
       * pty, and the host — not this daemon — holds the child's stdin. Provider
       * keys are stripped by the host AFTER the env merge, the same removal the
       * old `delete` loop did, so the session uses exactly the credential
       * `opencode auth login` stored.
       */
      const [command, ...args] = serveArgv
      let held: HeldEngine
      try {
        held = tapEngine(
          input.sessionId,
          await adapter.spawnHeadless({
            label,
            cmd: command ?? executablePath,
            args,
            cwd: input.workdir,
            env: stringEnv(env),
            stripEnv: STRIPPED_PROVIDER_KEYS,
          }),
        )
        held.childPid = (await held.session.ready).childPid
      } catch (err) {
        engines.delete(input.sessionId)
        throw err
      }

      const ready = await waitForReady(health, baseUrl, input.secret, READY_TIMEOUT_MS)
      if (!ready) {
        const banner = held.banner.trim()
        engines.delete(input.sessionId)
        held.session.dispose()
        await adapter.kill(label)
        throw new Error(
          `opencode serve did not answer ${healthPath} on ${baseUrl} within ${READY_TIMEOUT_MS}ms${
            banner ? `: ${banner}` : ''
          }`,
        )
      }
      if (process.platform !== 'linux') {
        // DECLARED, NOT HIDDEN. Without a systemd user manager the session runs
        // in the daemon's cgroup: it still works, but per-session memory
        // accounting and OOM isolation are gone, and a redeploy's
        // KillMode=control-group reaches it.
        log.warn('opencode session is running unscoped', {
          sessionId: input.sessionId,
        })
      }
      return endpointFor({
        sessionId: input.sessionId,
        baseUrl,
        secret: input.secret,
        pid: held.childPid,
        scopeUnit: engineScopeUnit(label),
        held,
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
      // The server survived — and because it runs under the host, the host did
      // too. Re-attach to it as the writer: the attachment carries the exit
      // reporting and the writer lease proves no stale daemon still drives it.
      // A lease held elsewhere throws out of here rather than abandoning: the
      // driver must hear the refusal loudly, not resume a server it cannot own.
      const label = scopeLabel(binding.sessionId)
      const held = await attachEngine(adapterFor(binding.sessionId), binding.sessionId, label)
      if (!held) {
        // The server answers but no host holds it — a host crash orphaned it.
        // Drivable is drivable: adopt without exit reporting (said out loud)
        // rather than strand a live conversation.
        log.warn('adopting an opencode server its host no longer holds', {
          sessionId: binding.sessionId,
          baseUrl: entry.baseUrl,
        })
      }
      // The session survived this daemon, and so may its client terminal: the
      // attachment is in its own scope precisely so a redeploy cannot reach it.
      // Nobody is holding its idle clock any more, so put it back under the
      // reaper — an unadopted one would stay resident until the machine rebooted.
      deps.clientTerminals?.adopt(binding.sessionId)
      return endpointFor({
        sessionId: binding.sessionId,
        baseUrl: entry.baseUrl,
        secret: entry.secret,
        pid: held?.childPid ?? entry.process.pid,
        scopeUnit: held ? engineScopeUnit(label) : entry.process.scopeUnit,
        held,
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
            ...(variant?.env ? { env: variant.env } : {}),
            conversation: entry.opencodeSessionId,
            // Loopback TCP with a mandatory per-session secret: the URL and the
            // credential travel together because the transport says they must.
            endpoint: {
              address: input.url,
              username: entry.username,
              secret: entry.secret,
            },
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
