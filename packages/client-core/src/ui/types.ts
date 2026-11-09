import type { IssueId, SessionId } from '@podium/model'
import type { MainView } from '../ui-state'

export interface IssueVisitBaseline {
  issueId: IssueId
  readAt: string | null
  openedAt: string
}

export interface TranscriptRevealRequest {
  nonce: number
  sessionId: SessionId
  itemKey: string
}

export interface UserFocus {
  view?: MainView
  worktreePath?: string
  /** NOT branded, and deliberately so: this interface MIRRORS the server's
   *  `UserFocus` zod schema field for field, and POD-362 branded that schema's
   *  two session ids but left `issueId` a plain `z.string().max(128)`. Branding
   *  only this side would make the mirror drift, which is worse than the widening
   *  — the pair must move together, server-side first. */
  issueId?: IssueId
  focusedSessionId?: SessionId
  visibleSessionIds?: SessionId[]
  filePath?: string
  /** Every file/artifact tab on screen (POD-782), not only the focused one. */
  openFilePaths?: string[]
  /** The issue detail drawer open over the workspace, when there is one. Not
   *  branded, for the same mirror-fidelity reason as `issueId` above. */
  openIssueId?: IssueId
}
