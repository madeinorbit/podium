/** Boot this candidate against a private snapshot; never run a supervisor or daemon. */
import { spawn, spawnSync } from 'node:child_process'
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  statfsSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openDatabase } from '../packages/runtime/src/sqlite'
import { mintUpdateSigningKey } from '../packages/runtime/src/update-signing-key'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SCRIPT = fileURLToPath(import.meta.url)

/** A whitelist prevents ambient relay, supervisor, credential and instance overrides leaking in. */
export function rehearsalEnvironment(root: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: join(root, 'home'),
    TMPDIR: join(root, 'tmp'),
    XDG_RUNTIME_DIR: join(root, 'runtime'),
    XDG_CACHE_HOME: join(root, 'cache'),
    XDG_CONFIG_HOME: join(root, 'config'),
    XDG_DATA_HOME: join(root, 'data'),
    XDG_STATE_HOME: join(root, 'xdg-state'),
    PODIUM_STATE_DIR: join(root, 'state'),
    PODIUM_AGENT_HOME: join(root, 'home'),
    PODIUM_INSTANCE: 'upgrade-rehearsal',
    PODIUM_ADOPT_STATE: '1',
    PODIUM_REHEARSAL: '1',
    PODIUM_CONNECT: 'off',
    PODIUM_TELEMETRY: 'off',
    PODIUM_HOST: '127.0.0.1',
    PODIUM_PORT: '0',
    PODIUM_HOOK_PORT: '0',
    PODIUM_AGENT_RELAY_PORT: '0',
    PODIUM_MODE: 'all-in-one',
    PODIUM_PUBLIC_URL: 'http://127.0.0.1',
    PODIUM_APP_URL: 'https://127.0.0.1',
    PODIUM_UPDATE_SCOPE: 'fleet-only',
    PODIUM_TRANSCRIPT_LAKE: 'off',
    PODIUM_NO_RELAY: '1',
    PODIUM_NO_SCOPE: '1',
    ABDUCO_SOCKET_DIR: join(root, 'abduco'),
  }
}

/** SQLite's consistent read transaction includes committed WAL pages without a whole-DB buffer. */
export function copyRehearsalState(source: string, destination: string): void {
  mkdirSync(destination, { recursive: true, mode: 0o700 })
  const db = openDatabase(join(source, 'podium.db'), { readOnly: true })
  try {
    db.exec('PRAGMA busy_timeout=30000; PRAGMA cache_size=-8192')
    db.prepare('VACUUM INTO ?').run(join(destination, 'podium.db'))
    chmodSync(join(destination, 'podium.db'), 0o600)
  } finally {
    db.close()
  }
}

export const DEFAULT_BOOT_TIMEOUT_MS = 600_000
const DISK_RESERVE_BYTES = 1024 ** 3

export interface RehearsalOptions {
  timeoutMs?: number
}

/** Keep room for the snapshot, the candidate's pre-migration backup, growth and live state. */
function checkCapacity(
  source: string,
  outputParent: string,
): { sourceBytes: number; requiredBytes: number; availableBytes: number } {
  const db = openDatabase(join(source, 'podium.db'), { readOnly: true })
  let sourceBytes: number
  try {
    const { page_count } = db.prepare('PRAGMA page_count').get() as { page_count: number }
    const { page_size } = db.prepare('PRAGMA page_size').get() as { page_size: number }
    sourceBytes = page_count * page_size
  } finally {
    db.close()
  }
  const disk = statfsSync(outputParent)
  const availableBytes = disk.bavail * disk.bsize
  const requiredBytes = sourceBytes * 3 + DISK_RESERVE_BYTES
  if (availableBytes < requiredBytes)
    throw new Error(
      `insufficient rehearsal space: need ${requiredBytes} bytes including 1 GiB live-state reserve; available ${availableBytes}; shortfall ${requiredBytes - availableBytes}`,
    )
  return { sourceBytes, requiredBytes, availableBytes }
}

async function bootCopy(): Promise<void> {
  if (process.env.PODIUM_REHEARSAL !== '1')
    throw new Error('--boot is internal; use a source state directory')
  const { addSink } = await import('../packages/logger/src/index')
  addSink({
    name: 'rehearsal',
    minLevel: 'info',
    write: (record) => console.log(JSON.stringify(record)),
  })
  // Exercise feed-resolution orchestration too, refusing egress at its transport
  // boundary. Only our own loopback health/fence probes may reach the network.
  const nativeFetch = globalThis.fetch
  let probeOrigin: string | undefined
  globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.origin !== probeOrigin) {
      throw new Error('Upgrade rehearsal: outbound fetch disabled')
    }
    return nativeFetch(input, init)
  }, nativeFetch)
  const { startServer } = await import('../apps/server/src/server')
  const server = await startServer({ port: 0, host: '127.0.0.1', transcriptLake: 'off' })
  try {
    const origin = `http://127.0.0.1:${server.port}`
    probeOrigin = origin
    if (!(await fetch(`${origin}/health`)).ok) throw new Error('candidate health check failed')
    if ((await fetch(`${origin}/trpc/machines.list`)).status !== 503)
      throw new Error('rehearsal API fence missing')
    if ((await fetch(`${origin}/daemon`)).status !== 503)
      throw new Error('rehearsal daemon fence missing')
    writeFileSync(
      join(process.env.PODIUM_STATE_DIR!, '..', 'result.json'),
      JSON.stringify({ healthy: true, port: server.port, sessionTrafficDisabled: true }, null, 2),
    )
  } finally {
    await server.close()
  }
}

