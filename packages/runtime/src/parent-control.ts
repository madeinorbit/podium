/**
 * Parent ←→ server control channel for update/handover requests.
 *
 * The server (or grant path) writes a request under the state dir and signals
 * the live parent; the parent performs swap + self-handover. [POD-2505]
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { stateDir } from './config'
import { liveRecord } from './run-registry'

export const PARENT_HANDOVER_SIGNAL: NodeJS.Signals = 'SIGUSR1'

export const HandoverRequest = z.object({
  /** Target version the successor must serve on /version. */
  expectedVersion: z.string().min(1),
  /** ISO timestamp of the request. */
  requestedAt: z.string(),
  /**
   * When true, the parent must run schema-gate + verified fetch + swap before
   * spawning the successor. When false, the bundle is already swapped and the
   * parent only runs handover (VERSION re-read still required).
   */
  performSwap: z.boolean().default(false),
  /** True when the release declares migrations the current DB has not applied. */
  releaseHadMigrations: z.boolean().default(false),
})
export type HandoverRequest = z.infer<typeof HandoverRequest>

export function handoverRequestPath(dir: string = stateDir()): string {
  return join(dir, 'run', 'handover-request.json')
}

export function writeHandoverRequest(
  request: HandoverRequest,
  dir: string = stateDir(),
): string {
  const parsed = HandoverRequest.parse(request)
  const path = handoverRequestPath(dir)
  mkdirSync(join(dir, 'run'), { recursive: true })
  writeFileSync(path, `${JSON.stringify(parsed, null, 2)}\n`)
  return path
}

export function readHandoverRequest(dir: string = stateDir()): HandoverRequest | undefined {
  const path = handoverRequestPath(dir)
  if (!existsSync(path)) return undefined
  try {
    return HandoverRequest.parse(JSON.parse(readFileSync(path, 'utf8')))
  } catch {
    return undefined
  }
}

export function clearHandoverRequest(dir: string = stateDir()): void {
  rmSync(handoverRequestPath(dir), { force: true })
}

export type SignalFn = (pid: number, signal?: NodeJS.Signals) => void

/**
 * Ask the live parent to run handover (and optionally swap). Returns false when
 * no parent is registered — caller should refuse with machine-cannot-restart.
 */
export function requestParentHandover(
  request: {
    expectedVersion: string
    performSwap?: boolean
    releaseHadMigrations?: boolean
    requestedAt?: string
  },
  opts: { stateDir?: string; signal?: SignalFn; kill?: SignalFn } = {},
): { ok: true; pid: number } | { ok: false; reason: 'no-parent' } {
  const dir = opts.stateDir ?? stateDir()
  const parent = liveRecord('parent')
  if (!parent) return { ok: false, reason: 'no-parent' }
  writeHandoverRequest(
    {
      expectedVersion: request.expectedVersion,
      performSwap: request.performSwap ?? false,
      releaseHadMigrations: request.releaseHadMigrations ?? false,
      requestedAt: request.requestedAt ?? new Date().toISOString(),
    },
    dir,
  )
  const kill = opts.signal ?? opts.kill ?? process.kill
  kill(parent.pid, PARENT_HANDOVER_SIGNAL)
  return { ok: true, pid: parent.pid }
}
