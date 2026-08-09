import type { IssueId, SessionId } from '@podium/model'
import type { LockAcquireResultWire, LockHolderWire, LockWire } from '@podium/protocol'
import type { LockRow, LockSessionKey, LocksRepository, LockWaiterRow } from '../../store/locks'
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

/** Default lease TTL (2 minutes). */
export const DEFAULT_LOCK_TTL_SECONDS = 120

/** Who is acquiring/holding: the relayed agent's session + bound issue, or the
 *  direct-HTTP operator (both null session and issue). */
export interface LockCallerIdentity {
  sessionId: LockHolderId | null
  issueId: IssueId | null
  label: string
  /**
   * Live workspace root for this caller (session cwd, usually the issue
   * worktree). Used to refuse co-located multi-issue contention that issue
   * labels alone cannot see. Null for the operator / unknown-relay.
   */
  workspace: string | null
}

/**
 * WHO holds (or waits on) a lock (POD-362).
 *
 * NOT plain `SessionId | null`, and that is deliberate: `registry.ts` produces
 * `UNKNOWN_RELAY_SESSION` ('unknown-session') for a relayed caller whose session
 * the live map does not know, and its own doc says it is DISTINCT from the
 * operator's null holder so an anomalous relay caller can never release an
 * operator-held lock. Branding it would launder a sentinel into the session id
 * space; the union keeps all three cases visible. POD-362's blanket
 * `sessionId: string` sweep branded this field and it was walked back here.
 */
export type LockHolderId = LockSessionKey

export type LockAcquireResult = LockAcquireResultWire

export interface LockServiceDeps {
  locks: LocksRepository
  /** Cross-row atomicity for release→advance / sweep (SessionStore.transact). */
  transact<T>(fn: () => T): T
  funnel: Pick<WriteFunnel, 'run'>
  now(): number
  /** repoPath → stable repo_id (ReposRepository.resolveRepoIdForPath). */
  resolveRepoId(repoPath: string): string
  /** Is the session still around (waiter pruning)? Unknown/exited → false. */
  /** `LockSessionKey`, not `SessionId`: `advanceQueue` DEPENDS on being able to
   *  look up `UNKNOWN_RELAY_SESSION` and get `false` — that miss is exactly how
   *  the unknown-relay sentinel gets pruned from a queue (see its doc in
   *  registry.ts). Narrowing this to `SessionId` would force a cast at the one
   *  call site and hide that mechanism. */
  sessionAlive(sessionId: LockHolderId): boolean
  /**
   * Live session workspace root (cwd) for addressability + co-location refuse.
   * Unknown / exited / sentinels → null. Same key type as sessionAlive.
   */
  sessionWorkspace(sessionId: LockHolderId): string | null
  /** Best-effort agent mail to an issue (IssueService.sendMail); never throws. */
  sendMail(issueId: string, from: string, body: string): void
  /** Durable event log append (steal audit trail). Best-effort. */
  appendEvent(e: { ts: string; kind: string; subject: string; payload?: unknown }): void
}

