/**
 * WHAT REMOVING A HOME STOPS FIRST (credential management §10; epic plan
 * Task 8, acceptance 8).
 *
 * Two kinds of process run in a home: the engines and terminals of Podium
 * sessions on that credential, and, for Codex 0.169 and later, Codex's own
 * managed app-server daemon. The first `codex app-server` in a home installs
 * a copy of Codex under `<home>/packages/app-server-daemon/` (about 400 MB)
 * and leaves that daemon and its update loop running detached, outliving
 * every client (POD-6893 report §2). Deleting the directory under a running
 * process would leave it running from deleted files, so everything is
 * stopped before the home goes: the sessions through the daemon's own stop
 * path, Codex's daemon through its documented `app-server daemon stop`, and
 * anything still running from inside the home by signal.
 */

import { execFile } from 'node:child_process'
import type { SessionId } from '@podium/model'
import type { HarnessHome } from './registry'

/** A process and its command line, as `ps` prints it. */
export interface RunningProcess {
  pid: number
  args: string
}

export interface HomeStopPorts {
  /** The sessions that run in `homeId` now. */
  sessionsIn(homeId: string): SessionId[] | string[]
  stopSession(sessionId: SessionId | string): Promise<unknown>
  /** The installed Codex the inventory verified, if any. */
  codexExecutable(): string | undefined
  /** The machine's command environment (PATH and the rest). */
  commandEnv(): Readonly<Record<string, string>>
  run(command: string, args: readonly string[], env: Record<string, string>): Promise<void>
  listProcesses(): Promise<RunningProcess[]>
  signal(pid: number, signal: 'SIGTERM' | 'SIGKILL'): void
  sleep(ms: number): Promise<void>
}

/** How long a process started from the home gets to exit after SIGTERM. */
const GRACE_MS = 5_000
const POLL_MS = 250

export async function stopHome(home: HarnessHome, ports: HomeStopPorts): Promise<void> {
  for (const sessionId of ports.sessionsIn(home.homeId)) await ports.stopSession(sessionId)
  if (home.harness !== 'codex') return
  const codex = ports.codexExecutable()
  if (codex) {
    try {
      await ports.run(codex, ['app-server', 'daemon', 'stop'], {
        ...ports.commandEnv(),
        CODEX_HOME: home.dir,
      })
    } catch {
      // An older Codex has no such command, or none was running: what still
      // runs from the home is found below either way.
    }
  }
  await killRunningFrom(home.dir, ports)
}

/** Stop every process whose executable lives under `dir`. */
async function killRunningFrom(dir: string, ports: HomeStopPorts): Promise<void> {
  const prefix = dir.endsWith('/') ? dir : `${dir}/`
  const inside = async () =>
    (await ports.listProcesses()).filter((process) => process.args.startsWith(prefix))
  const first = await inside()
  if (first.length === 0) return
  for (const process of first) ports.signal(process.pid, 'SIGTERM')
  for (let waited = 0; waited < GRACE_MS; waited += POLL_MS) {
    if ((await inside()).length === 0) return
    await ports.sleep(POLL_MS)
  }
  for (const process of await inside()) ports.signal(process.pid, 'SIGKILL')
}

/** The real process ports: `ps` lists, `process.kill` signals. */
export const systemProcessPorts: Pick<HomeStopPorts, 'run' | 'listProcesses' | 'signal' | 'sleep'> =
  {
    run: (command, args, env) =>
      new Promise((resolve, reject) => {
        execFile(command, [...args], { env, timeout: 30_000 }, (error) =>
          error ? reject(error) : resolve(),
        )
      }),
    listProcesses: () =>
      new Promise((resolve) => {
        execFile('ps', ['-eo', 'pid=,args='], { maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
          if (error) return resolve([])
          resolve(
            stdout
              .split('\n')
              .map((line) => /^\s*(\d+)\s+(.*)$/.exec(line))
              .filter((match): match is RegExpExecArray => match !== null)
              .map((match) => ({ pid: Number(match[1]), args: match[2] ?? '' })),
          )
        })
      }),
    signal: (pid, signal) => {
      try {
        process.kill(pid, signal)
      } catch {
        // Already gone.
      }
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  }
