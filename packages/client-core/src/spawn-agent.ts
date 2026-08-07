import type { AgentKind, IssueId, RepoId, SessionId } from '@podium/model'
import type { PodiumClientApi } from './api'

/** Where a new agent lands: a worktree path + its owning repo (+ machine). */
export interface SpawnTarget {
  path: string
  repoPath: string
  /* Stable project identity used to keep optimistic sidebar rows in the same
   * group as their reconciled server row. */
  repoId?: RepoId
  machineId?: string
  placement?: 'allowed' | 'unauthorized' | 'unreachable'
}

/**
 * The network half of the "New <Agent> in <Repo>" spawn: create the session (in a
 * fresh draft-issue vessel) on the server, then deliver an optional first prompt.
 *
 * The caller mints `sessionId` + `issueId` client-side and passes them here so the
 * server reuses them verbatim (issue #119) — that's what lets the store paint an
 * optimistic row that reconciles by id when the broadcast lands. This function does
 * NOT touch UI state; `store.spawnDraftAgent` wraps it with the optimistic overlay
 * (instant row + rollback-on-failure). Rejects if the create fails, so the wrapper
 * can roll back.
 *
 * `firstPrompt` rides `sessions.create.initialPrompt` so argv-capable harnesses
 * (claude/codex/grok) get it on the launch command — race-free. resumeAndSend is
 * only the fallback for harnesses that cannot take a launch argv: typing into a
 * fresh Grok PTY does not start a turn (POD-549).
 */
export class SpawnPlacementError extends Error {
  constructor(readonly reason: 'unauthorized' | 'unreachable') {
    super(
      reason === 'unauthorized'
        ? 'not authorized to use that machine'
        : 'target machine is unreachable',
    )
    this.name = 'SpawnPlacementError'
  }
}

/**
 * Harnesses whose first prompt is a launch argv token. Mirrors
 * `packages/harness` `capabilities.argvPrompt` without pulling that package into
 * client-core.
 */
export function agentAcceptsArgvPrompt(kind: AgentKind): boolean {
  return kind === 'claude-code' || kind === 'codex' || kind === 'grok'
}

/**
 * Refuse a placement before any optimistic entity is painted or network request
 * is assembled. Engine calls this at its action boundary; createDraftAgent
 * repeats it as defense in depth for direct callers.
 */
export function assertSpawnPlacement(target: SpawnTarget): void {
  if (target.placement === 'unauthorized') throw new SpawnPlacementError('unauthorized')
  if (target.placement === 'unreachable') throw new SpawnPlacementError('unreachable')
}

export async function createDraftAgent(args: {
  trpc: PodiumClientApi
  sessionId: SessionId
  issueId: IssueId
  target: SpawnTarget
  agentKind: AgentKind
  firstPrompt?: string
}): Promise<void> {
  assertSpawnPlacement(args.target)
  const text = args.firstPrompt?.trim()
  await args.trpc.sessions.create.mutate({
    sessionId: args.sessionId,
    agentKind: args.agentKind,
    cwd: args.target.path,
    draftIssue: { repoPath: args.target.repoPath, issueId: args.issueId },
    ...(args.target.machineId ? { machineId: args.target.machineId } : {}),
    ...(text ? { initialPrompt: text } : {}),
  })
  // Non-argv harnesses only get a composer draft seed from create; still deliver
  // via resumeAndSend. Argv agents already received the prompt on launch —
  // re-typing it would double-fire.
  if (text && !agentAcceptsArgvPrompt(args.agentKind)) {
    // Best-effort: the session exists either way; a failed first-prompt delivery
    // must not fail the spawn (the user lands in the session and can retype).
    // Still honour ok:false — a swallowed dead-letter looks like a delivered
    // first turn while the agent stays idle (POD-546).
    try {
      const result = await args.trpc.sessions.resumeAndSend.mutate({
        sessionId: args.sessionId,
        text,
      })
      if (
        result !== null &&
        typeof result === 'object' &&
        'ok' in result &&
        (result as { ok: unknown }).ok === false
      ) {
        console.debug(
          '[podium] first prompt refused after spawn',
          args.sessionId,
          (result as { reason?: string }).reason,
        )
      }
    } catch {
      // transport blip — session is up; retype from the composer
    }
  }
}
