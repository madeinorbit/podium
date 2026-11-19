/**
 * THE SAME-ID SEED OF MACHINES, REPOSITORIES AND PEOPLE, shared by its two-workspace test
 * (`store/people.workspace.test.ts`) and the completeness test
 * (`store/workspace-isolation.test.ts`, POD-7025). Moved here from that test unchanged: both
 * workspaces hold the same ids and natural keys, with content of their own (see the test's
 * header).
 */

import { createHash } from 'node:crypto'
import type { MemberWrite } from '@podium/identity'
import {
  type AccountId,
  asAccountId,
  asIssueId,
  asMachineId,
  asUserId,
  type MachineId,
  type UserId,
} from '@podium/model'
import { sql } from 'drizzle-orm'
import { deriveRepoId } from '../../repo-id'
import type { CheckoutRow } from '../../store/checkouts'
import type { GrantRow } from '../../store/grants'
import type { WorkspacePeopleSlice } from '../people-store-slice'

export type Tag = 'a' | 'b'
export const WS: Record<Tag, string> = { a: 'ws_a', b: 'ws_b' }
/** Each workspace's own timestamp: content, not a key. */
export const AT_OF: Record<Tag, string> = {
  a: '2026-11-17T10:00:00.000Z',
  b: '2026-11-17T10:30:00.000Z',
}
export const AT = AT_OF.a
export const LATER = '2099-01-01T00:00:00.000Z'
export const otherOf = (tag: Tag): Tag => (tag === 'a' ? 'b' : 'a')
export const sha = (value: string) => createHash('sha256').update(value).digest('hex')
export const ANTHROPIC: AccountId = asAccountId('managed:anthropic')
/** Machine 1's bearer token: content (a credential), so it differs per workspace. */
export const token = (tag: Tag) => SHARED.token(tag)

/**
 * The ids and natural keys a seed writes. `SHARED` (no prefix) is the set both workspaces
 * hold; a prefixed set is a plant only one workspace holds.
 */
export function idsFor(p = '') {
  return {
    user: (name = 'alice'): UserId => asUserId(`user:${p}${name}`),
    machine: (n = 1): MachineId => asMachineId(`${p}machine-${n}`),
    root: `/${p}repo`,
    origin: `https://example.test/${p}project.git`,
    prefix: p === '' ? 'AAA' : 'OBB',
    issue: `${p}iss-1`,
    profile: `${p}profile-1`,
    profileName: `${p}profile`,
    account: (name: string) => `${p}account-${name}`,
    email: (name: string) => `${p}${name}@example.test`,
    signIn: (label: string) => `${p}old-${label}`,
    carried: `${p}carried`,
    device: `${p}device-1`,
    fingerprint: `${p}fingerprint-1`,
    token: (tag: Tag) => `${p}${tag}-token`,
  }
}
export type Ids = ReturnType<typeof idsFor>
export const SHARED = idsFor()
export const user = SHARED.user
export const machine = SHARED.machine
export const ROOT = SHARED.root
/** The machine-1 grants bob holds: the same issue, different verbs per workspace. */
export const bobVerbs = (tag: Tag): GrantRow['verb'][] =>
  tag === 'a' ? ['read', 'write'] : ['read']
/** Who is an admin: alice in both, bob in B too. */
export const isAdmin = (tag: Tag, name: string) =>
  name === 'alice' || (tag === 'b' && name === 'bob')
/** One workspace's slice of the group's repositories, over the shared database. */
export type Store = WorkspacePeopleSlice

/** The tables this group owns, read raw per workspace, for "unchanged" comparisons. */
export const TABLES = [
  'users',
  'machines',
  'grants',
  'grant_audiences',
  'repos',
  'repo_prefixes',
  'repo_draft_seq',
  'checkouts',
  'checkout_reach',
  'checkout_lost',
  'accounts',
  'account_machine_sends',
  'native_login_opt_ins',
  'native_login_transfers',
  'client_sessions',
  'carried_sign_ins',
  'settings_audit_events',
  'agent_profiles',
] as const

/** Each table's rows of one workspace, in one order on either engine (by their text). */
export async function rowsOf(store: Store, tag: Tag): Promise<Record<string, unknown[]>> {
  const out: Record<string, unknown[]> = {}
  for (const table of TABLES) {
    const rows = await store.all<unknown>(
      sql`SELECT * FROM ${sql.identifier(table)} WHERE workspace_id = ${WS[tag]}`,
    )
    out[table] = rows
      .map((row) => [JSON.stringify(row), row] as const)
      .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))
      .map(([, row]) => row)
  }
  return out
}

