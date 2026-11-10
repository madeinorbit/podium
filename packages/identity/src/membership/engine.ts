/**
 * What every membership change shares (people and sign-in specification,
 * sections 1.4, 2.6 and 11.2): the transaction, the workspace revision, the
 * write of the membership and the application to the member row.
 *
 * Every change to a membership goes through `write` here, so a membership
 * never changes without its workspace's revision stepping and, where the
 * member rows share the database, without the member row following in the
 * same transaction.
 */
import type { Runtime } from '../runtime'
import { isGeneratedIdentifier } from '../secrets'
import { accountById } from '../statements'
import type { Actor, MemberRowsBinding, MembershipSnapshot } from '../types'
import { applyMembership } from './apply'
import {
  activeMembershipOfAccount,
  insertMembership,
  liveMembershipOfAccount,
  liveMembershipsOfAccount,
  lockRevision,
  type MembershipRole,
  type MembershipRow,
  type MembershipStatus,
  type MembershipWithAccountRow,
  membershipsAbove,
  stepRevision,
  updateMembership,
} from './statements'

/** One workspace this process serves, and how its member rows are reached. */
export interface BoundWorkspace {
  readonly workspaceId: string
  readonly binding: MemberRowsBinding
  /** Applies every membership change the member rows have not seen yet (section 11.2). */
  catchUp(): Promise<{ applied: number }>
}

/** The facts of a membership an operation decides; the engine adds the version. */
export interface MembershipFacts {
  workspaceId: string
  memberId: string
  accountId: string | null
  role: string
  status: string
  invitedEmail: string | null
  createdBy: string | null
  authorizationVersion?: number
}

export interface MembershipEngine {
  readonly runtime: Runtime
  /** The workspace-bound half of this process. Binding the same id again answers the first. */
  bind(workspaceId: string, binding: MemberRowsBinding): BoundWorkspace
  /**
   * Runs one membership operation of a workspace in one transaction. On
   * Postgres it takes the workspace's revision row first, so the operation's
   * checks and its write cannot be separated by another operation.
   */
  change<T>(workspaceId: string, fn: () => Promise<T>): Promise<T>
  /** Steps the revision, writes the membership with it and applies it. Inside `change` only. */
  write(
    facts: MembershipFacts,
    how: 'insert' | 'update',
    actor: Actor,
    authorityChanged?: boolean,
  ): Promise<MembershipRow>
}

/** A system actor for changes nobody in the workspace made: a profile change of the account. */
const ACCOUNT_CHANGE: Actor = { system: 'host' }

