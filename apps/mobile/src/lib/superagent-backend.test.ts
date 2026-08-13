import { describe, expect, it } from 'vitest'
import {
  applySuperagentModelPick,
  resolveSuperagentBackend,
  superagentTurnChoice,
} from './superagent-backend'

describe('superagent prompt-box backend', () => {
  it('defaults to auto and hides a connector until a model is picked', () => {
    expect(resolveSuperagentBackend(undefined, {})).toEqual({
      agentKind: undefined,
      model: 'auto',
      effort: 'auto',
    })
    expect(resolveSuperagentBackend({ agentKind: 'claude-code', effort: 'high' }, {})).toEqual({
      agentKind: undefined,
      model: 'auto',
      effort: 'high',
    })
  })

  it('reads a stored model from the thread and pins its connector', () => {
    expect(
      resolveSuperagentBackend(
        { agentKind: 'claude-code', model: 'opus', effort: 'medium' },
        {},
      ),
    ).toEqual({ agentKind: 'claude-code', model: 'opus', effort: 'medium' })
  })

  it('lets a local pick win, and Auto unpins the connector', () => {
    const thread = { agentKind: 'claude-code', model: 'opus', effort: 'medium' }
    expect(resolveSuperagentBackend(thread, { model: 'gpt-5.5', agentKind: 'codex' })).toEqual({
      agentKind: 'codex',
      model: 'gpt-5.5',
      effort: 'medium',
    })
    expect(resolveSuperagentBackend(thread, { model: 'auto', agentKind: null })).toEqual({
      agentKind: undefined,
      model: 'auto',
      effort: 'medium',
    })
  })

  it('resets effort when the model changes', () => {
    expect(applySuperagentModelPick({ effort: 'high' }, 'opus', 'claude-code')).toEqual({
      model: 'opus',
      agentKind: 'claude-code',
      effort: 'auto',
    })
    expect(applySuperagentModelPick({ agentKind: 'claude-code', effort: 'high' }, 'auto')).toEqual({
      model: 'auto',
      agentKind: null,
      effort: 'auto',
    })
  })

  it('sends auto to clear, and only names a harness with a concrete model', () => {
    expect(
      superagentTurnChoice({ agentKind: undefined, model: 'auto', effort: 'auto' }),
    ).toEqual({ model: 'auto', effort: 'auto' })
    expect(
      superagentTurnChoice({ agentKind: 'claude-code', model: 'opus', effort: 'high' }),
    ).toEqual({ model: 'opus', effort: 'high', agentKind: 'claude-code' })
  })
})
