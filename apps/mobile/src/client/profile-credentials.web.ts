import { cookieCredentials } from '@podium/client-core/accounts'

/** The browser owns its HttpOnly cookie; no token is read or persisted by either app. */
export const getProfileCredential = cookieCredentials.get
export const setProfileCredential = cookieCredentials.set
export const deleteProfileCredential = cookieCredentials.remove
export async function purgeOrphanedProfileCredentials(_validProfileIds: string[]): Promise<void> {}
