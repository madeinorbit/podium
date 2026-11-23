import { join } from 'node:path'
import { type AgentStateEvent, withStateChannel } from '../../agent-state/types.js'
import type { HarnessInstrumentation } from '../../manifest.js'
import { isRecord, stringField } from '../shared/json-util.js'

const EVENTS = [
  'SessionStart',
  'PreInvocation',
  'PostInvocation',
  'PreToolUse',
  'PostToolUse',
  'Stop',
] as const
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`

export function antigravityHookEvents(raw: unknown): AgentStateEvent[] {
  if (!isRecord(raw)) return []
  switch (raw.hookEventName) {
    case 'SessionStart':
      return [{ kind: 'session_started' }]
    case 'PreInvocation':
      return [{ kind: raw.invocationNum === 0 ? 'prompt_submitted' : 'activity' }]
    case 'PreToolUse': {
      const tool = isRecord(raw.toolCall) ? raw.toolCall : {}
      if (tool.name === 'ask_question')
        return [
          {
            kind: 'needs_user',
            need: 'question',
            summary: isRecord(tool.args) ? stringField(tool.args, 'Question') : undefined,
          },
        ]
      if (tool.name === 'ask_permission' || tool.name === 'ask_custom_permission')
        return [{ kind: 'needs_user', need: 'permission' }]
      return [{ kind: 'activity' }]
    }
    case 'PostInvocation':
    case 'PostToolUse':
      return [{ kind: 'activity' }]
    case 'Stop':
      if (raw.fullyIdle === false || raw.continuationActive === true) return [{ kind: 'activity' }]
      if (typeof raw.error === 'string' && raw.error)
        return [
          { kind: 'turn_failed', errorClass: 'provider', retryable: false, detail: raw.error },
        ]
      if (raw.fullyIdle !== true) return []
      return [
        {
          kind: 'turn_completed',
          verdict: {
            kind: /interrupt|cancel/iu.test(String(raw.terminationReason)) ? 'interrupted' : 'done',
          },
        },
      ]
    default:
      return []
  }
}

export const antigravityInstrumentation: HarnessInstrumentation = {
  scope: { kind: 'session' },
  hookTransport: 'loopback-http',
  async install(destination) {
    const root = join(destination.settingsDir, `antigravity-${destination.sessionId}`)
    const command =
      process.platform === 'win32'
        ? `curl.exe -fsS --connect-timeout 1 --max-time 2 -H "content-type: application/json" --data-binary @- "${destination.endpointUrl}" >NUL 2>NUL & echo {"decision":"allow"}`
        : `curl -fsS --connect-timeout 1 --max-time 2 -H 'content-type: application/json' --data-binary @- ${quote(destination.endpointUrl)} >/dev/null 2>&1; printf '%s\\n' '{"decision":"allow"}'`
    const handler = { type: 'command', command, timeout: 3 }
    const hooks = Object.fromEntries(
      EVENTS.map((event) => [
        event,
        event === 'PreToolUse' || event === 'PostToolUse'
          ? [{ matcher: '*', hooks: [handler] }]
          : [handler],
      ]),
    )
    return {
      args: ['--add-dir', root],
      file: {
        path: join(root, '.agents', 'hooks.json'),
        contents: JSON.stringify({ 'podium-observer': hooks }),
      },
    }
  },
  payloadCodec: {
    eventName: (raw) => (isRecord(raw) ? stringField(raw, 'hookEventName') : undefined),
    sessionId: (raw) => (isRecord(raw) ? stringField(raw, 'conversationId') : undefined),
    transcriptPath: (raw) => (isRecord(raw) ? stringField(raw, 'transcriptPath') : undefined),
    decode: async (raw) => withStateChannel(antigravityHookEvents(raw), 'hook'),
  },
}
