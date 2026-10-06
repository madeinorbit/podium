import { CHAT_CONTEXT_SUMMARIES } from './chat-context-schema'
import { ISSUE_PAGE_SUMMARIES } from './issue-page-schema'
import { SESSION_PANE_SCHEMA } from './session-pane-schema'

const { issue: issuePageFields } = ISSUE_PAGE_SUMMARIES
const { issue: chatIssueFields } = CHAT_CONTEXT_SUMMARIES

/** Phone session chrome and conversation context borrow the existing owners.
 * Transcript payloads and controller state are outside this declaration. */
export interface MobileSessionRows {
  mobileSessionReader: ReturnType<
    typeof import('./mobile-session-context').createMobileSessionReader
  >
  mobileSessionWindow: {
    cursor: number | null
  }
}
declare module './source-registry' {
  interface PoolSourceRows extends MobileSessionRows {}
}
export const MOBILE_SESSION_SOURCE_KEY = 'mobile-session-context'
export const MOBILE_SESSION_ENTITIES = ['mobileSessionReader', 'mobileSessionWindow'] as const
export const MOBILE_SESSION_SCHEMA = {
  mobileSessionReader: { key: 'reader', source: 'screen:reader', owner: 'existing pool' },
  mobileSessionWindow: {
    key: 'window',
    source: 'runtime:locals and replica:getCursor',
  },
  session: {
    source: 'pool:session',
    addressed: 'session-pane reader',
    summary: [
      ...SESSION_PANE_SCHEMA.session.fields,
      'agentColor',
      'refIssueId',
      'origin',
      'draftUpdatedAt',
      'lastInputAt',
      'workState',
      'busy',
      'stoppedAt',
      'refRepoId',
      'refSeq',
      'refLetter',
      'refDraft',
      'handoffTargetMachineId',
    ],
  },
  issue: {
    source: 'pool:issue',
    addressed: 'full row for the selected task; summaries for roster and references',
    summary: [
      ...issuePageFields,
      ...chatIssueFields,
      'priority',
      'linearIdentifier',
      'pinned',
      'childCount',
      'childDoneCount',
      'dependents',
    ],
  },
  draft: { source: 'chatDraft', key: 'sessionId' },
  exit: { source: 'sessionExit', key: 'sessionId' },
  spawnPending: { source: 'PoolTransactions', field: 'spawnPrompts' },
  issueAgentCount: {
    source: 'issue-page:attachedSessions',
    key: 'issueId',
    demand: 'visible draft-delete confirmation',
  },
  chromeIssue: {
    source: 'pool:issue summary fields and addressed repository prefix',
    key: 'issueId',
    demand: 'displayed session header and menu identity',
  },
  nextSession: {
    source: 'ReaderQueries:nextTriageSession',
    key: 'sessionId',
    demand: 'Next session action',
  },
  conversation: {
    source: 'chat context and notices',
    fields: ['messageRecord', 'chatHeld', 'pendingInteraction'],
    writes: 'existing runtime/outbox',
  },
} as const
export const MOBILE_SESSION_SUMMARIES = {
  session: MOBILE_SESSION_SCHEMA.session.summary,
  issue: MOBILE_SESSION_SCHEMA.issue.summary,
}