/** Whether `table`'s primary key leads with workspace_id, as every key does since POD-7024. */
export async function keyLeadsWithWorkspace(store: Store, table: string): Promise<boolean> {
  if (store.engine === 'pg') {
    const [first] = await store.all<{ name: string }>(
      sql`SELECT a.attname AS name FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0] WHERE i.indrelid = ${table}::regclass AND i.indisprimary`,
    )
    return first?.name === 'workspace_id'
  }
  const columns = await store.all<{ name: string; pk: number }>(
    sql`SELECT name, pk FROM pragma_table_info(${table})`,
  )
  return columns.find((column) => Number(column.pk) === 1)?.name === 'workspace_id'
}

export function member(
  tag: Tag,
  name: string,
  patch: Partial<MemberWrite> = {},
  ids: Ids = SHARED,
): MemberWrite {
  return {
    memberId: ids.user(name),
    version: 1,
    state: 'active',
    role: isAdmin(tag, name) ? 'admin' : 'member',
    accountId: ids.account(name),
    profile: { name: `${tag} ${name}`, image: null, email: ids.email(name) },
    actor: { system: 'setup' },
    ...patch,
  }
}

export function grant(
  tag: Tag,
  resourceId: string,
  grantee: UserId,
  verb: GrantRow['verb'],
  ids: Ids = SHARED,
): GrantRow {
  return {
    resourceKind: 'issue',
    resourceId,
    grantee,
    verb,
    owner: ids.user(),
    visibility: 'shared',
    createdAt: AT_OF[tag],
    actorKind: 'user',
    actorId: ids.user(),
    onBehalfOf: ids.user(),
  }
}

export function checkout(
  tag: Tag,
  path: string,
  patch: Partial<CheckoutRow> = {},
  ids: Ids = SHARED,
): CheckoutRow {
  return {
    machineId: ids.machine(),
    path,
    root: ids.root,
    kind: path === ids.root ? 'repository' : 'worktree',
    repoId: deriveRepoId({ originUrl: ids.origin, machineId: ids.machine(), path: ids.root }),
    branch: `${tag}-branch`,
    originUrl: ids.origin,
    locked: false,
    prunable: false,
    ...patch,
  }
}

export async function insertOldSignIn(
  store: Store,
  tag: Tag,
  hash: string,
  label: string,
  ids: Ids,
) {
  await store.run(
    sql`INSERT INTO client_sessions (workspace_id, token_hash, user_id, created_at, expires_at, label)
       VALUES (${WS[tag]}, ${hash}, ${ids.user()}, ${AT_OF[tag]}, ${LATER}, ${label})`,
  )
}

/** An issue row, raw: the issues repository is another task's (B2). */
export async function insertIssue(store: Store, tag: Tag, profileId: string, ids: Ids) {
  await store.run(
    sql`INSERT INTO issues (workspace_id, id, owner_user_id, created_by_actor, repo_path, repo_id, seq,
         title, stage, default_agent, agent_profile_id, created_at, updated_at)
       VALUES (${WS[tag]}, ${asIssueId(ids.issue)}, ${ids.user()}, ${ids.user()}, ${ids.root},
         ${`${ids.issue}-repo`}, ${1}, ${`${tag} issue 1`}, 'backlog', 'codex', ${profileId}, ${AT_OF[tag]}, ${AT_OF[tag]})`,
  )
}

/**
 * One workspace's rows, written through its own repositories, at the ids `ids` names (the
 * shared set by default). Members alice (admin), bob (an admin in B) and carol (disabled);
 * machine 1 (alice's custody, bearer token) and machine 2 (bob's); an issue grant to bob;
 * repository root with origin and prefix, a worktree, reach and a lost checkout; alice's
 * managed key, shared with bob and sent to machine 1; old sign-ins and a carry record; an audit
 * row; an agent profile with an issue using it.
 */
