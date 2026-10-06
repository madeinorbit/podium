import type { Store } from '@podium/client-core/engine'
import type { OutboxChatSend } from '@podium/client-core/engine'

/** Conversation payloads use NoticeSource. These rows borrow the existing
 * draft/window/outbox owners; they own neither mutations nor a transcript. */
export interface ChatContextRows {
  chatContextReader: ReturnType<typeof import('./chat-context').createChatContextReader>
  chatDraft: { text: string }
  chatWindow: Pick<Store, 'attachedSessionId' | 'transcriptReveal'>
  chatHeld: { sends: readonly OutboxChatSend[] }
  chatRecordOrder: { ids: readonly string[] }
  chatIssueOrder: { ids: readonly string[] }
  chatSessionOrder: { ids: readonly string[] }
}
declare module './source-registry' {
  interface PoolSourceRows extends ChatContextRows {}
}
export const CHAT_CONTEXT_ENTITIES = [
  'chatContextReader',
  'chatDraft',
  'chatWindow',
  'chatHeld',
  'chatRecordOrder',
  'chatIssueOrder',
  'chatSessionOrder',
] as const
const CHAT_CONTEXT_SCHEMA = {
  chatContextReader: { source: 'screen:reader', key: 'reader', owner: 'existing pool' },
  chatDraft: {
    key: 'sessionId',
    source: 'DraftStore.values',
    fields: ['text'],
    residency: 'addressed-on-demand',
  },
  chatWindow: {
    key: 'window',
    source: 'engine:locals',
    fields: ['attachedSessionId', 'transcriptReveal'],
  },
  chatHeld: {
    key: 'sessionId',
    source: 'runtime:outbox',
    fields: ['sends'],
    order: 'queuedAt ascending',
  },
  chatRecordOrder: {
    key: 'order',
    source: 'replica:messageRecords',
    fields: ['ids'],
    order: 'replica insertion order',
    payload: 'notice:messageRecord',
  },
  chatIssueOrder: {
    key: 'order',
    source: 'replica:issueProjections',
    fields: ['ids'],
    order: 'replica insertion order',
    payload: 'pool:issue summary',
  },
  chatSessionOrder: {
    key: 'order',
    source: 'replica:sessions',
    fields: ['ids'],
    order: 'replica insertion order',
    payload: 'pool:session summary',
  },
  issue: {
    source: 'pool:issue',
    summary: [
      'id',
      'seq',
      'title',
      'linearIdentifier',
      'archived',
      'deletedAt',
      'updatedAt',
      'repoId',
    ],
  },
  session: {
    source: 'pool:session',
    summary: [
      'sessionId',
      'displayRef',
      'cwd',
      'issueId',
      'title',
      'name',
      'archived',
      'status',
      'lastActiveAt',
      'agentKind',
      'resume',
      'headless',
    ],
  },
  repository: { source: 'header:repository', fields: ['path'], order: 'runtime repository order' },
} as const
export const CHAT_ORDER_KINDS = {
  chatRecordOrder: 'messageRecords',
  chatIssueOrder: 'issueProjections',
  chatSessionOrder: 'sessions',
} as const
export const CHAT_CONTEXT_SUMMARIES = {
  issue: CHAT_CONTEXT_SCHEMA.issue.summary,
  session: CHAT_CONTEXT_SCHEMA.session.summary,
}
