/**
 * Reap processes whose working directory proves that their hermetic test run is gone.
 *
 * This deliberately does not inspect process names, argv, environment, ancestry, or age.
 * A process is eligible only while Linux reports its cwd below a deleted directory whose
 * basename is exactly `podium-test-run-*`. That keeps developer, operator, and journalled
 * product servers untouchable even when they run the same executable.
 *
 * The hermetic test preload calls this once at lane startup. Operators can also run it:
 *
 *   bun scripts/reap-stale-test-runs.ts
 */
import { readdirSync, readlinkSync } from 'node:fs'

const DELETED_SUFFIX = ' (deleted)'
const TEST_RUN_COMPONENT = /^podium-test-run-[^/]+$/
const TERM_GRACE_MS = 1_000
const POLL_MS = 25

export interface StaleTestRunProcess {
  pid: number
  cwd: string
}

/** True only for a deleted cwd at or below an exactly named hermetic run root. */
export function isStaleTestRunCwd(cwd: string): boolean {
  if (!cwd.endsWith(DELETED_SUFFIX)) return false
  const path = cwd.slice(0, -DELETED_SUFFIX.length)
  return path.split('/').some((component) => TEST_RUN_COMPONENT.test(component))
}

export function listStaleTestRunProcesses(procRoot = '/proc'): StaleTestRunProcess[] {
  let entries: string[]
  try {
    entries = readdirSync(procRoot)
  } catch {
    // `/proc` is Linux-specific. Other platforms have no safe cwd-deletion oracle,
    // so doing nothing is the portable and conservative answer.
    return []
  }

  const found: StaleTestRunProcess[] = []
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue
    const pid = Number.parseInt(entry, 10)
    if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) continue
    try {
      const cwd = readlinkSync(`${procRoot}/${entry}/cwd`)
      if (isStaleTestRunCwd(cwd)) found.push({ pid, cwd })
    } catch {
      // The process exited, changed cwd, or is not inspectable. None is permission to kill it.
    }
  }
  return found.sort((a, b) => a.pid - b.pid)
}

function stillSameStaleProcess(candidate: StaleTestRunProcess, procRoot: string): boolean {
  try {
    const cwd = readlinkSync(`${procRoot}/${candidate.pid}/cwd`)
    return cwd === candidate.cwd && isStaleTestRunCwd(cwd)
  } catch {
    return false
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * SIGTERM every proven-stale process, then SIGKILL only survivors that still present the
 * identical deleted-cwd proof. Revalidation before each signal fences pid reuse and cwd races.
 */
export function reapStaleTestRunProcesses(procRoot = '/proc'): StaleTestRunProcess[] {
  const candidates = listStaleTestRunProcesses(procRoot)
  if (procRoot !== '/proc') return candidates

  for (const candidate of candidates) {
    if (!stillSameStaleProcess(candidate, procRoot)) continue
    try {
      process.kill(candidate.pid, 'SIGTERM')
    } catch {
      // Raced with exit.
    }
  }

  const deadline = Date.now() + TERM_GRACE_MS
  while (Date.now() < deadline && candidates.some((p) => stillSameStaleProcess(p, procRoot))) {
    sleepSync(POLL_MS)
  }

  for (const candidate of candidates) {
    if (!stillSameStaleProcess(candidate, procRoot)) continue
    try {
      process.kill(candidate.pid, 'SIGKILL')
    } catch {
      // Raced with exit.
    }
  }
  return candidates
}

if (import.meta.main) {
  const reaped = reapStaleTestRunProcesses()
  if (reaped.length === 0) {
    console.log('No stale podium test-run processes found.')
  } else {
    for (const process of reaped) console.log(`Reaped pid ${process.pid}: ${process.cwd}`)
  }
}
