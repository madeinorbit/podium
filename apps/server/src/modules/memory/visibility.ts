import { asIssueId, asSessionId, ROW, type VisibilityClass, visibilityClassOf } from '@podium/model'
import { mayReadOwned } from '../../issue-authz'
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

/**
 * Each memory document class, mapped to THE MATRIX ROW that classifies it — not
 * to a visibility class this module decides for itself (POD-335).
 *
 * The previous shape was a literal `{ session: 'personal', …, setting:
 * 'deployment-substrate' }`, which is a SECOND classification: ADR 1's ownership
 * matrix already declares every one of these, and nothing checked the two
 * against each other. They happened to agree — verified row by row when this was
 * flipped, all six identical — and that is exactly the state a drift begins in.
 * `authz-single-home` in the architecture manifest now fails the build on the
 * literal form (docs/multi-user-readiness.md §3.1.1 rule 2).
 *
 * The row ids are a typed edge (`MatrixRowId`), so a row renamed out from under
 * this map is a compile error rather than a silent fallback, and
 * `visibilityClassOf` is total and default-closed — an unclassified row resolves
 * `personal`, never tenant-visible.
 */
const MEMORY_DOCUMENT_MATRIX_ROW = {
  session: ROW.sessionIdentity,
  issue: ROW.issueCore,
  conversation: ROW.conversationRegistry,
  transcript: ROW.segments,
  'superagent-thread': ROW.superagentState,
  setting: ROW.preferencesInstance,
} as const satisfies Record<MemoryDocumentClass, (typeof ROW)[keyof typeof ROW]>

export const MEMORY_DOCUMENT_VISIBILITY: Record<MemoryDocumentClass, VisibilityClass> =
  Object.fromEntries(
    INDEXED_MEMORY_DOCUMENT_CLASSES.map((cls) => [
      cls,
      visibilityClassOf(MEMORY_DOCUMENT_MATRIX_ROW[cls]),
    ]),
  ) as Record<MemoryDocumentClass, VisibilityClass>

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

  classOf(value: string): VisibilityClass | undefined {
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
        return mayReadOwned(userId, {
          id: row.id,
          owner: row.ownerUserId,
          grants: this.readGranteesOf('issue', row.id),
        })
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
    // The owner-or-grant rule itself comes from `@podium/model`'s `authorize`
    // (POD-335). What stays here is the RESOLUTION — which row carries the
    // owner, and which resource the grants hang off — which is this module's
    // own knowledge and not a second authorization surface.
    return mayReadOwned(userId, {
      id: issueId ?? row.id,
      owner,
      grants: this.readGranteesOf(issueId ? 'issue' : 'session', issueId ?? row.id),
    })
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

  /**
   * The grantees whose edge on this resource admits READING it.
   *
   * A LOOKUP, not a decision. The previous form asked "does this user hold a
   * read-ish grant" and answered it here, which meant this module carried its
   * own view of which verbs imply read — including, silently, that `use` does
   * not, a rule ADR 9 D6 M2 states for a reason and that belonged nowhere near
   * a search index. Returning the grantee list hands `authorize` the FACT and
   * leaves it the decision.
   */
  private readGranteesOf(resourceKind: string, resourceId: string): string[] {
    return this.store.grants
      .listForResource(resourceKind, resourceId)
      .filter((edge) => edge.verb === 'read' || edge.verb === 'write' || edge.verb === 'manage')
      .map((edge) => edge.grantee)
  }
}
