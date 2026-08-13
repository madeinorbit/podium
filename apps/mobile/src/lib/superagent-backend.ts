import { type IssueAgentKind, issueAgentKind } from './agent-models'

/**
 * Superagent prompt-box backend — the same resolve + payload the desktop
 * composer uses (use-chat-surface / use-headless-turn). The stored value lives
 * on the thread; a fresh pick is held locally until the send that carries it.
 */

export type SuperagentBackendPick = {
  agentKind?: string | null
  model?: string
  effort?: string
}

export type SuperagentBackend = {
  agentKind: string | undefined
  model: string
  effort: string
}

export function resolveSuperagentBackend(
  thread: { agentKind?: string; model?: string; effort?: string } | undefined,
  pick: SuperagentBackendPick,
): SuperagentBackend {
  const model = pick.model ?? thread?.model ?? 'auto'
  // A model override pins the connector it was picked from. Auto (no model)
  // follows Settings, so the rail does not pretend a frozen harness is a choice.
  const agentKind =
    pick.agentKind !== undefined
      ? (pick.agentKind ?? undefined)
      : model !== 'auto'
        ? thread?.agentKind
        : undefined
  return {
    agentKind,
    model,
    effort: pick.effort ?? thread?.effort ?? 'auto',
  }
}

/** Changing the model resets effort — effort is scoped to the model. */
export function applySuperagentModelPick(
  pick: SuperagentBackendPick,
  model: string,
  agentKind?: string,
): SuperagentBackendPick {
  return {
    ...pick,
    model,
    agentKind: model === 'auto' ? null : (agentKind ?? pick.agentKind),
    effort: 'auto',
  }
}

/** Fields that ride `superagent.sendTurn`. `'auto'` is sent on purpose: the
 *  server treats it as "clear the override / follow Settings". */
export function superagentTurnChoice(backend: SuperagentBackend): {
  model?: string
  effort?: string
  agentKind?: IssueAgentKind
} {
  const harness = issueAgentKind(backend.agentKind)
  return {
    ...(backend.model ? { model: backend.model } : {}),
    ...(backend.effort ? { effort: backend.effort } : {}),
    ...(harness && backend.model && backend.model !== 'auto' ? { agentKind: harness } : {}),
  }
}
