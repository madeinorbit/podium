/**
 * Spawn-on-wake wiring (#237) [spec:SP-34d7 decision 4]: a wake-class message
 * addressed to an issue with nothing resumable spawns a FRESH agent on that
 * issue via the existing session-spawn machinery (SessionsService.createSession
 * — the same path issue_start / start_agent ride; no second spawn path). The
 * delivery service then queues the message so it lands as the child's first
 * prompt after prime.
 *
 * Ordering is enforced upstream of this factory: gate authz (write access to
 * the target issue, gate.send) → per-issue spawn budget → wake cooldown, all
 * in MessageDeliveryService.trySpawn. This module only knows how to spawn.
 */

import type { AgentKind } from '@podium/protocol'
import type { MessageRow } from '../../store'
import type { IssueService } from '../issues/service'
import type { SpawnOnWake } from './service'

export interface SpawnOnWakeDeps {
  issues(): IssueService
  /** SessionsService.createSession, narrowed to what a wake-spawn needs. */
  createSession(input: {
    cwd: string
    agentKind?: AgentKind
    model?: string
    effort?: string
    issueId?: string
    spawnedBy?: string
    machineId?: string
  }): { sessionId: string }
}

/** Provenance for the spawned child, derived from the triggering message's
 *  sender. A session-identified agent sender becomes the child's PARENT
 *  (`session:<id>` — the same spawnedBy shape the clamp matrix and the
 *  session-target authz gate already read), so the waker gets parent-grade
 *  rights over what it woke. */
export function spawnedByForMessage(m: MessageRow): string {
  if (m.fromKind === 'agent') {
    if (m.fromSession) return `session:${m.fromSession}`
    if (m.fromIssue) return `issue:${m.fromIssue}`
    return 'agent'
  }
  if (m.fromKind === 'operator') return 'user'
  return m.fromKind // superagent | system
}

export function makeSpawnOnWake(deps: SpawnOnWakeDeps): SpawnOnWake {
  return {
    spawn({ issueId, message }) {
      if (!issueId) return { ok: false, reason: 'no target issue to spawn on' }
      const issue = deps.issues().getMeta(issueId)
      if (!issue) return { ok: false, reason: `unknown issue ${issueId}` }
      // Started issue: spawn alongside its work. Unstarted: the repo root —
      // starting the issue (worktree + branch) stays a deliberate action.
      const cwd = issue.worktreePath ?? issue.repoPath
      if (!cwd) return { ok: false, reason: 'issue has no working directory' }
      try {
        const { sessionId } = deps.createSession({
          cwd,
          agentKind: issue.defaultAgent as AgentKind, // safeParsed downstream ('auto' → role default)
          model: issue.defaultModel,
          effort: issue.defaultEffort,
          issueId: issue.id,
          spawnedBy: spawnedByForMessage(message),
          ...(issue.machineId ? { machineId: issue.machineId } : {}),
        })
        return { ok: true, sessionId }
      } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : String(error) }
      }
    },
  }
}
