import { asIssueId, asSessionId } from '@podium/model'
import type { SessionRow, SessionStore } from '../../store'
import type { MemoryReader } from './types'

export const INDEXED_MEMORY_DOCUMENT_CLASSES = [
  'session',
  'issue',
  'conversation',
  'transcript',
  'superagent-thread',
  'setting',
] as const
export type MemoryDocumentClass = (typeof INDEXED_MEMORY_DOCUMENT_CLASSES)[number]

export const MEMORY_DOCUMENT_VISIBILITY = {
  session: 'personal',
  issue: 'personal',
  conversation: 'personal',
  transcript: 'personal',
  'superagent-thread': 'personal',
  setting: 'deployment-substrate',
} as const satisfies Record<MemoryDocumentClass, 'personal' | 'deployment-substrate'>

/** One switch for the unresolved existence-leak decision (POD-1070 / ADR 9). */
export const MEMORY_EXISTENCE_POLICY = {
  counts: 'visible-slice',
  facets: 'visible-slice',
} as const

export type MemoryDocumentRef =
  | { class: 'session'; id: string }
  | { class: 'issue'; id: string }
  | { class: 'conversation' | 'transcript'; machineId: string; nativeId: string }
  | { class: 'superagent-thread'; id: string; ownerUserId: string }
  | { class: 'setting'; id: string }

/**
 * The one query-time visibility policy for every memory source. Unknown classes
 * are private by default and therefore refused.
 */
export class MemoryVisibilityPolicy {
  constructor(private readonly store: SessionStore) {}

  classOf(value: string): (typeof MEMORY_DOCUMENT_VISIBILITY)[MemoryDocumentClass] | undefined {
    return Object.hasOwn(MEMORY_DOCUMENT_VISIBILITY, value)
      ? MEMORY_DOCUMENT_VISIBILITY[value as MemoryDocumentClass]
      : undefined
  }

  mayRead(reader: MemoryReader, ref: MemoryDocumentRef | { class: string }): boolean {
    const visibility = this.classOf(ref.class)
    if (!visibility) return false
    if (reader.kind === 'system') return true
    if (visibility === 'deployment-substrate') return true
    const userId = reader.kind === 'user' ? reader.id : reader.onBehalfOf
    switch (ref.class) {
      case 'session': {
        const row =
          'id' in ref ? this.store.sessions.getSession(asSessionId(String(ref.id))) : undefined
        return row ? this.mayReadSessionRow(userId, row) : false
      }
      case 'issue': {
        const row = 'id' in ref ? this.store.issues.getIssue(asIssueId(String(ref.id))) : undefined
        if (!row) return false
        return row.ownerUserId === userId || this.hasReadGrant(userId, 'issue', row.id)
      }
      case 'conversation':
      case 'transcript':
        return 'machineId' in ref && 'nativeId' in ref
          ? this.mayReadNativeConversation(userId, ref.machineId, ref.nativeId)
          : false
      case 'superagent-thread':
        return 'ownerUserId' in ref && ref.ownerUserId === userId
      case 'setting':
        return true
      default:
        return false
    }
  }

  mayReadSession(reader: MemoryReader, sessionId: string): boolean {
    if (reader.kind === 'system') return true
    const row = this.store.sessions.getSession(asSessionId(sessionId))
    if (!row) return false
    return this.mayReadSessionRow(reader.kind === 'user' ? reader.id : reader.onBehalfOf, row)
  }

  private mayReadSessionRow(userId: string, row: SessionRow): boolean {
    const issueId = row.issueId ?? undefined
    const owner = issueId
      ? (this.store.issues.getIssue(issueId)?.ownerUserId ?? row.ownerUserId)
      : row.ownerUserId
    if (owner === userId) return true
    return this.hasReadGrant(userId, issueId ? 'issue' : 'session', issueId ?? row.id)
  }

  private mayReadNativeConversation(userId: string, machineId: string, nativeId: string): boolean {
    const siblings = this.store.conversations.registry.siblingSegments(machineId, nativeId)
    const evidence = siblings.length > 0 ? siblings : [{ machineId, nativeId }]
    const keys = new Set(evidence.map((segment) => `${segment.machineId}\0${segment.nativeId}`))
    return this.store.sessions.loadSessions().some((row) => {
      if (!row.resumeValue && !row.conversationId) return false
      const rowMachine = row.machineId
      const matches =
        (row.resumeValue && keys.has(`${rowMachine}\0${row.resumeValue}`)) ||
        (row.conversationId && keys.has(`${rowMachine}\0${row.conversationId}`))
      return Boolean(matches) && this.mayReadSessionRow(userId, row)
    })
  }

  private hasReadGrant(userId: string, resourceKind: string, resourceId: string): boolean {
    return this.store.grants
      .listForResource(resourceKind, resourceId)
      .some(
        (edge) =>
          edge.grantee === userId &&
          (edge.verb === 'read' || edge.verb === 'write' || edge.verb === 'manage'),
      )
  }
}