export function createMembershipEngine(runtime: Runtime): MembershipEngine {
  const bound = new Map<string, BoundWorkspace & { actors: Map<number, Actor> }>()
  const onPostgres = runtime.config.database.dialect === 'pg'

  async function profileOf(accountId: string | null): Promise<MembershipSnapshot['profile']> {
    if (accountId === null) return null
    const [account] = await accountById(runtime.db()).run({ id: accountId })
    if (!account) return null
    return {
      name: account.name,
      image: account.image,
      email: isGeneratedIdentifier(account.email) ? null : account.email,
    }
  }

  function snapshotOf(
    row: MembershipRow,
    profile: MembershipSnapshot['profile'],
    actor: Actor,
  ): MembershipSnapshot {
    return {
      memberId: row.memberId,
      version: row.version,
      authorizationVersion: row.authorizationVersion,
      status: row.status as MembershipStatus,
      role: row.role as MembershipRole,
      accountId: row.accountId,
      profile,
      actor,
    }
  }

  const profileOfJoined = (row: MembershipWithAccountRow): MembershipSnapshot['profile'] =>
    row.accountId === null || row.accountName === null || row.accountEmail === null
      ? null
      : {
          name: row.accountName,
          image: row.accountImage,
          email: isGeneratedIdentifier(row.accountEmail) ? null : row.accountEmail,
        }

  async function change<T>(workspaceId: string, fn: () => Promise<T>): Promise<T> {
    const nested = runtime.inTransaction()
    const result = await runtime.transaction(async () => {
      if (onPostgres) await lockRevision(runtime.db()).run({ workspaceId })
      return await fn()
    })
    // Member rows that live elsewhere follow after the commit, before the
    // operation answers (section 11.3). Inside a caller's own transaction
    // nothing is committed yet; the caller's catch-up applies it.
    if (!nested) await bound.get(workspaceId)?.catchUp()
    return result
  }

  async function write(
    facts: MembershipFacts,
    how: 'insert' | 'update',
    actor: Actor,
    authorityChanged = true,
  ): Promise<MembershipRow> {
    const db = runtime.db()
    const [stepped] = await stepRevision(db).run({ workspaceId: facts.workspaceId })
    if (!stepped) throw new Error('identity: the workspace revision did not step')
    const version = Number(stepped.revision)
    const authorizationVersion =
      authorityChanged && how !== 'insert' ? version : (facts.authorizationVersion ?? 0)
    const now = runtime.now()
    if (how === 'insert') {
      await insertMembership(db).run({
        workspaceId: facts.workspaceId,
        memberId: facts.memberId,
        accountId: facts.accountId,
        role: facts.role,
        status: facts.status,
        version,
        authorizationVersion,
        invitedEmail: facts.invitedEmail,
        createdBy: facts.createdBy ?? ('system' in actor ? actor.system : actor.memberId),
        now,
      })
    } else {
      await updateMembership(db).run({
        workspaceId: facts.workspaceId,
        memberId: facts.memberId,
        accountId: facts.accountId,
        role: facts.role,
        status: facts.status,
        version,
        authorizationVersion,
        invitedEmail: facts.invitedEmail,
        now,
      })
    }
    const row: MembershipRow = { ...facts, version, authorizationVersion }
    const workspace = bound.get(facts.workspaceId)
    if (workspace?.binding.sameDatabase) {
      // The member row changes in the transaction that changed the membership.
      await applyMembership(
        workspace.binding.rows,
        snapshotOf(row, await profileOf(row.accountId), actor),
      )
    } else if (workspace) {
      // Catch-up applies it after the commit and attributes it to this actor.
      workspace.actors.set(version, actor)
    }
    return row
  }

  function bind(workspaceId: string, binding: MemberRowsBinding): BoundWorkspace {
    const earlier = bound.get(workspaceId)
    if (earlier) return earlier
    const actors = new Map<number, Actor>()

    async function run(): Promise<{ applied: number }> {
      if (binding.sameDatabase) return { applied: 0 }
      const cursor = await binding.cursor.read()
      const rows = await membershipsAbove(runtime.db()).run({ workspaceId, version: cursor })
      let applied = 0
      // In version order, stopping at the first failure: the cursor stays
      // before it, so the next run starts there. The server commits each row
      // and cursor together. Bindings without a transaction retain harmless,
      // idempotent replay after a crash between the two writes.
      for (const row of rows) {
        const actor = actors.get(row.version) ?? { system: 'organisation' }
        const apply = async () => {
          await applyMembership(binding.rows, snapshotOf(row, profileOfJoined(row), actor))
          await binding.cursor.write(row.version)
        }
        if (binding.cursor.transaction) await binding.cursor.transaction(apply)
        else await apply()
        applied += 1
      }
      // An actor noted for a version that is now behind the cursor is spent,
      // also one whose transaction rolled back.
      const reached = rows.at(-1)?.version ?? cursor
      for (const version of actors.keys()) {
        if (version <= reached) actors.delete(version)
      }
      return { applied }
    }

    // One run is in flight in a process; a call during a run waits for it and
    // then runs once more.
    let current: Promise<{ applied: number }> | undefined
    let next: Promise<{ applied: number }> | undefined
    function catchUp(): Promise<{ applied: number }> {
      if (!current) {
        current = run().finally(() => {
          current = undefined
        })
        return current
      }
      next ??= current
        .catch(() => undefined)
        .then(() => {
          next = undefined
          return catchUp()
        })
      return next
    }

    const workspace = { workspaceId, binding, actors, catchUp }
    bound.set(workspaceId, workspace)
    return workspace
  }

  // With local accounts, an account may sign in only while it has an active
  // membership (section 2.1). A shared account outlives its memberships.
  if (runtime.config.accounts === 'local') {
    runtime.signInGate = async (accountId) =>
      (await activeMembershipOfAccount(runtime.db()).run({ accountId })).length > 0
  }

  // A change of an account's name, picture or email adds one to the version of
  // each of its live memberships, so the new facts reach the member rows
  // (section 2.4).
  runtime.accountChanged.push(async (accountId) => {
    const nested = runtime.inTransaction()
    const workspaces = await runtime.transaction(async () => {
      const rows = await liveMembershipsOfAccount(runtime.db()).run({ accountId })
      // One order for every caller, so two changes never wait on each other.
      rows.sort((a, b) => (a.workspaceId < b.workspaceId ? -1 : 1))
      for (const row of rows) {
        if (!onPostgres) {
          await write(row, 'update', ACCOUNT_CHANGE, false)
          continue
        }
        const { workspaceId } = row
        await lockRevision(runtime.db()).run({ workspaceId })
        // The first read finds workspaces. The member may have changed while
        // we waited for this lock; a profile edit must preserve current rights.
        const [current] = await liveMembershipOfAccount(runtime.db()).run({ workspaceId, accountId })
        if (current) await write(current, 'update', ACCOUNT_CHANGE, false)
      }
      return rows.map((row) => row.workspaceId)
    })
    if (nested) return
    for (const workspaceId of workspaces) await bound.get(workspaceId)?.catchUp()
  })

  return { runtime, bind, change, write }
}