export async function seed(store: Store, tag: Tag, ids: Ids = SHARED): Promise<void> {
  const at = AT_OF[tag]
  const alice = ids.user()
  const bob = ids.user('bob')
  const m1 = ids.machine()
  const root = ids.root
  const rows = store.users.memberRows
  await rows.write(member(tag, 'alice', {}, ids))
  await rows.write(member(tag, 'bob', {}, ids))
  // A member row exists once its membership is active; carol is then disabled.
  await rows.write(member(tag, 'carol', {}, ids))
  await rows.write(member(tag, 'carol', { version: 2, state: 'disabled' }, ids))

  await store.machines.enrollMachine({
    id: m1,
    name: `${tag} box`,
    hostname: `${tag}-host`,
    tokenHash: sha(ids.token(tag)),
    ownerUserId: alice,
    podiumManaged: true,
    assignment: { server: false, agentExecution: true },
    assignmentEvidence: { version: 1, source: 'enrollment', requestId: `${tag}-enroll` },
  })
  await store.machines.upsertMachine({
    id: ids.machine(2),
    name: `${tag} laptop`,
    hostname: `${tag}-laptop`,
    tokenHash: sha(`${ids.token(tag)}-2`),
    ownerUserId: bob,
  })
  await store.machines.renameMachine(m1, `${tag} workstation`)
  await store.machines.setUpdateChannel(m1, 'stable')
  await store.machines.setMachineInventory(m1, JSON.stringify({ harnesses: [] }))

  for (const verb of bobVerbs(tag)) await store.grants.upsert(grant(tag, ids.issue, bob, verb, ids))

  await store.repos.addRepo(root, m1, ids.origin, ids.prefix)
  await store.repos.addRepo(`${root}-scratch`, ids.machine(2), undefined, `${ids.prefix}S`)
  await store.repos.setRepoDefaultParentBranch(m1, root, `${tag}-main`)
  await store.repos.nextDraftSeq(repoIdOf(ids))

  await store.checkouts.apply(
    [
      checkout(tag, root, {}, ids),
      checkout(tag, `${root}/w1`, {}, ids),
      checkout(tag, `${root}/w2`, {}, ids),
    ],
    [],
    at,
  )
  await store.checkouts.applyReach(
    {
      reach: [
        { userId: alice, machineId: m1, reach: tag === 'a' ? 'all' : 'roots' },
        { userId: bob, machineId: m1, reach: tag === 'a' ? 'roots' : 'all' },
      ],
      lost: [{ userId: bob, machineId: m1, path: `${root}/w0`, root: false }],
    },
    at,
  )

  await store.accounts.connect({
    ownerUserId: alice,
    accountKey: ANTHROPIC,
    provider: 'anthropic',
    kind: 'api-key',
    credential: `${tag}-secret`,
    identity: `${tag}-identity`,
    scope: 'role',
    createdAt: 1,
  })
  await store.accounts.share(alice, ANTHROPIC, [bob])
  await store.accounts.markSent(alice, ANTHROPIC, m1, at)
  await store.accounts.setOptIn(alice, 'claude-code', ids.fingerprint, true, at)
  await store.accounts.recordTransfer(alice, {
    harness: 'claude-code',
    fingerprint: ids.fingerprint,
    machineId: m1,
    outcome: 'installed',
    at,
    revision: 1,
  })

  for (const label of ['login', 'mobile', 'upstream']) {
    await insertOldSignIn(store, tag, ids.signIn(label), label, ids)
  }
  await store.signInCarryOver.record({
    oldTokenHash: ids.carried,
    deviceSignInId: ids.device,
    sealed: `${tag}-sealed`,
    expiresAt: LATER,
    memberId: alice,
    oldLabel: 'login',
  })
  await store.signInCarryOver.writePeriodEndIfAbsent(`${tag}-period-end`)

  await store.settingsAudit.append({
    command: 'machines.rename',
    outcome: 'applied',
    actorKind: 'user',
    actorId: alice,
    onBehalfOf: alice,
    detail: { machineId: m1, name: `${tag} workstation` },
    redactedPaths: [],
    createdAt: at,
  })

  await store.agentProfiles.insert({
    id: ids.profile,
    name: ids.profileName,
    description: `${tag} description`,
    candidates: [],
    machineId: m1,
    instructions: `${tag} instructions`,
    actor: alice,
    now: at,
  })
  await insertIssue(store, tag, ids.profile, ids)
}

export const repoIdOf = (ids: Ids = SHARED) =>
  deriveRepoId({ originUrl: ids.origin, machineId: ids.machine(), path: ids.root })
