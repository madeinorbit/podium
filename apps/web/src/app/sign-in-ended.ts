/**
 * A SIGN-IN THE SERVER ENDED IS NOT AN OUTAGE (POD-6910): the web wiring of
 * client-core's {@link watchSignIn}. Every lost link asks the server whether
 * this device is still signed in. When it says no (this device was signed out
 * from the device list, or the member was removed), the runtime ends through
 * the same expiry path a refused sync takes: LoginGate drops the app, erases
 * this member's local data and shows the sign-in screen with the reason. No
 * answer is an outage: the hub keeps reconnecting and the cache stays.
 *
 * Browser, desktop and phone web app all run this one function.
 */
import { type SignInWatchHub, watchSignIn } from '@podium/client-core/live-connection'
import { type ClientPrincipal, principalKey } from '@podium/client-core/principal'
import { expireSignedInRuntime } from '@/lib/account-context'
import { webAuth } from '@/lib/accounts'

export function startSignInEndedWatch(
  hub: SignInWatchHub,
  args: { httpOrigin: string; principal: ClientPrincipal },
): () => void {
  const account = principalKey(args.principal)
  return watchSignIn(hub, {
    check: () => webAuth.checkLiveAuth(args.httpOrigin, null),
    memberId: args.principal.userId,
    onSignedOut: (reason) => expireSignedInRuntime(account, reason),
  })
}
