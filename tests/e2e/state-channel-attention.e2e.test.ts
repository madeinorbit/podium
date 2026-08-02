import {
  AGENT_MANIFESTS,
  initialAgentState,
  reduceAgentState,
  withStateChannelEvent,
} from '@podium/harness'
import { asSessionId, asUserId, type SessionId } from '@podium/model'
import type { ServerMessage } from '@podium/protocol'
import { DEFAULT_SETTINGS } from '@podium/runtime'
import { describe, expect, it, vi } from 'vitest'
import { EventBus } from '../../apps/server/src/modules/bus'
import { NotifyService } from '../../apps/server/src/modules/notify/service'

describe('all-provider owner-scoped needs-attention', () => {
  it('routes each precise session signal only to its owning principal', () => {
    const owner = asUserId('user:owner')
    const other = asUserId('user:other')
    const ownerMessages: ServerMessage[] = []
    const otherMessages: ServerMessage[] = []
    const infos = new Map<
      SessionId,
      { sessionId: SessionId; name: string; cwd: string; agentKind: string }
    >()
    const clients = [
      { owner, visible: false, send: (message: ServerMessage) => ownerMessages.push(message) },
      {
        owner: other,
        visible: false,
        send: (message: ServerMessage) => otherMessages.push(message),
      },
    ]
    const bus = new EventBus()
    new NotifyService(
      {
        getSettings: () => DEFAULT_SETTINGS,
        telegramBotToken: () => '',
        appendEvent: vi.fn(),
        now: () => Date.parse('2026-08-02T10:00:00.000Z'),
        clients: (ownerUserId) => clients.filter((client) => client.owner === ownerUserId),
        sessionInfo: (sessionId) => infos.get(sessionId),
        sessionStates: () => [],
        notificationsEnabled: () => true,
      },
      { ntfy: vi.fn(), telegram: vi.fn() },
      bus,
    )

    const expectedSessionIds: SessionId[] = []
    for (const [kind, manifest] of Object.entries(AGENT_MANIFESTS)) {
      const sessionId = asSessionId(`state-channel-${kind}`)
      const channel = manifest.stateChannels[0]
      if (!channel) throw new Error(`${kind} has no state channel`)
      expectedSessionIds.push(sessionId)
      infos.set(sessionId, { sessionId, name: kind, cwd: `/repo/${kind}`, agentKind: kind })
      const previous = reduceAgentState(
        initialAgentState('2026-08-02T09:59:59.000Z'),
        withStateChannelEvent({ kind: 'prompt_submitted' }, channel.source),
        '2026-08-02T09:59:59.000Z',
      )
      const next = reduceAgentState(
        previous,
        withStateChannelEvent(
          { kind: 'needs_user', need: 'question', summary: `${kind} needs a decision` },
          channel.source,
        ),
        '2026-08-02T10:00:00.000Z',
      )
      bus.emit('session.stateChanged', { sessionId, ownerUserId: owner, prev: previous, next })
    }

    const attention = ownerMessages.filter(
      (message): message is Extract<ServerMessage, { type: 'attentionEvent' }> =>
        message.type === 'attentionEvent',
    )
    expect(attention.map((message) => message.sessionId).sort()).toEqual(
      [...expectedSessionIds].sort(),
    )
    expect(attention).toHaveLength(5)
    expect(otherMessages).toEqual([])

    // Unknown ownership fails closed; there is no ambient operator/broadcast fallback.
    const sessionId = expectedSessionIds[0]
    if (!sessionId) throw new Error('missing provider sessions')
    const state = reduceAgentState(
      initialAgentState('2026-08-02T10:00:01.000Z'),
      withStateChannelEvent({ kind: 'needs_user', need: 'question' }, 'hook'),
      '2026-08-02T10:00:01.000Z',
    )
    bus.emit('session.stateChanged', { sessionId, prev: undefined, next: state })
    expect(ownerMessages).toHaveLength(5)
    expect(otherMessages).toEqual([])
  })
})
