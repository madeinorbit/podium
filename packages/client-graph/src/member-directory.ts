import type { MemberView } from '@podium/model'
import { lazy } from '@podium/mobx-helpers'
import { action, compareShallow } from 'mobx'
import { here } from './lookup'
import type { MobxPool, PoolRows } from './pool'
import { RequestAnswer } from './request-answer'
import { ingestRequested } from './requested-records'

export interface MemberDirectoryAnswer {
  members: MemberView[]
  invites: { id: string; memberId?: string | null; email: string | null; role: string; expiresAt: string }[]
  mailAvailable: boolean
  currentMemberId: string
}
type Directory = Omit<MemberDirectoryAnswer, 'members'> & { memberIds: readonly string[] }
/** Invite receipts and authority hints are request answers. Members are records. */
export class MemberDirectory extends RequestAnswer<Directory> {
  constructor(private readonly pool: MobxPool) { super() }
  @action read(read: () => Promise<MemberDirectoryAnswer>): Promise<void> {
    return this.load(read, false, ({ members, ...answer }) => {
      const memberIds = ingestRequested(this.pool, 'member', members as PoolRows['member'][], row => row.id)
      const present = new Set(memberIds)
      const removed = (this.answer?.memberIds ?? []).filter(id => !present.has(id))
      if (removed.length) this.pool.apply({ type: 'update', rows: removed.map(id => ({ kind: 'member', id, value: undefined })) })
      return { ...answer, memberIds }
    })
  }

  @lazy({ equals: compareShallow }) get members() {
    return (this.answer?.memberIds ?? []).flatMap(id => here(this.pool.model('member', id)) ?? [])
  }
  @lazy get invites() { return this.answer?.invites ?? [] }
  @lazy get mailAvailable() { return this.answer?.mailAvailable ?? false }
  @lazy get currentMemberId() { return this.answer?.currentMemberId }
  dispose() { this.close() }
}
