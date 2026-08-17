/**
 * TEARING DOWN A SERVER-FAMILY SESSION'S PROCESS (POD-2249).
 *
 * The server's whole teardown vocabulary toward a daemon is two frames — the
 * generic `kill` (hibernate, stop, archive-park, shell-park, stale-park) and
 * `sessionBindingRetire` (row deleted) — and both land in `stopSessionProcess`,
 * which reaped the PTY family's identities: the bridge and the abduco/tmux
 * durable host. A server-driver session has neither. Its process lives behind a
 * handle in `ctx.opencodeRuntime`/`ctx.codexRuntime`/`ctx.grokRuntime`, and
 * before this module nothing on the teardown path ever asked those registries —
 * so `sessions.stop` parked the row while `opencode serve` ran on, and
 * `sessions.kill` deleted the row and left a credentialed child behind
 * (measured live by POD-2245; refiled as this issue).
 *
 * WHAT THIS MODULE OWNS: given one sessionId, decide whether the server family
 * holds it (a live handle, or — after a daemon restart — a binding-journal
 * entry), terminate the actual process, and report a MEASURED
 * `sessionKillResult`, the same honesty contract `reapDurableHost` carries for
 * the PTY family (POD-1953): the server flips the row before the kill is on the
 * wire, so an assumed receipt is a permanent lie the census never repairs.
 *
 * WHAT IT DELIBERATELY DOES NOT DO:
 *
 *   - It never calls `adoptFromJournal` to reach a post-restart orphan. Codex's
 *     `adopt()` STARTS A FRESH APP-SERVER (that is its documented resume-not-
 *     rebind shape), so adopt-then-kill would spawn a process in order to kill
 *     it. The journal already records the exact process identity — pid and
 *     scope unit — and killing by identity needs no handle.
 *   - It never signals a journalled pid on the pid's word alone. The journal
 *     survives parks, crashes and reboots (only `kill()` clears it), so a
 *     journalled pid can belong to an unrelated process by the time a queued
 *     kill arrives. See CORROBORATION below.
 *   - It does not touch the drivers' DEATH_PROBES machinery (POD-2114). The
 *     handle verbs set `disposed` before signalling, which is exactly what keeps
 *     a real kill from being mistaken for a false exit; nothing here weakens the
 *     multi-probe corroboration on the false-exit side.
 *
 * CORROBORATION — the per-driver identity proof, chosen and recorded here:
 *
 *   - opencode: the journalled `baseUrl` + `secret` health probe — the exact-
 *     identity guard the launch path already documents ("Stopping a live server
 *     here would kill a session we were about to adopt") — with cgroup
 *     membership of the journalled scope unit as the fallback for a wedged
 *     server that holds the credential but no longer answers.
 *   - codex, grok: cgroup membership of the journalled scope unit. Their
 *     transports are the child's stdio, so a daemon restart takes every child
 *     with it and there is no credentialed probe to ask; the scope unit is the
 *     one identity that survives into `/proc/<pid>/cgroup`. (`systemd-run
 *     --scope` execs, so the journalled pid IS the agent pid and the sole
 *     scope member — reading the pid's own cgroup file is the same fact as
 *     `systemctl show <unit> -p MainPID`, without the fork.) Unscoped (macOS)
 *     they cannot be corroborated — and cannot have survived either.
 *
 *   RECORDED RESIDUAL: an UNSCOPED session that also fails its probe (an
 *   unscoped opencode whose server wedged) reads as "no survivor". The upgrade
 *   path, should that case ever be observed, is a boot-id + `/proc` start-time
 *   stamp on `ProcessIdentity` at launch — not taken now because it touches
 *   all three hosts' launch paths for a state no platform currently produces.
 *
 *   A pid that fails corroboration is NEVER signalled, and it also does not
 *   count as "alive" in the receipt: an unreadable or foreign `/proc` entry
 *   (the EPERM case) is a recycled pid, not this session's survivor, so
 *   reporting `killed:false` on it would make `reviveParkedButAlive` resurrect
 *   a session whose process died long ago.
 */

