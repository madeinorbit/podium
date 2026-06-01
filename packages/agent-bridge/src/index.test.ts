import { describe, expect, test } from 'vitest'
import {
  type AgentConversation,
  type AgentConversationDiagnostic,
  type AgentConversationGitMetadata,
  AgentConversationLoadError,
  type AgentConversationMessage,
  type AgentConversationResumeRef,
  type AgentConversationRole,
  type AgentConversationSource,
  type AgentConversationStatusHint,
  type AgentConversationSummary,
  type AgentConversationTitleSource,
  type AgentKind,
  type ConversationProvider,
  type ConversationProviderContext,
  loadAgentConversation,
  type ProviderScanResult,
  type ScanAgentConversationsOptions,
  type ScanAgentConversationsResult,
  scanAgentConversations,
} from './index.js'

describe('public package exports', () => {
  test('exports conversation scanner runtime API from the package index', () => {
    expect(scanAgentConversations).toEqual(expect.any(Function))
    expect(loadAgentConversation).toEqual(expect.any(Function))
    expect(new AgentConversationLoadError('load failed')).toBeInstanceOf(AgentConversationLoadError)
  })

  test('exports public conversation scanner types from the package index', () => {
    type PublicTypes = [
      AgentConversation,
      AgentConversationDiagnostic,
      AgentConversationMessage,
      AgentConversationRole,
      AgentConversationSource,
      AgentConversationSummary,
      AgentKind,
      ScanAgentConversationsOptions,
      ScanAgentConversationsResult,
      AgentConversationTitleSource,
      AgentConversationStatusHint,
      AgentConversationGitMetadata,
      AgentConversationResumeRef,
      ConversationProvider,
      ConversationProviderContext,
      ProviderScanResult,
    ]

    expectTypeExport<PublicTypes>()
  })
})

function expectTypeExport<_T>(): void {
  expect(true).toBe(true)
}
