import type { LockRow, LocksRepository, LockWaiterRow } from '../../store/locks'
import { OPERATOR_LOCK_SESSION } from '../../store/locks'
import type { WriteFunnel } from '../funnel'

/**
 * Advisory named lease locks [spec:SP-85d1] — server-side coordination tokens
 * for agents, scoped (repo_id, name). PURELY advisory: no code path refuses a
 * git merge because of a lock; `podium merge-lock` is a convention over it.
 *
 * Semantics (see the spec):
 *  - acquire: free/expired → grant · same-session → renew ("already held") ·
 *    held by another → FIFO enqueue (idempotent) + position report;
 *  - release: holder-only; the next live queued waiter is granted + mailed;
 *  - renew: holder-only lease extension;
 *  - steal: force-take (humans/stuck cases) — logged + previous holder mailed;
 *  - lazy expiry: every op sweeps expired leases in the repo first;
 *  - session-bound auto-release: releaseForSession on session exit.
 */

/** Default lease TTL (2 minutes) — also what queue-advance grants use. */
export const DEFAULT_LOCK_TTL_SECONDS = 120

/** Who is acquiring/holding: the relayed agent's session + bound issue, or the
 *  direct-HTTP operator (both null session and issue). */
export interface LockCallerIdentity {
  sessionId: string | null
  issueId: string | null
  label: string
}

export interface LockHolderWire {
  sessionId: string | null
  issueId: string | null
  label: string
}

export interface LockQueueEntryWire extends LockHolderWire {
  position: number
  enqueuedAt: string
}

export interface LockWire {
  repoId: string
  name: string
  holder: LockHolderWire
  note: string | null
  acquiredAt: string
  expiresAt: string
  secondsLeft: number
  queue: LockQueueEntryWire[]
}

export type LockAcquireResult =
  | { granted: true; alreadyHeld: boolean; lock: LockWire }
  | { granted: false; position: number; lock: LockWire }

export interface LockServiceDeps {
  locks: LocksRepository
  /** Cross-row atomicity for release→advance / sweep (SessionStore.transact). */
  transact<T>(fn: () => T): T
  funnel: Pick<WriteFunnel, 'run'>
  now(): number
  /** repoPath → stable repo_id (ReposRepository.resolveRepoIdForPath). */
  resolveRepoId(repoPath: string): string
  /** Is the session still around (waiter pruning)? Unknown/exited → false. */
  sessionAlive(sessionId: string): boolean
  /** Best-effort agent mail to an issue (IssueService.sendMail); never throws. */
  sendMail(issueId: string, from: string, body: string): void
  /** Durable event log append (steal audit trail). Best-effort. */
  appendEvent(e: { ts: string; kind: string; subject: string; payload?: unknown }): void
}

const fmtTtl = (s: number): string => (s % 60 === 0 ? `${s / 60}m` : `${s}s`)

export class LockService {
  constructor(private readonly deps: LockServiceDeps) {}

  private nowIso(): string {
    return new Date(this.deps.now()).toISOString()
  }

  private secondsLeft(expiresAt: string): number {
    return Math.max(0, Math.ceil((Date.parse(expiresAt) - this.deps.now()) / 1000))
  }

  private toWire(lock: LockRow): LockWire {
    const queue = this.deps.locks.listWaiters(lock.repoId, lock.name).map((w, i) => ({
      position: i + 1,
      sessionId: w.sessionId,
      issueId: w.issueId,
      label: w.label,
      enqueuedAt: w.enqueuedAt,
    }))
    return {
      repoId: lock.repoId,
      name: lock.name,
      holder: {
        sessionId: lock.holderSessionId,
        issueId: lock.holderIssueId,
        label: lock.holderLabel,
      },
      note: lock.note,
      acquiredAt: lock.acquiredAt,
      expiresAt: lock.expiresAt,
      secondsLeft: this.secondsLeft(lock.expiresAt),
      queue,
    }
  }

  /** The waiter-queue session key: real session id, or the operator sentinel. */
  private sessionKey(caller: LockCallerIdentity): string {
    return caller.sessionId ?? OPERATOR_LOCK_SESSION
  }

  private sameHolder(lock: LockRow, caller: LockCallerIdentity): boolean {
    // Operator re-acquire (null == null) renews too: two operator terminals are
    // the same principal for coordination purposes.
    return lock.holderSessionId === caller.sessionId
  }

  /** Grant `lock.name` to a waiter/caller: write the lease and notify by mail
   *  when the new holder has a bound issue. */
  private grantTo(
    repoId: string,
    name: string,
    holder: { sessionId: string | null; issueId: string | null; label: string },
    ttlSeconds: number,
    note: string | null,
    opts?: { notify?: boolean },
  ): LockRow {
    const acquiredAt = this.nowIso()
    const row: LockRow = {
      repoId,
      name,
      holderSessionId: holder.sessionId,
      holderIssueId: holder.issueId,
      holderLabel: holder.label,
      note,
      acquiredAt,
      expiresAt: new Date(this.deps.now() + ttlSeconds * 1000).toISOString(),
    }
    this.deps.locks.upsertLock(row)
    if (opts?.notify && holder.issueId) {
      this.deps.sendMail(
        holder.issueId,
        'lock-manager',
        `Lock '${name}' granted to you (TTL ${fmtTtl(ttlSeconds)}). Release with \`podium lock release ${name}\` when done.`,
      )
    }
    return row
  }

