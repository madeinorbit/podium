import { lazy } from '@podium/mobx-helpers'
import type { MemberView } from '@podium/model'
import { action, compareShallow } from 'mobx'
import { here } from './lookup'
import type { MobxPool, PoolRows } from './pool'
import { RequestAnswer } from './request-answer'
import { ingestRequested } from './requested-records'
import type { MemberRosterAnswer } from './member-roster'

export interface MemberDirectoryAnswer {
  members: MemberView[]
  invites: {
    id: string
    memberId?: string | null
    email: string | null
    role: string
    expiresAt: string
  }[]
  mailAvailable: boolean
  currentMemberId: string
  /** Absent on older servers, where the UI still asks for confirmation. */
  hasOwnCredential?: boolean
  /** What the admin may do to each member, decided by the server (POD-6299). */
  actions?: Record<string, readonly string[]>
}
type Directory = Omit<MemberDirectoryAnswer, 'members'> & { memberIds: readonly string[] }
/** Invite receipts and authority hints are request answers. Members are records. */
export class MemberDirectory extends RequestAnswer<Directory> {
  constructor(private readonly pool: MobxPool) {
    super()
  }
  @action read(read: () => Promise<MemberDirectoryAnswer | MemberRosterAnswer>): Promise<void> {
    return this.load(read, false, ({ members, ...answer }) => {
      const memberIds = ingestRequested(
        this.pool,
        'member',
        members as PoolRows['member'][],
        (row) => row.id,
      )
      const present = new Set(memberIds)
      const removed = (this.answer?.memberIds ?? []).filter((id) => !present.has(id))
      if (removed.length)
        this.pool.apply({
          type: 'update',
          rows: removed.map((id) => ({ kind: 'member', id, value: undefined })),
        })
      return {
        memberIds,
        currentMemberId: answer.currentMemberId,
        invites: 'invites' in answer ? answer.invites : [],
        mailAvailable: 'mailAvailable' in answer && answer.mailAvailable,
        hasOwnCredential: 'hasOwnCredential' in answer ? answer.hasOwnCredential : false,
        actions: 'actions' in answer ? answer.actions : undefined,
      }
    })
  }

  @lazy({ equals: compareShallow }) get members() {
    return (this.answer?.memberIds ?? []).flatMap((id) => here(this.pool.model('member', id)) ?? [])
  }
  @lazy get invites() {
    return this.answer?.invites ?? []
  }
  @lazy get mailAvailable() {
    return this.answer?.mailAvailable ?? false
  }
  @lazy get currentMemberId() {
    return this.answer?.currentMemberId
  }
  @lazy get hasOwnCredential() {
    return this.answer?.hasOwnCredential ?? true
  }
  /** The server's allowed actions for one member; none until it says so. */
  actionsFor(memberId: string): readonly string[] {
    return this.answer?.actions?.[memberId] ?? []
  }
  dispose() {
    this.close()
  }
}
