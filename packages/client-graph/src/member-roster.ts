import { lazy } from '@podium/mobx-helpers'
import type { MemberView } from '@podium/model'
import { action, compareShallow } from 'mobx'
import type { MobxPool, PoolRows } from './pool'
import { RequestAnswer } from './request-answer'
import type { MemberModel } from './requested-models'
import { ingestRequested } from './requested-record-source'
import { type RosterFacts, rosterFacts } from './worklist/view-model'

/** `/auth/members/directory`: the active members, and who is asking. */
export interface MemberRosterAnswer {
  members: MemberView[]
  currentMemberId: string
}

/**
 * THE INSTANCE'S MEMBERS, AS THE TASK VIEWS NAME THEM (POD-6294; design §2.2).
 *
 * Every signed-in member reads the directory. Its rows are `member` records in
 * the pool, the same records the admin's Members settings list writes, so a
 * name is read off one shared model wherever it shows. The answer keeps only the
 * ids and who the viewer is (display only, never a command input).
 *
 * `shared` is the one switch for the multi-user task rules on this client: the
 * Assigned to filter and the personal sidebar apply only once the roster shows
 * two or more active members. Until it has loaded, and on a one-member
 * instance, the Tasks view and the sidebar behave exactly as before.
 *
 * One roster per pool (`memberRoster`), loaded by the app shell and kept for the
 * pool's lifetime: the always-on sidebar reads it as well as the Tasks view.
 */
export class MemberRoster extends RequestAnswer<true> {
  constructor(private readonly pool: MobxPool) {
    super()
  }

  @action read(read: () => Promise<MemberRosterAnswer>): Promise<void> {
    return this.load(read, false, ({ members, currentMemberId }) => {
      const memberIds = ingestRequested(
        this.pool,
        'member',
        members as PoolRows['member'][],
        (row) => row.id,
      )
      const facts = rosterFacts(this.pool)
      const present = new Set(memberIds)
      const removed = facts.memberIds.filter((id) => !present.has(id))
      if (removed.length)
        this.pool.apply({
          type: 'update',
          rows: removed.map((id) => ({ kind: 'member', id, value: undefined })),
        })
      // The answer lives in the startup roster facts the worklist reads.
      facts.accept(memberIds, currentMemberId)
      return true as const
    })
  }

  /** The active members, in the directory's order (earliest first). */
  @lazy({ equals: compareShallow }) get members(): MemberModel[] {
    return rosterFacts(this.pool).members
  }

  /** The viewer's member id, for display and filtering only. */
  @lazy get currentMemberId(): string | undefined {
    return rosterFacts(this.pool).currentMemberId
  }

  /** Two or more active members: the multi-user task rules apply. */
  @lazy get shared(): boolean {
    return rosterFacts(this.pool).shared
  }

  /** Display names two or more active members share (POD-6295). */
  @lazy({ equals: compareShallow }) get sharedNames(): string[] {
    return rosterFacts(this.pool).sharedNames
  }

  /** A member's display name, or undefined while unknown; see {@link RosterFacts.nameOf}. */
  nameOf(id: string | null | undefined): string | undefined {
    return rosterFacts(this.pool).nameOf(id)
  }

  dispose() {
    this.close()
  }
}

/** The short, stable tag that tells two same-named members apart. */
export { memberTag } from './worklist/view-model'

/** The pool's one roster. */
export function memberRoster(pool: MobxPool): MemberRoster {
  return pool.sources.view('members.roster', () => new MemberRoster(pool))
}
