/**
 * The parts of the sign-in library that only the cloud needs.
 *
 * podium-cloud imports the library only through this entry, so one process
 * holds one copy of it (specification, section 3).
 */
export type { BetterAuthPlugin } from 'better-auth'
export { organization } from 'better-auth/plugins/organization'
