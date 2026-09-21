/**
 * Supervisor-owned process host for the Grok ACP driver.
 *
 * (Moved from apps/daemon/src/runtime/grok-acp-server.ts in 1.5: the daemon
 * stops knowing this headless harness. The family is handed the engine
 * address through injected supervision ports and never spawns, journals or
 * kills the engine itself; argv/env compose here off the adapter's sections,
 * read through {@link GrokEngineFacts}.)
 *
 * THE ENGINE RUNS UNDER PODIUM-HOST (`--no-pty`), OWNED BY THE SUPERVISOR'S
 * DURABLE PROCESS (POD-4433). The host's pipe mode carries the ACP stdio: the
 * merged ring IS the child's stdout, stdin arrives via WRITE, and a supervisor
 * restart re-attaches to the same pipes instead of replacing the child. The
 * driver then `session/load`s the native session named by the binding journal
 * over a FRESH stdio channel to the SURVIVING engine — durable, not faked.
 * `grep child_process` in this file must stay empty; process mechanics live
 * behind the supervision port.
 */
import {
  closeSync,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
} from 'node:fs'
import { createLogger } from '@podium/logger'
import type { HarnessAgent, SessionId } from '@podium/model'
import { asSessionId } from '@podium/model'
import { grokSessionPaths } from '../../../agent-state/grok.js'
import {
  GROK_ACP_VERSION_POLICY,
  gateHarnessVersion,
  harnessVersionDiagnostic,
} from '../../../version-policy.js'
import type { ScopeResources } from '../../capabilities.js'
import type {
  GrokAcpEndpoint,
  GrokAcpJournal,
  GrokAcpRuntimeHost,
} from './runtime.js'
import type { GrokAcpTransport } from './client.js'
import type { GrokVersionDiagnostic } from './version.js'
import type { GrokEngineFacts } from './engine-facts.js'
import type { EngineAttachment, EngineSupervisor } from '../engine-supervision.js'

const log = createLogger('harness:grok-acp-engine-host')

/** Only a version below the policy floor prevents full-driver admission. */
export type GrokAcpProbeVerdict =
  | { drivable: true; reason?: 'unprobeable'; diagnostic?: GrokVersionDiagnostic }
  | { drivable: false; reason: 'unsupported'; diagnostic: GrokVersionDiagnostic }

/**
 * THE PURE ADMISSION EVALUATION. The supervisor owns the probe budget, the
 * memo and the fork; this family owns what the output MEANS. Failed probes
 * cannot establish a floor violation, even if stderr contains a version.
 */
export function evaluateGrokAcpVersionProbe(output: string, ok: boolean): GrokAcpProbeVerdict {
  const observed = ok ? output : ''
  const status = gateHarnessVersion(GROK_ACP_VERSION_POLICY, observed)
  const diagnostic = harnessVersionDiagnostic('grok', GROK_ACP_VERSION_POLICY, observed)
  if (status === 'too-old' && diagnostic) {
    return { drivable: false, reason: 'unsupported', diagnostic }
  }
  return {
    drivable: true,
    ...(status === 'unparseable' ? { reason: 'unprobeable' as const } : {}),
    ...(diagnostic ? { diagnostic } : {}),
  }
}

/**
 * What the grok engine host needs from whoever owns processes and disks.
 * Facts arrive as values (adapter sections, read by the family);
 * supervision arrives as ports the supervisor implements.
 */
