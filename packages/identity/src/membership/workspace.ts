/**
 * The workspace-bound half of the core (people and sign-in specification,
 * sections 2.3, 2.5 and 5.5): from a request to a member, through an active
 * membership and nothing else.
 */
import { type Credentials, candidateOf, LAST_SEEN_EVERY_MS, renewDue } from '../credentials'
import { toDeviceSignIn } from '../device-sign-ins'
import { storedTokenForm, verifySignedToken } from '../secrets'
import { firstPasswordAccounts, touchLastSeen } from '../statements'
import type {
  ConnectionFacts,
  DeviceKind,
  IdentityCore,
  Resolution,
  WorkspaceIdentity,
} from '../types'
import type { BoundWorkspace, MembershipEngine } from './engine'
import { membershipOperations } from './operations'
import {
  countSignInsOfWorkspace,
  heldSignInStillValid,
  invitedMembershipByEmail,
  type MembershipRole,
  sameMachineFacts,
  signInsOfWorkspace,
  signInWithMembership,
} from './statements'

export function workspaceIdentity(
  engine: MembershipEngine,
  workspace: BoundWorkspace,
  core: IdentityCore,
  credentials: Credentials,
): WorkspaceIdentity {
  const { runtime } = engine
  const { workspaceId } = workspace
  const db = () => runtime.db()

  /**
   * THE SAME-MACHINE RULE (section 5.5): the sole active member, when this
   * edition has the rule, exactly one membership is active, and no account has
   * a password unless the server waived sign-in. One statement.
   */
  async function soleMember(): Promise<
    { memberId: string; role: MembershipRole; accountId: string } | undefined
  > {
    const policy = runtime.config.sameMachine
    if (!policy) return undefined
    const rows = await sameMachineFacts(db()).run({ workspaceId })
    const [only] = rows
    if (rows.length !== 1 || !only || only.accountId === null) return undefined
    if (only.password && !(await policy.waived())) return undefined
    return {
      memberId: only.memberId,
      role: only.role as MembershipRole,
      accountId: only.accountId,
    }
  }

  async function resolve(request: Request, facts: ConnectionFacts): Promise<Resolution> {
    const configuration = runtime.configurationFor(facts)
    // Plain HTTP that is not same-machine is answered before anything is read.
    if (!configuration) return { kind: 'https_required' }

    const candidate = candidateOf(request, facts, configuration)
    // A value whose signature fails is treated as no credential.
    const token = candidate && verifySignedToken(candidate.signed, runtime.config.secret)
    if (token) {
      const now = runtime.now()
      const [row] = await signInWithMembership(db()).run({
        token: storedTokenForm(token),
        now,
        workspaceId,
      })
      if (row) {
        if (!row.lastSeenAt || now.getTime() - row.lastSeenAt.getTime() >= LAST_SEEN_EVERY_MS) {
          await touchLastSeen(db()).run({
            id: row.id,
            now,
            stale: new Date(now.getTime() - LAST_SEEN_EVERY_MS),
          })
        }
        if (row.status === 'active' && row.memberId !== null) {
          return {
            kind: 'member',
            memberId: row.memberId,
            role: row.role as MembershipRole,
            accountId: row.accountId,
            deviceSignIn: { id: row.id, kind: row.kind as DeviceKind, expiresAt: row.expiresAt },
            renewDue: renewDue(row, now),
          }
        }
        // Signed in, and not a member here. A membership that is only invited
        // names no account yet; it is known by the address it was issued for.
        let membership: 'none' | 'invited' | 'disabled' | 'removed' = 'none'
        if (row.status === 'disabled' || row.status === 'removed') {
          membership = row.status
        } else {
          const invited = await invitedMembershipByEmail(db()).run({
            workspaceId,
            email: row.accountEmail,
          })
          if (invited.length > 0) membership = 'invited'
        }
        return { kind: 'not-a-member', accountId: row.accountId, membership }
      }
    }

    // No valid credential: the same-machine rule, or nobody.
    if (facts.sameMachine) {
      const sole = await soleMember()
      if (sole) return { kind: 'member', ...sole, deviceSignIn: null, renewDue: false }
    }
    return { kind: 'unauthenticated' }
  }

  return {
    workspaceId,
    core,
    resolve,

    async revalidate(held) {
      if ('sameMachine' in held) {
        // Admitted by the rule: the rule is evaluated again.
        const sole = await soleMember()
        return sole !== undefined && sole.memberId === held.memberId && sole.role === held.role
      }
      const rows = await heldSignInStillValid(db()).run({
        id: held.deviceSignInId,
        now: runtime.now(),
        workspaceId,
        memberId: held.memberId,
        role: held.role,
      })
      return rows.length > 0
    },

    renew: (request, facts) => credentials.renew(request, facts),

    async signInRequired() {
      const policy = runtime.config.sameMachine
      if (!policy) return true
      const rows = await sameMachineFacts(db()).run({ workspaceId })
      if (rows.length >= 2) return true
      // With no active member the statement has no row to carry the password fact.
      const password =
        rows.length === 1
          ? Boolean(rows[0]?.password)
          : (await firstPasswordAccounts(db()).run({})).length > 0
      return password && !(await policy.waived())
    },

    memberships: membershipOperations(engine, workspace, core.accounts),

    async listDeviceSignIns(page) {
      const now = runtime.now()
      const rows = await signInsOfWorkspace(db()).run({ workspaceId, now, limit: page.limit })
      const [count] = await countSignInsOfWorkspace(db()).run({ workspaceId, now })
      return {
        signIns: rows.map((row) => toDeviceSignIn(row, undefined)),
        total: Number(count?.total ?? 0),
      }
    },

    catchUp: () => workspace.catchUp(),
  }
}
