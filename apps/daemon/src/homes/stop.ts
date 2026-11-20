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
import { type CodexHomeStopPorts, type RunningProcess, stopCodexHome } from '@podium/harness'
import type { SessionId } from '@podium/model'
import type { HarnessHome } from './registry'

export type { RunningProcess } from '@podium/harness'

export interface HomeStopPorts extends CodexHomeStopPorts {
  /** The sessions that run in `homeId` now. */
  sessionsIn(homeId: string): SessionId[] | string[]
  stopSession(sessionId: SessionId | string): Promise<unknown>
}

export async function stopHome(home: HarnessHome, ports: HomeStopPorts): Promise<void> {
  for (const sessionId of ports.sessionsIn(home.homeId)) await ports.stopSession(sessionId)
  await stopCodexHome(home, ports)
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