export interface GrokEngineHostDeps {
  facts: GrokEngineFacts
  /** The durable owner of every engine: spawn, re-attach and kill go through
   *  it; this family composes argv/env and binds protocol, never forks.
   *  Absent (tests that never launch) = launch/stop/kill refuse loudly rather
   *  than forking a child no restart could re-adopt. */
  supervision?: EngineSupervisor
  /** The binding journal, persisted by the supervisor (0600, sync). */
  journal: GrokAcpJournal
  /** Resource truth for a session's scope — memory, tasks and the kernel's own
   *  OOM-kill counter, from the supervisor's one cgroup observer. */
  resources(input: {
    sessionId: SessionId
    label: string
    pid?: number
    scopeUnit?: string
  }): ScopeResources | undefined
  /** Start Grok's original TUI against the native session for `attach()`. */
  attachClient?(input: {
    sessionId: SessionId
    grokSessionId: string
    workdir: string
    mode: 'takeover' | 'peek'
  }): Promise<{ streamId: string; warmTtlMs: number } | undefined>
  /**
   * The instance agent home (`ctx.homeDir`), overriding the child's `HOME` the
   * same way the PTY path does (POD-2247). Absent = default instance, daemon
   * env unchanged. Without it a named instance's `grok agent stdio` reads and
   * writes the operator's REAL `~/.grok` credentials and session stores — the
   * live find that filed this issue.
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
    instanceUuid?: string
  }): Record<string, string>
  /** How long a SIGTERM stop waits for the child to take its stdin EOF. Shared
   *  with the reap that has to outlast it — arrives as a value rather than
   *  living here twice. */
  gracefulExitMs: number
  /** Version admission: only the floor can refuse a launch. The supervisor
   *  owns the probe budget, the memo and the fork; this family owns the
   *  evaluation (see `evaluateGrokAcpVersionProbe`). */
  checkVersion(): Promise<GrokAcpProbeVerdict>
}

/**
 * Stable process identity for the logical Grok session.
 *
 * Adoption derives this from the Podium session id instead of trusting the
 * binding journal. That gives the journal's recorded process key an
 * independent identity to match before a fresh stdio channel is allowed to
 * load the native session it names. It contains the session id, which is also
 * what charges the host-held engine to the session in `/proc` attribution.
 */
export const grokAcpProcessKey = (facts: GrokEngineFacts, sessionId: SessionId): string =>
  `podium-${facts.scopeToken}-${String(sessionId)
    .replace(/[^a-zA-Z0-9_.-]/g, '-')
    .slice(-48)}`

/** The writer lease held by a daemon that did not die. A new generation must
 *  refuse loudly — log line naming the session — not read along silently. */
export class GrokEngineLeaseRefused extends Error {
  override readonly name = 'GrokEngineLeaseRefused'

