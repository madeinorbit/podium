import { describe, expect, it } from 'vitest'
import { recordRuntimeForKind } from './runtime'

describe('recordRuntimeForKind', () => {
  it('reads the actual Codex model and effort from turn context', () => {
    const observed = recordRuntimeForKind('codex', {
      type: 'turn_context',
      payload: { model: 'gpt-5.7-codex', reasoning_effort: 'high' },
    })
    expect(observed).toEqual({ model: 'gpt-5.7-codex', effort: 'high' })
  })

  it('computes Codex context use only from an exact window and token count', () => {
    const observed = recordRuntimeForKind('codex', {
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          model_context_window: 258_400,
          total_token_usage: { total_tokens: 57_521 },
        },
      },
    })
    expect(observed).toEqual({ contextUsagePercent: 22.3 })
  })

  it('does not guess a context percentage when the harness omits its window', () => {
    expect(
      recordRuntimeForKind('codex', {
        type: 'event_msg',
        payload: { type: 'token_count', info: { total_token_usage: { total_tokens: 10 } } },
      }),
    ).toEqual({})
  })

  it('reads Claude model and effort from the assistant record', () => {
    const observed = recordRuntimeForKind('claude-code', {
      type: 'assistant',
      effort: 'medium',
      message: { model: 'claude-opus-4-8' },
    })
    expect(observed).toEqual({ model: 'claude-opus-4-8', effort: 'medium' })
  })
})
