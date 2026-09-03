/**
 * Daemon-owned process host for the Grok ACP driver.
 *
 * The child's stdio is the only protocol channel. A daemon restart therefore
 * replaces the child and `session/load` resumes the native session named by
 * the binding journal; the journal is durable, the pipe is intentionally not.
 */
import { spawn } from 'node:child_process'
import {
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import {
  type GrokAcpEndpoint,
  type GrokAcpJournal,
  type GrokAcpJournalEntry,
  type GrokAcpRuntimeHost,
  type GrokAcpTransport,
  type GrokVersionDiagnostic,
  gateGrokVersion,
  OPENCODE_VERSION_PROBE_TIMEOUT_MS,
  type ScopeResources,
} from '@podium/agent-runtime'
import { grokSessionPaths } from '@podium/harness'
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
import { SERVER_GRACEFUL_EXIT_MS, SERVER_SYSTEMCTL_CALL_TIMEOUT_MS } from './server-teardown-budget'
import {
  createVersionProbeCache,
  execVersionProbe,
  type VersionProbe,
  type VersionProbePolicy,
} from './version-probe'

const log = createLogger('daemon:grok-acp-server')
const PROBE_TIMEOUT_MS = OPENCODE_VERSION_PROBE_TIMEOUT_MS
/** How long a SIGTERM stop waits for the child to take its stdin EOF before
 *  signalling. SHARED WITH THE REAP THAT HAS TO OUTLAST IT (POD-2775) — see
 *  `server-teardown-budget.ts` for why the two numbers are declared together. */
const EXIT_TIMEOUT_MS = SERVER_GRACEFUL_EXIT_MS

const journalDir = (): string => join(stateDir(), 'grok-acp-servers')
const journalPath = (sessionId: SessionId): string =>
  join(journalDir(), `${encodeURIComponent(sessionId)}.json`)

export function createGrokAcpJournal(): GrokAcpJournal {
  const cache = new Map<SessionId, GrokAcpJournalEntry>()
  return {
    read(sessionId) {
      const cached = cache.get(sessionId)
      if (cached) return cached
      try {
        const entry = JSON.parse(
          readFileSync(journalPath(sessionId), 'utf8'),
        ) as GrokAcpJournalEntry
        cache.set(sessionId, entry)
        return entry
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
        log.warn('could not persist Grok ACP binding journal', {
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
        // Best effort. A stale entry is rejected when resume fails.
      }
    },
  }
}

export type GrokAcpProbeVerdict =
  | { drivable: true }
  | { drivable: false; reason: 'unsupported'; diagnostic: GrokVersionDiagnostic }
  | { drivable: false; reason: 'unprobeable'; diagnostic: GrokVersionDiagnostic }

const versionProbeCache = createVersionProbeCache<GrokAcpProbeVerdict>({
  evaluate: ({ output, ok }) => {
    if (!ok) {
      return {
        drivable: false,
        reason: 'unprobeable',
        diagnostic: {
          code: 'grok-acp-version-unsupported',
          title: 'Grok ACP version could not be checked',
          body: `\`grok --version\` did not answer within ${PROBE_TIMEOUT_MS}ms; a later spawn will probe again. Observed: ${output || '(no output)'}`,
          observedVersion: output.trim() || '(probe failed)',
        },
      }
    }
    const diagnostic = gateGrokVersion(output)
    return diagnostic ? { drivable: false, reason: 'unsupported', diagnostic } : { drivable: true }
  },
})

/** Three-valued gate: a timeout/ENOENT is transient and cached only briefly. */
export function grokAcpVersionProbe(
  probe: VersionProbe = defaultVersionProbe,
  policy?: VersionProbePolicy,
): Promise<GrokAcpProbeVerdict> {
  return versionProbeCache.probe(probe, policy)
}

export function resetGrokAcpVersionProbe(): void {
  versionProbeCache.reset()
}

function defaultVersionProbe(): Promise<{ output: string; ok: boolean }> {
  // Deliberately the daemon's own env, NOT the instance composition: the probe
  // asks "what can this MACHINE run" and reads no per-user state — see
  // `serverChildEnv` for the env-class record (POD-2247).
  return execVersionProbe('grok', PROBE_TIMEOUT_MS)
}

export interface GrokAcpHostDeps {
  /** Resource truth for a session's scope — memory, tasks and the kernel's own
   *  OOM-kill counter, from the daemon's one cgroup observer. */
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
  /** Immutable daemon ownership stamp for orphan attribution. */
  instanceUuid?: string
}

/**
 * Stable process identity for the logical Grok session.
 *
 * Adoption derives this from the Podium session id instead of trusting the
 * binding journal. That gives the journal's recorded process key an
 * independent identity to match before a fresh stdio child is allowed to load
 * the native session it names.
 */
export const grokAcpProcessKey = (sessionId: SessionId): string =>
  `podium-gk-${String(sessionId)
    .replace(/[^a-zA-Z0-9_.-]/g, '-')
    .slice(-48)}`

export function createGrokAcpHost(deps: GrokAcpHostDeps): GrokAcpRuntimeHost {
  const journal = createGrokAcpJournal()
  const children = new Map<SessionId, Set<ReturnType<typeof spawn>>>()
  const liveChildren = (id: SessionId): Set<ReturnType<typeof spawn>> => {
    let set = children.get(id)
    if (!set) {
      set = new Set()
      children.set(id, set)
    }
    return set
  }

  const runSystemctl = async (args: readonly string[]): Promise<void> => {
    await new Promise<void>((resolve) => {
      const child = spawn('systemctl', [...args], { stdio: 'ignore' })
      child.once('exit', () => resolve())
      child.once('error', () => resolve())
      const timer = setTimeout(resolve, SERVER_SYSTEMCTL_CALL_TIMEOUT_MS)
      timer.unref?.()
    })
  }

  const terminate = async (
    sessionId: SessionId,
    signal: 'SIGTERM' | 'SIGKILL',
    child: ReturnType<typeof spawn>,
  ): Promise<void> => {
    const live = liveChildren(sessionId)
    live.delete(child)
    if (signal === 'SIGTERM') {
      try {
        child.stdin?.end()
      } catch {
        // Already closed.
      }
      await new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) return resolve()
        const timer = setTimeout(resolve, EXIT_TIMEOUT_MS)
        timer.unref?.()
        child.once('exit', () => {
          clearTimeout(timer)
          resolve()
        })
      })
    }
    if (child.exitCode === null && child.signalCode === null) child.kill(signal)
    if (live.size > 0) return
    children.delete(sessionId)
    if (!(await canScopeMaster())) return
    const unit = scopeUnitName(grokAcpProcessKey(sessionId))
    for (const args of scopeReclaimArgvs(unit)) await runSystemctl(args)
  }

  return {
    journal,
    now: deps.now ?? (() => Date.now()),
    mintSessionId: () => asSessionId(crypto.randomUUID()),
    onRawFrame:
      process.env.PODIUM_GROK_ACP_TRACE === '1'
        ? (sessionId, frame) => {
            log.info('Grok ACP inbound frame', { sessionId, frame })
          }
        : undefined,

    async launch(input) {
      const verdict = await grokAcpVersionProbe()
      if (!verdict.drivable) {
        throw new Error(`${verdict.diagnostic.title}: ${verdict.diagnostic.body}`)
      }

      const label = grokAcpProcessKey(input.sessionId)
      const scoped = await canScopeMaster()
      const unit = scopeUnitName(label)
      if (scoped && liveChildren(input.sessionId).size === 0) {
        for (const args of scopeReclaimArgvs(unit)) await runSystemctl(args)
      }
      // The ACP server receives cwd in session/new and session/load. A native
      // --worktree would create a second nested worktree; no SessionSpec sandbox
      // field exists, so GROK_SANDBOX/config remains authoritative.
      const argv = ['grok', 'agent', 'stdio']
      const [command, ...args] = scoped ? ['systemd-run', ...systemdScopeArgv(unit, argv)] : argv
      const env: NodeJS.ProcessEnv = serverChildEnv({
        instanceUuid: deps.instanceUuid,
        sessionId: input.sessionId,
        agentKind: 'grok',
        ...(deps.homeDir ? { homeDir: deps.homeDir } : {}),
        ...(input.env ? { sessionEnv: input.env } : {}),
      })
      // An inherited API key can silently replace the user's subscription.
      delete env.XAI_API_KEY

      const child = spawn(command ?? 'grok', args, {
        cwd: input.workdir,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: false,
      })
      // The instance's sessions slice exists now that a scope named it, so its
      // aggregate throttle can be set (POD-2413). Fire and forget, memoized on
      // success: a session must never wait on a best-effort budget call.
      if (scoped) void applySessionsSliceBudget()
      liveChildren(input.sessionId).add(child)
      child.once('exit', () => children.get(input.sessionId)?.delete(child))
      let banner = ''
      child.stderr?.on('data', (chunk: Buffer) => {
        banner = `${banner}${chunk.toString('utf8')}`.slice(-2000)
      })
      child.once('error', (err) => {
        log.warn('Grok ACP child errored', { err, sessionId: input.sessionId })
      })
      if (!scoped) log.warn('Grok ACP session is running unscoped', { sessionId: input.sessionId })

      const endpoint: GrokAcpEndpoint = {
        transport: childTransport(child, () => banner),
        process: {
          key: label,
          ...(child.pid !== undefined ? { pid: child.pid } : {}),
          ...(scoped ? { scopeUnit: unit } : {}),
        },
        stop: () => terminate(input.sessionId, 'SIGTERM', child),
        kill: async () => {
          await terminate(input.sessionId, 'SIGKILL', child)
          journal.clear(input.sessionId)
        },
        resources: () =>
          deps.resources({
            sessionId: input.sessionId,
            label,
            ...(child.pid !== undefined ? { pid: child.pid } : {}),
            ...(scoped ? { scopeUnit: unit } : {}),
          }),
        alive: () => child.exitCode === null && child.signalCode === null,
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
      const entry = journal.read(input.sessionId)
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

function childTransport(child: ReturnType<typeof spawn>, banner: () => string): GrokAcpTransport {
  let buffer = ''
  let closed = false
  return {
    write(line) {
      if (!closed) child.stdin?.write(line)
    },
    onLine(handler) {
      child.stdout?.on('data', (chunk: Buffer) => {
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
        if (banner().trim()) log.warn('Grok ACP child ended', { stderr: banner().slice(-500) })
        handler.closed()
      }
      child.once('exit', ended)
      child.stdout?.once('end', ended)
      child.once('error', ended)
    },
    close() {
      if (closed) return
      closed = true
      child.stdin?.end()
    },
  }
}