  constructor(sessionId: SessionId, label: string) {
    super(
      `grok engine for ${sessionId} is still driven: another daemon holds the writer lease on '${label}'`,
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
function engineAdapter(supervision: EngineSupervisor | undefined, sessionId: SessionId): EngineSupervisor {
  if (!supervision) {
    throw new Error(
      `grok engine for ${sessionId} requires the podium-host backend: this supervisor runs with no durable backend`,
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

export function createGrokEngineHost(deps: GrokEngineHostDeps): GrokAcpRuntimeHost {
  /** Every engine this daemon generation currently holds a host attachment for.
   *  A daemon restart empties this map without touching the engines — the next
   *  generation re-attaches by label through `launch` itself, which adopts a
   *  live host instead of spawning beside it. */
  const engines = new Map<SessionId, HeldEngine>()

  const adapterFor = (sessionId: SessionId): EngineSupervisor =>
    engineAdapter(deps.supervision, sessionId)

  /**
   * Tap a host attachment: the merged stdout/stderr ring feeds the launch
   * banner, and the host's EXITED frame records the real status. A previous
   * attachment for the session is released first — one holder per engine, so a
   * re-attach never strands a lease. `engines.delete` before signalling is
   * what keeps an EXPECTED ending (stop/kill) from logging as a crash.
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
        log.warn('Grok ACP engine exited on its own', { sessionId, code, signal })
      }
    })
    return held
  }

  /**
   * Take ownership of a host attachment: confirm the writer lease, then tap.
   * A lease held elsewhere is a stale daemon still driving this engine — loud
   * refusal, never silent read-along. A welcome that never arrives degrades to
   * `undefined` for adopt paths; launch turns it into a throw.
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
      log.warn('grok engine host never welcomed its attach', { err, sessionId, label })
      session.dispose()
      engines.delete(sessionId)
      return undefined
    }
    if (!welcome.lease) {
      session.dispose()
      engines.delete(sessionId)
      log.error('refusing a grok engine whose writer lease is held elsewhere', {
        sessionId,
        label,
      })
      throw new GrokEngineLeaseRefused(sessionId, label)
    }
    const held = tapEngine(sessionId, session)
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
      const off = held.session.connection.onExit(() => {
        clearTimeout(timer)
        resolve(true)
      })
    })

  /**
   * End ONE engine — the one this endpoint owns — and sweep its scope. There
   * is no stdin-EOF graceful stop any more: the host owns the child's stdin,
   * so SIGTERM carries the grace, bounded by the shared budget.
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
    await adapterFor(sessionId).kill(grokAcpProcessKey(deps.facts, sessionId))
  }

  return {
    journal: deps.journal,
    now: deps.now ?? (() => Date.now()),
    mintSessionId: () => asSessionId(crypto.randomUUID()),
    onRawFrame:
      process.env.PODIUM_GROK_ACP_TRACE === '1'
        ? (sessionId, frame) => {
            log.info('Grok ACP inbound frame', { sessionId, frame })
          }
        : undefined,

    async launch(input) {
      const verdict = await deps.checkVersion()
      if (!verdict.drivable) {
        throw new Error(`${verdict.diagnostic.title}: ${verdict.diagnostic.body}`)
      }

      const label = grokAcpProcessKey(deps.facts, input.sessionId)
      const adapter = adapterFor(input.sessionId)
      // The ACP server receives cwd in session/new and session/load. A native
      // --worktree would create a second nested worktree; no SessionSpec sandbox
      // field exists, so GROK_SANDBOX/config remains authoritative.
      const argv = [deps.facts.command, ...deps.facts.serverArgs]
      const [command, ...args] = argv
      const env = deps.buildEnv({
        ...(deps.instanceUuid ? { instanceUuid: deps.instanceUuid } : {}),
        sessionId: input.sessionId,
        agentKind: deps.facts.harnessKind,
        ...(deps.homeDir ? { homeDir: deps.homeDir } : {}),
        ...(input.env ? { sessionEnv: input.env } : {}),
      })

      /**
       * THE ENGINE, UNDER THE HOST — ADOPTED WHEN IT IS ALREADY THERE.
       * `spawnHeadless` puts `grok agent stdio` under podium-host `--no-pty`
       * in the session's transient scope, and adopts the live host when this
       * label already owns one — which is exactly the daemon-restart case, so
       * the driver's adopt (which loads the journalled native session over the
       * fresh transport below) rebinds to the survivor instead of replacing it.
       * An inherited API key is stripped by the host after the merge: it would
       * silently replace the user's subscription either way.
       */
      let held: HeldEngine | undefined
      try {
        held = await claimEngine(
          input.sessionId,
          label,
          await adapter.spawnHeadless({
            label,
            cmd: command ?? deps.facts.command,
            args,
            cwd: input.workdir,
            env,
            stripEnv: deps.facts.stripEnv,
          }),
        )
      } catch (err) {
        engines.delete(input.sessionId)
        throw err
      }
      if (!held) {
        engines.delete(input.sessionId)
        throw new Error(`grok engine host for ${input.sessionId} never welcomed its spawn`)
      }
      if (process.platform !== 'linux') {
        log.warn('Grok ACP session is running unscoped', { sessionId: input.sessionId })
      }

      const scopeUnit = adapter.scopeUnitFor(label)
      const endpoint: GrokAcpEndpoint = {
        transport: hostTransport(input.sessionId, held),
        process: {
          key: label,
          ...(held.childPid !== undefined ? { pid: held.childPid } : {}),
          ...(scopeUnit ? { scopeUnit } : {}),
        },
        stop: () => terminate(input.sessionId, 'SIGTERM', held),
        kill: async () => {
          await terminate(input.sessionId, 'SIGKILL', held)
          deps.journal.clear(input.sessionId)
        },
        resources: () =>
          deps.resources({
            sessionId: input.sessionId,
            label,
            ...(held.childPid !== undefined ? { pid: held.childPid } : {}),
            ...(scopeUnit ? { scopeUnit } : {}),
          }),
        alive: () => held.exit === undefined,
        /** The host's EXITED frame, when the engine has reported its own exit. */
        engineExit: () => held.exit ?? engines.get(input.sessionId)?.exit,
      }
      return endpoint
    },

    async readNativeUpdates(input) {
      const path = grokSessionPaths({
        cwd: input.workdir,
        sessionId: input.grokSessionId,
        homeDir: deps.homeDir,
      }).updatesPath
      let descriptor: number | undefined
      try {
        descriptor = openSync(path, 'r')
        const size = fstatSync(descriptor).size
        const offset = size < input.offset ? 0 : input.offset
        const bytes = Buffer.allocUnsafe(Math.max(0, size - offset))
        let read = 0
        while (read < bytes.length) {
          const count = readSync(descriptor, bytes, read, bytes.length - read, offset + read)
          if (count === 0) break
          read += count
        }
        return { offset, bytes: bytes.subarray(0, read) }
      } catch {
        return undefined
      } finally {
        if (descriptor !== undefined) closeSync(descriptor)
      }
    },
    async readArchive(input) {
      const paths = grokSessionPaths({
        cwd: input.workdir,
        sessionId: input.grokSessionId,
        homeDir: deps.homeDir,
      })
      const candidates = [
        ['updates.jsonl', paths.updatesPath],
        ['chat_history.jsonl', paths.chatHistoryPath],
        ['summary.json', paths.summaryPath],
      ] as const
      const files = []
      for (const [path, absolute] of candidates) {
        try {
          files.push({ path, bytes: new Uint8Array(readFileSync(absolute)) })
        } catch {
          // Some sessions have not materialized all three files yet.
        }
      }
      return files.length > 0 ? files : undefined
    },

    async attachClient(input) {
      const entry = deps.journal.read(input.sessionId)
      if (!entry) return undefined
      return deps.attachClient?.({
        sessionId: input.sessionId,
        grokSessionId: input.grokSessionId,
        workdir: entry.workdir,
        mode: input.mode,
      })
    },
  }
}

/**
 * The ACP stdio channel over a host attachment (POD-4433): the merged ring IS
 * the engine's stdout (line-split here, the way the direct pipe was), stdin
 * arrives through the connection's WRITE, and closing drops this generation's
 * channel without ending the engine — `stop()`/`kill()` own that. A daemon
 * restart attaches a FRESH channel at the tail: pre-restart correlation ids
 * died with the old driver, so replaying stale responses into new ones would
 * be fabrication, and `session/load` re-establishes the conversation instead.
 */
function hostTransport(sessionId: SessionId, held: HeldEngine): GrokAcpTransport {
  let buffer = ''
  let closed = false
  return {
    write(line) {
      if (closed) return
      held.session.connection.write?.(Buffer.from(line))?.catch(() => {
        // A write to a dead channel is the engine being gone; the close path
        // below reports it, and throwing here would surface the fact twice.
      })
    },
    onLine(handler) {
      held.session.connection.onData((_seq, chunk) => {
        if (closed) return
        buffer += chunk.toString('utf8')
        let boundary = buffer.indexOf('\n')
        while (boundary >= 0) {
          const line = buffer.slice(0, boundary)
          buffer = buffer.slice(boundary + 1)
          if (line.trim()) handler.line(line)
          boundary = buffer.indexOf('\n')
        }
      })
      const ended = (): void => {
        if (closed) return
        closed = true
        if (held.banner.trim()) {
          log.warn('Grok ACP engine ended', { sessionId, stderr: held.banner.slice(-500) })
        }
        handler.closed()
      }
      held.session.connection.onExit(ended)
    },
    close() {
      if (closed) return
      closed = true
    },
  }
}
