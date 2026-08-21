/**
 * Parent ←→ server control channel for update swap and self-handover [POD-2505].
 *
 * TWO request kinds, because spec §8 disposition 11 moves the swap itself into
 * the parent:
 *
 *  - `swap`     — the parent runs schema-gate-before-fetch, verified fetch,
 *                 atomic swap (retaining `.old`) and the post-swap VERSION
 *                 re-read fence. The server does NOT swap its own bundle out
 *                 from under itself; it asks and waits for the answer.
 *  - `handover` — the bundle on disk is already the target; the parent spawns
 *                 the successor parent and waits for it to be healthy.
 *
 * A `swap` needs an answer (a fetch can fail, and the operation's `server` step
 * has to report `download-failed` with a real reason rather than hanging), so
 * the parent writes a RESULT file keyed by the request id and the caller polls
 * for it. `handover` has no useful answer — by the time it succeeds the asking
 * server has been replaced.
 *
 * The files live under `<stateDir>/run/`; the wakeup is SIGUSR1 to the pid in
 * the parent's run-registry record.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { stateDir } from './config'
import { liveRecord } from './run-registry'

export const PARENT_HANDOVER_SIGNAL: NodeJS.Signals = 'SIGUSR1'

export const ParentRequestKind = z.enum(['swap', 'handover'])
export type ParentRequestKind = z.infer<typeof ParentRequestKind>

export const ParentRequest = z.object({
  /** Correlates a request with its result file. */
  requestId: z.string().min(1),
  kind: ParentRequestKind,
  /** Target version the successor must serve on /version. */
  expectedVersion: z.string().min(1),
  /** ISO timestamp of the request. */
  requestedAt: z.string(),
  /**
   * For `swap`: the full update target, so the parent can plan convergence,
   * schema-gate it against this machine's ledger and fetch the verified bundle.
   * Kept as a passthrough object — the parent parses it with the protocol's own
   * `UpdateTarget` schema, and runtime must not re-declare that shape here.
   */
  target: z.record(z.unknown()).optional(),
  /**
   * For `swap`: the public half of the instance's update-signing key, so the
   * parent verifies dev-published bundles against the SAME pin the server
   * advertises. The server owns that identity (it mints the key); the parent
   * must not re-derive it, so it travels with the request. Public by
   * construction — it is what pairing daemons are handed.
   */
  pinnedPubkey: z.string().optional(),
})
export type ParentRequest = z.infer<typeof ParentRequest>

export const ParentResult = z.object({
  requestId: z.string().min(1),
  kind: ParentRequestKind,
  ok: z.boolean(),
  /** Failure reason, verbatim, when `ok` is false. */
  error: z.string().optional(),
  /**
   * Set by a successful `swap`: did the release the parent just installed carry
   * migrations this database had not applied? Decision 4 forbids rollback when
   * it did, and this is the ONLY place that can answer it — the parent is what
   * reads the target's declared migrations against the live ledger.
   */
  releaseHadMigrations: z.boolean().optional(),
  completedAt: z.string(),
})
export type ParentResult = z.infer<typeof ParentResult>

/**
 * The parent's UNSOLICITED report about the release it was asked to install.
 *
 * A result file answers a request; this one answers nothing, because by the time
 * the parent knows the release is bad the process that asked has been replaced
 * or killed. Decision 4 requires the parent to "report WHY rollback was
 * unavailable", and §4 requires a rollback to end as a `stuck` report rather
 * than as a silent revert — so the outcome is written where the NEXT server to
 * boot will find it, and that server folds it into the update operation it
 * adopts (`reconcileUpdateOperation`).
 */
export const ParentOutcome = z.object({
  at: z.string(),
  outcome: z.enum(['rolled-back', 'rollback-unavailable']),
  /** One plain sentence: what happened to the release, and why. */
  why: z.string().min(1),
  /** The version the machine is left running. */
  version: z.string().optional(),
})
export type ParentOutcome = z.infer<typeof ParentOutcome>

export function parentOutcomePath(dir: string = stateDir()): string {
  return join(dir, 'run', 'parent-outcome.json')
}

export function writeParentOutcome(outcome: ParentOutcome, dir: string = stateDir()): void {
  const parsed = ParentOutcome.parse(outcome)
  mkdirSync(join(dir, 'run'), { recursive: true })
  writeFileSync(parentOutcomePath(dir), `${JSON.stringify(parsed, null, 2)}\n`)
}

export function readParentOutcome(dir: string = stateDir()): ParentOutcome | undefined {
  const path = parentOutcomePath(dir)
  if (!existsSync(path)) return undefined
  try {
    return ParentOutcome.parse(JSON.parse(readFileSync(path, 'utf8')))
  } catch {
    return undefined
  }
}

/**
 * Consume the report. Called by the server that read it: the note describes the
 * boot that just happened, and leaving it would misattribute it to a later one.
 */
export function clearParentOutcome(dir: string = stateDir()): void {
  rmSync(parentOutcomePath(dir), { force: true })
}

