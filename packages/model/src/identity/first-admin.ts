/** Resolve an ambient owner from the owning store, never from the last store opened. */
import { type UserId, asUserId } from '../ids/brands'

export interface FirstAdminSource {
  users: { earliestAdmin(): Promise<{ id: string } | undefined> }
}

// Only fixture setup primes this slot. Production must supply its store.
const SLOT = Symbol.for('podium.identity.firstAdminFixture')
type SlotHolder = { [SLOT]?: UserId }

export function firstAdminMemberId(source: FirstAdminSource): Promise<UserId>
/** @deprecated Test fixture identity only; production callers must pass their store. */
export function firstAdminMemberId(): UserId
export function firstAdminMemberId(source?: FirstAdminSource): UserId | Promise<UserId> {
  if (source) return source.users.earliestAdmin().then(member => {
    if (!member) throw new Error('the first admin member is not resolved: no active administrator in this store')
    return asUserId(member.id)
  })
  const id = firstAdminMemberIdOrUndefined()
  if (id === undefined) throw new Error('the first admin member is not resolved: pass the owning store or prime a test fixture')
  return id
}

export function firstAdminMemberIdOrUndefined(): UserId | undefined {
  return (globalThis as SlotHolder)[SLOT]
}

/** Test fixture setup only. Opening a production database never writes this slot. */
export function primeFirstAdminMember(id: UserId | string): UserId | undefined {
  const previous = firstAdminMemberIdOrUndefined()
  ;(globalThis as SlotHolder)[SLOT] = asUserId(id)
  return previous
}

export function clearFirstAdminMember(): void {
  delete (globalThis as SlotHolder)[SLOT]
}
