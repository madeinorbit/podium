/** Boot this candidate against a private snapshot; never run a supervisor or daemon. */
import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openDatabase, serializeDatabase } from '../packages/runtime/src/sqlite'

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

/** Regular files only: copied symlinks and sockets must never lead back to live state. */
export function copyRehearsalState(source: string, destination: string): void {
  const transient = new Set(['instance.json', 'agent-home', 'node_modules'])
  const copy = (from: string, to: string, top: boolean): void => {
    mkdirSync(to, { recursive: true, mode: 0o700 })
    for (const name of readdirSync(from)) {
      if (top && transient.has(name)) continue
      if (/-(wal|shm)$/.test(name)) continue
      const input = join(from, name)
      const output = join(to, name)
      const stat = lstatSync(input)
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) continue
      if (stat.isDirectory()) copy(input, output, false)
      else if (name.endsWith('.db') || name.endsWith('.sqlite')) {
        // sqlite3_serialize reads a consistent page image including the committed WAL.
        // Never checkpoint or migrate the source database.
        const db = openDatabase(input, { readOnly: true })
        try { writeFileSync(output, serializeDatabase(db), { mode: 0o600 }) }
        finally { db.close() }
      } else copyFileSync(input, output)
    }
  }
  copy(source, destination, true)
}

async function bootCopy(): Promise<void> {
  if (process.env.PODIUM_REHEARSAL !== '1') throw new Error('--boot is internal; use a source state directory')
  const { startServer } = await import('../apps/server/src/server')
  const server = await startServer({ port: 0, host: '127.0.0.1', transcriptLake: 'off' })
  try {
    const origin = `http://127.0.0.1:${server.port}`
    if (!(await fetch(`${origin}/health`)).ok) throw new Error('candidate health check failed')
    if ((await fetch(`${origin}/trpc/machines.list`)).status !== 503) throw new Error('rehearsal API fence missing')
    if ((await fetch(`${origin}/daemon`)).status !== 503) throw new Error('rehearsal daemon fence missing')
    writeFileSync(join(process.env.PODIUM_STATE_DIR!, '..', 'result.json'), JSON.stringify({ healthy: true, port: server.port, sessionTrafficDisabled: true }, null, 2))
  } finally { await server.close() }
}

export async function rehearse(sourceArg: string, outputArg?: string): Promise<string> {
  const source = realpathSync(sourceArg)
  if (!lstatSync(source).isDirectory() || !existsSync(join(source, 'podium.db'))) throw new Error('source must be a state directory containing podium.db')
  const root = outputArg ? join(realpathSync(dirname(resolve(outputArg))), basename(resolve(outputArg))) : mkdtempSync(join(tmpdir(), 'podium-upgrade-rehearsal-'))
  if (root === source || root.startsWith(`${source}/`)) throw new Error('rehearsal output must be outside the source state directory')
  if (outputArg && existsSync(root)) throw new Error('output directory must not exist')
  mkdirSync(root, { recursive: true, mode: 0o700 })
  const env = rehearsalEnvironment(root)
  for (const name of ['home', 'tmp', 'runtime', 'cache', 'config', 'data', 'xdg-state', 'abduco']) mkdirSync(join(root, name), { mode: 0o700 })
  copyRehearsalState(source, join(root, 'state'))
  console.log(`Rehearsal copy: ${root}`)
  const child = spawn(process.execPath, ['--conditions=@podium/source', SCRIPT, '--boot'], { cwd: ROOT, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let log = ''
  child.stdout?.on('data', (bytes) => { log += bytes })
  child.stderr?.on('data', (bytes) => { log += bytes })
  const kill = () => { if (child.pid) { try { process.kill(-child.pid, 'SIGKILL') } catch {} } }
  const timeout = setTimeout(kill, 90_000)
  process.once('SIGINT', kill)
  process.once('SIGTERM', kill)
  try {
    const code = await new Promise<number | null>((done, reject) => { child.once('error', reject); child.once('close', done) })
    writeFileSync(join(root, 'boot.log'), log, { mode: 0o600 })
    if (code !== 0 || !existsSync(join(root, 'result.json'))) throw new Error(`candidate failed (exit ${code}); see ${join(root, 'boot.log')}`)
    const state = JSON.parse(readFileSync(join(root, 'state', 'machine.json'), 'utf8')) as { machineId: string }
    console.log(`Candidate boot healthy; session execution disabled; machine ${state.machineId}. Evidence: ${join(root, 'result.json')}`)
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
  else if (args.length >= 1 && args.length <= 2 && !args[0]!.startsWith('-')) await rehearse(args[0]!, args[1])
  else throw new Error(`Usage: bun ${basename(SCRIPT)} <real-state-dir> [new-output-dir]`)
}
