import { FIRST_ADMIN_USER_ID } from '@podium/model'
import type { ClientMux, ClientPeer, ClientTransport } from '../gateway/client-mux'
import type { ClientPublicationAuthority } from '../modules/sessions/session'

/** Explicit in-process transport authenticator used only by server fixtures. */
export function attachTestClient(
  mux: ClientMux,
  peer: ClientPeer,
  publication?: ClientPublicationAuthority,
): string {
  const transport: ClientTransport =
    typeof peer === 'function'
      ? { send: peer, userId: FIRST_ADMIN_USER_ID, userRole: 'admin' }
      : {
          ...peer,
          userId: peer.userId ?? FIRST_ADMIN_USER_ID,
          userRole: peer.userRole ?? 'admin',
        }
  return mux.attachClient({
    ...transport,
    ...(publication ? { publication } : {}),
  })
}