import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { setTimeout as sleepFor } from 'node:timers/promises'
import type { AgentSessionHandle } from '@podium/agent-runtime'
import { createLogger } from '@podium/logger'
import type { SessionId } from '@podium/model'
import { canScopeMaster, scopeReclaimArgvs } from '@podium/pty'
import type { DaemonContext } from '../control/context'
import { probeHealth } from './opencode-server'

const log = createLogger('daemon:server-reap')

/** How long a SIGTERM gets to land before escalation, and how long a SIGKILL
 *  gets before the answer is "still running". Bounded like `reapDurableHost`'s
 *  one-retry: teardown must converge on a measured answer, not wait politely
 *  forever — the graceful endings the drivers define (codex's stdin EOF,
 *  systemd's scope stop) have already run inside the handle verb by the time
 *  these polls start. */
const TERM_GRACE_MS = 3000
const KILL_GRACE_MS = 2000
const POLL_GAP_MS = 250

/** The identity this module kills by: what a handle's binding and a journal
 *  entry both carry. */
interface ServerProcessIdentity {
  key: string
  pid?: number | undefined
  scopeUnit?: string | undefined
}

/** Injected effects, so the tests can run without processes or systemd.
 *  Production callers omit it and get the real ones. Every process-table touch
 *  goes through here — a test that reached the real `process.kill` could take
 *  down an unrelated pid. */
export interface ServerReapIo {
  pidAlive(pid: number): boolean
  signal(pid: number, signal: 'SIGTERM' | 'SIGKILL'): void
  /** Is this pid a member of this systemd scope unit's cgroup? The journal
   *  path's identity proof for codex/grok (and opencode's fallback). */
  pidInUnit(pid: number, scopeUnit: string): boolean
  /** The opencode credentialed health probe — exact identity via the secret. */
  probeOpencode(input: { baseUrl: string; secret: string }): Promise<boolean>
  runSystemctl(args: readonly string[]): Promise<void>
  sleep(ms: number): Promise<void>
  canScope(): boolean
}

const defaultIo: ServerReapIo = {
  pidAlive(pid) {
    try {
      process.kill(pid, 0)
      return true
    } catch (err) {
      // EPERM means the pid exists under another uid — alive. Only ESRCH (and
      // the paranoid default for anything else) reads as gone. This is the
      // HANDLE path's measure, where the pid was recorded from our own spawn in
      // this daemon life; the journal path measures by corroboration instead.
      return (err as NodeJS.ErrnoException).code === 'EPERM'
    }
  },
  signal(pid, signal) {
    try {
      process.kill(pid, signal)
    } catch {
      // Gone between the caller's probe and this signal — the state we wanted.
    }
  },
  pidInUnit(pid, scopeUnit) {
    try {
      // `/proc/<pid>/cgroup` names the unit path of every controller the pid
      // sits in; a scope member's line ends in `/<unit>` — matched as exactly
      // that, per `ProcessIdentity.key`'s own warning ("EXACT. A prefix match
      // here is how ghost sessions happen"). Unreadable — ESRCH, ENOENT, or
      // EPERM for a foreign uid — is NOT membership: a pid this daemon cannot
      // even inspect is a recycled pid, never our child.
      return readFileSync(`/proc/${pid}/cgroup`, 'utf8')
        .split('\n')
        .some((line) => line.endsWith(`/${scopeUnit}`))
    } catch {
      return false
    }
  },
  probeOpencode: ({ baseUrl, secret }) => probeHealth(baseUrl, secret),
  async runSystemctl(args) {
    await new Promise<void>((resolve) => {
      // The live env map, per SP-3f93 — scope management runs with the
      // daemon's own env, the same rule POD-2247 records for its exec classes.
      const child = spawn('systemctl', [...args], { stdio: 'ignore', env: process.env })
      const done = (): void => resolve()
      child.once('exit', done)
      child.once('error', done)
      const timer = setTimeout(done, 8000)
      timer.unref?.()
    })
  },
  sleep: (ms) => sleepFor(ms),
  canScope: () => canScopeMaster(),
}

