import { describe, expect, test } from 'vitest'
import {
  AgentConversationLoadError,
  loadAgentConversation,
  scanAgentConversations,
  type AgentConversation,
  type AgentConversationDiagnostic,
  type AgentConversationMessage,
  type AgentConversationRole,
  type AgentConversationSource,
  type AgentConversationSummary,
  type AgentConversationTitleSource,
  type AgentConversationStatusHint,
  type AgentConversationGitMetadata,
  type AgentConversationResumeRef,
  type ConversationProvider,
  type ConversationProviderContext,
  type ProviderScanResult,
  type AgentKind,
  type ScanAgentConversationsOptions,
  type ScanAgentConversationsResult,
} from './index.js'

describe('public package exports', () => {
  test('exports conversation scanner runtime API from the package index', () => {
    expect(scanAgentConversations).toEqual(expect.any(Function))
    expect(loadAgentConversation).toEqual(expect.any(Function))
    expect(new AgentConversationLoadError('load failed')).toBeInstanceOf(
      AgentConversationLoadError,
    )
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

function expectTypeExport<T>(): void {
  expect(true).toBe(true)
}
