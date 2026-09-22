/**
 * SERVER-OWNED DOCK-SHELL MAPPING (POD-4436, Phase 2 step 2 of POD-4414).
 *
 * "Which shell belongs to this worktree" is a server fact, not a per-device
 * browser map: per user, per worktree (normalized absolute path) → session
 * id. One dock shell per worktree (SP-75b1); tab shells from the + menu are
 * unmapped by design and never enter this mapping.
 *
 * ---------------------------------------------------------------------------
 * WHY CLAIM-BEFORE-CREATE, NOT CHECK-THEN-INSERT
 * ---------------------------------------------------------------------------
 * Two devices opening the same worktree at once must not create two shells.
 * `forWorktree` mints an id, claims the `(user, worktree)` row with INSERT
 * ... ON CONFLICT DO NOTHING, and only the winner spawns — the loser re-reads
 * the winner's row and never calls `createShell`. A check-then-insert passes
 * two sequential calls and proves nothing; the concurrency test races two
 * overlapping calls with a delayed create to prove the loser never spawns.
 *
 * A per-(user, worktree) in-process mutex serializes overlapping calls in this
 * process (both devices land on this server), so dead-shell replacement — an
 * upsert, which the PK cannot arbitrate — also spawns exactly once here. The
 * PK remains the cross-restart arbiter for the fresh-claim path.
 */

import { normalizeDockWorktreeKey, type MachineId, type SessionId, type UserId } from '@podium/model'
import { randomUUID } from 'node:crypto'
import { asSessionId } from '@podium/model'
import type { UserDockShellRepository } from '../../store/user-layout'

/** The session facts `forWorktree` needs — a narrow port, not the lifecycle. */
export interface DockShellSessionPort {
  sessionById(sessionId: SessionId): Promise<DockShellSessionView | undefined>
  createShell(input: {
    sessionId: SessionId
    cwd: string
    ownerUserId: UserId
    machineId?: MachineId
  }): Promise<{ sessionId: SessionId }>
  archiveSession?(sessionId: SessionId): Promise<void>
}

export interface DockShellSessionView {
  sessionId: SessionId
  agentKind: string
  archived: boolean
  status: string
}

export interface DockShellServiceDeps {
  dockShells: UserDockShellRepository
  sessions: DockShellSessionPort
  now?: () => string
}

export interface ForWorktreeResult {
  sessionId: SessionId
  /** True when this call created the shell; false when it attached to an existing row. */
  created: boolean
}

const MAX_ATTEMPTS = 3

export class DockShellService {
  private readonly locks = new Map<string, Promise<void>>()

  constructor(private readonly deps: DockShellServiceDeps) {}

  /** One user's dock shell for one worktree, without creating. */
  async get(userId: UserId, worktreePath: string): Promise<SessionId | undefined> {
    return await this.deps.dockShells.get(userId, worktreePath)
  }

  /** Every worktree→shell entry for one user. */
  async listForUser(userId: UserId): Promise<Record<string, SessionId>> {
    return await this.deps.dockShells.listForUser(userId)
  }

  /**
   * Forget every user's mapping for a freed worktree path. Freeing is global:
   * the disk fact holds for all devices, so every dock releases it. Returns
   * the retired session ids so the lifetime policy can park/kill per its rule
   * (step 4; the policy read of this mapping lands with terminal-lifetime).
   */
  async handleWorktreeFreed(worktreePath: string): Promise<SessionId[]> {
    return await this.deps.dockShells.removeByWorktree(worktreePath)
  }

  /**
   * Return-or-create the dock shell for (user, worktree). Creation stays a
   * normal shell spawn (agentKind 'shell'); only the mapping is new.
   */
  async forWorktree(
    userId: UserId,
    worktreePath: string,
    opts: { machineId?: MachineId } = {},
  ): Promise<ForWorktreeResult> {
    const key = normalizeDockWorktreeKey(worktreePath)
    if (key === null) {
      throw new Error(`'${worktreePath}' is not an absolute worktree path`)
    }
    return await this.withLock(`${userId}\0${key}`, async () => {
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        const existing = await this.deps.dockShells.get(userId, key)
        if (existing !== undefined) {
          const view = await this.deps.sessions.sessionById(existing)
          if (isLiveDockShell(view)) {
            return { sessionId: existing, created: false }
          }
          // Dead, missing, or non-shell: archive best-effort, then replace.
          if (view && !view.archived) {
            await this.deps.sessions.archiveSession?.(existing).catch(() => {})
          }
          const replacement = asSessionId(randomUUID())
          await this.deps.sessions.createShell({
            sessionId: replacement,
            cwd: key,
            ownerUserId: userId,
            ...(opts.machineId ? { machineId: opts.machineId } : {}),
          })
          await this.deps.dockShells.set(userId, key, replacement, this.nowIso())
          return { sessionId: replacement, created: true }
        }
        const claimed = asSessionId(randomUUID())
        const won = await this.deps.dockShells.tryClaim(userId, key, claimed, this.nowIso())
        if (won) {
          try {
            await this.deps.sessions.createShell({
              sessionId: claimed,
              cwd: key,
              ownerUserId: userId,
              ...(opts.machineId ? { machineId: opts.machineId } : {}),
            })
          } catch (error) {
            await this.deps.dockShells.removeBySession(claimed).catch(() => {})
            throw error
          }
          return { sessionId: claimed, created: true }
        }
        // Lost the claim: loop and re-read the winner's row.
      }
      throw new Error(`dock shell claim for '${key}' did not settle`)
    })
  }

  private nowIso(): string {
    return this.deps.now?.() ?? new Date().toISOString()
  }

  /** Serialize overlapping calls for one (user, worktree) in this process. */
  private async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prior = this.locks.get(key) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>((resolve) => {
      release = resolve
    })
    this.locks.set(key, prior.then(() => current))
    await prior
    try {
      return await fn()
    } finally {
      release()
      if (this.locks.get(key) === current) this.locks.delete(key)
    }
  }
}

/**
 * A mapped shell is live when it exists, is a shell, and is not dead. Dead is
 * archived-or-exited (the dock client's own rule); parked (hibernated) is NOT
 * dead — the same session id resumes in place — and starting/reconnecting are
 * healthy transients that must never trigger a replacement loop.
 */
function isLiveDockShell(view: DockShellSessionView | undefined): boolean {
  if (!view) return false
  if (view.agentKind !== 'shell') return false
  if (view.archived) return false
  if (view.status === 'exited') return false
  return true
}