/** The live server-family handle for a session, if any registry holds one.
 *  Deliberately NOT `runtime/handlers.ts`'s four-registry lookup: the terminal
 *  driver's own `stop()` routes back through `stopSessionProcess`, so including
 *  it here would make the reap re-enter itself. */
export function serverRuntimeHandleFor(
  ctx: DaemonContext,
  sessionId: SessionId,
): AgentSessionHandle | undefined {
  return (
    ctx.opencodeRuntime?.handleFor(sessionId) ??
    ctx.codexRuntime?.handleFor(sessionId) ??
    ctx.grokRuntime?.handleFor(sessionId)
  )
}

/** What a queued kill flushed after a daemon restart has to work from: the
 *  journalled process identity, the driver that wrote it (each driver's
 *  corroboration differs — see the module header), and opencode's credentialed
 *  probe material. */
interface JournalledReap {
  driver: 'opencode' | 'codex' | 'grok'
  identity: ServerProcessIdentity
  /** opencode only: the exact-identity liveness probe from its journal. */
  probe?: { baseUrl: string; secret: string }
  clearJournal: () => void
}

function journalledServerProcess(
  ctx: DaemonContext,
  sessionId: SessionId,
): JournalledReap | undefined {
  const opencode = ctx.opencodeRuntime?.journal.read(sessionId)
  if (opencode) {
    return {
      driver: 'opencode',
      identity: opencode.process,
      probe: { baseUrl: opencode.baseUrl, secret: opencode.secret },
      clearJournal: () => ctx.opencodeRuntime?.journal.clear(sessionId),
    }
  }
  const codex = ctx.codexRuntime?.journal.read(sessionId)
  if (codex) {
    return {
      driver: 'codex',
      identity: codex.process,
      clearJournal: () => ctx.codexRuntime?.journal.clear(sessionId),
    }
  }
  const grok = ctx.grokRuntime?.journal.read(sessionId)
  if (grok) {
    return {
      driver: 'grok',
      identity: grok.process,
      clearJournal: () => ctx.grokRuntime?.journal.clear(sessionId),
    }
  }
  return undefined
}

/**
 * Reap a server-family session's process, if the server family owns it.
 *
 * SYNCHRONOUS OWNERSHIP, ASYNC REAP — the same shape as `reapDurableHost`'s
 * call site: the caller learns "is this mine?" and the process work is
 * fire-and-forget behind that answer. Returns false untouched for a session
 * the server family never held.
 *
 * `retire` is `sessionBindingRetire`'s arm — the row is deleted, so the binding
 * journal must go with the process (a deleted session must never leave a
 * credentialed child, and a journal entry is the credential's address). The
 * generic kill keeps the park semantics: SIGTERM first, because codex flushes
 * its rollout JSONL on the way out and that file is what resume works from.
 */
export function beginServerDriverReap(
  ctx: DaemonContext,
  sessionId: SessionId,
  opts: { retire: boolean },
  io: ServerReapIo = defaultIo,
): boolean {
  const handle = serverRuntimeHandleFor(ctx, sessionId)
  if (handle) {
    void reapViaHandle(ctx, sessionId, handle, opts, io)
    return true
  }
  const journalled = journalledServerProcess(ctx, sessionId)
  if (journalled) {
    void reapByIdentity(ctx, sessionId, journalled, opts, io)
    return true
  }
  return false
}

/** Poll until the check says gone or the window closes. Attempt-counted rather
 *  than wall-clocked, so an injected instant `sleep` bounds a test the same way
 *  the real one bounds production. */
async function pollGone(
  stillThere: () => boolean | Promise<boolean>,
  windowMs: number,
  io: ServerReapIo,
): Promise<boolean> {
  const attempts = Math.max(1, Math.ceil(windowMs / POLL_GAP_MS))
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (!(await stillThere())) return true
    if (attempt < attempts - 1) await io.sleep(POLL_GAP_MS)
  }
  return false
}

