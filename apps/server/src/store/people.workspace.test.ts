/**
 * MACHINES, REPOSITORIES AND PEOPLE ARE A WORKSPACE'S (POD-6959 design 2.4, 2.5; task POD-7019).
 *
 * Two workspaces over one database of the run's engine (`openPeopleStoreSlices`), each seeded
 * through its own
 * repositories with its own members, machines, grants, repositories, checkouts, managed
 * accounts, old sign-ins, audit rows and agent profiles.
 * Both workspaces hold the SAME ids and natural keys (POD-7025): the same members, emails,
 * account ids, machines, repository roots, origin and prefix, checkouts, issue, sign-in tokens,
 * opt-in fingerprint and agent profile. Every key leads with workspace_id (POD-7024), so the
 * same id is two rows, told apart only by the workspace. The content differs (display names,
 * machine names and hosts, credentials, identities, branches, which grants and admins a
 * workspace holds, timestamps, sealed carry records, profile texts), so a read that crossed
 * over would answer the other workspace's content. Where a case needs an id the other
 * workspace does not hold, it plants one only the other holds (`only-<tag>…`).
 *
 * For every repository method of the group (machines, machine record context, repos, checkouts,
 * grants, accounts, users, sign-in carry-over, settings audit, agent profiles, identity upgrade):
 *   - a read answers only its own workspace's rows;
 *   - an update, delete or upsert in one workspace leaves the other's rows unchanged, both for
 *     the ids the two share and for ids only the other holds, which must find nothing to change.
 * The settings and secrets repositories have their own two-workspace test
 * (`settings.workspace.test.ts`, POD-7013).
 *
 * One machine id enrolled in both workspaces (the daemon's own UUID) and one repository origin
 * registered in both are the cases the composite keys exist for, and every seeded row is one.
 */

import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
import {
  createMachineCredential,
  machinePublicKeyWire,
  signWithMachine,
} from '@podium/runtime/machine-credential'
import { sql } from 'drizzle-orm'
import { afterEach, describe, expect, it } from 'vitest'
import { deriveRepoId } from '../repo-id'
import {
  openPeopleStoreSlices,
  type WorkspacePeopleSlice,
} from '../test-support/people-store-slice'
import type { CheckoutRow } from './checkouts'
import type { GrantRow } from './grants'

type Tag = 'a' | 'b'
const WS: Record<Tag, string> = { a: 'ws_a', b: 'ws_b' }
/** Each workspace's own timestamp: content, not a key. */
const AT_OF: Record<Tag, string> = { a: '2026-11-17T10:00:00.000Z', b: '2026-11-17T10:30:00.000Z' }
const AT = AT_OF.a
const LATER = '2099-01-01T00:00:00.000Z'
const otherOf = (tag: Tag): Tag => (tag === 'a' ? 'b' : 'a')
const sha = (value: string) => createHash('sha256').update(value).digest('hex')
const ANTHROPIC: AccountId = asAccountId('managed:anthropic')
/** Machine 1's bearer token: content (a credential), so it differs per workspace. */
const token = (tag: Tag) => SHARED.token(tag)

/**
 * The ids and natural keys a seed writes. `SHARED` (no prefix) is the set both workspaces
 * hold; a prefixed set is a plant only one workspace holds.
 */
