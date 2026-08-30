/**
 * Worker-backed recovery-snapshot verification (POD-3068).
 *
 * The rule this file exists to enforce: a request handler never opens a
 * retained backup. `updates.start` used to call a scan that ran
 * `PRAGMA quick_check` over every retained snapshot — three ~747 MiB files on
 * Ludovico — and held the event loop for ~80 seconds while planning a
 * machine-only update it did not even need a snapshot for.
 *
 * So the answer is split in two:
 *
 *  - READING is stat-only. {@link SnapshotVerifier.verifiedFallbackPath} reads
 *    the published catalogue and stats the recorded file. Microseconds, and an
 *    honest `undefined` when nothing has been verified yet.
 *  - PROVING happens in a killable child process, once, under a deadline, and
 *    its result is published only if the candidate still has the identity the
 *    child was launched against.
 *
 * The server-replacement step is the one caller allowed to WAIT for a proof
 * ({@link SnapshotVerifier.verify}); it awaits a Promise inside the operation
 * runner while this process keeps serving requests.
 */

import { type ChildProcess, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { createLogger } from '@podium/logger'
import { retainedSnapshotPaths } from './backup'
import {
  readSnapshotCatalogue,
  retainSnapshotRecords,
  type SnapshotIdentity,
  type SnapshotRecord,
  sameSnapshotIdentity,
  snapshotIdentity,
  upsertSnapshotRecord,
  verificationCandidates,
  verifiedFallback,
  writeSnapshotCatalogue,
} from './snapshot-catalogue'
import type { VerifySnapshotRequest, VerifySnapshotResult } from './snapshot-verification'
import { SNAPSHOT_VERIFIER_ENV } from './snapshot-verifier-child'

const log = createLogger('server:snapshot-verifier')

/** A snapshot of this size takes minutes at worst; past that it is stuck, not slow. */
export const SNAPSHOT_VERIFY_TIMEOUT_MS = 600_000

/** How long a terminated child is given to exit cleanly before it is killed. */
export const SNAPSHOT_VERIFY_KILL_GRACE_MS = 5_000

/** How many verification records the catalogue keeps (mirrors backup retention). */
export const SNAPSHOT_RECORDS_TO_KEEP = 3

export type SnapshotVerification =
  | { ok: true; path: string; schemaVersion?: string; durationMs: number }
  | { ok: false; code: string; detail: string; durationMs: number }

/** What a child run produced, before it is judged against the candidate. */
export interface SnapshotChildOutcome {
  result?: VerifySnapshotResult
  /** Set when the child itself failed — crash, timeout, unparsable output. */
  failure?: { code: 'timeout' | 'crashed' | 'unreadable-output' | 'cancelled'; detail: string }
}

export type SnapshotChildRunner = (
  request: VerifySnapshotRequest,
  timeoutMs: number,
  /** Aborted when the owner shuts down; the child must not outlive it. */
  signal: AbortSignal,
) => Promise<SnapshotChildOutcome>

export interface SnapshotVerifierDeps {
  runChild?: SnapshotChildRunner
  now?: () => number
  keep?: number
  timeoutMs?: number
  /** Injected so a test never leaves a real timer behind. */
  schedule?: (fn: () => void) => void
}

/**
 * Launch the verifier as a child of this binary.
 *
 * `process.execPath` is the compiled `podium` binary in an installation and
 * `bun` in a source checkout; the entry in both cases inspects
 * `PODIUM_VERIFY_SNAPSHOT` before it does anything else, so no public CLI
 * surface is added for it. The request goes through the environment rather than
 * argv so an operator's `ps` output never carries state-dir paths.
 */
export function spawnSnapshotVerifierChild(
  request: VerifySnapshotRequest,
  timeoutMs: number,
  deps: {
    spawnProcess?: typeof spawn
    execPath?: string
    compiled?: boolean
    killGraceMs?: number
    /** Shutdown seam: aborting terminates the child on the same escalation. */
    signal?: AbortSignal
  } = {},
): Promise<SnapshotChildOutcome> {
  const spawnProcess = deps.spawnProcess ?? spawn
  const compiled = deps.compiled ?? import.meta.url.includes('/$bunfs/')
  const args = compiled
    ? ['snapshot-verify']
    : [
        '--conditions=@podium/source',
        fileURLToPath(new URL('../../../../scripts/cli.ts', import.meta.url)),
        'snapshot-verify',
      ]
  return new Promise<SnapshotChildOutcome>((resolve) => {
    let child: ChildProcess
    try {
      child = spawnProcess(deps.execPath ?? process.execPath, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, [SNAPSHOT_VERIFIER_ENV]: JSON.stringify(request) },
      })
    } catch (error) {
      resolve({
        failure: {
          code: 'crashed',
          detail: error instanceof Error ? error.message : String(error),
        },
      })
      return
    }

    let stdout = ''
    let stderr = ''
    let settled = false
    let killTimer: ReturnType<typeof setTimeout> | undefined
    // Settling does NOT cancel the pending SIGKILL: the parent stops waiting at
    // the deadline, but the child still has to die. Only the child actually
    // exiting cancels it.
    const finish = (outcome: SnapshotChildOutcome): void => {
      if (settled) return
      settled = true
      clearTimeout(deadline)
      resolve(outcome)
    }
    let detachAbort: () => void = () => {}
    const childGone = (): void => {
      if (killTimer) clearTimeout(killTimer)
      killTimer = undefined
      detachAbort()
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })

    // Ask first, then insist. A child mid-`quick_check` is inside a synchronous
    // native call and will not see SIGTERM until it returns, which is exactly
    // why this path exists as a process and not as a worker thread.
    const terminate = (): void => {
      try {
        child.kill('SIGTERM')
      } catch {}
      if (killTimer) return
      killTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL')
        } catch {}
      }, deps.killGraceMs ?? SNAPSHOT_VERIFY_KILL_GRACE_MS)
      killTimer.unref?.()
    }

    const deadline = setTimeout(() => {
      terminate()
      finish({ failure: { code: 'timeout', detail: `no result within ${timeoutMs}ms` } })
    }, timeoutMs)
    deadline.unref?.()

    // Shutdown uses the SAME escalation as the deadline. A server that stops
    // while a verifier is scanning must not leave a multi-minute `quick_check`
    // orphaned behind it.
    const onAbort = (): void => {
      terminate()
      finish({ failure: { code: 'cancelled', detail: 'the verifier was shut down' } })
    }
    if (deps.signal?.aborted) {
      onAbort()
      return
    }
    deps.signal?.addEventListener('abort', onAbort, { once: true })
    detachAbort = () => deps.signal?.removeEventListener('abort', onAbort)

    child.once('error', (error: Error) => {
      childGone()
      finish({ failure: { code: 'crashed', detail: error.message } })
    })
    child.once('close', (code: number | null, signal: NodeJS.Signals | null) => {
      childGone()
      if (code !== 0) {
        finish({
          failure: {
            code: 'crashed',
            detail: `verifier exited code=${code ?? 'null'} signal=${signal ?? 'none'}${
              stderr ? `: ${stderr.trim().slice(0, 500)}` : ''
            }`,
          },
        })
        return
      }
      const line = stdout.trim().split('\n').filter(Boolean).pop()
      if (!line) {
        finish({ failure: { code: 'unreadable-output', detail: 'verifier printed no result' } })
        return
      }
      try {
        finish({ result: JSON.parse(line) as VerifySnapshotResult })
      } catch (error) {
        finish({
          failure: {
            code: 'unreadable-output',
            detail: error instanceof Error ? error.message : String(error),
          },
        })
      }
    })
  })
}