/** The handle path's measure: the pid, recorded from our own spawn in THIS
 *  daemon life — no recycling window while we hold the child. `undefined` when
 *  no pid was ever recorded: the verbs ran and nothing contradicted them, which
 *  the reporter states as killed-with-caveat rather than as a measurement. */
async function pollDead(
  identity: ServerProcessIdentity,
  windowMs: number,
  io: ServerReapIo,
): Promise<boolean | undefined> {
  if (identity.pid === undefined) return undefined
  const pid = identity.pid
  return pollGone(() => io.pidAlive(pid), windowMs, io)
}

async function reapViaHandle(
  ctx: DaemonContext,
  sessionId: SessionId,
  handle: AgentSessionHandle,
  opts: { retire: boolean },
  io: ServerReapIo,
): Promise<void> {
  const identity: ServerProcessIdentity = handle.binding.process
  try {
    // Retire goes straight to `kill()` — it clears the journal and SIGKILLs.
    // The park path earns the graceful ending first.
    if (opts.retire) await handle.kill()
    else await handle.stop()
    let dead = await pollDead(identity, TERM_GRACE_MS, io)
    if (dead === false) {
      log.warn('the server-driver process survived its stop — escalating', {
        sessionId,
        processKey: identity.key,
      })
      // THE RAW SIGKILL GOES FIRST. It is the escalation's last resort — the
      // path for an unscoped opencode child the driver verbs can no longer
      // reach (the host's child map entry was consumed by the first verb) —
      // and the only reason this branch runs is that the verbs are already
      // misbehaving, so it must not sit behind an await that can throw.
      if (identity.pid !== undefined && io.pidAlive(identity.pid)) {
        io.signal(identity.pid, 'SIGKILL')
      }
      // `kill()` re-runs the scope stop, clears the journal, and closes the
      // client terminal — the parts a raw signal cannot do.
      await handle.kill()
      dead = await pollDead(identity, KILL_GRACE_MS, io)
    }
    sendKillResult(ctx, sessionId, identity.key, dead)
  } catch (err) {
    // A verb that THREW proves nothing about the process; report what the pid
    // says rather than a guess — the same posture as `reapDurableHost`'s catch.
    log.warn('could not reap the server-driver session', { err, sessionId })
    const alive = identity.pid !== undefined && io.pidAlive(identity.pid)
    ctx.send({
      type: 'sessionKillResult',
      sessionId,
      durableLabel: identity.key,
      killed: !alive,
      reason: err instanceof Error ? err.message : String(err),
    })
  }
}

/** Is the journalled process still THIS session's process, and alive? The
 *  per-driver corroboration recorded in the module header, and the ONLY
 *  liveness measure the journal path uses — a bare `pidAlive` here is exactly
 *  the recycled-pid kill the review caught. */
async function corroboratedAlive(reap: JournalledReap, io: ServerReapIo): Promise<boolean> {
  if (reap.probe && (await io.probeOpencode(reap.probe))) return true
  const { pid, scopeUnit } = reap.identity
  if (pid !== undefined && scopeUnit !== undefined && io.pidInUnit(pid, scopeUnit)) return true
  return false
}

/**
 * Kill a journalled process no handle reaches — the post-daemon-restart arm:
 * the kill frame was queued while the daemon was down and flushed on attach,
 * before any adoption ran.
 *
 * The pid is signalled ONLY when corroboration proves it is still this
 * session's process. The scope stop needs no such gate — the unit name carries
 * the session id, so `systemctl stop` cannot hit a bystander — and it covers
 * grandchildren the pid signal cannot, so it runs in both arms: an
 * uncorroborated pid with a lingering scope still gets its cgroup cleared.
 */
