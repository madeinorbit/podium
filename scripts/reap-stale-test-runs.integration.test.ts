/** Linux process integration: real /proc cwd links, signals, and parent death. */
import { type ChildProcess, spawn } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  isStaleTestRunCwd,
  listStaleTestRunProcesses,
  markTestRunRootOwned,
  reapStaleTestRunProcesses,
  recoverStaleTestRunRoots,
  stillSameStaleProcess,
} from './reap-stale-test-runs'

const HOST_TMPDIR = process.env.PODIUM_TEST_HOST_TMPDIR?.trim() || tmpdir()
const GUARDIAN_ENTRY = fileURLToPath(new URL('./test-run-guardian.mjs', import.meta.url))
const REPO_ROOT = dirname(dirname(GUARDIAN_ENTRY))
const children: ChildProcess[] = []
const dirs: string[] = []

function trackedDir(prefix: string): string {
  const dir = mkdtempSync(join(HOST_TMPDIR, prefix))
  dirs.push(dir)
  return dir
}

function spawnSentinel(cwd: string): ChildProcess {
  const child = spawn(
    process.execPath,
    ['-e', "process.title = 'opencode serve'; setInterval(() => {}, 1000)"],
    { cwd, stdio: 'ignore' },
  )
  children.push(child)
  return child
}

function spawnOwner(): ChildProcess {
  const owner = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    cwd: REPO_ROOT,
    stdio: 'ignore',
  })
  children.push(owner)
  return owner
}

function spawned(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once('spawn', resolve)
    child.once('error', reject)
  })
}

async function waitForCwd(child: ChildProcess, expected: string): Promise<void> {
  const canonicalExpected = realpathSync(expected)
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    if (!child.pid || !alive(child)) throw new Error('sentinel exited before publishing its cwd')
    try {
      if (readlinkSync(`/proc/${child.pid}/cwd`) === canonicalExpected) return
    } catch {
      // The child is between fork and exec; keep waiting for the kernel-visible proof.
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`pid ${child.pid} never published cwd ${canonicalExpected}`)
}

function exited(child: ChildProcess, timeoutMs = 5_000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`pid ${child.pid} did not exit`)), timeoutMs)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

function alive(child: ChildProcess): boolean {
  if (!child.pid) return false
  try {
    process.kill(child.pid, 0)
    return true
  } catch {
    return false
  }
}

function procStartTime(pid: number): string {
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
  return stat
    .slice(stat.lastIndexOf(') ') + 2)
    .trim()
    .split(/\s+/)[19] as string
}

function spawnGuardian(owner: ChildProcess, runRoot: string): ChildProcess {
  const guardian = spawn(
    process.execPath,
    [GUARDIAN_ENTRY, String(owner.pid), procStartTime(owner.pid as number), runRoot],
    { cwd: REPO_ROOT, stdio: 'ignore', detached: true },
  )
  children.push(guardian)
  return guardian
}

function writeFakeStat(procRoot: string, pid: number, startTime: string): void {
  const fields = ['S', ...Array.from({ length: 18 }, () => '0'), startTime, '0']
  writeFileSync(
    join(procRoot, String(pid), 'stat'),
    `${pid} (sentinel worker) ${fields.join(' ')}\n`,
  )
}

