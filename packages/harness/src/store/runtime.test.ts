import { describe, expect, it } from 'vitest'
import { claudeRuntime, codexRuntime, grokRuntime } from './runtime'

describe('per-harness runtime readers', () => {
  it('reads the actual Codex model and effort from turn context', () => {
    const observed = codexRuntime({
      type: 'turn_context',
      payload: { model: 'gpt-5.7-codex', reasoning_effort: 'high' },
    })
    expect(observed).toEqual({ model: 'gpt-5.7-codex', effort: 'high' })
  })

  it('computes Codex context use only from an exact window and token count', () => {
    const observed = codexRuntime({
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
      codexRuntime({
        type: 'event_msg',
        payload: { type: 'token_count', info: { total_token_usage: { total_tokens: 10 } } },
      }),
    ).toEqual({})
  })

  it('reads Claude model and effort from the assistant record', () => {
    const observed = claudeRuntime({
      type: 'assistant',
      effort: 'medium',
      message: { model: 'claude-opus-4-8' },
    })
    expect(observed).toEqual({ model: 'claude-opus-4-8', effort: 'medium' })
  })

  it('reads the Grok model id from either the record or its message', () => {
    expect(grokRuntime({ model_id: 'grok-4.5' })).toEqual({ model: 'grok-4.5' })
    expect(grokRuntime({ message: { model: 'grok-4.5-fast' } })).toEqual({ model: 'grok-4.5-fast' })
    expect(grokRuntime({ message: {} })).toEqual({})
  })

  /** Each reader answers for ITS OWN harness only — no reader infers a fact from
   * another harness's record shape. The manifest picks which one applies, so a
   * reader that also parsed a foreign shape would silently mislabel a session. */
  it('does not read another harness record shape', () => {
    const codexTurnContext = {
      type: 'turn_context',
      payload: { model: 'gpt-5.7-codex', reasoning_effort: 'high' },
    }
    expect(claudeRuntime(codexTurnContext)).toEqual({})
    expect(grokRuntime(codexTurnContext)).toEqual({})
    expect(codexRuntime({ type: 'assistant', message: { model: 'claude-opus-4-8' } })).toEqual({})
  })
})
