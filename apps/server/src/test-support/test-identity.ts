/**
 * Identity for tests (POD-6746).
 *
 * `openTestIdentity` gives a test store the identity a self-hosted server
 * builds on it at boot, by the same function: the real core, the real member
 * rows, and the first admin's membership and account. Members are then made
 * the only way a member comes to exist, by an invitation that is accepted.
 *
 * `stubMemberOfRequest` is for a test of something BEHIND the resolver (a
 * guard's answer, a route's own rule) that has no need of a database.
 */
import type { ConnectionFacts, IssuedSignIn, WorkspaceIdentity } from '@podium/identity'
import { asUserId, type UserId, type UserRole } from '@podium/model'
import { userCommandPrincipal } from '../command-principal'
import { type MemberCredentials, memberCredentials } from '../identity/member-credentials'
import {
  createMemberOfRequest,
  type MemberOfRequest,
  type MemberResolution,
} from '../identity/member-of-request'
import { openServerIdentity } from '../identity/server-identity'
import type { SessionStore } from '../store'

export interface TestIdentity {
  workspace: WorkspaceIdentity
  credentials: MemberCredentials
  memberOfRequest: MemberOfRequest
  /** Invites a member as the host and accepts for them; answers the new member id. */
  addMember(input: {
    name: string
    email: string
    password?: string
    role?: UserRole
  }): Promise<UserId>
  /** A password sign-in from an address of its own; throws when it is refused. */
  signIn(
    input: { email?: string; password: string },
    facts?: ConnectionFacts,
  ): Promise<IssuedSignIn>
}

/** Each sign-in comes from an address of its own: the library limits sign-ins per address. */
let addresses = 0
export function httpsFacts(): ConnectionFacts {
  addresses += 1
  return {
    scheme: 'https',
    sameMachine: false,
    clientAddress: `10.8.${(addresses >> 8) & 255}.${addresses & 255}`,
  }
}

/** The `name=value` pair of the cookie a sign-in set. */
export function cookieOf(signIn: IssuedSignIn): string {
  const cookie = signIn.headers.getSetCookie().find((c) => c.includes('session_token'))
  if (!cookie) throw new Error('the sign-in set no cookie')
  return cookie.split(';')[0] as string
}

export async function openTestIdentity(
  store: SessionStore,
  opts: {
    trustedProxyHops?: number
    /** The ids of the members `addMember` makes, for a test that names one. */
    newMemberId?: () => string
  } = {},
): Promise<TestIdentity> {
  const { workspace } = await openServerIdentity(store, { newMemberId: opts.newMemberId })
  const credentials = memberCredentials(store.users, workspace.core.accounts)
  return {
    workspace,
    credentials,
    memberOfRequest: createMemberOfRequest({
      identity: workspace,
      users: store.users,
      trustedProxyHops: opts.trustedProxyHops ?? 0,
    }),
    async addMember(input) {
      const { invitation } = await workspace.memberships.invite({
        actor: { system: 'host' },
        role: input.role ?? 'member',
        email: input.email,
      })
      const accepted = await workspace.memberships.accept({
        token: invitation.token,
        account: {
          kind: 'new',
          name: input.name,
          email: input.email,
          ...(input.password ? { password: input.password } : {}),
        },
      })
      return asUserId(accepted.memberId)
    },
    async signIn(input, facts = httpsFacts()) {
      const issued = await workspace.core.signIn.password(
        { ...input, device: { kind: 'browser' }, delivery: 'cookie' },
        facts,
      )
      if ('refused' in issued) throw new Error(`sign-in refused: ${issued.refused}`)
      return issued
    },
  }
}

/** A `member` resolution for a stub, as `memberOfRequest` would give it. */
export function memberResolution(
  memberId: string,
  role: UserRole,
  deviceSignInId: string | null = 'test-device-sign-in',
): Extract<MemberResolution, { kind: 'member' }> {
  const id = asUserId(memberId)
  return {
    kind: 'member',
    memberId: id,
    role,
    principal: userCommandPrincipal(id, role),
    accountId: `account-of-${memberId}`,
    deviceSignIn: deviceSignInId
      ? { id: deviceSignInId, kind: 'browser', expiresAt: new Date('2999-01-01T00:00:00Z') }
      : null,
    renewDue: false,
  }
}

export function stubMemberOfRequest(
  resolve: (request: Request) => MemberResolution | Promise<MemberResolution>,
): MemberOfRequest {
  return Object.assign(async (request: Request) => await resolve(request), {
    factsOf: (request: Request): ConnectionFacts => ({
      scheme: request.url.startsWith('https:') ? ('https' as const) : ('http' as const),
      sameMachine: false,
      clientAddress: null,
    }),
  })
}
