/** Linux process integration: real /proc cwd links, signals, and parent death. */
import { type ChildProcess, spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, readlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { isStaleTestRunCwd, reapStaleTestRunProcesses } from './reap-stale-test-runs'

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

function spawned(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once('spawn', resolve)
    child.once('error', reject)
  })
}

async function waitForCwd(child: ChildProcess, expected: string): Promise<void> {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    if (!child.pid || !alive(child)) throw new Error('sentinel exited before publishing its cwd')
    try {
      if (readlinkSync(`/proc/${child.pid}/cwd`) === expected) return
    } catch {
      // The child is between fork and exec; keep waiting for the kernel-visible proof.
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`pid ${child.pid} never published cwd ${expected}`)
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
    expect(isStaleTestRunCwd('/tmp/podium-test-run-abc (deleted)')).toBe(true)
    expect(isStaleTestRunCwd('/tmp/podium-test-run-abc/workdir (deleted)')).toBe(true)
    expect(isStaleTestRunCwd('/tmp/podium-test-run-abc')).toBe(false)
    expect(isStaleTestRunCwd('/tmp/podium-e2e-abc (deleted)')).toBe(false)
    expect(isStaleTestRunCwd('/tmp/not-podium-test-run-abc/workdir (deleted)')).toBe(false)
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

    expect(reaped.some((candidate) => candidate.pid === stale.pid)).toBe(true)
    expect(reaped.some((candidate) => candidate.pid === legitimate.pid)).toBe(false)
    expect(alive(legitimate)).toBe(true)
  })
})

describe('live test-run guardian', () => {
  it('reaps the exact run after its owner is SIGKILLed and leaves a decoy server alive', async () => {
    if (process.platform !== 'linux') return
    const runRoot = trackedDir('podium-test-run-guardian-')
    const legitimateRoot = trackedDir('podium-legitimate-server-')
    const owner = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      cwd: REPO_ROOT,
      stdio: 'ignore',
    })
    const target = spawnSentinel(runRoot)
    const legitimate = spawnSentinel(legitimateRoot)
    children.push(owner)
    await Promise.all([spawned(owner), spawned(target), spawned(legitimate)])
    await Promise.all([waitForCwd(target, runRoot), waitForCwd(legitimate, legitimateRoot)])

    const guardian = spawn(
      process.execPath,
      [GUARDIAN_ENTRY, String(owner.pid), procStartTime(owner.pid as number), runRoot],
      { cwd: REPO_ROOT, stdio: 'ignore', detached: true },
    )
    children.push(guardian)
    await spawned(guardian)
    await new Promise((resolve) => setTimeout(resolve, 150))

    owner.kill('SIGKILL')
    await Promise.all([exited(owner), exited(target), exited(guardian)])

    expect(alive(target)).toBe(false)
    expect(alive(legitimate)).toBe(true)
  })
})