/**
 * One verifier per store instance: the catalogue reader, the child owner, and
 * the publisher of verified markers.
 */
export class SnapshotVerifier {
  private inFlight: Promise<SnapshotVerification> | undefined
  private backgroundQueued = false
  private closed = false
  /** Aborted by {@link close}; the in-flight child dies with the server. */
  private readonly lifetime = new AbortController()

  constructor(
    private readonly dbPath: string,
    private readonly deps: SnapshotVerifierDeps = {},
  ) {}

  private now(): number {
    return (this.deps.now ?? Date.now)()
  }

  private records(): SnapshotRecord[] {
    return readSnapshotCatalogue(this.dbPath)
  }

  /**
   * The catalogue, plus a `pending` record for every retained snapshot the
   * catalogue has never heard of. Stat-only, and it opens nothing.
   *
   * This is the 0.1.0 compatibility path. An installation that upgrades into the
   * verifier has `<db>.backup-v*` files and no catalogue at all, and the boot
   * migration (`migrations/index.ts`) still stages snapshots without publishing
   * a record. Starting discovery from the catalogue alone would leave every one
   * of those files permanently invisible — never verified, never offered, never
   * even queued. So discovery starts from the DIRECTORY and the catalogue is
   * what it converges on.
   */
  /**
   * Catalogue rows whose file is still on disk.
   *
   * A row pointing at a deleted snapshot is not history, it is noise: it can
   * never be a verified fallback (the fallback is identity-matched against the
   * file) and never a verification candidate (a missing file is skipped). What
   * it CAN do is occupy a slot in finite retention — three pruned rows with
   * recent verification timestamps were enough to push a real, still-present
   * 0.1.0 backup out of the catalogue before it was ever seeded. So a row is
   * dropped when the thing it describes is gone.
   */
  private livingRecords(): SnapshotRecord[] {
    return this.records().filter((row) => snapshotIdentity(row.path) !== undefined)
  }

