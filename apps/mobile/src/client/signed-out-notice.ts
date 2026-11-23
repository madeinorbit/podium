/**
 * WHY THE SERVER ENDED THIS PHONE'S SIGN-IN (POD-6910), carried from the live
 * provider, which learns it, to the sign-in screen, which says it. Dropping
 * the credential remounts everything between the two, so the reason is kept
 * here, for the one profile it belongs to, until the next sign-in.
 */
import { SIGNED_OUT_COPY, type SignedOutReason } from '@podium/client-core/live-connection'

let pending: { profileId: string; reason: SignedOutReason } | undefined

export function noteSignedOut(profileId: string, reason: SignedOutReason): void {
  pending = { profileId, reason }
}

/** The sentence for this profile's sign-in screen, if its sign-in was ended. */
export function signedOutNotice(profileId: string): string | undefined {
  return pending?.profileId === profileId ? SIGNED_OUT_COPY[pending.reason] : undefined
}

export function clearSignedOutNotice(): void {
  pending = undefined
}
