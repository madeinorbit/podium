import { pendingAskFromState } from '@podium/client-core/values'
import { type AgentNeed, asSessionId } from '@podium/model'
import { PendingInteractionWire } from '@podium/protocol'
import { autorun, observable, runInAction } from 'mobx'
import { expect, it } from 'vitest'
import { claudeRecordToItems } from '../../../../packages/harness/src/adapters/claude-code/transcript'
import { MobileConversation } from './mobile-conversation'

const nativeCall = (id: string, question: string, label: string) =>
  claudeRecordToItems({
    type: 'assistant',
    uuid: id,
    message: {
      content: [
        {
          type: 'tool_use',
          id: `${id}-use`,
          name: 'AskUserQuestion',
          input: { questions: [{ question, options: [{ label }] }] },
        },
      ],
    },
  })
const nativeResult = (id: string, text: string) =>
  claudeRecordToItems({
    type: 'user',
    uuid: `${id}-result`,
    message: { content: [{ type: 'tool_result', tool_use_id: `${id}-use`, content: text }] },
  })

it.each([
  '',
  'Error: answer could not be delivered',
  '[Tool call interrupted: its outcome is unknown.]',
  'Unrecognized outcome',
])('retains read-only history through state-only needs and a later answer for %j', async (result) => {
  for (const authority of ['need', 'interaction'] as const) {
    const state = observable(
      {
        phase: 'working',
        need: undefined as AgentNeed | undefined,
        question: undefined as PendingInteractionWire | undefined,
      },
      {},
      { deep: false },
    )
    const questions = [{ question: 'New question?', options: [{ label: 'New choice' }] }]
    const session = {
      status: 'live',
      get agentPhase() {
        return state.phase
      },
      get agentNeed() {
        return state.need
      },
    }
    const history = [
      ...nativeCall('old', 'Old question?', 'Old choice'),
      ...nativeResult('old', result),
    ]
    const conversation = new MobileConversation(
      {
        sessionId: asSessionId('question-history'),
        drafts: { get: () => '', set: () => {} },
        readSession: () => session,
        transcript: {
          source: {
            read: async () => ({ items: history, hasMore: false }),
            subscribe: () => () => {},
          },
        },
        sends: { createDeliveryId: () => 'unused', deliver: async () => ({ state: 'sent' }) },
      },
      { hidePendingQuestion: true },
    )
    const stop = autorun(() => {
      conversation.pendingQuestion
      conversation.presentation.keys.slice()
    })
    try {
      await conversation.start()
      const old = history[0]
      if (!old) throw new Error('Missing historical question fixture')
      const version = conversation.graph.rowPublication
      runInAction(() => {
        state.phase = authority === 'need' ? 'needs_user' : 'working'
        state.need =
          authority === 'need' ? { kind: 'question', interview: { questions } } : undefined
        state.question =
          authority === 'interaction'
            ? PendingInteractionWire.parse({
                id: 'new-interaction',
                sessionId: 'question-history',
                askedAt: '2026-11-13T12:00:00Z',
                source: 'hook',
                answerable: 'keystroke-emulated',
                fingerprint: 'new',
                kind: 'question',
                status: 'asked',
                payload: {
                  v: 1,
                  questions: questions.map((question) => ({
                    ...question,
                    multiSelect: false,
                    previewLayout: false,
                  })),
                },
              })
            : undefined
      })
      expect(conversation.graph.rowPublication).toBe(version)
      expect([...conversation.presentation.keys]).toContain(old.id)
      expect(conversation.presentation.row(old.id)?.item.toolResult).toBe(result)
      const live =
        conversation.pendingQuestion ??
        pendingAskFromState(state.need, 'live', state.phase, false, state.question)?.item
      expect(live?.toolInputJson).toContain('New question?')
      runInAction(() =>
        conversation.transcript.merge([
          ...nativeCall('new', 'New question?', 'New choice'),
          ...nativeResult('new', 'User has answered your questions: "New question?"="New choice".'),
        ]),
      )
      runInAction(() => {
        state.phase = 'working'
        state.need = undefined
        state.question = undefined
      })
      expect(conversation.graph.pendingQuestionId).toBeUndefined()
      expect(conversation.pendingQuestion).toBeNull()
      expect(pendingAskFromState(state.need, 'live', state.phase, false, state.question)).toBeNull()
      expect([...conversation.presentation.keys]).toContain(old.id)
      expect(conversation.presentation.row(old.id)?.item.toolResult).toBe(result)
    } finally {
      stop()
      conversation.dispose()
    }
  }
})