  /**
   * Advance the FIFO queue after the holder is gone (release / expiry /
   * session-exit / steal-of-free): prune dead waiters, grant to the first live
   * one (with a grant-notification mail), or delete the lock row when the
   * queue is empty. Returns the new holder row, or null when the lock is free.
   */
  private advanceQueue(repoId: string, name: string): LockRow | null {
    for (const w of this.deps.locks.listWaiters(repoId, name)) {
      // Skip/prune waiters whose sessions are gone. The operator sentinel has
      // no session and is never pruned — it discovers grants via polling.
      if (w.sessionId !== OPERATOR_LOCK_SESSION && !this.deps.sessionAlive(w.sessionId)) {
        this.deps.locks.removeWaiter(w.id)
        continue
      }
      this.deps.locks.removeWaiter(w.id)
      return this.grantTo(
        repoId,
        name,
        {
          sessionId: w.sessionId === OPERATOR_LOCK_SESSION ? null : w.sessionId,
          issueId: w.issueId,
          label: w.label,
        },
        DEFAULT_LOCK_TTL_SECONDS,
        null,
        { notify: true },
      )
    }
    this.deps.locks.deleteLock(repoId, name)
    return null
  }

  /** Lazy expiry: retire every expired lease in the repo, advancing each queue
   *  (with grant-notification mail). Runs first on every lock operation. */
  private sweepExpired(repoId: string): void {
    for (const lock of this.deps.locks.listExpiredLocks(repoId, this.nowIso())) {
      this.advanceQueue(lock.repoId, lock.name)
    }
  }

  private repoIdFor(repoPath: string): string {
    return this.deps.resolveRepoId(repoPath)
  }

  acquire(
    caller: LockCallerIdentity,
    input: { repoPath: string; name: string; ttlSeconds?: number; note?: string },
  ): LockAcquireResult {
    const ttl = input.ttlSeconds ?? DEFAULT_LOCK_TTL_SECONDS
    const repoId = this.repoIdFor(input.repoPath)
    return this.deps.funnel.run({
      write: () =>
        this.deps.transact(() => {
          this.sweepExpired(repoId)
          const existing = this.deps.locks.getLock(repoId, input.name)
          if (!existing) {
            const row = this.grantTo(repoId, input.name, caller, ttl, input.note ?? null)
            return { granted: true as const, alreadyHeld: false, lock: this.toWire(row) }
          }
          if (this.sameHolder(existing, caller)) {
            // Same-session re-acquire: renew (extend the lease from now),
            // keeping the original acquired_at.
            const row: LockRow = {
              ...existing,
              note: input.note ?? existing.note,
              expiresAt: new Date(this.deps.now() + ttl * 1000).toISOString(),
            }
            this.deps.locks.upsertLock(row)
            return { granted: true as const, alreadyHeld: true, lock: this.toWire(row) }
          }
          // Held by someone else → FIFO enqueue (idempotent per session).
          this.deps.locks.enqueueWaiter({
            repoId,
            name: input.name,
            sessionId: this.sessionKey(caller),
            issueId: caller.issueId,
            label: caller.label,
            enqueuedAt: this.nowIso(),
          })
          const wire = this.toWire(existing)
          const key = this.sessionKey(caller)
          const position = wire.queue.find(
            (w) => (w.sessionId ?? OPERATOR_LOCK_SESSION) === key,
          )?.position
          return { granted: false as const, position: position ?? wire.queue.length, lock: wire }
        }),
    })
  }

  release(
    caller: LockCallerIdentity,
    input: { repoPath: string; name: string },
  ): { released: true; next: LockHolderWire | null } {
    const repoId = this.repoIdFor(input.repoPath)
    return this.deps.funnel.run({
      write: () =>
        this.deps.transact(() => {
          this.sweepExpired(repoId)
          const existing = this.deps.locks.getLock(repoId, input.name)
          if (!existing) throw new Error(`lock '${input.name}' is not held`)
          if (!this.sameHolder(existing, caller)) {
            throw new Error(
              `lock '${input.name}' is held by ${existing.holderLabel}, not by you — cannot release`,
            )
          }
          const next = this.advanceQueue(repoId, input.name)
          return {
            released: true as const,
            next: next
              ? {
                  sessionId: next.holderSessionId,
                  issueId: next.holderIssueId,
                  label: next.holderLabel,
                }
              : null,
          }
        }),
    })
  }