  private recordsIncludingLegacy(): SnapshotRecord[] {
    const records = this.livingRecords()
    const known = new Set(records.map((row) => row.path))
    const discovered = retainedSnapshotPaths(this.dbPath)
      .filter((path) => !known.has(path))
      .flatMap((path) => {
        const identity = snapshotIdentity(path)
        if (!identity) return []
        return [
          {
            ...identity,
            outcome: 'pending' as const,
            correlationId: 'legacy-discovery',
            // Dated by the FILE, not by the discovery: a pre-existing snapshot
            // is as old as it is, and must not jump the retention queue merely
            // because this boot was the first to notice it.
            recordedAtMs: identity.mtimeMs,
          },
        ]
      })
    return [...records, ...discovered]
  }

  /**
   * The cheap read every boot, maintenance pass and request path uses: metadata
   * and `stat`, nothing else. `undefined` means "nothing verified is known
   * right now", which is an honest answer and never a reason to block.
   */
  verifiedFallbackPath(): string | undefined {
    if (this.closed) return undefined
    return verifiedFallback(this.records())?.path
  }

  /**
   * Bring the catalogue up to date with the directory and queue at most one
   * background verification. Called at boot and maintenance — NEVER from a
   * request path, because seeding records writes a file and queueing starts a
   * child, and update planning is allowed to do neither.
   */
  discoverAndQueue(): boolean {
    if (this.closed) return false
    const merged = this.recordsIncludingLegacy()
    // Compared by PATH SET, not by count: this pass both drops rows for deleted
    // files and adds rows for discovered ones, so an equal length is no evidence
    // that nothing changed.
    const before = new Set(this.records().map((row) => row.path))
    const after = new Set(merged.map((row) => row.path))
    const changed = before.size !== after.size || [...after].some((path) => !before.has(path))
    if (changed) {
      const active = verifiedFallback(merged)?.path
      writeSnapshotCatalogue(
        this.dbPath,
        retainSnapshotRecords(merged, this.deps.keep ?? SNAPSHOT_RECORDS_TO_KEEP, active),
      )
    }
    return this.queueBackgroundVerification()
  }

  /** The verified record itself, for callers that want its schema identity too. */
  verifiedFallbackRecord(): SnapshotRecord | undefined {
    return this.closed ? undefined : verifiedFallback(this.records())
  }

  /**
   * Publish a `pending` record for a freshly staged snapshot. Written before the
   * child starts so a crash mid-verification is legible afterwards as "this file
   * was staged and never proved" rather than as silence.
   */
  recordStaged(path: string, correlationId: string): SnapshotIdentity | undefined {
    const identity = snapshotIdentity(path)
    if (!identity) return undefined
    this.publish({
      ...identity,
      outcome: 'pending',
      correlationId,
      recordedAtMs: this.now(),
    })
    return identity
  }

  private publish(record: SnapshotRecord): void {
    const existing = this.livingRecords()
    const next = upsertSnapshotRecord(existing, record)
    const active = verifiedFallback(next)?.path
    writeSnapshotCatalogue(
      this.dbPath,
      retainSnapshotRecords(next, this.deps.keep ?? SNAPSHOT_RECORDS_TO_KEEP, active),
    )
  }

  /**
   * Prove `path` in a child process and publish the result.
   *
   * Awaiting this is legitimate ONLY from the operation runner: the event loop
   * stays free while the child works, which is what lets health and read
   * requests continue during a server replacement.
   */
  async verify(path: string, expectedSchemaVersion?: string): Promise<SnapshotVerification> {
    if (this.closed) {
      return { ok: false, code: 'stopped', detail: 'the verifier is shut down', durationMs: 0 }
    }
    // One verifier per instance. A caller arriving while a run is in flight
    // waits for it rather than starting a second scan of the same disk.
    const previous = this.inFlight
    if (previous) {
      try {
        await previous
      } catch {}
    }
    const run = this.runOnce(path, expectedSchemaVersion)
    this.inFlight = run
    try {
      return await run
    } finally {
      if (this.inFlight === run) this.inFlight = undefined
    }
  }

