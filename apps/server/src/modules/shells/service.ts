/**
 * SERVER-OWNED DOCK-SHELL MAPPING (POD-4436, Phase 2 step 2 of POD-4414).
 *
 * "Which shell belongs to this worktree" is a server fact, not a per-device
 * browser map: per user, per worktree (normalized absolute path) → session
 * id. One dock shell per worktree (SP-75b1); tab shells from the + menu are
 * unmapped by design and never enter this mapping.
 *
 * ---------------------------------------------------------------------------
 * WHY CLAIM-BEFORE-CREATE, NOT CHECK-THEN-INSERT — AND WHAT ARBITRATES WHAT
 * ---------------------------------------------------------------------------
 * Two devices opening the same worktree at once must not create two shells.
 * `forWorktree` mints an id, claims the `(user, worktree)` row with INSERT
 * ... ON CONFLICT DO NOTHING, and only the claim winner spawns. A
 * check-then-insert passes two sequential calls and proves nothing; the
 * concurrency test races two overlapping calls with a delayed create to prove
 * the loser never spawns.
 *
 * THE IN-PROCESS MUTEX IS THE CREATION ARBITER, NOT THE PK. Both devices land
 * on one server process, and the per-(user, worktree) mutex serializes their
 * overlapping calls — that, and only that, is what makes exactly one spawn
 * here. The PK keeps the ROW single-valued, and it arbitrates fresh claims
 * only once the winner's session exists (a loser that re-reads a live row
 * attaches and never spawns). It does NOT arbitrate the in-flight window: a
 * loser that re-reads between the winner's claim and the winner's create
 * finds a row with no session, reads it as dead, and takes the replacement
 * branch — a second shell overwriting the winner's row. Disabling only the
 * mutex makes the concurrency test fail with two ids, PK intact.
 *
 * So two server processes racing one worktree are OUTSIDE this guarantee (one
 * deployment runs one server). A crash between claim and create is fine the
 * other way: the orphan row reads as dead and the next call correctly
 * replaces it. Closing the cross-process window — the loser waiting for the
 * winner's session instead of replacing — is a behaviour change, deliberately
 * not done here.
 */

import {
  normalizeDockWorktreeKey,
  type IssueId,
  type MachineId,
  type SessionId,
  type UserId,
} from '@podium/model'
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

/**
 * THE POLICY'S OWNING-WORKTREE INPUT (POD-4436 step 3).
 *
 * The lifetime table takes an owning worktree per shell, and the stop path
 * answered it from a cwd string (`issueForCwd(session.cwd)`). A dock shell's
 * cwd can be a subdir, stale, or bound to a different issue than the worktree
 * it serves — so the table learns the worktree from the server mapping
 * instead: session id → worktree key (exact), then key → owning issue.
 *
 * Only shells can be mapped (tab shells from the + menu are unmapped by
 * design, SP-75b1), so a non-shell answers undefined without touching the
 * store and its caller falls back to exactly what it did before. An unmapped
 * shell likewise answers undefined. A mapped shell whose key resolves to no
 * issue (deleted out from under it) falls back to its bound issue, if any —
 * the old answer is preserved rather than replaced with nothing.
 */
export interface DockShellOwnerSession {
  sessionId: SessionId
  agentKind: string
  issueId?: IssueId | null | undefined
}

export interface DockShellOwnerDeps {
  worktreeForSession(
    sessionId: SessionId,
  ): Promise<ReadonlyArray<{ userId: UserId; worktreeKey: string }>>
  issueForCwd(cwd: string): Promise<IssueId | null | undefined>
}

export interface DockShellOwner {
  /** The exact owning worktree key from the server mapping. */
  worktreeKey: string
  /** The top-level issue owning that worktree, when one still does. */
  issueId?: IssueId | undefined
}

export async function resolveDockShellOwner(
  deps: DockShellOwnerDeps,
  session: DockShellOwnerSession,
): Promise<DockShellOwner | undefined> {
  if (session.agentKind !== 'shell') return undefined
  const rows = await deps.worktreeForSession(session.sessionId)
  const worktreeKey = rows[0]?.worktreeKey
  if (!worktreeKey) return undefined
  const owner = await deps.issueForCwd(worktreeKey)
  return {
    worktreeKey,
    ...(owner ? { issueId: owner } : {}),
    ...(!owner && session.issueId ? { issueId: session.issueId } : {}),
  }
}

/**
 * THE OWNING ISSUE OF A SHELL (POD-4526): one resolver with one precedence,
 * called by all three lifetime triggers (reaper projection, tab-release,
 * stop/issue-close).
 *
 * Precedence is MAPPING-FIRST: the mapping's owning issue wins over the
 * bound issue; a mapped shell whose worktree resolves to no issue, and any
 * unmapped shell, fall back to the bound issue; otherwise undefined.
 *
 * WHY: session id → worktree key is an exact server fact (POD-4436), while
 * the bound issue may be stale or simply differ from the worktree the dock
 * shell serves — a dock shell's cwd is created from the key, so the key, not
 * the binding, names the worktree whose owner decides keep/park/kill. The
 * reaper previously answered bound-first (and skipped the mapping entirely
 * for bound shells) while tab-release and stop answered mapping-first, so
 * one shell bound to open A but mapped to closed B read as owner-open in one
 * trigger and owner-closed in another. Every trigger now calls this function
 * instead of re-deriving the `??` order at its call site.
 *
 * LIMITS: non-shells never touch the store and answer their bound issue via
 * the same fallback; there is deliberately NO cwd-containment fallback here —
 * containing a cwd string is a guess, and only the stop path keeps its old
 * `issueForCwd(session.cwd)` last resort for the free target (pinned there).
 */
export async function resolveShellOwningIssue(
  deps: DockShellOwnerDeps,
  session: DockShellOwnerSession,
): Promise<IssueId | undefined> {
  const mapped = await resolveDockShellOwner(deps, session)
  if (mapped?.issueId) return mapped.issueId
  return session.issueId ?? undefined
}
