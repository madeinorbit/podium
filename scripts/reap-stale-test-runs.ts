/**
 * Recover abandoned hermetic run roots and reap processes whose cwd proves that
 * the whole run root is gone.
 *
 * Process names, argv, environment, ancestry, and age are deliberately irrelevant.
 * A process becomes eligible only after Linux reports a deleted cwd below an exact
 * `podium-test-run-*` component AND that matched root path no longer exists.
 */
import {
  existsSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

const DELETED_SUFFIX = ' (deleted)'
const TEST_RUN_COMPONENT = /^podium-test-run-[^/]+$/
const TERM_GRACE_MS = 1_000
const POLL_MS = 25
export const TEST_RUN_OWNER_MARKER = '.podium-test-run-owner.json'

interface TestRunOwnerMarker {
  kind: 'podium-hermetic-test-run'
  version: 1
  ownerPid: number
  ownerStartTime: string
}

export interface ProcessIdentity {
  pid: number
  startTime: string
}

export interface StaleTestRunProcess extends ProcessIdentity {
  cwd: string
  runRoot: string
}

export function procStartTime(pid: number, procRoot = '/proc'): string | undefined {
  try {
    // `/proc/<pid>/stat` field 22. The comm field may contain spaces and parentheses,
    // so split only after its final `) ` boundary.
    const stat = readFileSync(`${procRoot}/${pid}/stat`, 'utf8')
    return stat
      .slice(stat.lastIndexOf(') ') + 2)
      .trim()
      .split(/\s+/)[19]
  } catch {
    return undefined
  }
}

function sameProcess(identity: ProcessIdentity, procRoot = '/proc'): boolean {
  return procStartTime(identity.pid, procRoot) === identity.startTime
}

/** Extract the exact hermetic root named in a kernel cwd link. */
export function testRunRootFromCwd(cwd: string): string | undefined {
  const path = cwd.endsWith(DELETED_SUFFIX) ? cwd.slice(0, -DELETED_SUFFIX.length) : cwd
  const components = path.split('/')
  const index = components.findIndex((component) => TEST_RUN_COMPONENT.test(component))
  if (index === -1) return undefined
  return components.slice(0, index + 1).join('/') || '/'
}

/** True only when the cwd is deleted and its matched run root itself is absent. */
export function staleTestRunRoot(
  cwd: string,
  pathExists: (path: string) => boolean = existsSync,
): string | undefined {
  if (!cwd.endsWith(DELETED_SUFFIX)) return undefined
  const runRoot = testRunRootFromCwd(cwd)
  if (!runRoot || pathExists(runRoot)) return undefined
  return runRoot
}

export function isStaleTestRunCwd(
  cwd: string,
  pathExists: (path: string) => boolean = existsSync,
): boolean {
  return staleTestRunRoot(cwd, pathExists) !== undefined
}

/** Persist the identity that makes a still-present run root safe to recover later. */
export function markTestRunRootOwned(runRoot: string, owner: ProcessIdentity): string {
  const canonicalRoot = realpathSync(runRoot)
  if (!TEST_RUN_COMPONENT.test(basename(canonicalRoot))) {
    throw new Error(`refusing to mark non-hermetic test root: ${canonicalRoot}`)
  }
  const marker: TestRunOwnerMarker = {
    kind: 'podium-hermetic-test-run',
    version: 1,
    ownerPid: owner.pid,
    ownerStartTime: owner.startTime,
  }
  writeFileSync(join(canonicalRoot, TEST_RUN_OWNER_MARKER), `${JSON.stringify(marker)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  })
  return canonicalRoot
}

function readOwnerMarker(runRoot: string): TestRunOwnerMarker | undefined {
  try {
    const parsed = JSON.parse(
      readFileSync(join(runRoot, TEST_RUN_OWNER_MARKER), 'utf8'),
    ) as Partial<TestRunOwnerMarker>
    if (
      parsed.kind !== 'podium-hermetic-test-run' ||
      parsed.version !== 1 ||
      !Number.isSafeInteger(parsed.ownerPid) ||
      (parsed.ownerPid ?? 0) <= 1 ||
      typeof parsed.ownerStartTime !== 'string' ||
      parsed.ownerStartTime.length === 0
    ) {
      return undefined
    }
    return parsed as TestRunOwnerMarker
  } catch {
    return undefined
  }
}

/**
 * Remove only marked run roots whose recorded owner identity is gone. This closes
 * the guardian+worker double-SIGKILL window at the next lane start (or explicit
 * script run); removing the root turns surviving cwd links into the strict deleted
 * proof consumed by {@link reapStaleTestRunProcesses}.
 */
export function recoverStaleTestRunRoots(
  hostTmpdir = process.env.PODIUM_TEST_HOST_TMPDIR?.trim() || tmpdir(),
  procRoot = '/proc',
): string[] {
  try {
    readdirSync(procRoot)
  } catch {
    // Without a readable process table, "owner absent" cannot be distinguished
    // from "owner identity unavailable". Never delete on that ambiguity.
    return []
  }
  let canonicalHost: string
  try {
    canonicalHost = realpathSync(hostTmpdir)
  } catch {
    return []
  }

  let entries: string[]
  try {
    entries = readdirSync(canonicalHost)
  } catch {
    return []
  }

  const recovered: string[] = []
  for (const entry of entries) {
    if (!TEST_RUN_COMPONENT.test(entry)) continue
    const runRoot = join(canonicalHost, entry)
    const marker = readOwnerMarker(runRoot)
    if (
      !marker ||
      sameProcess({ pid: marker.ownerPid, startTime: marker.ownerStartTime }, procRoot)
    ) {
      continue
    }

    // Re-read both the marker and owner identity immediately before deletion. A
    // path reused by a new run, or a PID reused by the kernel, must fail closed.
    const current = readOwnerMarker(runRoot)
    if (
      !current ||
      current.ownerPid !== marker.ownerPid ||
      current.ownerStartTime !== marker.ownerStartTime ||
      sameProcess({ pid: current.ownerPid, startTime: current.ownerStartTime }, procRoot)
    ) {
      continue
    }
    try {
      rmSync(runRoot, { recursive: true, force: true })
      recovered.push(runRoot)
    } catch {
      // A root we cannot remove cannot produce the deleted-root proof, so leave it alone.
    }
  }
  return recovered.sort()
}

export function listStaleTestRunProcesses(procRoot = '/proc'): StaleTestRunProcess[] {
  let entries: string[]
  try {
    entries = readdirSync(procRoot)
  } catch {
    return []
  }

  const found: StaleTestRunProcess[] = []
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue
    const pid = Number.parseInt(entry, 10)
    if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) continue
    try {
      const cwd = readlinkSync(`${procRoot}/${entry}/cwd`)
      const runRoot = staleTestRunRoot(cwd)
      const startTime = procStartTime(pid, procRoot)
      if (runRoot && startTime) found.push({ pid, startTime, cwd, runRoot })
    } catch {
      // The process exited, changed cwd, or is not inspectable. None is permission to kill it.
    }
  }
  return found.sort((a, b) => a.pid - b.pid)
}

/** Revalidate PID identity, cwd, and absent run root immediately before a signal. */
export function stillSameStaleProcess(candidate: StaleTestRunProcess, procRoot = '/proc'): boolean {
  try {
    if (!sameProcess(candidate, procRoot)) return false
    const cwd = readlinkSync(`${procRoot}/${candidate.pid}/cwd`)
    return cwd === candidate.cwd && staleTestRunRoot(cwd) === candidate.runRoot
  } catch {
    return false
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/** SIGTERM every proven-stale process, then SIGKILL only identical survivors. */
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
  const recovered = recoverStaleTestRunRoots()
  const reaped = reapStaleTestRunProcesses()
  for (const root of recovered) console.log(`Recovered stale test root: ${root}`)
  if (reaped.length === 0) {
    console.log('No stale podium test-run processes found.')
  } else {
    for (const candidate of reaped) console.log(`Reaped pid ${candidate.pid}: ${candidate.cwd}`)
  }
}
