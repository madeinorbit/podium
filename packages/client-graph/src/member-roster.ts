import { lazy } from '@podium/mobx-helpers'
import type { MemberView } from '@podium/model'
import { action, compareShallow } from 'mobx'
import { here } from './lookup'
import type { MobxPool, PoolRows } from './pool'
import { RequestAnswer } from './request-answer'
import type { MemberModel } from './requested-models'
import { ingestRequested } from './requested-record-source'

/** `/auth/members/directory`: the active members, and who is asking. */
export interface MemberRosterAnswer {
  members: MemberView[]
  currentMemberId: string
}

type Roster = { memberIds: readonly string[]; currentMemberId: string }

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
export class MemberRoster extends RequestAnswer<Roster> {
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
      const present = new Set(memberIds)
      const removed = (this.answer?.memberIds ?? []).filter((id) => !present.has(id))
      if (removed.length)
        this.pool.apply({
          type: 'update',
          rows: removed.map((id) => ({ kind: 'member', id, value: undefined })),
        })
      return { memberIds, currentMemberId }
    })
  }

  /** The active members, in the directory's order (earliest first). */
  @lazy({ equals: compareShallow }) get members(): MemberModel[] {
    return (this.answer?.memberIds ?? []).flatMap((id) => {
      const member = here(this.pool.model('member', id))
      return member && !member.disabledAt ? [member] : []
    })
  }

  /** The viewer's member id, for display and filtering only. */
  @lazy get currentMemberId(): string | undefined {
    return this.answer?.currentMemberId
  }

  /** Two or more active members: the multi-user task rules apply. */
  @lazy get shared(): boolean {
    return this.members.length > 1
  }

  /** Display names two or more active members share (POD-6295). */
  @lazy({ equals: compareShallow }) get sharedNames(): string[] {
    const counts = new Map<string, number>()
    for (const member of this.members) {
      const name = member.displayName?.trim()
      if (name) counts.set(name, (counts.get(name) ?? 0) + 1)
    }
    return [...counts]
      .filter(([, count]) => count > 1)
      .map(([name]) => name)
      .sort()
  }

  /**
   * A member's display name, or undefined while unknown (not loaded, or not an
   * active member any more). A name another active member also uses carries a
   * short tag from the member id, `Sam (k3f9)`, so two people never read as
   * one. Never the email: another member's email is the admins' (MU-13).
   */
  nameOf(id: string | null | undefined): string | undefined {
    if (!id) return undefined
    const name = here(this.pool.model('member', id))?.displayName?.trim() || undefined
    return name && this.sharedNames.includes(name) ? `${name} (${memberTag(id)})` : name
  }

  dispose() {
    this.close()
  }
}

/** The short, stable tag that tells two same-named members apart. */
export function memberTag(id: string): string {
  return id.replace(/^mem_/, '').slice(-4)
}

/** The pool's one roster. */
export function memberRoster(pool: MobxPool): MemberRoster {
  return pool.sources.view('members.roster', () => new MemberRoster(pool))
}
