/**
 * TEARING DOWN A SERVER-FAMILY SESSION'S PROCESS (POD-2249).
 *
 * The server's whole teardown vocabulary toward a daemon is two frames — the
 * generic `kill` (hibernate, stop, archive-park, shell-park, stale-park) and
 * `sessionBindingRetire` (row deleted) — and both land in `stopSessionProcess`,
 * which reaps the PTY family's identities: the bridge and the abduco/tmux
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
 *   - It does not touch the drivers' DEATH_PROBES machinery (POD-2114). The
 *     handle verbs set `disposed` before signalling, which is exactly what keeps
 *     a real kill from being mistaken for a false exit; nothing here probes a
 *     driver's health endpoint.
 */

import { spawn } from 'node:child_process'
import { setTimeout as sleepFor } from 'node:timers/promises'
import type { AgentSessionHandle } from '@podium/agent-runtime'
import { createLogger } from '@podium/logger'
import type { SessionId } from '@podium/model'
import { canScopeMaster, scopeReclaimArgvs } from '@podium/pty'
import type { DaemonContext } from '../control/context'

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
      // the paranoid default for anything else) reads as gone.
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
  async runSystemctl(args) {
    await new Promise<void>((resolve) => {
      const child = spawn('systemctl', [...args], { stdio: 'ignore' })
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

/** The journalled process identity for a session no registry holds — what a
 *  queued kill flushed after a daemon restart has to work from. */
function journalledServerProcess(
  ctx: DaemonContext,
  sessionId: SessionId,
): { identity: ServerProcessIdentity; clearJournal: () => void } | undefined {
  for (const runtime of [ctx.opencodeRuntime, ctx.codexRuntime, ctx.grokRuntime]) {
    const entry = runtime?.journal.read(sessionId)
    if (entry) {
      return {
        identity: entry.process,
        clearJournal: () => runtime?.journal.clear(sessionId),
      }
    }
  }
  return undefined
}

/**
 * Reap a server-family session's process, if the server family owns it.
 *
 * SYNCHRONOUS OWNERSHIP, ASYNC REAP — the same shape as `reapDurableHost`'s
 * call site: the caller needs "is this mine?" before it decides whether to also
 * reap a durable host, and the process work is fire-and-forget behind that
 * answer. Returns false untouched for a session the server family never held,
 * so the PTY path stays byte-for-byte what it was.
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
    void reapByIdentity(ctx, sessionId, journalled.identity, opts, io, journalled.clearJournal)
    return true
  }
  return false
}

/** Poll until the pid is gone or the window closes. An unrecorded pid cannot be
 *  measured; `undefined` says so, and the reporter treats it as "the verbs ran
 *  and nothing contradicted them" rather than a measurement. Attempt-counted
 *  rather than wall-clocked, so an injected instant `sleep` bounds a test the
 *  same way the real one bounds production. */
async function pollDead(
  identity: ServerProcessIdentity,
  windowMs: number,
  io: ServerReapIo,
): Promise<boolean | undefined> {
  if (identity.pid === undefined) return undefined
  const attempts = Math.max(1, Math.ceil(windowMs / POLL_GAP_MS))
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (!io.pidAlive(identity.pid)) return true
    if (attempt < attempts - 1) await io.sleep(POLL_GAP_MS)
  }
  return false
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
      // `kill()` re-runs the scope stop and clears the journal, but an UNSCOPED
      // opencode child is out of its reach (the host's child map entry was
      // consumed by the first verb), so the recorded pid gets the SIGKILL
      // directly as well.
      await handle.kill()
      if (identity.pid !== undefined && io.pidAlive(identity.pid)) {
        io.signal(identity.pid, 'SIGKILL')
      }
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

/**
 * Kill a journalled process no handle reaches: signal the recorded pid, stop
 * the recorded scope, measure. This is the post-daemon-restart arm — the kill
 * frame was queued while the daemon was down and flushed on attach, before any
 * adoption ran. The scope stop covers grandchildren the pid signal cannot; the
 * pid signal covers the unscoped platforms the scope stop cannot.
 */
async function reapByIdentity(
  ctx: DaemonContext,
  sessionId: SessionId,
  identity: ServerProcessIdentity,
  opts: { retire: boolean },
  io: ServerReapIo,
  clearJournal: () => void,
): Promise<void> {
  try {
    if (identity.pid !== undefined && io.pidAlive(identity.pid)) {
      io.signal(identity.pid, 'SIGTERM')
    }
    if (identity.scopeUnit && io.canScope()) {
      for (const args of scopeReclaimArgvs(identity.scopeUnit)) await io.runSystemctl(args)
    }
    let dead = await pollDead(identity, TERM_GRACE_MS, io)
    if (dead === false && identity.pid !== undefined) {
      log.warn('the journalled server-driver process survived SIGTERM — escalating', {
        sessionId,
        processKey: identity.key,
      })
      io.signal(identity.pid, 'SIGKILL')
      dead = await pollDead(identity, KILL_GRACE_MS, io)
    }
    // The journal is the adoption path's map to a credentialed endpoint. A
    // retired session must not stay on that map; a parked one keeps its entry
    // (a dead process fails the adopt probe, so a stale entry only costs a
    // refused rebind — the same trade the handle verbs make).
    if (opts.retire) clearJournal()
    sendKillResult(ctx, sessionId, identity.key, dead)
  } catch (err) {
    log.warn('could not reap the journalled server-driver session', { err, sessionId })
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

/** One receipt, measured where measurement exists. `undefined` dead means no
 *  pid was ever recorded — the verbs completed and nothing observable
 *  contradicts them, which is reported as killed with the caveat named rather
 *  than as a confident measurement. */
function sendKillResult(
  ctx: DaemonContext,
  sessionId: SessionId,
  processKey: string,
  dead: boolean | undefined,
): void {
  if (dead === false) {
    log.warn('the server-driver process is STILL running after a kill', {
      sessionId,
      processKey,
    })
  }
  ctx.send({
    type: 'sessionKillResult',
    sessionId,
    durableLabel: processKey,
    killed: dead !== false,
    ...(dead === false ? { reason: 'the server-driver process is still running' } : {}),
  })
}
