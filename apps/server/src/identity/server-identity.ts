/**
 * THE SERVER'S IDENTITY (POD-6746; docs/design/people-and-sign-in.md, sections
 * 2.1 and 3).
 *
 * One `WorkspaceIdentity` per server process, and the server does not know
 * which database is behind it:
 *
 * - a self-hosted server builds the core on its own store, with the
 *   self-hosted edition configuration, and binds the workspace `local`;
 * - a hosted composition root builds one identity core on Postgres for its
 *   process and hands the server the workspace half of it through
 *   `startServer({ identity })`. The option is a function because what it
 *   needs from the server exists only after the server has opened its store.
 *
 * Nothing else in the server chooses between the two. What the server gives
 * the hosted function is over the workspace database; none of it is a secret
 * or an address.
 */
import { randomBytes } from 'node:crypto'
import {
  type AppliedCursor,
  createIdentityCore,
  type MemberRows,
  type WorkspaceIdentity,
} from '@podium/identity'
import { createLogger } from '@podium/logger'
import { newMemberId } from '@podium/model'
import { hashPassword, isPasswordHash, verifyPasswordHash } from '@podium/runtime/auth-store'
import type { SessionStore } from '../store'
import { ensureLocalIdentity } from './ensure-local-identity'

const log = createLogger('server:identity')

/** The workspace id of a self-hosted database: it holds exactly one workspace. */
export const LOCAL_WORKSPACE_ID = 'local'

/** One member row of the workspace database, as the seam shows it. */
export interface ExistingMember {
  memberId: string
  role: 'admin' | 'member'
  /** A removed member is a disabled row too; only a membership tells the two apart. */
  disabled: boolean
  /** The account id on the row, which only apply-membership writes. */
  accountId: string | null
}

export interface IdentitySeamDeps {
  /** The server's member rows. The package's apply-membership is the only caller of `write`. */
  memberRows: MemberRows
  /**
   * One number in the workspace database's `meta` table (key
   * `identity.appliedMembershipVersion`): every membership change up to it has
   * been applied to the member rows. 0 before the first write.
   */
  appliedCursor: AppliedCursor
  /**
   * Every member row of the workspace database, disabled ones included, IN
   * CREATION ORDER, EARLIEST FIRST (rows created at the same instant are
   * ordered by member id). Read-only. A hosted root calls it once per boot,
   * before the server serves, to adopt the rows that carry an account id and
   * to find the earliest enabled admin row without one.
   */
  existingMembers(): Promise<ExistingMember[]>
  /**
   * True on a start whose workspace database cannot be written (the recovery
   * start of a server move). The function must then write nothing through
   * `memberRows` or the cursor: adopt nothing, and try again at the next
   * start. The server does not call `catchUp()` on such a start either.
   */
  recoveryOnly: boolean
}

/** What a hosted composition root passes as `startServer({ identity })`. */
export type IdentitySeam = (
  deps: IdentitySeamDeps,
) => WorkspaceIdentity | Promise<WorkspaceIdentity>

export function identitySeamDeps(
  store: SessionStore,
  opts: { recoveryOnly?: boolean } = {},
): IdentitySeamDeps {
  return {
    recoveryOnly: opts.recoveryOnly === true,
    memberRows: store.users.memberRows,
    appliedCursor: {
      transaction: (run) => store.transact(run),
      read: () => store.settings.appliedMembershipVersion(),
      write: (version) => store.settings.recordAppliedMembershipVersion(version),
    },
    existingMembers: async () =>
      (await store.users.listIncludingDisabled()).map((row) => ({
        memberId: row.id,
        role: row.role,
        disabled: row.disabledAt !== null,
        accountId: row.accountId ?? null,
      })),
  }
}

export interface ServerIdentity {
  readonly workspace: WorkspaceIdentity
  /** True: the server built the core on its own database. False: the seam handed it one. */
  readonly local: boolean
}

export async function openServerIdentity(
  store: SessionStore,
  opts: {
    seam?: IdentitySeam | undefined
    /** A store that cannot be written (transfer recovery): nothing is created or applied. */
    readOnly?: boolean
    /** Tests only: the ids of the members this server mints. Absent: the model's. */
    newMemberId?: (() => string) | undefined
  } = {},
): Promise<ServerIdentity> {
  if (opts.seam) {
    const workspace = await opts.seam(identitySeamDeps(store, { recoveryOnly: opts.readOnly }))
    // Hosted: the memberships live elsewhere, so the member rows are brought
    // up to date before anything is served (section 11). startServer owns the timer.
    if (!opts.readOnly) await workspace.catchUp()
    return { workspace, local: false }
  }

  const core = await createIdentityCore({
    database: store.identityDatabase(),
    // A store that cannot be written and has no secret yet holds no sign-in
    // either, so a secret that lives only as long as this process loses nothing.
    secret: opts.readOnly
      ? ((await store.secrets.identitySigningSecret({ create: false })) ??
        randomBytes(32).toString('base64url'))
      : await store.secrets.identitySigningSecret(),
    loginMethods: { password: true },
    mail: null,
    selfSignUp: false,
    accounts: 'local',
    hosts: { kind: 'self-hosted' },
    // The operator's own choice about their own machine; a second active
    // member ends the rule whatever this says (section 5.5).
    sameMachine: { waived: () => store.settings.resolve('authOpenMode').value },
    passwordHashing: {
      hash: hashPassword,
      verify: ({ password, hash }) => verifyPasswordHash(password, hash),
      isHash: isPasswordHash,
    },
    rateLimit: { storage: 'memory' },
    newMemberId: opts.newMemberId ?? newMemberId,
  })
  const workspace = core.workspace(LOCAL_WORKSPACE_ID, {
    rows: store.users.memberRows,
    sameDatabase: true,
  })
  // Only a server that built its own core: a hosted workspace database must
  // never get local accounts.
  if (!opts.readOnly) {
    const outcome = await ensureLocalIdentity(store, workspace)
    if (outcome.kind === 'adopted-first-admin') {
      log.info('the first admin of this database got its membership and account', {
        memberId: outcome.memberId,
      })
    } else if (outcome.kind === 'left-untouched') {
      log.warn(
        'this database has members from before shared sign-in and no memberships; it was left untouched and nobody can sign in until the upgrade step exists',
        { reason: outcome.reason, members: outcome.members },
      )
    }
  }
  return { workspace, local: true }
}
