/**
 * @podium/server — session registry + Hono/ws/tRPC server. Exports the tRPC AppRouter type.
 */

export type {
  MemberOfRequest,
  MemberRefusal,
  MemberResolution,
} from './identity/member-of-request'
export { createMemberOfRequest, refusalAnswer } from './identity/member-of-request'
// The identity seam of a hosted composition root (docs/design/people-and-sign-in.md, section 3).
export type { ExistingMember, IdentitySeam, IdentitySeamDeps } from './identity/server-identity'
export type { InviteClaim, InviteIdentity } from './member-invites'
export { MemberInvites } from './member-invites'
export type { MemberInviteMail } from './member-routes'
export type { PodiumPlugin, PodiumPluginHooks } from './plugins'
export * from './relay'
export type { ServerRoleConfig } from './roles'
export type { AppRouter } from './router'
export type { ServerHandle } from './server'
export { startServer } from './server'
