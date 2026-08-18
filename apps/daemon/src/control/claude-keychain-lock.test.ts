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
import { access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  acquireClaudeStorageWriteLock,
  CLAUDE_STORAGE_LOCK_CONTRACT,
  createClaudeStorageLockFactory,
  type ClaudeStorageWriteLock,
} from './claude-keychain-lock'

const temporaryDirectories: string[] = []

function temporaryLockDirectory(): { readonly directory: string; readonly artifact: string } {
  const directory = mkdtempSync(join(tmpdir(), 'podium-claude-lock-behavior-'))
  temporaryDirectories.push(directory)
  return { directory, artifact: join(directory, CLAUDE_STORAGE_LOCK_CONTRACT.artifactName) }
}

async function waitForCondition(
  condition: () => boolean,
  failure: string,
  artifact: string,
): Promise<void> {
  for (let turn = 0; turn < 1_000; turn += 1) {
    if (condition()) return
    // A real filesystem completion yields to mkdir/stat continuations without
    // depending on any clock primitive intercepted by Bun's fake timers.
    await access(artifact).catch(() => {})
  }
  throw new Error(failure)
}

async function waitForRetryTimer(artifact: string): Promise<void> {
  await waitForCondition(
    () => vi.getTimerCount() >= 1,
    'contender did not schedule its retry timer',
    artifact,
  )
}

async function releaseQuietly(lock: ClaudeStorageWriteLock | undefined): Promise<void> {
  await lock?.release().catch(() => {})
}

afterEach(() => {
  vi.useRealTimers()
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('production Claude storage lock behavior', () => {
  it('retries contention without removing another live owner artifact', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { directory, artifact } = temporaryLockDirectory()
    mkdirSync(artifact)
    try {
      const contenderResult = acquireClaudeStorageWriteLock(directory).then(
        (lock) => ({ lock }),
        (error: unknown) => ({ error }),
      )

      for (let retry = 0; retry < CLAUDE_STORAGE_LOCK_CONTRACT.retries; retry += 1) {
        await waitForRetryTimer(artifact)
        vi.advanceTimersToNextTimer()
      }

      const result = await contenderResult
      if ('lock' in result) await releaseQuietly(result.lock)
      expect(result).toEqual({ error: expect.objectContaining({ code: 'ELOCKED' }) })
      expect(lstatSync(artifact).isDirectory()).toBe(true)
    } finally {
      rmSync(artifact, { recursive: true, force: true })
    }
  })

  it('takes over a stale empty directory artifact', async () => {
    const { directory, artifact } = temporaryLockDirectory()
    mkdirSync(artifact)
    const stale = new Date(Date.now() - CLAUDE_STORAGE_LOCK_CONTRACT.staleMs - 1_000)
    utimesSync(artifact, stale, stale)

    const lock = await acquireClaudeStorageWriteLock(directory)
    try {
      expect(lstatSync(artifact).isDirectory()).toBe(true)
      expect(readdirSync(artifact)).toEqual([])
      expect(statSync(artifact).mtime.getTime()).toBeGreaterThan(stale.getTime())
    } finally {
      await releaseQuietly(lock)
    }
    expect(existsSync(artifact)).toBe(false)
  })

  it('refreshes its heartbeat and reports an externally changed artifact as compromised', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { directory, artifact } = temporaryLockDirectory()
    const healthy = await acquireClaudeStorageWriteLock(directory)
    try {
      const initialMtime = statSync(artifact).mtime.getTime()
      vi.advanceTimersByTime(CLAUDE_STORAGE_LOCK_CONTRACT.updateMs)
      await waitForCondition(
        () => statSync(artifact).mtime.getTime() !== initialMtime,
        'heartbeat did not refresh the lock artifact',
        artifact,
      )
    } finally {
      await releaseQuietly(healthy)
    }

    const compromised = await acquireClaudeStorageWriteLock(directory)
    let releaseAttempted = false
    try {
      const changed = new Date(statSync(artifact).mtime.getTime() + 1_000)
      utimesSync(artifact, changed, changed)
      vi.advanceTimersByTime(CLAUDE_STORAGE_LOCK_CONTRACT.updateMs)
      await waitForCondition(
        () => compromised.compromised,
        'heartbeat did not observe the externally changed artifact',
        artifact,
      )
      releaseAttempted = true
      await expect(compromised.release()).rejects.toMatchObject({ code: 'ECOMPROMISED' })
    } finally {
      if (!releaseAttempted) await releaseQuietly(compromised)
    }
  })

  it('waits for an in-flight heartbeat before release and safe reacquisition', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
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
    let releasing: Promise<void> | undefined
    try {
      vi.advanceTimersByTime(CLAUDE_STORAGE_LOCK_CONTRACT.updateMs)
      await heartbeatReached

      let releaseSettled = false
      releasing = first.release().then(() => {
        releaseSettled = true
      })
      await Promise.resolve()
      expect(releaseSettled).toBe(false)
      resumeHeartbeat()
      await releasing
      expect(existsSync(artifact)).toBe(false)
    } finally {
      resumeHeartbeat()
      await releasing?.catch(() => {})
      if (!releasing) await releaseQuietly(first)
    }

    const second = await acquireClaudeStorageWriteLock(directory)
    try {
      const reacquiredMtime = statSync(artifact).mtime.getTime()
      vi.advanceTimersByTime(1_000)
      expect(statSync(artifact).mtime.getTime()).toBe(reacquiredMtime)
      expect(second.compromised).toBe(false)
    } finally {
      await releaseQuietly(second)
    }
  })
})
