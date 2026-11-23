import { parseReplicaNamespaceKey } from '@podium/client-core/replica'

/** Which member a refusal is about, as the replica's namespace key. */
export function refusedPrincipal(
  opened: string | undefined,
  profile: { syncBoundaryId?: string | undefined; memberId?: string | undefined } | undefined,
): string | undefined {
  if (opened && parseReplicaNamespaceKey(opened)) return opened
  return profile?.syncBoundaryId && profile.memberId
    ? JSON.stringify([profile.syncBoundaryId, profile.memberId])
    : undefined
}

/**
 * THE SERVER REFUSED THIS MEMBER (POD-6297, the phone's half of POD-6293;
 * design §4.5). Disabled, removed or signed out everywhere, perhaps while the
 * phone was offline: that member's stored data goes before anything is shown
 * again, and only theirs.
 *
 * HOW THEY SIGN BACK IN. A paired profile is a server address plus a bearer.
 * Removing the profile would make the person pair the server again. Instead the
 * phone does what its own Log out does: erase the member's data, drop the
 * credential, keep the saved server. The person lands on that server's sign-in
 * (email and password, or the hosted sign-in) and starts with a fresh replica.
 * Pairing again stays available from Settings for a server they cannot sign in
 * to that way.
 *
 * The credential is dropped even when the erase fails: a refused member must
 * not keep a working session here. The failure is reported, and the profile is
 * already marked signed out, so the data is not opened offline either.
 */
export async function discardRefusedMember(args: {
  principal: string | undefined
  /** The browser build: other tabs share the saved account, so it is removed
   *  for this member (which also erases their namespace). */
  web: boolean
  erase(principal: string): Promise<void>
  removeWebPrincipal(principal: string): Promise<void>
  clearCredential(): Promise<void>
  report(cause: unknown): void
}): Promise<void> {
  if (args.principal !== undefined) {
    try {
      await (args.web ? args.removeWebPrincipal(args.principal) : args.erase(args.principal))
    } catch (cause) {
      args.report(cause)
    }
  }
  await args.clearCredential()
}