export function parentRequestPath(dir: string = stateDir()): string {
  return join(dir, 'run', 'parent-request.json')
}

export function parentResultPath(dir: string = stateDir()): string {
  return join(dir, 'run', 'parent-result.json')
}

export function writeParentRequest(request: ParentRequest, dir: string = stateDir()): string {
  const parsed = ParentRequest.parse(request)
  const path = parentRequestPath(dir)
  mkdirSync(join(dir, 'run'), { recursive: true })
  // A stale result from an earlier request must never be read as this one's answer.
  rmSync(parentResultPath(dir), { force: true })
  writeFileSync(path, `${JSON.stringify(parsed, null, 2)}\n`)
  return path
}

export function readParentRequest(dir: string = stateDir()): ParentRequest | undefined {
  const path = parentRequestPath(dir)
  if (!existsSync(path)) return undefined
  try {
    return ParentRequest.parse(JSON.parse(readFileSync(path, 'utf8')))
  } catch {
    return undefined
  }
}

export function clearParentRequest(dir: string = stateDir()): void {
  rmSync(parentRequestPath(dir), { force: true })
}

export function writeParentResult(result: ParentResult, dir: string = stateDir()): void {
  const parsed = ParentResult.parse(result)
  mkdirSync(join(dir, 'run'), { recursive: true })
  writeFileSync(parentResultPath(dir), `${JSON.stringify(parsed, null, 2)}\n`)
}

export function readParentResult(
  requestId: string,
  dir: string = stateDir(),
): ParentResult | undefined {
  const path = parentResultPath(dir)
  if (!existsSync(path)) return undefined
  try {
    const parsed = ParentResult.parse(JSON.parse(readFileSync(path, 'utf8')))
    return parsed.requestId === requestId ? parsed : undefined
  } catch {
    return undefined
  }
}

export type SignalFn = (pid: number, signal?: NodeJS.Signals) => void

export interface ParentRequestOptions {
  stateDir?: string
  signal?: SignalFn
  kill?: SignalFn
  /** Injectable clock/ids for tests. */
  now?: () => number
  newId?: () => string
  sleep?: (ms: number) => Promise<void>
}

const sleepMs = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function post(
  kind: ParentRequestKind,
  request: { expectedVersion: string; target?: Record<string, unknown>; pinnedPubkey?: string },
  opts: ParentRequestOptions,
): { ok: true; pid: number; requestId: string } | { ok: false; reason: 'no-parent' } {
  const dir = opts.stateDir ?? stateDir()
  const parent = liveRecord('parent')
  if (!parent) return { ok: false, reason: 'no-parent' }
  const requestId = opts.newId?.() ?? `${kind}-${(opts.now?.() ?? Date.now()).toString(36)}`
  writeParentRequest(
    {
      requestId,
      kind,
      expectedVersion: request.expectedVersion,
      requestedAt: new Date(opts.now?.() ?? Date.now()).toISOString(),
      ...(request.target ? { target: request.target } : {}),
      ...(request.pinnedPubkey ? { pinnedPubkey: request.pinnedPubkey } : {}),
    },
    dir,
  )
  const kill = opts.signal ?? opts.kill ?? process.kill
  kill(parent.pid, PARENT_HANDOVER_SIGNAL)
  return { ok: true, pid: parent.pid, requestId }
}

/**
 * Ask the live parent to run self-handover onto the bundle already on disk.
 * Returns false when no parent is registered — the caller must surface
 * machine-cannot-restart rather than pretending a restart is under way
 * (disposition 6).
 */
export function requestParentHandover(
  request: { expectedVersion: string },
  opts: ParentRequestOptions = {},
): { ok: true; pid: number } | { ok: false; reason: 'no-parent' } {
  const posted = post('handover', request, opts)
  return posted.ok ? { ok: true, pid: posted.pid } : posted
}

/**
 * Ask the live parent to schema-gate, fetch, verify and swap `target`, and WAIT
 * for its answer. Resolves once the parent has written its result; rejects with
 * the parent's own reason on failure, and on timeout.
 */
export async function requestParentSwap(
  request: { expectedVersion: string; target: Record<string, unknown>; pinnedPubkey?: string },
  opts: ParentRequestOptions & { timeoutMs?: number } = {},
): Promise<{ releaseHadMigrations: boolean }> {
  const dir = opts.stateDir ?? stateDir()
  const posted = post('swap', request, opts)
  if (!posted.ok) {
    throw new Error(
      'machine-cannot-restart: no supervising parent is registered to install this update',
    )
  }
  const now = opts.now ?? Date.now
  const sleep = opts.sleep ?? sleepMs
  const deadline = now() + (opts.timeoutMs ?? 20 * 60_000)
  while (now() < deadline) {
    const result = readParentResult(posted.requestId, dir)
    if (result) {
      if (!result.ok) throw new Error(result.error ?? 'the parent could not install this update')
      return { releaseHadMigrations: result.releaseHadMigrations === true }
    }
    await sleep(250)
  }
  throw new Error(
    `the supervising parent (pid ${posted.pid}) did not answer the install request in time`,
  )
}
