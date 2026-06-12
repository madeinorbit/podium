import type { AgentKind } from '@podium/protocol'
import type { AgentInstrumentation, AgentStateEvent, AgentStateProvider } from './types.js'

// Observation only: every hook replies 200 {} immediately (see the daemon's
// ingest server), so injecting these can never block or steer the agent.
function httpHook(url: string): { hooks: { type: 'http'; url: string }[] } {
  return { hooks: [{ type: 'http', url }] }
}

export function claudeHookSettings(endpointUrl: string): string {
  const h = httpHook(endpointUrl)
  return JSON.stringify(
    {
      hooks: {
        SessionStart: [h],
        UserPromptSubmit: [h],
        // Only the explicit ask-user tool; all other tool use arrives via PostToolUse.
        PreToolUse: [{ matcher: 'AskUserQuestion', ...h }],
        PostToolUse: [h],
        PermissionRequest: [h],
        // idle_prompt etc. are redundant with Stop; permission prompts are the signal.
        Notification: [{ matcher: 'permission_prompt', ...h }],
        Stop: [h],
        StopFailure: [h],
        TaskCreated: [h],
        TaskCompleted: [h],
        PreCompact: [h],
        PostCompact: [h],
        SessionEnd: [h],
      },
    },
    null,
    2,
  )
}

export const claudeCodeStateProvider: AgentStateProvider = {
  instrumentation({ endpointUrl, settingsPath }): AgentInstrumentation {
    return {
      args: ['--settings', settingsPath],
      file: { path: settingsPath, contents: claudeHookSettings(endpointUrl) },
    }
  },
  async translate(_payload: unknown): Promise<AgentStateEvent[]> {
    return [] // payload translation lands in the next commit
  },
}

/** The provider registry. Uninstrumented kinds return undefined → phase stays 'unknown'. */
export function agentStateProviderFor(kind: AgentKind): AgentStateProvider | undefined {
  return kind === 'claude-code' ? claudeCodeStateProvider : undefined
}
