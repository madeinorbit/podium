import { describe, expect, test } from 'vitest'
import { AgentConversationLoadError, loadAgentConversation, scanAgentConversations } from './index.js'

describe('public package exports', () => {
  test('exports conversation scanner runtime API from the package index', () => {
    expect(scanAgentConversations).toEqual(expect.any(Function))
    expect(loadAgentConversation).toEqual(expect.any(Function))
    expect(new AgentConversationLoadError('load failed')).toBeInstanceOf(AgentConversationLoadError)
  })
})
