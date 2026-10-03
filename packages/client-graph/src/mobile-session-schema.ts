import type { Store } from '@podium/client-core/engine'
import { CHAT_CONTEXT_SUMMARIES } from './chat-context-schema'
import { ISSUE_PAGE_SUMMARIES } from './issue-page-schema'
import { SESSION_PANE_SCHEMA } from './session-pane-schema'

/** Phone session chrome and conversation context borrow the existing owners.
 * Transcript payloads and controller state are outside this declaration. */
export interface MobileSessionRows {
  mobileSessionReader: ReturnType<typeof import('./mobile-session-context').createMobileSessionReader>
  mobileSessionWindow: {
    cursor: number | null
    pendingSpawnPrompts: Store['pendingSpawnPrompts']
  }
}
declare module './source-registry' { interface PoolSourceRows extends MobileSessionRows {} }
export const MOBILE_SESSION_SOURCE_KEY = 'mobile-session-context'
export const MOBILE_SESSION_ENTITIES = ['mobileSessionReader', 'mobileSessionWindow'] as const
export const MOBILE_SESSION_SCHEMA = {
  mobileSessionReader: { key: 'reader', source: 'screen:reader', owner: 'existing pool' },
  mobileSessionWindow: { key: 'window', source: 'runtime:locals and replica:getCursor', fields: ['cursor', 'pendingSpawnPrompts'] },
  session: { source: 'pool:session', addressed: 'session-pane reader', summary: [
    ...SESSION_PANE_SCHEMA.session.fields, 'agentColor', 'refIssueId', 'origin',
    'refRepoId', 'refSeq', 'refLetter', 'refDraft', 'handoffTargetMachineId',
  ] },
  issue: { source: 'pool:issue', addressed: 'full row for the selected task; summaries for roster and references', summary: [
    ...ISSUE_PAGE_SUMMARIES.issue, ...CHAT_CONTEXT_SUMMARIES.issue,
    'priority', 'linearIdentifier', 'pinned', 'childCount', 'childDoneCount', 'dependents',
  ] },
  draft: { source: 'chatDraft', key: 'sessionId' },
  exit: { source: 'sessionExit', key: 'sessionId' },
  readPosition: { source: 'normalized sessionUserState and replica cursor', fields: ['readAt', 'unread', 'cursor'] },
  spawnPending: { source: 'sessionPaneWindow', field: 'pendingSpawnIds' },
  conversation: { source: 'chat context and notices', fields: ['messageRecord', 'chatHeld', 'pendingInteraction'], writes: 'existing runtime/outbox' },
} as const
export const MOBILE_SESSION_SUMMARIES = {
  session: MOBILE_SESSION_SCHEMA.session.summary,
  issue: MOBILE_SESSION_SCHEMA.issue.summary,
}
export const MOBILE_SESSION_RELATIONS = [
  { from: 'session', name: 'issue', key: 'issueId', to: 'issue', reader: 'pool.row addressed foreign key, including headless sessions' },
  { from: 'issue', name: 'repo', to: 'repo', reader: 'pool.relations.one' },
  { from: 'issue', name: 'pageDependents', to: 'issue', reader: 'existing issue-page reader over declared inverse edges' },
  { from: 'issue', name: 'treeChildren', to: 'issue', reader: 'existing issue-page reader over declared parent edges' },
  { from: 'session', name: 'machine', key: 'machineId', to: 'machine' },
  { from: 'chatDraft', name: 'session', key: 'sessionId', to: 'session' },
  { from: 'chatHeld', name: 'session', key: 'sessionId', to: 'session' },
] as const