/** Normalize a path for co-location compares (trailing slashes, empty → null). */
export function normalizeWorkspace(raw: string | null | undefined): string | null {
  if (raw == null) return null
  const trimmed = raw.trim().replace(/\/+$/, '')
  return trimmed.length > 0 ? trimmed : null
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

  /** Liveness for a holder/waiter key: operator is always live; unknown-relay
   *  and missing sessions are dead (same rule advanceQueue uses for pruning). */
  private isAlive(sessionId: LockHolderId | null): boolean {
    if (sessionId == null || sessionId === OPERATOR_LOCK_SESSION) return true
    if (sessionId === 'unknown-session') return false
    return this.deps.sessionAlive(sessionId)
  }

  private workspaceOf(sessionId: LockHolderId | null): string | null {
    if (sessionId == null || sessionId === OPERATOR_LOCK_SESSION || sessionId === 'unknown-session') {
      return null
    }
    return normalizeWorkspace(this.deps.sessionWorkspace(sessionId))
  }

  private principalWire(
    sessionId: LockHolderId | null,
    issueId: IssueId | null,
    label: string,
  ): LockHolderWire {
    return {
      sessionId,
      issueId,
      label,
      alive: this.isAlive(sessionId),
      workspace: this.workspaceOf(sessionId),
    }
  }

  private toWire(lock: LockRow): LockWire {
    const queue = this.deps.locks.listWaiters(lock.repoId, lock.name).map((w, i) => ({
      position: i + 1,
      ...this.principalWire(w.sessionId, w.issueId, w.label),
      sessionId: w.sessionId,
      enqueuedAt: w.enqueuedAt,
    }))
    return {
      repoId: lock.repoId,
      name: lock.name,
      holder: this.principalWire(lock.holderSessionId, lock.holderIssueId, lock.holderLabel),
      note: lock.note,
      acquiredAt: lock.acquiredAt,
      expiresAt: lock.expiresAt,
      secondsLeft: this.secondsLeft(lock.expiresAt),
      queue,
    }
  }

  /**
   * A sibling is another session that already holds or is queued for the same
   * lock and shares either (a) the same issue binding, or (b) the same live
   * workspace root. Issue-only keying misses the multi-issue / shared-worktree
   * collision (POD-516): many issues in one checkout all label as the worktree
   * owner, and their real issue ids do not match each other. `--allow-sibling`
   * opts into genuine concurrent multi-session access.
   */
  private findSibling(
    lock: LockRow,
    caller: LockCallerIdentity,
  ): {
    kind: 'holder' | 'waiter'
    reason: 'issue' | 'workspace'
    sessionId: LockHolderId | null
    label: string
    position?: number
  } | null {
    const callerKey = this.sessionKey(caller)
    const callerWorkspace =
      normalizeWorkspace(caller.workspace) ?? this.workspaceOf(caller.sessionId)

    const matches = (
      otherSessionId: LockHolderId | null,
      otherIssueId: IssueId | null,
    ): 'issue' | 'workspace' | null => {
      if (otherSessionId === caller.sessionId) return null
      // Operator (null session) is never a "sibling" of an agent.
      if (caller.sessionId == null || otherSessionId == null) return null
      if (otherSessionId === OPERATOR_LOCK_SESSION || otherSessionId === 'unknown-session') {
        return null
      }
      if (
        caller.issueId != null &&
        otherIssueId != null &&
        otherIssueId === caller.issueId
      ) {
        return 'issue'
      }
      if (callerWorkspace != null) {
        const otherWs = this.workspaceOf(otherSessionId)
        if (otherWs != null && otherWs === callerWorkspace) return 'workspace'
      }
      return null
    }

    const holderReason = matches(lock.holderSessionId, lock.holderIssueId)
    if (holderReason) {
      return {
        kind: 'holder',
        reason: holderReason,
        sessionId: lock.holderSessionId,
        label: lock.holderLabel,
      }
    }
    const waiters = this.deps.locks.listWaiters(lock.repoId, lock.name)
    for (let i = 0; i < waiters.length; i++) {
      const w = waiters[i]!
      if (w.sessionId === callerKey) continue
      const reason = matches(
        w.sessionId === OPERATOR_LOCK_SESSION ? null : w.sessionId,
        w.issueId,
      )
      if (reason) {
        return {
          kind: 'waiter',
          reason,
          sessionId: w.sessionId === OPERATOR_LOCK_SESSION ? null : w.sessionId,
          label: w.label,
          position: i + 1,
        }
      }
    }
    return null
  }

  /** The waiter-queue session key: real session id, or the operator sentinel. */
  private sessionKey(caller: LockCallerIdentity): LockHolderId {
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
    holder: LockCallerIdentity,
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
          workspace: this.workspaceOf(
            w.sessionId === OPERATOR_LOCK_SESSION ? null : w.sessionId,
          ),
        },
        w.ttlSeconds,
        w.note,
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
    input: {
      repoPath: string
      name: string
      ttlSeconds?: number
      note?: string
      /**
       * Opt into queueing/holding alongside another session on the same issue
       * or shared worktree (co-located multi-session access).
       */
      allowSibling?: boolean
    },
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
          // Idempotent re-acquire while already queued: report position, no
          // sibling check (the caller's own entry is the match, not a sibling).
          const key = this.sessionKey(caller)
          const alreadyQueued = this.deps.locks
            .listWaiters(repoId, input.name)
            .find((w) => w.sessionId === key)
          if (!alreadyQueued && !input.allowSibling) {
            const sibling = this.findSibling(existing, caller)
            if (sibling) {
              const who =
                sibling.sessionId != null
                  ? `${sibling.sessionId} (${sibling.label})`
                  : sibling.label
              const via =
                sibling.reason === 'workspace'
                  ? 'sharing this worktree'
                  : 'on the same issue'
              if (sibling.kind === 'holder') {
                throw new Error(
                  `sibling ${who} already holds lock '${input.name}' (${via}) — coordinate with them, or pass --allow-sibling for serialised multi-session access`,
                )
              }
              throw new Error(
                `sibling ${who} is already queued for lock '${input.name}' at position ${sibling.position} (${via}) — coordinate with them, or pass --allow-sibling for serialised multi-session access`,
              )
            }
          }
          // Held by someone else → FIFO enqueue (idempotent per session).
          this.deps.locks.enqueueWaiter({
            repoId,
            name: input.name,
            sessionId: key,
            issueId: caller.issueId,
            label: caller.label,
            ttlSeconds: ttl,
            note: input.note ?? alreadyQueued?.note ?? null,
            enqueuedAt: this.nowIso(),
          })
          const wire = this.toWire(existing)
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
              ? this.principalWire(next.holderSessionId, next.holderIssueId, next.holderLabel)
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
              ? this.principalWire(
                  existing.holderSessionId,
                  existing.holderIssueId,
                  existing.holderLabel,
                )
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
  releaseForSession(sessionId: SessionId): void {
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
