/**
 * Daemon-owned process host for the Grok ACP driver.
 *
 * The child's stdio is the only protocol channel. A daemon restart therefore
 * replaces the child and `session/load` resumes the native session named by
 * the binding journal; the journal is durable, the pipe is intentionally not.
 */
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
} from '@podium/agent-runtime'
import { grokSessionPaths } from '@podium/harness'
import { createLogger } from '@podium/logger'
import type { SessionId } from '@podium/model'
import { asSessionId } from '@podium/model'
import { canScopeMaster, scopeReclaimArgvs, scopeUnitName, systemdScopeArgv } from '@podium/pty'
import { stateDir } from '@podium/runtime/config'

const log = createLogger('daemon:grok-acp-server')
const PROBE_TIMEOUT_MS = OPENCODE_VERSION_PROBE_TIMEOUT_MS
const EXIT_TIMEOUT_MS = 2_000

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

let versionVerdict: GrokAcpProbeVerdict | undefined

/** Three-valued gate: a timeout/ENOENT is transient and is never memoized. */
export function grokAcpVersionProbe(
  probe: () => { output: string; ok: boolean } = defaultVersionProbe,
): GrokAcpProbeVerdict {
  if (versionVerdict) return versionVerdict
  const { output, ok } = probe()
  if (!ok) {
    return {
      drivable: false,
      reason: 'unprobeable',
      diagnostic: {
        code: 'grok-acp-version-unsupported',
        title: 'Grok ACP version could not be checked',
        body: `\`grok --version\` did not answer within ${PROBE_TIMEOUT_MS}ms; the next spawn will probe again. Observed: ${output || '(no output)'}`,
        observedVersion: output.trim() || '(probe failed)',
      },
    }
  }
  const diagnostic = gateGrokVersion(output)
  const verdict: GrokAcpProbeVerdict = diagnostic
    ? { drivable: false, reason: 'unsupported', diagnostic }
    : { drivable: true }
  versionVerdict = verdict
  return verdict
}

export function resetGrokAcpVersionProbe(): void {
  versionVerdict = undefined
}

function defaultVersionProbe(): { output: string; ok: boolean } {
  const result = spawnSync('grok', ['--version'], {
    encoding: 'utf8',
    timeout: PROBE_TIMEOUT_MS,
  })
  return {
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim(),
    ok: result.error === undefined && result.status === 0,
  }
}

export interface GrokAcpHostDeps {
  memoryBytes(input: { sessionId: SessionId; label: string; pid?: number }): number | undefined
  now?: () => number
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
      const timer = setTimeout(resolve, 8_000)
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
    if (!canScopeMaster()) return
    const unit = scopeUnitName(grokAcpProcessKey(sessionId))
    for (const args of scopeReclaimArgvs(unit)) await runSystemctl(args)
  }

  return {
    journal,
    now: deps.now ?? (() => Date.now()),
    mintSessionId: () => asSessionId(crypto.randomUUID()),

    async launch(input) {
      const verdict = grokAcpVersionProbe()
      if (!verdict.drivable) {
        throw new Error(`${verdict.diagnostic.title}: ${verdict.diagnostic.body}`)
      }

      const label = grokAcpProcessKey(input.sessionId)
      const scoped = canScopeMaster()
      const unit = scopeUnitName(label)
      if (scoped && liveChildren(input.sessionId).size === 0) {
        for (const args of scopeReclaimArgvs(unit)) await runSystemctl(args)
      }
      // The ACP server receives cwd in session/new and session/load. A native
      // --worktree would create a second nested worktree; no SessionSpec sandbox
      // field exists, so GROK_SANDBOX/config remains authoritative.
      const argv = ['grok', 'agent', 'stdio']
      const [command, ...args] = scoped ? ['systemd-run', ...systemdScopeArgv(unit, argv)] : argv
      const env: NodeJS.ProcessEnv = { ...process.env, ...input.env }
      // An inherited API key can silently replace the user's subscription.
      delete env.XAI_API_KEY

      const child = spawn(command ?? 'grok', args, {
        cwd: input.workdir,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: false,
      })
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
        memoryBytes: () =>
          deps.memoryBytes({
            sessionId: input.sessionId,
            label,
            ...(child.pid !== undefined ? { pid: child.pid } : {}),
          }),
        alive: () => child.exitCode === null && child.signalCode === null,
      }
      return endpoint
    },

    async readArchive(input) {
      const paths = grokSessionPaths({ cwd: input.workdir, sessionId: input.grokSessionId })
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