  private async runOnce(
    path: string,
    expectedSchemaVersion: string | undefined,
  ): Promise<SnapshotVerification> {
    const correlationId = randomUUID()
    const startedAt = this.now()
    const expected = snapshotIdentity(path)
    if (!expected) {
      const detail = 'the snapshot file is not present'
      log.warn('recovery snapshot verification skipped', { path, correlationId, detail })
      return { ok: false, code: 'missing', detail, durationMs: 0 }
    }
    this.publish({ ...expected, outcome: 'pending', correlationId, recordedAtMs: startedAt })
    log.info('recovery snapshot verification started', {
      path,
      correlationId,
      bytes: expected.size,
      phase: 'worker-start',
    })

    const timeoutMs = this.deps.timeoutMs ?? SNAPSHOT_VERIFY_TIMEOUT_MS
    const runChild =
      this.deps.runChild ??
      ((request, ms, signal) => spawnSnapshotVerifierChild(request, ms, { signal }))
    const request: VerifySnapshotRequest = {
      path,
      expected,
      correlationId,
      ...(expectedSchemaVersion ? { expectedSchemaVersion } : {}),
    }
    const outcome = await runChild(request, timeoutMs, this.lifetime.signal)
    const durationMs = this.now() - startedAt

    // A result that names a different run, or that describes a candidate the
    // file no longer matches, is DROPPED. Publishing it would let a slow answer
    // about an older file overwrite the verdict on a newer one.
    const current = snapshotIdentity(path)
    const stale =
      outcome.result !== undefined &&
      (outcome.result.correlationId !== correlationId || !sameSnapshotIdentity(expected, current))
    if (stale) {
      log.warn('recovery snapshot verification result was superseded', {
        path,
        correlationId,
        durationMs,
        phase: 'verification',
      })
      return {
        ok: false,
        code: 'superseded',
        detail: 'the snapshot changed while it was being verified',
        durationMs,
      }
    }

    if (outcome.failure) {
      // The child failed; the SNAPSHOT is not thereby condemned. `failed` says
      // "unproved", which never advertises the file and never deletes it.
      this.publish({
        ...expected,
        outcome: 'failed',
        correlationId,
        recordedAtMs: this.now(),
        diagnostic: outcome.failure.detail.slice(0, 500),
      })
      log.warn('recovery snapshot verification did not complete', {
        path,
        correlationId,
        durationMs,
        code: outcome.failure.code,
        detail: outcome.failure.detail,
        phase: 'publication',
      })
      return { ok: false, code: outcome.failure.code, detail: outcome.failure.detail, durationMs }
    }

    const result = outcome.result
    if (!result) {
      const detail = 'the verifier produced no result'
      this.publish({
        ...expected,
        outcome: 'failed',
        correlationId,
        recordedAtMs: this.now(),
        diagnostic: detail,
      })
      return { ok: false, code: 'unreadable-output', detail, durationMs }
    }

    if (!result.ok) {
      this.publish({
        ...expected,
        outcome: 'invalid',
        correlationId,
        recordedAtMs: this.now(),
        diagnostic: `${result.code}: ${result.detail}`.slice(0, 500),
      })
      log.warn('recovery snapshot did not verify', {
        path,
        correlationId,
        durationMs,
        code: result.code,
        detail: result.detail,
        phase: 'publication',
      })
      return { ok: false, code: result.code, detail: result.detail, durationMs }
    }

    this.publish({
      ...expected,
      outcome: 'verified',
      correlationId,
      recordedAtMs: this.now(),
      ...(result.schemaVersion ? { schemaVersion: result.schemaVersion } : {}),
    })
    log.info('recovery snapshot verified', {
      path,
      correlationId,
      durationMs,
      bytes: expected.size,
      ...(result.schemaVersion ? { schemaVersion: result.schemaVersion } : {}),
      phase: 'publication',
    })
    return {
      ok: true,
      path,
      ...(result.schemaVersion ? { schemaVersion: result.schemaVersion } : {}),
      durationMs,
    }
  }

  /**
   * Queue AT MOST ONE background verification for the newest undecided or
   * changed record. Nothing waits for it; boot and maintenance are readiness
   * paths and may not be delayed by a disk scan.
   */
  queueBackgroundVerification(): boolean {
    if (this.closed || this.backgroundQueued || this.inFlight) return false
    const candidate = verificationCandidates(this.recordsIncludingLegacy())[0]
    if (!candidate) return false
    this.backgroundQueued = true
    const schedule = this.deps.schedule ?? ((fn: () => void) => void setImmediate(fn))
    schedule(() => {
      void this.verify(candidate.path)
        .catch((error: unknown) => {
          log.warn('background recovery snapshot verification failed', {
            path: candidate.path,
            err: error,
          })
        })
        .finally(() => {
          this.backgroundQueued = false
        })
    })
    return true
  }

  /**
   * Stop verifying and take the child with us.
   *
   * Flipping a flag would not be a shutdown: a `quick_check` on a
   * multi-hundred-megabyte file runs for minutes, so a verifier left alone here
   * outlives the server that started it. Aborting the lifetime signal runs the
   * same SIGTERM → grace → SIGKILL escalation the deadline uses.
   */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.lifetime.abort()
  }
}
