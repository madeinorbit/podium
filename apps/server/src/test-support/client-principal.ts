import { firstAdminMemberId } from '@podium/model'
import { userClientPrincipal } from '../gateway/client-principal'

/** Explicit identity for in-process fixtures; never imported by production. */
export const testClientPrincipal = (connectionId: string) =>
  userClientPrincipal(connectionId, firstAdminMemberId(), 'admin')
