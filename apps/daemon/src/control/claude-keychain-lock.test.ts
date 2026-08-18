import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  acquireClaudeStorageWriteLock,
  CLAUDE_STORAGE_LOCK_CONTRACT,
  createClaudeStorageLockFactory,
} from './claude-keychain-lock'

const temporaryDirectories: string[] = []

function temporaryLockDirectory(): { readonly directory: string; readonly artifact: string } {
  const directory = mkdtempSync(join(tmpdir(), 'podium-claude-lock-behavior-'))
  temporaryDirectories.push(directory)
  return { directory, artifact: join(directory, CLAUDE_STORAGE_LOCK_CONTRACT.artifactName) }
}

afterEach(() => {
  vi.useRealTimers()
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('production Claude storage lock behavior', () => {
  it('retries a live contention and leaves cleanup to the owner', async () => {
    vi.useFakeTimers()
    const { directory, artifact } = temporaryLockDirectory()
    const owner = await acquireClaudeStorageWriteLock(directory)
    const contender = acquireClaudeStorageWriteLock(directory)
    const rejected = expect(contender).rejects.toMatchObject({ code: 'ELOCKED' })

    await vi.advanceTimersByTimeAsync(8_000)
    await rejected
    expect(lstatSync(artifact).isDirectory()).toBe(true)
    await owner.release()
    expect(existsSync(artifact)).toBe(false)
  })

  it('takes over a stale empty directory artifact', async () => {
    const { directory, artifact } = temporaryLockDirectory()
    mkdirSync(artifact)
    const stale = new Date(Date.now() - CLAUDE_STORAGE_LOCK_CONTRACT.staleMs - 1_000)
    utimesSync(artifact, stale, stale)

    const lock = await acquireClaudeStorageWriteLock(directory)
    expect(lstatSync(artifact).isDirectory()).toBe(true)
    expect(readdirSync(artifact)).toEqual([])
    expect(statSync(artifact).mtime.getTime()).toBeGreaterThan(stale.getTime())
    await lock.release()
    expect(existsSync(artifact)).toBe(false)
  })

  it('refreshes its heartbeat and reports an externally changed artifact as compromised', async () => {
    vi.useFakeTimers()
    const { directory, artifact } = temporaryLockDirectory()
    const healthy = await acquireClaudeStorageWriteLock(directory)
    const initialMtime = statSync(artifact).mtime.getTime()

    await vi.advanceTimersByTimeAsync(CLAUDE_STORAGE_LOCK_CONTRACT.updateMs)
    expect(statSync(artifact).mtime.getTime()).toBeGreaterThan(initialMtime)
    await healthy.release()

    const compromised = await acquireClaudeStorageWriteLock(directory)
    const changed = new Date(statSync(artifact).mtime.getTime() + 1_000)
    utimesSync(artifact, changed, changed)
    await vi.advanceTimersByTimeAsync(CLAUDE_STORAGE_LOCK_CONTRACT.updateMs)
    expect(compromised.compromised).toBe(true)
    await expect(compromised.release()).rejects.toMatchObject({ code: 'ECOMPROMISED' })
  })

  it('waits for an in-flight heartbeat before release and safe reacquisition', async () => {
    vi.useFakeTimers()
    const { directory, artifact } = temporaryLockDirectory()
    let reachHeartbeat!: () => void
    const heartbeatReached = new Promise<void>((resolve) => {
      reachHeartbeat = resolve
    })
    let resumeHeartbeat!: () => void
    const heartbeatGate = new Promise<void>((resolve) => {
      resumeHeartbeat = resolve
    })
    const acquire = createClaudeStorageLockFactory({
      async beforeHeartbeatTouch() {
        reachHeartbeat()
        await heartbeatGate
      },
    })
    const first = await acquire(directory)
    const advancingHeartbeat = vi.advanceTimersByTimeAsync(CLAUDE_STORAGE_LOCK_CONTRACT.updateMs)
    await heartbeatReached

    let releaseSettled = false
    const releasing = first.release().then(() => {
      releaseSettled = true
    })
    await Promise.resolve()
    expect(releaseSettled).toBe(false)
    resumeHeartbeat()
    await advancingHeartbeat
    await releasing
    expect(existsSync(artifact)).toBe(false)

    const second = await acquireClaudeStorageWriteLock(directory)
    const reacquiredMtime = statSync(artifact).mtime.getTime()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(statSync(artifact).mtime.getTime()).toBe(reacquiredMtime)
    expect(second.compromised).toBe(false)
    await second.release()
  })
})
