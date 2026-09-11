import { firstAdminMemberId } from '@podium/model'
import type { ClientMux, ClientPeer, ClientTransport } from '../gateway/client-mux'

/** Explicit in-process transport authenticator used only by server fixtures. */
export function attachTestClient(mux: ClientMux, peer: ClientPeer): string {
  const transport: ClientTransport =
    typeof peer === 'function'
      ? { send: peer, userId: firstAdminMemberId(), userRole: 'admin' }
      : {
          ...peer,
          userId: peer.userId ?? firstAdminMemberId(),
          userRole: peer.userRole ?? 'admin',
        }
  return mux.attachClient(transport)
}
