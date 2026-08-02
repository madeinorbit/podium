import { FIRST_ADMIN_USER_ID } from '@podium/model'
import { userClientPrincipal } from '../gateway/client-principal'

/** Explicit identity for in-process fixtures; never imported by production. */
export const testClientPrincipal = (connectionId: string) =>
  userClientPrincipal(connectionId, FIRST_ADMIN_USER_ID, 'admin')