afterEach(async () => {
  const spawnedChildren = children.splice(0)
  for (const child of spawnedChildren) {
    if (alive(child)) child.kill('SIGKILL')
  }
  await Promise.all(spawnedChildren.map((child) => exited(child).catch(() => {})))
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('stale test-run cwd oracle', () => {
  it('requires both an exact run-root component and the kernel deleted suffix', () => {
    const absent = (): boolean => false
    expect(isStaleTestRunCwd('/tmp/podium-test-run-abc (deleted)', absent)).toBe(true)
    expect(isStaleTestRunCwd('/tmp/podium-test-run-abc/workdir (deleted)', absent)).toBe(true)
    expect(isStaleTestRunCwd('/tmp/podium-test-run-abc', absent)).toBe(false)
    expect(isStaleTestRunCwd('/tmp/podium-e2e-abc (deleted)', absent)).toBe(false)
    expect(isStaleTestRunCwd('/tmp/not-podium-test-run-abc/workdir (deleted)', absent)).toBe(false)
  })

  it('does not select a deleted nested cwd while the matched run root is live', async () => {
    if (process.platform !== 'linux') return
    const runRoot = trackedDir('podium-test-run-active-')
    const nested = join(runRoot, 'journaled-server-worktree')
    mkdirSync(nested)
    markTestRunRootOwned(runRoot, {
      pid: process.pid,
      startTime: procStartTime(process.pid),
    })
    const legitimate = spawnSentinel(nested)
    await spawned(legitimate)
    await waitForCwd(legitimate, nested)

    rmSync(nested, { recursive: true, force: true })
    expect(readlinkSync(`/proc/${legitimate.pid}/cwd`)).toBe(`${nested} (deleted)`)
    expect(recoverStaleTestRunRoots(HOST_TMPDIR)).not.toContain(realpathSync(runRoot))
    const reaped = reapStaleTestRunProcesses()

    expect(reaped.some((candidate) => candidate.pid === legitimate.pid)).toBe(false)
    expect(alive(legitimate)).toBe(true)
  })

  it('reaps a deleted-run process and leaves an identically named legitimate server alive', async () => {
    if (process.platform !== 'linux') return
    const staleRoot = trackedDir('podium-test-run-stale-')
    const legitimateRoot = trackedDir('podium-legitimate-server-')
    const stale = spawnSentinel(staleRoot)
    const legitimate = spawnSentinel(legitimateRoot)
    await Promise.all([spawned(stale), spawned(legitimate)])
    await Promise.all([waitForCwd(stale, staleRoot), waitForCwd(legitimate, legitimateRoot)])

    rmSync(staleRoot, { recursive: true, force: true })
    expect(readlinkSync(`/proc/${stale.pid}/cwd`)).toBe(`${staleRoot} (deleted)`)
    const reaped = reapStaleTestRunProcesses()
    await exited(stale)

    // A concurrently starting lane may win this same global /proc candidate after
    // the deleted-cwd assertion above. The contract is the process fact: it is gone.
    expect(alive(stale)).toBe(false)
    expect(reaped.some((candidate) => candidate.pid === legitimate.pid)).toBe(false)
    expect(alive(legitimate)).toBe(true)
  })

  it('rejects a candidate whose PID start time changes after discovery', () => {
    if (process.platform !== 'linux') return
    const procRoot = trackedDir('podium-fake-proc-')
    const pid = 424242
    const pidRoot = join(procRoot, String(pid))
    mkdirSync(pidRoot)
    const missingRun = join(HOST_TMPDIR, 'podium-test-run-missing-pid-fence')
    symlinkSync(`${missingRun}/workdir (deleted)`, join(pidRoot, 'cwd'))
    writeFakeStat(procRoot, pid, '111')

    const [candidate] = listStaleTestRunProcesses(procRoot)
    expect(candidate?.startTime).toBe('111')
    writeFakeStat(procRoot, pid, '222')

    expect(candidate && stillSameStaleProcess(candidate, procRoot)).toBe(false)
  })
})

describe('live test-run guardian', () => {
  it('reaps the exact run after its owner is SIGKILLed and leaves a decoy server alive', async () => {
    if (process.platform !== 'linux') return
    const runRoot = trackedDir('podium-test-run-guardian-')
    const legitimateRoot = trackedDir('podium-legitimate-server-')
    const owner = spawnOwner()
    const target = spawnSentinel(runRoot)
    const legitimate = spawnSentinel(legitimateRoot)
    await Promise.all([spawned(owner), spawned(target), spawned(legitimate)])
    await Promise.all([waitForCwd(target, runRoot), waitForCwd(legitimate, legitimateRoot)])

    const guardian = spawnGuardian(owner, runRoot)
    await spawned(guardian)
    await new Promise((resolve) => setTimeout(resolve, 150))

    owner.kill('SIGKILL')
    await Promise.all([exited(owner), exited(target), exited(guardian)])

    expect(alive(target)).toBe(false)
    expect(alive(legitimate)).toBe(true)
  })

  it('canonicalizes a symlinked run root before matching proc cwd', async () => {
    if (process.platform !== 'linux') return
    const realHost = trackedDir('podium-real-tmp-')
    const aliasHost = join(HOST_TMPDIR, `podium-tmp-alias-${process.pid}-${Date.now()}`)
    symlinkSync(realHost, aliasHost, 'dir')
    dirs.push(aliasHost)
    const aliasRunRoot = mkdtempSync(join(aliasHost, 'podium-test-run-symlink-'))
    const owner = spawnOwner()
    const target = spawnSentinel(aliasRunRoot)
    await Promise.all([spawned(owner), spawned(target)])
    await waitForCwd(target, aliasRunRoot)

    const guardian = spawnGuardian(owner, aliasRunRoot)
    await spawned(guardian)
    await new Promise((resolve) => setTimeout(resolve, 150))
    owner.kill('SIGKILL')
    await Promise.all([exited(owner), exited(target), exited(guardian)])

    expect(alive(target)).toBe(false)
  })

  it('recovers a survivor after both guardian and owner are SIGKILLed', async () => {
    if (process.platform !== 'linux') return
    const runRoot = trackedDir('podium-test-run-double-kill-')
    const owner = spawnOwner()
    const target = spawnSentinel(runRoot)
    await Promise.all([spawned(owner), spawned(target)])
    await waitForCwd(target, runRoot)
    const canonicalRunRoot = realpathSync(runRoot)
    const ownerIdentity = {
      pid: owner.pid as number,
      startTime: procStartTime(owner.pid as number),
    }
    markTestRunRootOwned(runRoot, ownerIdentity)

    const guardian = spawnGuardian(owner, runRoot)
    await spawned(guardian)
    await new Promise((resolve) => setTimeout(resolve, 150))
    guardian.kill('SIGKILL')
    await exited(guardian)
    owner.kill('SIGKILL')
    await exited(owner)
    expect(alive(target)).toBe(true)

    expect(recoverStaleTestRunRoots(HOST_TMPDIR)).toContain(canonicalRunRoot)
    const reaped = reapStaleTestRunProcesses()
    await exited(target)

    expect(reaped.some((candidate) => candidate.pid === target.pid)).toBe(true)
    expect(alive(target)).toBe(false)
  })
})
