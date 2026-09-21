import { rmdirSync } from 'node:fs'
import { mkdir, rmdir, stat, utimes } from 'node:fs/promises'
import { join } from 'node:path'

export const CLAUDE_STORAGE_LOCK_CONTRACT = Object.freeze({
  targetName: '.storage-write',
  artifactName: '.storage-write.lock',
  staleMs: 15_000,
  updateMs: 7_500,
  retries: 10,
  minRetryMs: 100,
  maxRetryMs: 1_000,
  artifactKind: 'directory' as const,
  payload: 'none' as const,
})

export interface ClaudeStorageWriteLock {
  readonly compromised: boolean
  release(): Promise<void>
}

export type ClaudeStorageLockFactory = (storageDirectory: string) => Promise<ClaudeStorageWriteLock>

export interface ClaudeStorageLockHooks {
  /** Test seam after ownership verification and before the heartbeat touch. */
  readonly beforeHeartbeatTouch?: () => Promise<void>
}

const ownedArtifacts = new Set<string>()
let exitCleanupInstalled = false

function trackOwnedArtifact(path: string): void {
  ownedArtifacts.add(path)
  if (exitCleanupInstalled) return
  exitCleanupInstalled = true
  process.once('exit', () => {
    for (const artifact of ownedArtifacts) {
      try {
        rmdirSync(artifact)
      } catch {
        // A released, stale-reclaimed, or compromised lock is not ours to remove.
      }
    }
  })
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined
}

function lockBusy(): Error & { code: string } {
  return Object.assign(new Error('Claude secure-storage lock is held'), { code: 'ELOCKED' })
}

function retryDelay(attempt: number): number {
  return Math.min(
    CLAUDE_STORAGE_LOCK_CONTRACT.minRetryMs * 2 ** attempt,
    CLAUDE_STORAGE_LOCK_CONTRACT.maxRetryMs,
  )
}

function wait(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs))
}

async function createLockDirectory(lockPath: string, allowStaleRemoval = true): Promise<Date> {
  try {
    await mkdir(lockPath)
  } catch (error: unknown) {
    if (errorCode(error) !== 'EEXIST') throw error
    if (!allowStaleRemoval) throw lockBusy()
    const metadata = await stat(lockPath).catch((statError: unknown) => {
      if (errorCode(statError) === 'ENOENT') return undefined
      throw statError
    })
    if (!metadata) return createLockDirectory(lockPath, false)
    if (metadata.mtime.getTime() >= Date.now() - CLAUDE_STORAGE_LOCK_CONTRACT.staleMs) {
      throw lockBusy()
    }
    await rmdir(lockPath)
    return createLockDirectory(lockPath, false)
  }

  const probe = new Date(Math.ceil(Date.now() / 1_000) * 1_000 + 5)
  try {
    await utimes(lockPath, probe, probe)
    return (await stat(lockPath)).mtime
  } catch (error: unknown) {
    await rmdir(lockPath).catch(() => {})
    throw error
  }
}

export function createClaudeStorageLockFactory(
  hooks: ClaudeStorageLockHooks = {},
): ClaudeStorageLockFactory {
  return async (storageDirectory) => {
    await mkdir(storageDirectory, { recursive: true })
    const lockPath = join(storageDirectory, CLAUDE_STORAGE_LOCK_CONTRACT.artifactName)
    let mtime: Date | undefined
    let lastError: unknown
    for (let attempt = 0; attempt <= CLAUDE_STORAGE_LOCK_CONTRACT.retries; attempt += 1) {
      try {
        mtime = await createLockDirectory(lockPath)
        break
      } catch (error: unknown) {
        lastError = error
        if (errorCode(error) !== 'ELOCKED' || attempt === CLAUDE_STORAGE_LOCK_CONTRACT.retries) {
          throw error
        }
        await wait(retryDelay(attempt))
      }
    }
    if (!mtime) throw lastError ?? lockBusy()
    trackOwnedArtifact(lockPath)

    let expectedMtime = mtime.getTime()
    let lastUpdate = Date.now()
    let compromised = false
    let released = false
    let heartbeat: NodeJS.Timeout | undefined
    let heartbeatWork: Promise<void> = Promise.resolve()
    let scheduleHeartbeat!: (delay?: number) => void

    const runHeartbeat = async (): Promise<void> => {
      if (released || compromised) return
      try {
        const current = await stat(lockPath)
        if (released || compromised) return
        if (current.mtime.getTime() !== expectedMtime) {
          compromised = true
          ownedArtifacts.delete(lockPath)
          return
        }
        await hooks.beforeHeartbeatTouch?.()
        // Release waits for this work. This second check prevents an old owner
        // from touching a lock directory after release has started.
        if (released || compromised) return
        const next = new Date(Date.now())
        await utimes(lockPath, next, next)
        if (released || compromised) return
        const refreshed = await stat(lockPath)
        if (released || compromised) return
        expectedMtime = refreshed.mtime.getTime()
        lastUpdate = Date.now()
        scheduleHeartbeat()
      } catch (error: unknown) {
        if (released || compromised) return
        if (
          errorCode(error) === 'ENOENT' ||
          lastUpdate + CLAUDE_STORAGE_LOCK_CONTRACT.staleMs < Date.now()
        ) {
          compromised = true
          ownedArtifacts.delete(lockPath)
          return
        }
        scheduleHeartbeat(1_000)
      }
    }

    scheduleHeartbeat = (delay: number = CLAUDE_STORAGE_LOCK_CONTRACT.updateMs) => {
      heartbeat = setTimeout(() => {
        heartbeatWork = runHeartbeat()
      }, delay)
      heartbeat.unref()
    }
    scheduleHeartbeat()

    return {
      get compromised() {
        return compromised
      },
      async release() {
        if (released) {
          throw Object.assign(new Error('lock is already released'), { code: 'ERELEASED' })
        }
        released = true
        if (heartbeat) clearTimeout(heartbeat)
        await heartbeatWork
        if (compromised) {
          throw Object.assign(new Error('lock was compromised'), { code: 'ECOMPROMISED' })
        }
        try {
          await rmdir(lockPath).catch((error: unknown) => {
            if (errorCode(error) !== 'ENOENT') throw error
          })
        } finally {
          ownedArtifacts.delete(lockPath)
        }
      },
    }
  }
}

export const acquireClaudeStorageWriteLock = createClaudeStorageLockFactory()