function idsFor(p = '') {
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
type Ids = ReturnType<typeof idsFor>
const SHARED = idsFor()
const user = SHARED.user
const machine = SHARED.machine
const ROOT = SHARED.root
/** The machine-1 grants bob holds: the same issue, different verbs per workspace. */
const bobVerbs = (tag: Tag): GrantRow['verb'][] => (tag === 'a' ? ['read', 'write'] : ['read'])
/** Who is an admin: alice in both, bob in B too. */
const isAdmin = (tag: Tag, name: string) => name === 'alice' || (tag === 'b' && name === 'bob')

let opened: WorkspacePeopleSlice | undefined
const keyDirs: string[] = []

afterEach(async () => {
  await opened?.close()
  opened = undefined
  for (const dir of keyDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** One workspace's slice of the group's repositories, over the shared database. */
type Store = WorkspacePeopleSlice

/** The tables this group owns, read raw per workspace, for "unchanged" comparisons. */
const TABLES = [
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
async function rowsOf(store: Store, tag: Tag): Promise<Record<string, unknown[]>> {
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
async function keyLeadsWithWorkspace(store: Store, table: string): Promise<boolean> {
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

function member(
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

function grant(
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

function checkout(
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

async function insertOldSignIn(store: Store, tag: Tag, hash: string, label: string, ids: Ids) {
  await store.run(
    sql`INSERT INTO client_sessions (workspace_id, token_hash, user_id, created_at, expires_at, label)
       VALUES (${WS[tag]}, ${hash}, ${ids.user()}, ${AT_OF[tag]}, ${LATER}, ${label})`,
  )
}

/** An issue row, raw: the issues repository is another task's (B2). */
async function insertIssue(store: Store, tag: Tag, profileId: string, ids: Ids) {
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
async function seed(store: Store, tag: Tag, ids: Ids = SHARED): Promise<void> {
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

const repoIdOf = (ids: Ids = SHARED) =>
  deriveRepoId({ originUrl: ids.origin, machineId: ids.machine(), path: ids.root })

async function twoSeeded(): Promise<readonly [Store, Store]> {
  const stores = await openPeopleStoreSlices([WS.a, WS.b])
  opened = stores[0]
  await seed(stores[0], 'a')
  await seed(stores[1], 'b')
  return stores
}

const pairs = (a: Store, b: Store) =>
  [
    [a, 'a'],
    [b, 'b'],
  ] as const

/** No content of the other workspace anywhere in `value`. */
function onlyOwn(value: unknown, tag: Tag): void {
  const other = otherOf(tag)
  const text = JSON.stringify(value)
  expect(text).not.toMatch(
    new RegExp(
      `"${other} |\\b${other}-(host|laptop|secret|identity|sealed|period-end|main|description|instructions|enroll|branch)|only-${other}|"${WS[other]}"`,
    ),
  )
  expect(text).not.toContain(AT_OF[other])
  expect(text).not.toContain(sha(token(other)))
}

describe('every row is written under its own workspace', () => {
  it('seeds each table of the group in both workspaces, with its own rows only', async () => {
    const [a] = await twoSeeded()
    for (const tag of ['a', 'b'] as const) {
      const rows = await rowsOf(a, tag)
      for (const table of TABLES) {
        expect({ table, rows: rows[table]!.length > 0 }).toEqual({ table, rows: true })
        onlyOwn(rows[table], tag)
      }
    }
  })
})

describe('reads answer only their own workspace', () => {
  it('members', async () => {
    const [a, b] = await twoSeeded()
    // A disabled member only each workspace holds.
    const only = (tag: Tag) => asUserId(`user:only-${tag}`)
    for (const [store, tag] of pairs(a, b)) {
      const onlyMember = {
        memberId: only(tag),
        accountId: `only-${tag}-account`,
        profile: { name: `${tag} only`, image: null, email: `only-${tag}@example.test` },
      }
      await store.users.memberRows.write(member(tag, 'carol', onlyMember))
      await store.users.memberRows.write(
        member(tag, 'carol', { ...onlyMember, version: 2, state: 'disabled' }),
      )
    }
    for (const [store, tag] of pairs(a, b)) {
      const other = otherOf(tag)
      const users = store.users
      const listed = await users.list()
      expect(listed.map((row) => row.id).sort()).toEqual([user(), user('bob')].sort())
      onlyOwn(listed, tag)
      const everyone = await users.listIncludingDisabled()
      expect(everyone.map((row) => row.id).sort()).toEqual(
        [user(), user('bob'), user('carol'), only(tag)].sort(),
      )
      expect((await users.get(user()))?.displayName).toBe(`${tag} alice`)
      expect(await users.get(only(other))).toBeUndefined()
      expect(await users.roleOf(user())).toBe('admin')
      expect(await users.roleOf(user('bob'))).toBe(tag === 'b' ? 'admin' : 'member')
      expect(await users.roleOf(only(other))).toBeUndefined()
      expect(await users.authzGenerationOf(only(other))).toBeUndefined()
      expect(typeof (await users.authzGenerationOf(user()))).toBe('number')
      expect(await users.queuedBeforeAuthorityChange(only(other), Date.now())).toBe(true)
      expect([...(await users.activeAdminIds())].sort()).toEqual(
        tag === 'a' ? [user()] : [user(), user('bob')].sort(),
      )
      expect((await users.earliestAdmin())?.displayName).toBe(`${tag} alice`)
      expect((await users.byEmail(SHARED.email('alice')))?.displayName).toBe(`${tag} alice`)
      expect((await users.findMemberByAccount(SHARED.account('bob')))?.displayName).toBe(
        `${tag} bob`,
      )
      const recorded = await users.recordMembers()
      expect(recorded.map((row) => row.id).sort()).toEqual([user(), user('bob')].sort())
      onlyOwn(recorded, tag)
      expect(await users.hasSeveralActiveMembers()).toBe(true)
      expect(await users.hasSeveralMembers()).toBe(true)
      expect(await users.soleActiveMember()).toBeUndefined()
      expect(await users.memberRows.exists?.(user('carol'))).toBe(true)
      expect(await users.memberRows.exists?.(only(other))).toBe(false)
    }
  })

  it('machines', async () => {
    const [a, b] = await twoSeeded()
    // A machine only each workspace holds.
    const only = (tag: Tag) => asMachineId(`only-${tag}-machine`)
    for (const [store, tag] of pairs(a, b)) {
      await store.machines.upsertMachine({
        id: only(tag),
        name: `${tag} only box`,
        hostname: `${tag}-host-only`,
        tokenHash: sha(`only-${tag}-token`),
        ownerUserId: user(),
      })
    }
    for (const [store, tag] of pairs(a, b)) {
      const other = otherOf(tag)
      const machines = store.machines
      const own = [machine(), machine(2), only(tag)].sort()
      const listed = await machines.listMachines()
      expect(listed.map((row) => row.id).sort()).toEqual(own)
      onlyOwn(listed, tag)
      expect([...(await machines.recordIds())].sort()).toEqual(own)
      expect((await machines.getMachine(machine()))?.name).toBe(`${tag} workstation`)
      expect(await machines.getMachine(only(other))).toBeUndefined()
      const got = await machines.getMachines([machine(), only(other)])
      expect([...got.keys()]).toEqual([machine()])
      expect(got.get(machine())?.name).toBe(`${tag} workstation`)
      // The same machine id, each workspace's own token.
      expect(await machines.getMachineByToken(machine(), token(tag))).toBe(true)
      expect(await machines.getMachineByToken(machine(), token(other))).toBe(false)
      expect(await machines.credentialIncarnation(machine())).toBe(sha(token(tag)))
      expect(await machines.credentialIncarnation(only(other))).toBeUndefined()
      expect(await machines.custodian(machine())).toBe(user())
      expect(await machines.custodian(only(other))).toBeNull()
      expect(await machines.custodyMachineIds(user())).toEqual([machine()])
      expect(await machines.legacyMachineSentinelSites()).toEqual([])
    }
  })

  it('grants', async () => {
    const [a, b] = await twoSeeded()
    for (const [store, tag] of pairs(a, b)) {
      const grants = store.grants
      const bob = user('bob')
      const issue = SHARED.issue
      const verbs = (rows: GrantRow[]) => rows.map((row) => `${row.grantee}:${row.verb}`).sort()
      const bobs = bobVerbs(tag).map((verb) => `${bob}:${verb}`)
      expect(verbs(await grants.listForResource('issue', issue))).toEqual(bobs)
      const listed = await grants.listForResources('issue', [issue, 'only-iss'])
      expect([...listed.keys()]).toEqual([issue])
      expect(verbs(listed.get(issue) ?? [])).toEqual(bobs)
      expect(verbs(await grants.loadForResource('machine', machine()))).toEqual([
        `${user()}:manage`,
        `${user()}:use`,
      ])
      const loaded = await grants.loadForResources('issue', [issue])
      expect(verbs(loaded.get(issue) ?? [])).toEqual(bobs)
      const kinds = await grants.loadForResourcesOfKinds({
        issue: [issue],
        machine: [machine(2)],
      })
      expect(verbs(kinds.get('issue')?.get(issue) ?? [])).toEqual(bobs)
      expect(verbs(kinds.get('machine')?.get(machine(2)) ?? [])).toEqual([
        `${bob}:manage`,
        `${bob}:use`,
      ])
      expect(new Set(await grants.machineIdsForGrantee(user()))).toEqual(new Set([machine()]))
      const audiences = await grants.visibilityAudiencesFor('issue', [issue])
      expect(audiences.get(issue)).toEqual([bob])
    }
  })

  it('repositories', async () => {
    const [a, b] = await twoSeeded()
    // A repository only each workspace holds, on the machine both hold.
    const only = (tag: Tag) => ({
      root: `/only-${tag}`,
      origin: `https://example.test/only-${tag}.git`,
      prefix: `ONL${tag.toUpperCase()}`,
    })
    const onlyRepoId = (tag: Tag) =>
      deriveRepoId({ originUrl: only(tag).origin, machineId: machine(), path: only(tag).root })
    for (const [store, tag] of pairs(a, b)) {
      await store.repos.addRepo(only(tag).root, machine(), only(tag).origin, only(tag).prefix)
    }
    for (const [store, tag] of pairs(a, b)) {
      const other = otherOf(tag)
      const repos = store.repos
      const listed = await repos.listRepos()
      expect(listed.map((row) => row.path).sort()).toEqual(
        [ROOT, `${ROOT}-scratch`, only(tag).root].sort(),
      )
      onlyOwn(listed, tag)
      expect((await repos.listRepoPaths(machine())).sort()).toEqual([ROOT, only(tag).root].sort())
      expect(await repos.prefixForRepoId(repoIdOf())).toBe('AAA')
      expect(await repos.prefixForRepoId(onlyRepoId(other))).toBeNull()
      expect(await repos.prefixForPath(`${ROOT}/src`)).toBe('AAA')
      expect(await repos.prefixForPath(`${only(other).root}/src`)).toBeNull()
      expect((await repos.prefixResolver())(`${only(other).root}/src`)).toBeNull()
      expect(await repos.isPrefixTaken('AAA')).toBe(true)
      expect(await repos.isPrefixTaken(only(other).prefix)).toBe(false)
      expect(await repos.repoForPrefix('AAA')).toEqual({ repoId: repoIdOf(), path: ROOT })
      expect(await repos.repoForPrefix(only(other).prefix)).toBeNull()
      // The same repository, each workspace's own default branch.
      expect(await repos.defaultParentBranchForRepoId(repoIdOf())).toBe(`${tag}-main`)
      expect(await repos.defaultParentBranchForRepoId(onlyRepoId(other))).toBeNull()
      expect(await repos.defaultParentBranchForIssueRepo(ROOT, machine())).toBe(`${tag}-main`)
      expect(await repos.reportingMachineFor(repoIdOf(), ROOT)).toBe(machine())
      expect(await repos.reportingMachineFor(onlyRepoId(other), only(other).root)).toBeNull()
      expect(await repos.machineHasRootContaining(`${ROOT}/x`, machine())).toBe(true)
      expect(await repos.machineHasRootContaining(`${only(other).root}/x`, machine())).toBe(false)
      expect(await repos.resolveRepoIdForPath(`${ROOT}/x`, machine())).toBe(repoIdOf())
      expect(await repos.resolveIssueRepoId(ROOT, machine())).toBe(repoIdOf())
      expect(await repos.resolveRepoIdForPath(`${only(other).root}/x`, machine())).not.toBe(
        onlyRepoId(other),
      )
      expect(await repos.legacyRepoResidue()).toEqual({ repoIdsMissing: 0, prefixesMissing: 0 })
      // The places name own machines only (a range's upper bound may spell another path).
      const places = await repos.prefixedPlaces()
      expect(places).not.toBe('everywhere')
      if (places !== 'everywhere') {
        const named = [...places.bounded, ...places.open].map(([machineId]) => machineId)
        expect(new Set(named)).toEqual(new Set([machine(), machine(2)]))
      }
    }
  })

  it('checkouts', async () => {
    const [a, b] = await twoSeeded()
    for (const [store, tag] of pairs(a, b)) {
      const checkouts = store.checkouts
      const paths = [ROOT, `${ROOT}/w1`, `${ROOT}/w2`]
      const all = await checkouts.all()
      expect(all.map((row) => [row.path, row.branch])).toEqual(
        paths.map((path) => [path, `${tag}-branch`]),
      )
      const ofMachine = await checkouts.ofMachine(machine())
      expect(ofMachine.map((row) => row.path)).toEqual(paths)
      onlyOwn(ofMachine, tag)
      const ofMachines = await checkouts.ofMachines([machine()])
      expect(ofMachines.length).toBe(3)
      onlyOwn(ofMachines, tag)
      const pathsOf = await checkouts.pathsOfMachines([machine()])
      expect([...pathsOf.keys()]).toEqual([machine()])
      expect([...(pathsOf.get(machine()) ?? [])].sort()).toEqual(paths)
      expect([...(await checkouts.rootPathsOfMachines([machine()])).keys()]).toEqual([machine()])
      // The same people on the same machine, each workspace's own reach.
      const reach = await checkouts.reachOfMachines([machine()])
      expect([...reach.keys()]).toEqual([machine()])
      expect(Object.fromEntries(reach.get(machine()) ?? [])).toEqual({
        [user()]: tag === 'a' ? 'all' : 'roots',
        [user('bob')]: tag === 'a' ? 'roots' : 'all',
      })
      const lost = await checkouts.lostOfMachines([machine()])
      expect([...lost.keys()]).toEqual([machine()])
      onlyOwn([...lost.values()], tag)
    }
  })

  it('managed accounts and native logins', async () => {
    const [a, b] = await twoSeeded()
    for (const [store, tag] of pairs(a, b)) {
      const accounts = store.accounts
      const alice = user()
      const bob = user('bob')
      expect((await accounts.list()).map((row) => [row.ownerUserId, row.credential])).toEqual([
        [alice, `${tag}-secret`],
      ])
      expect((await accounts.summaries()).map((row) => row.identity)).toEqual([`${tag}-identity`])
      expect((await accounts.listFor(alice)).map((row) => row.credential)).toEqual([
        `${tag}-secret`,
      ])
      expect((await accounts.ownedBy(alice)).map((row) => row.credential)).toEqual([
        `${tag}-secret`,
      ])
      expect((await accounts.getFor(alice, ANTHROPIC))?.credential).toBe(`${tag}-secret`)
      expect((await accounts.own(alice, ANTHROPIC))?.credential).toBe(`${tag}-secret`)
      const shared = await accounts.sharedWith(bob, ANTHROPIC)
      expect(shared.map((row) => row.credential)).toEqual([`${tag}-secret`])
      const sharedWithBob = await accounts.sharedWithUser(bob)
      expect(sharedWithBob.map((row) => row.credential)).toEqual([`${tag}-secret`])
      expect(await accounts.sentTo(alice, ANTHROPIC)).toEqual([machine()])
      const sends = await accounts.sendsOf(alice)
      expect([...sends.keys()]).toEqual([ANTHROPIC])
      onlyOwn([...sends.values()], tag)
      const optIns = await accounts.optInsFor(alice)
      expect(optIns.map((row) => row.fingerprint)).toEqual([SHARED.fingerprint])
      onlyOwn(optIns, tag)
      const optIn = await accounts.optInFor(alice, 'claude-code', SHARED.fingerprint)
      expect(optIn).toBeDefined()
      onlyOwn(optIn, tag)
      const transfers = await accounts.transfersFor(alice)
      expect(transfers.map((row) => row.machineId)).toEqual([machine()])
      onlyOwn(transfers, tag)
    }
  })

  it('old sign-ins, carry records and the period end', async () => {
    const [a, b] = await twoSeeded()
    // An old sign-in only each workspace holds.
    for (const [store, tag] of pairs(a, b)) {
      await insertOldSignIn(store, tag, `only-${tag}-login`, 'login', SHARED)
    }
    for (const [store, tag] of pairs(a, b)) {
      const other = otherOf(tag)
      const carry = store.signInCarryOver
      expect(await carry.matches(SHARED.signIn('login'), AT)).toBe(true)
      expect(await carry.matches(SHARED.carried, AT)).toBe(true)
      expect(await carry.matches(`only-${tag}-login`, AT)).toBe(true)
      expect(await carry.matches(`only-${other}-login`, AT)).toBe(false)
      // The same carried token, each workspace's own sealed record.
      expect(await carry.sealedOf(SHARED.carried, AT)).toBe(`${tag}-sealed`)
      expect(await carry.countHonoured()).toBe(3)
      expect(await carry.periodEnd()).toBe(`${tag}-period-end`)
    }
  })

  it('the audit trail, agent profiles and the fleet channel', async () => {
    const [a, b] = await twoSeeded()
    // A profile only each workspace holds.
    const only = (tag: Tag) => `only-${tag}-profile`
    for (const [store, tag] of pairs(a, b)) {
      await store.agentProfiles.insert({
        id: only(tag),
        name: `only ${tag}`,
        description: '',
        candidates: [],
        machineId: null,
        instructions: '',
        actor: user(),
        now: AT_OF[tag],
      })
    }
    for (const [store, tag] of pairs(a, b)) {
      const other = otherOf(tag)
      const trail = await store.settingsAudit.list()
      expect(trail.length).toBeGreaterThan(1)
      onlyOwn(trail, tag)
      const events = await store.settingsAudit.securityEvents(100)
      expect(events.some((row) => row.command === 'machines.rename')).toBe(true)
      onlyOwn(events, tag)
      onlyOwn(await store.settingsAudit.securityEvents(100, undefined, { kind: 'people' }), tag)
      const byAlice = await store.settingsAudit.securityEvents(100, undefined, { actor: user() })
      expect(byAlice.length).toBeGreaterThan(0)
      onlyOwn(byAlice, tag)

      const profiles = store.agentProfiles
      expect((await profiles.list()).map((row) => [row.id, row.description]).sort()).toEqual(
        [
          [SHARED.profile, `${tag} description`],
          [only(tag), ''],
        ].sort(),
      )
      expect((await profiles.get(SHARED.profile))?.description).toBe(`${tag} description`)
      expect(await profiles.get(only(other))).toBeNull()
      expect((await profiles.getByName(SHARED.profileName.toUpperCase()))?.description).toBe(
        `${tag} description`,
      )
      expect(await profiles.getByName(`only ${other}`)).toBeNull()
      expect(await profiles.openIssueSeqsUsing(SHARED.profile)).toEqual([1])
      expect(await profiles.openIssueSeqsUsing(only(other))).toEqual([])
    }
    // The fleet channel and the update execution are the install's (install keys of meta):
    // one value for every workspace, by design.
    expect(await a.machines.recordContext.setFleetChannel('dev')).toBe(true)
    expect((await b.machines.recordContext.read()).fleetChannel).toBe('dev')
  })
})

describe('writes in one workspace leave the other unchanged', () => {
  it("A's writes aimed at ids only B holds change nothing in B", async () => {
    const [a, b] = await twoSeeded()
    // A whole set of ids only B holds, seeded as the shared ones are.
    const O = idsFor('only-b-')
    await seed(b, 'b', O)
    const before = await rowsOf(a, 'b')

    // Machines: every writer addressed at a machine only B holds finds no row in A.
    const m = O.machine()
    const am = a.machines
    await am.renameMachine(m, 'taken over')
    await am.setUpdateChannel(m, 'edge')
    await am.setAvailability(m, { epoch: 'e', server: true, daemon: true, supervisor: true })
    await am.recordHarnessVersion(m, { harness: 'codex', version: '9', probedAt: AT })
    await am.setMachineInventory(m, '{}')
    await am.setMachineBuild(m, { appVersion: '9.9.9' }, [], AT, 'supervisor')
    await am.setSupervisorPresence(
      m,
      { appVersion: '9.9.9' },
      [],
      { version: 1, services: [] } as never,
      AT,
    )
    await am.setServiceAssignment(m, { server: true, agentExecution: true })
    await am.setPresenceSource(m, 'supervisor')
    expect(await am.addMachineComponent(m, 'server')).toBe(false)
    expect(
      await am.replaceExecutionAssignment(
        m,
        { server: false, agentExecution: false },
        { version: 1, source: 's', requestId: 'r' },
      ),
    ).toBe('missing')
    await expect(am.transferServerAssignment(m, O.machine(2), 'r')).rejects.toThrow()
    expect(
      await am.adoptLegacyHostCredential(
        m,
        'ed25519:key',
        { server: false, agentExecution: true },
        { version: 1, source: 's', requestId: 'r' },
      ),
    ).toBe(false)
    await am.setMachineOwner(m, user())
    await am.touchMachine(m, 'taken-host')
    await am.supersedeMachine(m, machine())
    await am.revokeMachine(m)
    await am.deleteMachine(O.machine(2))
    expect(
      await am.enrollMachine(
        {
          id: m,
          name: 'replaced',
          hostname: 'replaced',
          tokenHash: sha('replaced'),
          ownerUserId: user(),
          podiumManaged: true,
          assignment: { server: false, agentExecution: true },
          assignmentEvidence: { version: 1, source: 'enrollment', requestId: 'r' },
        },
        AT,
        sha(O.token('b')),
      ),
    ).toBe(false)

    // Grants.
    expect(await a.grants.remove('issue', O.issue, O.user('bob'), 'read')).toBe(false)
    await a.grants.removeAllForGrantee(O.user('bob'))
    await a.grants.removeAllForResource('machine', m)
    await a.grants.removeAllForResource('issue', O.issue)

    // Repositories: B's roots are not A's to rename, re-origin or remove.
    await a.repos.updateRepoOrigin(m, O.root, 'https://example.test/other.git')
    await a.repos.removeRepo(O.root, m)
    await a.repos.removeRepo(`${O.root}-scratch`, O.machine(2))

    // Checkouts: removals, reach drops and found lost checkouts of B's keys.
    await a.checkouts.apply(
      [],
      [
        { machineId: m, path: O.root, root: O.root },
        { machineId: m, path: `${O.root}/w1`, root: O.root },
      ],
      AT,
    )
    await a.checkouts.applyReach(
      {
        reach: [{ userId: O.user(), machineId: m, reach: 'none' }],
        found: [{ userId: O.user('bob'), machineId: m, path: `${O.root}/w0` }],
      },
      AT,
    )

    // Managed accounts.
    expect(await a.accounts.share(O.user(), ANTHROPIC, [])).toBe(false)
    expect(await a.accounts.unmarkSent(O.user(), ANTHROPIC, m)).toBe(false)
    await a.accounts.markSent(O.user(), ANTHROPIC, machine(), AT)
    expect(await a.accounts.disconnect(O.user(), ANTHROPIC)).toBe(false)
    await a.accounts.removeFor(O.user(), ANTHROPIC)

    // Members.
    await expect(a.users.writeProfile(O.user(), 'taken over', null)).rejects.toThrow(
      'Member unavailable',
    )
    await a.users.endOldSignIns(O.user())

    // The boot upgrade's retirement of the old upstream sign-ins: A's one row only.
    expect(await a.identityUpgrade.retireSessions()).toBe(1)

    // Old sign-ins: by token, member, label, expiry and the end of the period.
    const carry = a.signInCarryOver
    expect(await carry.consume(O.signIn('login'), AT)).toBeUndefined()
    await carry.forget(O.carried)
    await carry.endForToken(O.signIn('mobile'))
    await carry.endForMember(O.user())
    await carry.endByLabel('login')
    // Just after every seeded expiry, so every row of A's is expired.
    await carry.deleteExpired(new Date(Date.parse(LATER) + 1).toISOString())
    await carry.deleteEverything()
    await a.signInCarryOver.writePeriodEndIfAbsent('a-other-end')

    // Agent profiles.
    expect(
      await a.agentProfiles.update({
        id: O.profile,
        name: 'taken over',
        description: '',
        candidates: [],
        machineId: null,
        instructions: '',
        actor: user(),
        now: AT,
      }),
    ).toBe(false)
    expect(await a.agentProfiles.delete(O.profile)).toBe(false)

    expect(await rowsOf(a, 'b')).toEqual(before)
    expect(await b.signInCarryOver.periodEnd()).toBe('b-period-end')
  })

  it("A's own writes, upserts and deletes of the ids both hold leave B's rows unchanged", async () => {
    const [a, b] = await twoSeeded()
    const before = await rowsOf(a, 'b')

    await a.users.memberRows.write(member('a', 'dave'))
    await a.users.memberRows.write(member('a', 'bob', { version: 2, role: 'admin' }))
    await a.users.memberRows.write(member('a', 'carol', { version: 3, state: 'removed' }))
    await a.users.writeProfile(user(), 'renamed', null)
    await a.users.audit('members.join', user(), { memberId: user('dave') })

    await a.machines.renameMachine(machine(), 'renamed')
    await a.machines.setMachineOwner(machine(2), user())
    await a.machines.revokeMachine(machine())
    await a.machines.deleteMachine(machine(2))

    await a.grants.upsert(grant('a', 'iss-2', user('bob'), 'read'))
    await a.grants.removeAllForGrantee(user('bob'))

    await a.repos.setRepoPrefix(machine(), ROOT, 'AAB')
    await a.repos.setRepoDefaultParentBranch(machine(), ROOT, 'a-next')
    expect(await a.repos.nextDraftSeq(repoIdOf())).toBe(2)
    await a.repos.removeRepo(`${ROOT}-scratch`, machine(2))

    await a.checkouts.apply(
      [checkout('a', `${ROOT}/w3`)],
      [
        { machineId: machine(), path: ROOT, root: ROOT },
        { machineId: machine(), path: `${ROOT}/w1`, root: ROOT },
      ],
      AT,
    )
    await a.checkouts.applyReach(
      {
        reach: [{ userId: user(), machineId: machine(), reach: 'none' }],
        found: [{ userId: user('bob'), machineId: machine(), path: `${ROOT}/w0` }],
      },
      AT,
    )

    expect(await a.accounts.disconnect(user(), ANTHROPIC)).toBe(true)
    await a.accounts.setOptIn(user(), 'claude-code', SHARED.fingerprint, false, AT)

    await a.signInCarryOver.endByLabel('login')
    await a.signInCarryOver.deleteEverything()

    expect(await a.agentProfiles.delete(SHARED.profile)).toBe(true)
    await a.settingsAudit.append({
      command: 'members.remove',
      outcome: 'applied',
      actorKind: 'system',
      actorId: 'system:test',
      onBehalfOf: null,
      detail: {},
      redactedPaths: [],
      createdAt: AT,
    })

    expect(await rowsOf(a, 'b')).toEqual(before)
    // And A's own rows did change: the writes reached their workspace.
    const after = await rowsOf(a, 'a')
    expect(after.carried_sign_ins).toEqual([])
    expect(after.agent_profiles).toEqual([])
    expect(after.accounts).toEqual([])
    // B reads its own rows of the same ids as they were.
    expect((await b.users.get(user()))?.displayName).toBe('b alice')
    expect((await b.machines.getMachine(machine()))?.name).toBe('b workstation')
    expect((await b.machines.getMachine(machine()))?.revokedAt).toBeNull()
    expect(await b.repos.prefixForRepoId(repoIdOf())).toBe('AAA')
    expect(await b.repos.defaultParentBranchForRepoId(repoIdOf())).toBe('b-main')
    expect((await b.accounts.getFor(user(), ANTHROPIC))?.credential).toBe('b-secret')
    expect((await b.agentProfiles.get(SHARED.profile))?.description).toBe('b description')
    expect(await b.signInCarryOver.sealedOf(SHARED.carried, AT)).toBe('b-sealed')
  })

  it("the sentinel scan and the credential checks see only their own workspace's rows", async () => {
    const [a, b] = await twoSeeded()
    await b.run(
      sql`INSERT INTO repos (workspace_id, machine_id, path, added_at) VALUES (${WS.b}, 'local', ${'/legacy-b'}, ${AT})`,
    )
    expect(await a.machines.legacyMachineSentinelSites()).toEqual([])
    expect(await b.machines.legacyMachineSentinelSites()).toEqual(['repos.machine_id'])

    // A machine key adopted in B for the machine id both hold verifies in B only, and A
    // cannot rotate it.
    const dir = mkdtempSync(join(tmpdir(), 'people-ws-key-'))
    keyDirs.push(dir)
    const key = createMachineCredential(dir)
    const wire = machinePublicKeyWire(key)
    expect(
      await b.machines.adoptLegacyHostCredential(
        machine(),
        wire,
        { server: false, agentExecution: true },
        { version: 1, source: 'adopt', requestId: 'b-adopt' },
      ),
    ).toBe(true)
    const signature = signWithMachine(key, 'hello')
    expect(await b.machines.verifyMachineSignature(machine(), 'hello', signature)).toBe(true)
    expect(await a.machines.verifyMachineSignature(machine(), 'hello', signature)).toBe(false)
    const next = createMachineCredential(join(dir, 'next'))
    const nextWire = machinePublicKeyWire(next)
    const before = await rowsOf(a, 'b')
    expect(
      await a.machines.rotateCredential(
        machine(),
        {
          newKeyId: nextWire,
          newPublicKey: nextWire,
          newSignature: signWithMachine(next, 'rotate'),
          previous: { kind: 'ed25519', publicKey: wire, signature: signWithMachine(key, 'rotate') },
        },
        'rotate',
      ),
    ).toBe(false)
    expect(await rowsOf(a, 'b')).toEqual(before)
  })
})

describe('one machine and one repository in both workspaces', () => {
  it('one repository origin gives the same repo_id in both, and they do not interfere', async () => {
    const [a, b] = await twoSeeded()
    const shared = 'https://example.test/shared/project.git'
    const sharedId = deriveRepoId({ originUrl: shared, machineId: machine(), path: '/shared' })
    await a.repos.addRepo('/shared', machine(), shared, 'SHA')
    await b.repos.addRepo('/shared', machine(), shared)
    await b.repos.setRepoDefaultParentBranch(machine(), '/shared', 'b-shared-main')
    expect(await a.repos.resolveRepoIdForPath('/shared/x', machine())).toBe(sharedId)
    expect(await b.repos.resolveRepoIdForPath('/shared/x', machine())).toBe(sharedId)
    expect((await a.repos.listRepos()).filter((row) => row.repoId === sharedId)).toHaveLength(1)
    expect(
      (await b.repos.listRepos()).filter((row) => row.repoId === sharedId).map((row) => row.path),
    ).toEqual(['/shared'])
    expect(await a.repos.reportingMachineFor(sharedId, '/shared')).toBe(machine())
    expect(await b.repos.reportingMachineFor(sharedId, '/shared')).toBe(machine())
    expect(await a.repos.defaultParentBranchForRepoId(sharedId)).toBeNull()
    expect(await b.repos.defaultParentBranchForRepoId(sharedId)).toBe('b-shared-main')
    expect(await a.repos.repoForPrefix('SHA')).toEqual({ repoId: sharedId, path: '/shared' })
    // Prefixes are unique per workspace (POD-7024): B derives its own, which may be the same
    // letters, and it names B's root.
    const prefixOfB = await b.repos.prefixForRepoId(sharedId)
    expect(prefixOfB).not.toBeNull()
    expect(await b.repos.repoForPrefix(prefixOfB as string)).toEqual({
      repoId: sharedId,
      path: '/shared',
    })

    // A's removal of its root leaves B's root of the same repository.
    await a.repos.removeRepo('/shared', machine())
    expect((await a.repos.listRepos()).some((row) => row.repoId === sharedId)).toBe(false)
    expect(
      (await b.repos.listRepos()).filter((row) => row.repoId === sharedId).map((row) => row.path),
    ).toEqual(['/shared'])

    // Each workspace holds its own prefix row for the shared id (POD-7024).
    expect(await keyLeadsWithWorkspace(a, 'repo_prefixes')).toBe(true)
    expect(await b.repos.prefixForRepoId(sharedId)).toBe(prefixOfB)
  })

  it('one machine id enrolled in both workspaces is two rows with their own grants and checkouts', async () => {
    const [a, b] = await twoSeeded()
    // The machines key leads with the workspace (POD-7024), so one id is two rows.
    expect(await keyLeadsWithWorkspace(a, 'machines')).toBe(true)
    const daemon = asMachineId('11111111-2222-4333-8444-555555555555')
    for (const [store, tag] of pairs(a, b)) {
      expect(
        await store.machines.enrollMachine({
          id: daemon,
          name: `${tag} shared box`,
          hostname: `${tag}-shared`,
          tokenHash: sha(`${tag}-shared-token`),
          ownerUserId: tag === 'a' ? user() : user('bob'),
          podiumManaged: true,
          assignment: { server: false, agentExecution: true },
          assignmentEvidence: { version: 1, source: 'enrollment', requestId: `${tag}-shared` },
        }),
      ).toBe(true)
      await store.checkouts.apply([checkout(tag, '/shared', { machineId: daemon })], [], AT)
    }
    for (const [store, tag] of pairs(a, b)) {
      expect((await store.machines.getMachine(daemon))?.name).toBe(`${tag} shared box`)
      expect(await store.machines.custodian(daemon)).toBe(tag === 'a' ? user() : user('bob'))
      expect(await store.machines.getMachineByToken(daemon, `${tag}-shared-token`)).toBe(true)
      expect(await store.machines.getMachineByToken(daemon, `${otherOf(tag)}-shared-token`)).toBe(
        false,
      )
      expect(
        (await store.checkouts.ofMachine(daemon)).map((row) => [row.path, row.branch]),
      ).toEqual([['/shared', `${tag}-branch`]])
    }
    await a.machines.revokeMachine(daemon)
    expect((await b.machines.getMachine(daemon))?.revokedAt).toBeNull()
    expect(await b.machines.custodian(daemon)).toBe(user('bob'))
  })
})

/**
 * THE SAME ID UPSERTED FIRST IN THE OTHER WORKSPACE (POD-7024): every ON CONFLICT target leads with workspace_id,
 * so an upsert in A of an id B already holds makes A its own row, B's row stays byte for byte
 * as it was, and A's second upsert of the id updates A's row only.
 */
describe('the same id in both workspaces, upserted through the repository (POD-7024)', () => {
  it("makes a second row, leaves the other workspace's as it was, and updates only its own", async () => {
    const SAME = 'same-machine'
    const rowsIn = async (store: Store, tag: Tag) =>
      await store.all<Record<string, unknown>>(
        sql`SELECT * FROM machines WHERE workspace_id = ${WS[tag]} AND id = ${SAME}`,
      )
    const [a, b] = await twoSeeded()
    const upsert = async (store: Store, tag: Tag, name: string) =>
      await store.machines.upsertMachine({
        id: SAME,
        name,
        hostname: `${tag}-same-host`,
        tokenHash: sha(`${tag}-same-token`),
        ownerUserId: user(),
      })
    await upsert(b, 'b', 'b box')
    const before = await rowsIn(b, 'b')
    expect(before).toHaveLength(1)
    await upsert(a, 'a', 'a box')
    expect(await rowsIn(a, 'a')).toHaveLength(1)
    expect(await rowsIn(b, 'b')).toEqual(before)
    await upsert(a, 'a', 'a box renamed')
    expect(await rowsIn(a, 'a')).toEqual([expect.objectContaining({ name: 'a box renamed' })])
    expect(await rowsIn(b, 'b')).toEqual(before)
  })
})
