/**
 * The composition root for session commands: turn a transport's authenticated
 * capability into a {@link SessionCommandCtx}.
 *
 * Split out of `commands.ts` so the contracts stay a pure table over ports and
 * do not import the whole module graph — and so both transports build the
 * context the SAME way. A transport that built its own principal would be a
 * second answer to "who is calling", which is the failure D7 exists to prevent.
 */

import type { Capability } from '@podium/model'
import { resolvePrincipal } from '../../command-principal'
import { ownershipFromMachines } from '../../machine-access'
import type { RegistryModules } from '../../relay'
import { SessionCommandCtx, type SessionCommandDeps } from './command-plane'

/**
 * Build the per-call context.
 *
 * The delegation index reads `spawnedBy` — today's agent-ancestry provenance —
 * so a sub-agent's chain is walked from live rows rather than from anything the
 * caller supplied. `onBehalfOfFor` is absent until POD-1075 lands accounts, so
 * every chain roots at the instance's one human.
 */
export function sessionCommandCtx(
  modules: RegistryModules,
  capability: Capability,
  overrideScope?: boolean,
): SessionCommandCtx {
  const sessions = modules.sessions
  const issues = modules.issues
  const principal = resolvePrincipal(capability, {
    parentSessionOf: (sessionId) => {
      const spawnedBy = sessions.listSessions().find((s) => s.sessionId === sessionId)?.spawnedBy
      return spawnedBy?.startsWith('session:') === true ? spawnedBy.slice('session:'.length) : undefined
    },
  })
  const deps: SessionCommandDeps = {
    sessions: () => sessions,
    messages: () => modules.messages,
    createDraftIssue: (repoPath, agentKind, issueId) =>
      issues.createDraftFor(repoPath, agentKind, issueId),
    access: {
      listSessions: () => sessions.listSessions(),
      issues,
      // POD-1075 supplies the owner/grant answer; today one account sees all.
    },
    ownership: ownershipFromMachines(modules.machines),
  }
  return new SessionCommandCtx(deps, principal, overrideScope)
}
