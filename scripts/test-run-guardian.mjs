/**
 * Parent-death guardian for opt-in live test lanes.
 *
 * The test preload starts one guardian per hermetic run root. Intentional daemon restarts do
 * not affect it: it watches the test runner itself. If that owner disappears (including by
 * SIGKILL), or asks the guardian to stop during signal teardown, every process whose cwd is
 * still inside this exact run root gets TERM→KILL escalation.
 */
import { readdirSync, readFileSync, readlinkSync, realpathSync } from 'node:fs'
import { basename } from 'node:path'

const [ownerArg, ownerStartTime, runRootArg] = process.argv.slice(2)
const ownerPid = Number.parseInt(ownerArg ?? '', 10)
let runRoot
try {
  // Proc cwd links always report the canonical target, so canonicalize the
  // configured side too. This keeps a symlinked host TMPDIR from defeating ownership.
  runRoot = runRootArg ? realpathSync(runRootArg) : undefined
} catch {
  process.exit(2)
}
if (
  !Number.isSafeInteger(ownerPid) ||
  ownerPid <= 1 ||
  !ownerStartTime ||
  !runRoot ||
  !/^podium-test-run-[^/]+$/.test(basename(runRoot))
) {
  process.exit(2)
}

const deletedSuffix = ' (deleted)'
const normalizedCwd = (cwd) =>
  cwd.endsWith(deletedSuffix) ? cwd.slice(0, -deletedSuffix.length) : cwd
const belongsToRun = (cwd) => {
  const normalized = normalizedCwd(cwd)
  return normalized === runRoot || normalized.startsWith(`${runRoot}/`)
}

const procStartTime = (pid) => {
  try {
    // `/proc/<pid>/stat` field 22. The comm field may contain spaces and parentheses, so
    // split only after its final `) ` boundary.
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const fieldsAfterComm = stat
      .slice(stat.lastIndexOf(') ') + 2)
      .trim()
      .split(/\s+/)
    return fieldsAfterComm[19]
  } catch {
    return undefined
  }
}

const ownerIsSameProcess = () => procStartTime(ownerPid) === ownerStartTime
const candidates = () => {
  let entries
  try {
    entries = readdirSync('/proc')
  } catch {
    return []
  }
  return entries.flatMap((entry) => {
    if (!/^\d+$/.test(entry)) return []
    const pid = Number.parseInt(entry, 10)
    if (pid <= 1 || pid === process.pid || pid === ownerPid) return []
    try {
      const cwd = readlinkSync(`/proc/${pid}/cwd`)
      const startTime = procStartTime(pid)
      return belongsToRun(cwd) && startTime ? [{ pid, cwd, startTime }] : []
    } catch {
      return []
    }
  })
}

const stillSameOwnedProcess = ({ pid, cwd, startTime }) => {
  try {
    if (procStartTime(pid) !== startTime) return false
    const current = readlinkSync(`/proc/${pid}/cwd`)
    return current === cwd && belongsToRun(current)
  } catch {
    return false
  }
}

let cleaning = false
const cleanup = async () => {
  if (cleaning) return
  cleaning = true
  const owned = candidates()
  for (const candidate of owned) {
    if (!stillSameOwnedProcess(candidate)) continue
    try {
      process.kill(candidate.pid, 'SIGTERM')
    } catch {
      // Raced with exit.
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 1_000))
  for (const candidate of owned) {
    if (!stillSameOwnedProcess(candidate)) continue
    try {
      process.kill(candidate.pid, 'SIGKILL')
    } catch {
      // Raced with exit.
    }
  }
  process.exit(0)
}

process.on('SIGINT', () => void cleanup())
process.on('SIGTERM', () => void cleanup())
process.on('SIGHUP', () => void cleanup())

const poll = () => {
  if (!ownerIsSameProcess()) {
    void cleanup()
    return
  }
  setTimeout(poll, 100)
}
poll()
