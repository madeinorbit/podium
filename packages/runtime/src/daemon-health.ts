// Daemon role health is independent of supervisor-owned machine presence.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { stateDir } from './config'
import { ConnectivityStatus } from './connectivity'

export function readDaemonHealth(dir = stateDir()): ConnectivityStatus | undefined {
  try {
    return ConnectivityStatus.parse(
      JSON.parse(readFileSync(join(dir, 'run', 'daemon-health.json'), 'utf8')),
    )
  } catch {
    return undefined
  }
}

/** Publish a complete observation atomically; never inherit a previous process's proof. */
export function writeDaemonHealth(
  observation: Omit<ConnectivityStatus, 'updatedAt'>,
  dir = stateDir(),
): void {
  const status = ConnectivityStatus.parse({ ...observation, updatedAt: new Date().toISOString() })
  const runtimeDir = join(dir, 'run')
  mkdirSync(runtimeDir, { recursive: true })
  const path = join(runtimeDir, 'daemon-health.json')
  const temporary = `${path}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify(status)}\n`, { mode: 0o600 })
  renameSync(temporary, path)
}
