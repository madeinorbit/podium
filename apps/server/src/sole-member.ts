import { asUserId, type UserId } from '@podium/model'

/**
 * THE OWNER OF WORK THAT NAMES NONE (POD-6285).
 *
 * Some in-process callers predate per-person ownership and start or revive a
 * session without saying for whom. On a one-person instance the answer was,
 * and stays, that person. Once a second member exists there is no honest
 * answer, so the call is refused rather than handed to "the first admin".
 * Request paths always name their caller and never reach this.
 */
export async function soleMemberFor(
  users: { soleActiveMember(): Promise<{ id: string } | undefined> },
  what: string,
): Promise<UserId> {
  const sole = await users.soleActiveMember()
  if (!sole) throw new Error(`${what} names no owner, and this instance has more than one member`)
  return asUserId(sole.id)
}
