import { lazy } from '@podium/mobx-helpers'
import type { MemberView } from '@podium/model'
import { action, compareShallow } from 'mobx'
import { here } from './lookup'
import type { MobxPool } from './pool'
import { RequestAnswer } from './request-answer'
import type { MemberModel } from './requested-models'
import { ingestRequested } from './requested-record-source'
import { type RosterFacts, rosterFacts } from './worklist/view-model'

/** `/auth/members/directory`: the active members, and who is asking. */
export interface MemberRosterAnswer {
  members: Pick<MemberView, 'id' | 'displayName' | 'role'>[]
  currentMemberId: string
}

/**
 * The public directory hydrates only names and roles. Omitted admin fields
 * stay as last authorized by `/list` in this principal's pool; they are not
 * cleared or inferred from roster membership. New members have no admin data.
 */
export function ingestMemberRoster(
  pool: MobxPool,
  members: MemberRosterAnswer['members'],
): string[] {
  return ingestRequested(
    pool,
    'member',
    members.map(({ id, displayName, role }) => ({
      ...here(pool.row('member', id)),
      id,
      displayName,
      role,
    })),
    (row) => row.id,
  )
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
      const memberIds = ingestMemberRoster(this.pool, members)
      const facts = rosterFacts(this.pool)
      // Absence means inactive, not deleted: an admin list may still show
      // that member. Only replace the active ids the worklist reads.
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