  /** Leave the FIFO wait queue: remove the caller's own waiter entry. Errors
   *  when the caller isn't queued (a holder should `release`, not cancel). */
  cancel(
    caller: LockCallerIdentity,
    input: { repoPath: string; name: string },
  ): { cancelled: true } {
    const repoId = this.repoIdFor(input.repoPath)
    return this.deps.funnel.run({
      write: () =>
        this.deps.transact(() => {
          this.sweepExpired(repoId)
          const existing = this.deps.locks.getLock(repoId, input.name)
          if (existing && this.sameHolder(existing, caller)) {
            throw new Error(`you hold lock '${input.name}' — use \`release\`, not cancel`)
          }
          const key = this.sessionKey(caller)
          const queued = this.deps.locks
            .listWaiters(repoId, input.name)
            .some((w) => w.sessionId === key)
          if (!queued) throw new Error(`not queued for lock '${input.name}'`)
          this.deps.locks.removeWaiterBySession(repoId, input.name, key)
          return { cancelled: true as const }
        }),
    })
  }

  renew(
    caller: LockCallerIdentity,
    input: { repoPath: string; name: string; ttlSeconds?: number },
  ): LockWire {
    const ttl = input.ttlSeconds ?? DEFAULT_LOCK_TTL_SECONDS
    const repoId = this.repoIdFor(input.repoPath)
    return this.deps.funnel.run({
      write: () =>
        this.deps.transact(() => {
          this.sweepExpired(repoId)
          const existing = this.deps.locks.getLock(repoId, input.name)
          if (!existing) throw new Error(`lock '${input.name}' is not held`)
          if (!this.sameHolder(existing, caller)) {
            throw new Error(
              `lock '${input.name}' is held by ${existing.holderLabel}, not by you — cannot renew`,
            )
          }
          const expiresAt = new Date(this.deps.now() + ttl * 1000).toISOString()
          this.deps.locks.renewLock(repoId, input.name, existing.holderSessionId, expiresAt)
          const row = this.deps.locks.getLock(repoId, input.name)
          if (!row) throw new Error(`lock '${input.name}' vanished during renew`)
          return this.toWire(row)
        }),
    })
  }

  /** All locks in the repo, or just `name` (empty array when free). */
  status(input: { repoPath: string; name?: string }): LockWire[] {
    const repoId = this.repoIdFor(input.repoPath)
    return this.deps.funnel.run({
      write: () =>
        this.deps.transact(() => {
          this.sweepExpired(repoId)
          if (input.name != null) {
            const lock = this.deps.locks.getLock(repoId, input.name)
            return lock ? [this.toWire(lock)] : []
          }
          return this.deps.locks.listLocks(repoId).map((l) => this.toWire(l))
        }),
    })
  }

  /** Force-take regardless of holder (humans/stuck cases). Logged to the event
   *  log; the previous holder's issue gets a best-effort mail. The queue is
   *  kept intact; the stealer's own queue entry (if any) is removed. */
  steal(
    caller: LockCallerIdentity,
    input: { repoPath: string; name: string; ttlSeconds?: number; note?: string },
  ): { lock: LockWire; previousHolder: LockHolderWire | null } {
    const ttl = input.ttlSeconds ?? DEFAULT_LOCK_TTL_SECONDS
    const repoId = this.repoIdFor(input.repoPath)
    return this.deps.funnel.run({
      write: () =>
        this.deps.transact(() => {
          this.sweepExpired(repoId)
          const existing = this.deps.locks.getLock(repoId, input.name)
          const previousHolder: LockHolderWire | null =
            existing && !this.sameHolder(existing, caller)
              ? {
                  sessionId: existing.holderSessionId,
                  issueId: existing.holderIssueId,
                  label: existing.holderLabel,
                }
              : null
          this.deps.locks.removeWaiterBySession(repoId, input.name, this.sessionKey(caller))
          const row = this.grantTo(repoId, input.name, caller, ttl, input.note ?? null)
          if (previousHolder) {
            try {
              this.deps.appendEvent({
                ts: this.nowIso(),
                kind: 'lock.stolen',
                subject: `${repoId}:${input.name}`,
                payload: { previousHolder, newHolder: caller.label },
              })
            } catch {}
            if (previousHolder.issueId) {
              this.deps.sendMail(
                previousHolder.issueId,
                'lock-manager',
                `Lock '${input.name}' was stolen from you by ${caller.label}.`,
              )
            }
          }
          return { lock: this.toWire(row), previousHolder }
        }),
    })
  }

  /** Session-bound auto-release: on session exit, release every lock it holds
   *  (advancing each queue with grant-notification mail) and prune its queue
   *  entries. Fired from the session-lifecycle bus wiring. */
  releaseForSession(sessionId: string): void {
    this.deps.funnel.run({
      write: () =>
        this.deps.transact(() => {
          for (const w of this.deps.locks.listWaitsBySession(sessionId)) {
            this.deps.locks.removeWaiter(w.id)
          }
          for (const lock of this.deps.locks.listLocksHeldBySession(sessionId)) {
            this.advanceQueue(lock.repoId, lock.name)
          }
        }),
    })
  }
}

export type { LockRow, LockWaiterRow }
