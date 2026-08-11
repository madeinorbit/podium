import type { LockAcquireResultWire } from '@podium/protocol'
import { DEV_BUNDLE_LOCK_NAME, type DevBundleLock } from './dev-bundle'

/**
 * The development build is a server job, not an interactive operator action.
 * This identity is constructed in-process only; no HTTP or CLI input can select
 * it, and the adapter below exposes authority over one fixed lock name only.
 */
export const DEV_BUNDLE_LOCK_SESSION = 'system:dev-bundle' as const
export const DEV_BUNDLE_LOCK_TTL_SECONDS = 15 * 60
const DEFAULT_POLL_INTERVAL_MS = 1_000

type DevBundleLockCaller = {
  sessionId: typeof DEV_BUNDLE_LOCK_SESSION
  issueId: null
  label: typeof DEV_BUNDLE_LOCK_SESSION
  workspace: null
}

type DevBundleLockRef = { repoPath: string; name: typeof DEV_BUNDLE_LOCK_NAME }

export interface DevBundleLockService {
  acquire(
    caller: DevBundleLockCaller,
    input: DevBundleLockRef & {
      ttlSeconds?: number
      note?: string
      allowSibling?: boolean
    },
  ): LockAcquireResultWire
  cancel(caller: DevBundleLockCaller, input: DevBundleLockRef): unknown
  renew(caller: DevBundleLockCaller, input: DevBundleLockRef & { ttlSeconds?: number }): unknown
  release(caller: DevBundleLockCaller, input: DevBundleLockRef): unknown
}

const DEV_BUNDLE_LOCK_CALLER: DevBundleLockCaller = {
  sessionId: DEV_BUNDLE_LOCK_SESSION,
  issueId: null,
  label: DEV_BUNDLE_LOCK_SESSION,
  workspace: null,
}

export interface ServerDevBundleLockOptions {
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  pollIntervalMs?: number
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

/**
 * Adapt the server's authoritative lock service to the bundle builder without
 * crossing the cookie-gated HTTP boundary. Contention retains the CLI's bounded
 * wait semantics and removes the durable queue entry on timeout.
 */
export function createServerDevBundleLock(
  root: string,
  locks: DevBundleLockService,
  opts: ServerDevBundleLockOptions = {},
): DevBundleLock {
  const now = opts.now ?? Date.now
  const sleep = opts.sleep ?? defaultSleep
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
  const ref: DevBundleLockRef = { repoPath: root, name: DEV_BUNDLE_LOCK_NAME }

  return {
    async acquire() {
      const deadline = now() + DEV_BUNDLE_LOCK_TTL_SECONDS * 1_000
      for (;;) {
        const result = locks.acquire(DEV_BUNDLE_LOCK_CALLER, {
          ...ref,
          ttlSeconds: DEV_BUNDLE_LOCK_TTL_SECONDS,
          note: 'server-owned development bundle build',
        })
        if (result.granted) return true
        if (now() >= deadline) {
          locks.cancel(DEV_BUNDLE_LOCK_CALLER, ref)
          return false
        }
        await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - now())))
      }
    },
    async renew() {
      locks.renew(DEV_BUNDLE_LOCK_CALLER, {
        ...ref,
        ttlSeconds: DEV_BUNDLE_LOCK_TTL_SECONDS,
      })
    },
    async release() {
      locks.release(DEV_BUNDLE_LOCK_CALLER, ref)
    },
  }
}
