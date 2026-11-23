import { describe, expect, it } from 'vitest'
import { ACCESS_CARRYING_CONTROL_TYPES, ControlMessage } from './control'
import {
  CAP_CONVERSATION_PREPARE,
  ConversationPrepareRequestMessage,
  ConversationPrepareResultMessage,
} from './conversation'
import { DaemonMessage } from './daemon'
import { CONTROL_PLANE_CLASS, DAEMON_PLANE_CLASS } from './message-class'

const CRED = 'cred_0b6f6f5e-2d43-4f7a-9d55-6a1f7c3e0e11'

const request = {
  type: 'conversationPrepareRequest',
  requestId: 'r1',
  sessionId: 'sess-1',
  agentKind: 'codex',
  cwd: '/work/repo',
  resume: { kind: 'codex-thread', value: 'thread-1' },
  toHomeId: `${CRED}:codex`,
  account: CRED,
  fromAccount: 'none',
  modelProvider: 'openai',
} as const

describe('conversation preparation messages', () => {
  it('names its capability', () => {
    expect(CAP_CONVERSATION_PREPARE).toBe('conversation.prepare.v1')
  })

  it('parse as a control frame and a daemon frame', () => {
    expect(ControlMessage.parse(request)).toEqual(request)
    const result = {
      type: 'conversationPrepareResult',
      requestId: 'r1',
      ok: true,
      placed: 'copied',
      droppedReasoning: true,
    }
    expect(DaemonMessage.parse(result)).toEqual(result)
    expect(
      DaemonMessage.parse({
        type: 'conversationPrepareResult',
        requestId: 'r2',
        ok: false,
        error: 'not found',
      }),
    ).toMatchObject({ ok: false })
  })

  it('takes the request without the optional account and provider (a wake)', () => {
    const { fromAccount: _f, modelProvider: _m, ...wake } = request
    expect(ConversationPrepareRequestMessage.parse(wake)).toEqual(wake)
  })

  it('refuses a placement it does not know', () => {
    expect(
      ConversationPrepareResultMessage.safeParse({
        type: 'conversationPrepareResult',
        requestId: 'r1',
        ok: true,
        placed: 'moved',
      }).success,
    ).toBe(false)
  })

  it('carries no credential: it is not an access-carrying frame', () => {
    expect(ACCESS_CARRYING_CONTROL_TYPES).not.toContain('conversationPrepareRequest')
  })

  it('is classed as a control command both ways', () => {
    expect(CONTROL_PLANE_CLASS.conversationPrepareRequest).toBe('control.command')
    expect(DAEMON_PLANE_CLASS.conversationPrepareResult).toBe('control.command')
  })
})