export async function rehearse(
  sourceArg: string,
  outputArg?: string,
  options: RehearsalOptions = {},
): Promise<string> {
  const started = performance.now()
  const timeoutMs = options.timeoutMs ?? DEFAULT_BOOT_TIMEOUT_MS
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647)
    throw new Error('timeout must be a positive integer of at most 2147483647 ms')
  const source = realpathSync(sourceArg)
  if (!lstatSync(source).isDirectory() || !existsSync(join(source, 'podium.db')))
    throw new Error('source must be a state directory containing podium.db')
  const root = outputArg
    ? join(realpathSync(dirname(resolve(outputArg))), basename(resolve(outputArg)))
    : mkdtempSync(join(tmpdir(), 'podium-upgrade-rehearsal-'))
  if (root === source || root.startsWith(`${source}/`))
    throw new Error('rehearsal output must be outside the source state directory')
  if (outputArg && existsSync(root)) throw new Error('output directory must not exist')
  const capacity = checkCapacity(source, dirname(root))
  mkdirSync(root, { recursive: true, mode: 0o700 })
  const env = rehearsalEnvironment(root)
  for (const name of ['home', 'tmp', 'runtime', 'cache', 'config', 'data', 'xdg-state', 'abduco'])
    mkdirSync(join(root, name), { mode: 0o700 })
  const snapshotStarted = performance.now()
  copyRehearsalState(source, join(root, 'state'))
  const snapshotMs = performance.now() - snapshotStarted
  // No live identity, signing key or credential files are needed for the database drill.
  writeFileSync(
    join(root, 'state', 'update-signing-key.json'),
    JSON.stringify(mintUpdateSigningKey()),
    { mode: 0o600 },
  )
  const snapshotBytes = statSync(join(root, 'state', 'podium.db')).size
  const bootStarted = performance.now()
  const logPath = join(root, 'boot.log')
  const logFd = openSync(logPath, 'wx', 0o600)
  console.log(`Rehearsal copy: ${root}`)
  const child = spawn(process.execPath, ['--conditions=@podium/source', SCRIPT, '--boot'], {
    cwd: ROOT,
    env,
    detached: true,
    stdio: ['ignore', logFd, logFd],
  })
  closeSync(logFd)
  let timedOut = false
  const kill = () => {
    if (child.pid) {
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {}
    }
  }
  const timeout = setTimeout(() => {
    timedOut = true
    kill()
  }, timeoutMs)
  process.once('SIGINT', kill)
  process.once('SIGTERM', kill)
  try {
    const { code, signal } = await new Promise<{
      code: number | null
      signal: NodeJS.Signals | null
    }>((done, reject) => {
      child.once('error', reject)
      child.once('close', (code, signal) => done({ code, signal }))
    })
    const bootMs = performance.now() - bootStarted
    const log = readFileSync(logPath, 'utf8')
    const stages = log.split('\n').flatMap((line) => {
      try {
        const record = JSON.parse(line)
        return record.ns === 'server:boot'
          ? [
              {
                stage: record.stage,
                durationMs: record.durationMs,
                stageDurationMs: record.stageDurationMs,
              },
            ]
          : []
      } catch {
        return []
      }
    })
    writeFileSync(join(root, 'boot-stages.json'), JSON.stringify(stages, null, 2), { mode: 0o600 })
    const healthy = code === 0 && existsSync(join(root, 'result.json'))
    const revision = spawnSync('git', ['rev-parse', 'HEAD'], {
      cwd: ROOT,
      encoding: 'utf8',
    }).stdout?.trim()
    const report = {
      healthy,
      exitCode: code,
      signal,
      timedOut,
      timeoutMs,
      candidateCommit: revision,
      runtimeVersion: process.versions.bun,
      ...capacity,
      snapshotBytes,
      snapshotMs,
      bootMs,
      totalMs: performance.now() - started,
      migrationMs: stages.find((row) => row.stage === 'migrations')?.stageDurationMs ?? null,
      stages,
    }
    writeFileSync(join(root, 'rehearsal.json'), JSON.stringify(report, null, 2), { mode: 0o600 })
    console.log(JSON.stringify(report))
    if (!healthy)
      throw new Error(
        `candidate failed (exit ${code}, signal ${signal}, timedOut ${timedOut}); see ${logPath}`,
      )
    console.log(
      `Candidate boot healthy; session execution disabled. Evidence: ${join(root, 'rehearsal.json')}`,
    )
    return root
  } finally {
    clearTimeout(timeout)
    process.removeListener('SIGINT', kill)
    process.removeListener('SIGTERM', kill)
    kill()
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  if (args[0] === '--boot') await bootCopy()
  else {
    const positional: string[] = []
    let timeoutMs = DEFAULT_BOOT_TIMEOUT_MS
    for (let i = 0; i < args.length; i++) {
      const arg = args[i]!
      if (arg === '--timeout-seconds') timeoutMs = Number(args[++i]) * 1000
      else if (arg.startsWith('-')) throw new Error(`unknown option: ${arg}`)
      else positional.push(arg)
    }
    if (positional.length < 1 || positional.length > 2)
      throw new Error(
        `Usage: bun ${basename(SCRIPT)} <real-state-dir> [new-output-dir] [--timeout-seconds 600]`,
      )
    await rehearse(positional[0]!, positional[1], { timeoutMs })
  }
}