async function reapByIdentity(
  ctx: DaemonContext,
  sessionId: SessionId,
  reap: JournalledReap,
  opts: { retire: boolean },
  io: ServerReapIo,
): Promise<void> {
  const identity = reap.identity
  const reclaimScope = async (): Promise<void> => {
    if (!identity.scopeUnit || !io.canScope()) return
    for (const args of scopeReclaimArgvs(identity.scopeUnit)) await io.runSystemctl(args)
  }
  try {
    const ours = await corroboratedAlive(reap, io)
    let dead = true
    if (ours) {
      if (identity.pid !== undefined) io.signal(identity.pid, 'SIGTERM')
      await reclaimScope()
      dead = await pollGone(() => corroboratedAlive(reap, io), TERM_GRACE_MS, io)
      if (!dead) {
        log.warn('the journalled server-driver process survived SIGTERM — escalating', {
          sessionId,
          driver: reap.driver,
          processKey: identity.key,
        })
        if (identity.pid !== undefined) io.signal(identity.pid, 'SIGKILL')
        dead = await pollGone(() => corroboratedAlive(reap, io), KILL_GRACE_MS, io)
      }
    }
    let ambiguity: string | undefined
    if (!ours) {
      // Nothing corroborates a survivor: the process is gone, or the pid now
      // belongs to someone else (a reboot, a recycle, another uid). Either way
      // this session has no PROVEN live process — which is also why this arm
      // reports killed rather than inverting into the permanent `killed:false`
      // that would make `reviveParkedButAlive` resurrect a long-dead session.
      await reclaimScope()
      // THE AMBIGUOUS CORNER, SAID OUT LOUD (review residual). A pid that is
      // PRESENT but uncorroborable is genuinely unknown — for an unscoped
      // wedged opencode (the one driver whose child outlives the daemon) it
      // may be this session's credentialed server running on. The receipt
      // still says killed, but the ambiguity is logged and named on it rather
      // than collapsing into silent confidence.
      if (identity.pid !== undefined && io.pidAlive(identity.pid)) {
        ambiguity =
          'an uncorroborable process holds the journalled pid — possibly a wedged unscoped survivor'
        log.warn('a journalled server-driver pid is occupied but uncorroborable', {
          sessionId,
          driver: reap.driver,
          processKey: identity.key,
          pid: identity.pid,
        })
      }
    }
    // The journal is the adoption path's map to a credentialed endpoint. A
    // retired session must not stay on that map; a parked one keeps its entry
    // (a dead process fails the adopt probe, so a stale entry only costs a
    // refused rebind — the same trade the handle verbs make).
    if (opts.retire) reap.clearJournal()
    sendKillResult(ctx, sessionId, identity.key, dead, ambiguity)
  } catch (err) {
    log.warn('could not reap the journalled server-driver session', { err, sessionId })
    const alive = await corroboratedAlive(reap, io).catch(() => false)
    if (!alive && identity.pid !== undefined && io.pidAlive(identity.pid)) {
      log.warn('a journalled server-driver pid is occupied but uncorroborable', {
        sessionId,
        driver: reap.driver,
        processKey: identity.key,
        pid: identity.pid,
      })
    }
    ctx.send({
      type: 'sessionKillResult',
      sessionId,
      durableLabel: identity.key,
      killed: !alive,
      reason: err instanceof Error ? err.message : String(err),
    })
  }
}

/** One receipt, measured where measurement exists. `undefined` dead means no
 *  pid was ever recorded — the verbs completed and nothing observable
 *  contradicts them, which is reported as killed with the caveat named rather
 *  than as a confident measurement. */
function sendKillResult(
  ctx: DaemonContext,
  sessionId: SessionId,
  processKey: string,
  dead: boolean | undefined,
  /** A caveat worth carrying on a KILLED receipt — the uncorroborable-pid
   *  ambiguity. The server acts only on `killed`, so this is for the operator
   *  reading the receipt, not for the row machinery. */
  note?: string,
): void {
  if (dead === false) {
    log.warn('the server-driver process is STILL running after a kill', {
      sessionId,
      processKey,
    })
  }
  const reason = dead === false ? 'the server-driver process is still running' : note
  ctx.send({
    type: 'sessionKillResult',
    sessionId,
    durableLabel: processKey,
    killed: dead !== false,
    ...(reason ? { reason } : {}),
  })
}
