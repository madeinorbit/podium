/**
 * MACHINES, REPOSITORIES AND PEOPLE ARE A WORKSPACE'S (POD-6959 design 2.4, 2.5; task POD-7019).
 *
 * Two workspaces over one database (`openWorkspaceStores`), each seeded through its own
 * repositories with its own members, machines, grants, repositories, checkouts, managed
 * accounts, old sign-ins, audit rows and agent profiles. The ids and names differ between the
 * workspaces: until the key migration (C1, POD-7024) no unique constraint includes
 * `workspace_id`, so the same id in both would collide on the old key.
 *
 * For every repository method of the group (machines, machine record context, repos, checkouts,
 * grants, accounts, users, sign-in carry-over, settings audit, agent profiles, identity upgrade):
 *   - a read answers only its own workspace's rows;
 *   - an update, delete or upsert in one workspace leaves the other's rows unchanged, including
 *     a write in A addressed at B's own ids, which must find nothing to change.
 * The settings and secrets repositories have their own two-workspace test
 * (`settings.workspace.test.ts`, POD-7013).
 *
 * One machine id enrolled in both workspaces (the daemon's own UUID) and one repository origin
 * registered in both are the cases the composite keys exist for. The parts that need two rows
 * under one id (`machines`, `repo_prefixes`) run once those tables' primary keys lead with
 * `workspace_id` (C1); the rest runs now.
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
import { afterEach, describe, expect, it } from 'vitest'
import { deriveRepoId } from '../repo-id'
import type { SessionStore } from '../store'
import { openWorkspaceStores } from '../test-support/workspace-stores'
import type { CheckoutRow } from './checkouts'
import type { GrantRow } from './grants'

type Tag = 'a' | 'b'
const WS: Record<Tag, string> = { a: 'ws_a', b: 'ws_b' }
const AT = '2026-11-17T10:00:00.000Z'
const LATER = '2099-01-01T00:00:00.000Z'
const otherOf = (tag: Tag): Tag => (tag === 'a' ? 'b' : 'a')

const user = (tag: Tag, name = 'alice'): UserId => asUserId(`user:${tag}-${name}`)
const machine = (tag: Tag, n = 1): MachineId => asMachineId(`${tag}-machine-${n}`)
const root = (tag: Tag) => `/repo-${tag}`
const origin = (tag: Tag) => `https://example.test/${tag}/project.git`
const prefixOf = (tag: Tag) => (tag === 'a' ? 'AAA' : 'BBB')
const token = (tag: Tag) => `${tag}-token`
const sha = (value: string) => createHash('sha256').update(value).digest('hex')
const ANTHROPIC: AccountId = asAccountId('managed:anthropic')

let opened: SessionStore | undefined
const keyDirs: string[] = []

afterEach(async () => {
  await opened?.close()
  opened = undefined
  for (const dir of keyDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

interface RawDb {
  prepare(sql: string): {
    all(...params: unknown[]): unknown[]
    run(...params: unknown[]): unknown
  }
}
const rawDb = (store: SessionStore): RawDb => (store as unknown as { db: RawDb }).db

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

function rowsOf(store: SessionStore, tag: Tag): Record<string, unknown[]> {
  const db = rawDb(store)
  return Object.fromEntries(
    TABLES.map((table) => [
      table,
      db.prepare(`SELECT * FROM ${table} WHERE workspace_id = ? ORDER BY rowid`).all(WS[tag]),
    ]),
  )
}

/** Whether `table`'s primary key leads with workspace_id: true once C1 (POD-7024) lands. */
function keyLeadsWithWorkspace(store: SessionStore, table: string): boolean {
  const columns = rawDb(store).prepare(`PRAGMA table_info(${table})`).all() as {
    name: string
    pk: number
  }[]
  return columns.find((column) => column.pk === 1)?.name === 'workspace_id'
}

function member(tag: Tag, name: string, patch: Partial<MemberWrite> = {}): MemberWrite {
  return {
    memberId: user(tag, name),
    version: 1,
    state: 'active',
    role: name === 'alice' ? 'admin' : 'member',
    accountId: `${tag}-account-${name}`,
    profile: { name: `${tag} ${name}`, image: null, email: `${name}@${tag}.test` },
    actor: { system: 'setup' },
    ...patch,
  }
}

function grant(tag: Tag, resourceId: string, grantee: UserId, verb: GrantRow['verb']): GrantRow {
  return {
    resourceKind: 'issue',
    resourceId,
    grantee,
    verb,
    owner: user(tag),
    visibility: 'shared',
    createdAt: AT,
    actorKind: 'user',
    actorId: user(tag),
    onBehalfOf: user(tag),
  }
}

function checkout(tag: Tag, path: string, patch: Partial<CheckoutRow> = {}): CheckoutRow {
  return {
    machineId: machine(tag),
    path,
    root: root(tag),
    kind: path === root(tag) ? 'repository' : 'worktree',
    repoId: deriveRepoId({ originUrl: origin(tag), machineId: machine(tag), path: root(tag) }),
    branch: `${tag}-branch`,
    originUrl: origin(tag),
    locked: false,
    prunable: false,
    ...patch,
  }
}

function insertOldSignIn(store: SessionStore, tag: Tag, hash: string, label: string): void {
  rawDb(store)
    .prepare(
      `INSERT INTO client_sessions (workspace_id, token_hash, user_id, created_at, expires_at, label)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(WS[tag], hash, user(tag), AT, LATER, label)
}

/** An issue row, raw: the issues repository is another task's (B2). */
function insertIssue(store: SessionStore, tag: Tag, seq: number, profileId: string): void {
  rawDb(store)
    .prepare(
      `INSERT INTO issues (workspace_id, id, owner_user_id, created_by_actor, repo_path, repo_id, seq,
         title, stage, default_agent, agent_profile_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'backlog', 'codex', ?, ?, ?)`,
    )
    .run(
      WS[tag],
      asIssueId(`${tag}-iss-${seq}`),
      user(tag),
      user(tag),
      root(tag),
      `${tag}-repo`,
      seq,
      `${tag} issue ${seq}`,
      profileId,
      AT,
      AT,
    )
}

/**
 * One workspace's rows, written through its own repositories. Members alice (admin), bob and
 * carol (disabled); machine 1 (alice's custody, bearer token) and machine 2 (bob's); an issue
 * grant to bob; repository root with origin and prefix, a worktree, reach and a lost checkout;
 * alice's managed key, shared with bob and sent to machine 1; old sign-ins and a carry record;
 * an audit row; an agent profile with an issue using it.
 */
async function seed(store: SessionStore, tag: Tag): Promise<void> {
  const rows = store.users.memberRows
  await rows.write(member(tag, 'alice'))
  await rows.write(member(tag, 'bob'))
  // A member row exists once its membership is active; carol is then disabled.
  await rows.write(member(tag, 'carol'))
  await rows.write(member(tag, 'carol', { version: 2, state: 'disabled' }))

  await store.machines.enrollMachine({
    id: machine(tag),
    name: `${tag} box`,
    hostname: `${tag}-host`,
    tokenHash: sha(token(tag)),
    ownerUserId: user(tag),
    podiumManaged: true,
    assignment: { server: false, agentExecution: true },
    assignmentEvidence: { version: 1, source: 'enrollment', requestId: `${tag}-enroll` },
  })
  await store.machines.upsertMachine({
    id: machine(tag, 2),
    name: `${tag} laptop`,
    hostname: `${tag}-laptop`,
    tokenHash: sha(`${tag}-token-2`),
    ownerUserId: user(tag, 'bob'),
  })
  await store.machines.renameMachine(machine(tag), `${tag} workstation`)
  await store.machines.setUpdateChannel(machine(tag), 'stable')
  await store.machines.setMachineInventory(machine(tag), JSON.stringify({ harnesses: [] }))

  await store.grants.upsert(grant(tag, `${tag}-iss-1`, user(tag, 'bob'), 'read'))
  await store.grants.upsert(grant(tag, `${tag}-iss-1`, user(tag, 'bob'), 'write'))

  await store.repos.addRepo(root(tag), machine(tag), origin(tag), prefixOf(tag))
  await store.repos.addRepo(`${root(tag)}-scratch`, machine(tag, 2), undefined, `${prefixOf(tag)}S`)
  await store.repos.setRepoDefaultParentBranch(machine(tag), root(tag), `${tag}-main`)
  await store.repos.nextDraftSeq(repoIdOf(tag))

  await store.checkouts.apply(
    [checkout(tag, root(tag)), checkout(tag, `${root(tag)}/w1`), checkout(tag, `${root(tag)}/w2`)],
    [],
    AT,
  )
  await store.checkouts.applyReach(
    {
      reach: [
        { userId: user(tag), machineId: machine(tag), reach: 'all' },
        { userId: user(tag, 'bob'), machineId: machine(tag), reach: 'roots' },
      ],
      lost: [
        { userId: user(tag, 'bob'), machineId: machine(tag), path: `${root(tag)}/w0`, root: false },
      ],
    },
    AT,
  )

  await store.accounts.connect({
    ownerUserId: user(tag),
    accountKey: ANTHROPIC,
    provider: 'anthropic',
    kind: 'api-key',
    credential: `${tag}-secret`,
    identity: `${tag}-identity`,
    scope: 'role',
    createdAt: 1,
  })
  await store.accounts.share(user(tag), ANTHROPIC, [user(tag, 'bob')])
  await store.accounts.markSent(user(tag), ANTHROPIC, machine(tag), AT)
  await store.accounts.setOptIn(user(tag), 'claude-code', `${tag}-fingerprint`, true, AT)
  await store.accounts.recordTransfer(user(tag), {
    harness: 'claude-code',
    fingerprint: `${tag}-fingerprint`,
    machineId: machine(tag),
    outcome: 'installed',
    at: AT,
    revision: 1,
  })

  insertOldSignIn(store, tag, `${tag}-old-login`, 'login')
  insertOldSignIn(store, tag, `${tag}-old-mobile`, 'mobile')
  insertOldSignIn(store, tag, `${tag}-old-upstream`, 'upstream')
  await store.signInCarryOver.record({
    oldTokenHash: `${tag}-carried`,
    deviceSignInId: `${tag}-device`,
    sealed: `${tag}-sealed`,
    expiresAt: LATER,
    memberId: user(tag),
    oldLabel: 'login',
  })
  await store.signInCarryOver.writePeriodEndIfAbsent(`${tag}-period-end`)

  await store.settingsAudit.append({
    command: 'machines.rename',
    outcome: 'applied',
    actorKind: 'user',
    actorId: user(tag),
    onBehalfOf: user(tag),
    detail: { machineId: machine(tag) },
    redactedPaths: [],
    createdAt: AT,
  })

  await store.agentProfiles.insert({
    id: `${tag}-profile`,
    name: `${tag} profile`,
    description: `${tag} description`,
    candidates: [],
    machineId: machine(tag),
    instructions: `${tag} instructions`,
    actor: user(tag),
    now: AT,
  })
  insertIssue(store, tag, 1, `${tag}-profile`)
}

const repoIdOf = (tag: Tag) =>
  deriveRepoId({ originUrl: origin(tag), machineId: machine(tag), path: root(tag) })

async function twoSeeded(): Promise<readonly [SessionStore, SessionStore]> {
  const stores = await openWorkspaceStores([WS.a, WS.b], { path: ':memory:' })
  opened = stores[0]
  await seed(stores[0], 'a')
  await seed(stores[1], 'b')
  return stores
}

const pairs = (a: SessionStore, b: SessionStore) =>
  [
    [a, 'a'],
    [b, 'b'],
  ] as const

/** Every string in `value` that names a seeded thing starts with its own workspace's tag. */
function onlyOwn(value: unknown, tag: Tag): void {
  const other = otherOf(tag)
  const text = JSON.stringify(value)
  expect(text).not.toMatch(
    new RegExp(
      `\\b${other}-(machine|alice|bob|carol|host|laptop|secret|identity|profile|old|carried|iss)`,
    ),
  )
  expect(text).not.toContain(`/repo-${other}`)
  expect(text).not.toContain(`@${other}.test`)
}

describe('every row is written under its own workspace', () => {
  it('seeds each table of the group in both workspaces, with its own rows only', async () => {
    const [a] = await twoSeeded()
    for (const tag of ['a', 'b'] as const) {
      const rows = rowsOf(a, tag)
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
    for (const [store, tag] of pairs(a, b)) {
      const other = otherOf(tag)
      const users = store.users
      expect((await users.list()).map((row) => row.id).sort()).toEqual(
        [user(tag), user(tag, 'bob')].sort(),
      )
      expect((await users.listIncludingDisabled()).map((row) => row.id).sort()).toEqual(
        [user(tag), user(tag, 'bob'), user(tag, 'carol')].sort(),
      )
      expect((await users.get(user(tag)))?.id).toBe(user(tag))
      expect(await users.get(user(other))).toBeUndefined()
      expect(await users.roleOf(user(tag))).toBe('admin')
      expect(await users.roleOf(user(other))).toBeUndefined()
      expect(await users.authzGenerationOf(user(other))).toBeUndefined()
      expect(typeof (await users.authzGenerationOf(user(tag)))).toBe('number')
      expect(await users.queuedBeforeAuthorityChange(user(other), Date.now())).toBe(true)
      expect([...(await users.activeAdminIds())]).toEqual([user(tag)])
      expect((await users.earliestAdmin())?.id).toBe(user(tag))
      expect((await users.byEmail(`alice@${tag}.test`))?.id).toBe(user(tag))
      expect(await users.byEmail(`alice@${other}.test`)).toBeUndefined()
      expect((await users.findMemberByAccount(`${tag}-account-bob`))?.id).toBe(user(tag, 'bob'))
      expect(await users.findMemberByAccount(`${other}-account-bob`)).toBeUndefined()
      expect((await users.recordMembers()).map((row) => row.id).sort()).toEqual(
        [user(tag), user(tag, 'bob')].sort(),
      )
      expect(await users.hasSeveralActiveMembers()).toBe(true)
      expect(await users.hasSeveralMembers()).toBe(true)
      expect(await users.soleActiveMember()).toBeUndefined()
      expect(await users.memberRows.exists?.(user(tag, 'carol'))).toBe(true)
      expect(await users.memberRows.exists?.(user(other, 'carol'))).toBe(false)
    }
  })

  it('machines', async () => {
    const [a, b] = await twoSeeded()
    for (const [store, tag] of pairs(a, b)) {
      const other = otherOf(tag)
      const machines = store.machines
      const own = [machine(tag), machine(tag, 2)].sort()
      expect((await machines.listMachines()).map((row) => row.id).sort()).toEqual(own)
      expect([...(await machines.recordIds())].sort()).toEqual(own)
      expect((await machines.getMachine(machine(tag)))?.name).toBe(`${tag} workstation`)
      expect(await machines.getMachine(machine(other))).toBeUndefined()
      expect([...(await machines.getMachines([machine(tag), machine(other)])).keys()]).toEqual([
        machine(tag),
      ])
      expect(await machines.getMachineByToken(machine(tag), token(tag))).toBe(true)
      expect(await machines.getMachineByToken(machine(other), token(other))).toBe(false)
      expect(await machines.credentialIncarnation(machine(tag))).toBe(sha(token(tag)))
      expect(await machines.credentialIncarnation(machine(other))).toBeUndefined()
      expect(await machines.custodian(machine(tag))).toBe(user(tag))
      expect(await machines.custodian(machine(other))).toBeNull()
      expect(await machines.custodyMachineIds(user(tag))).toEqual([machine(tag)])
      expect(await machines.custodyMachineIds(user(other))).toEqual([])
      expect(await machines.legacyMachineSentinelSites()).toEqual([])
    }
  })

  it('grants', async () => {
    const [a, b] = await twoSeeded()
    for (const [store, tag] of pairs(a, b)) {
      const other = otherOf(tag)
      const grants = store.grants
      const bob = user(tag, 'bob')
      const verbs = (rows: GrantRow[]) => rows.map((row) => `${row.grantee}:${row.verb}`).sort()
      expect(verbs(await grants.listForResource('issue', `${tag}-iss-1`))).toEqual([
        `${bob}:read`,
        `${bob}:write`,
      ])
      expect(await grants.listForResource('issue', `${other}-iss-1`)).toEqual([])
      expect(await grants.listForResource('machine', machine(other))).toEqual([])
      expect([
        ...(await grants.listForResources('issue', [`${tag}-iss-1`, `${other}-iss-1`])).keys(),
      ]).toEqual([`${tag}-iss-1`])
      expect(verbs(await grants.loadForResource('machine', machine(tag)))).toEqual([
        `${user(tag)}:manage`,
        `${user(tag)}:use`,
      ])
      expect(await grants.loadForResource('machine', machine(other))).toEqual([])
      const loaded = await grants.loadForResources('issue', [`${tag}-iss-1`, `${other}-iss-1`])
      expect(loaded.get(`${other}-iss-1`)).toEqual([])
      const kinds = await grants.loadForResourcesOfKinds({
        issue: [`${other}-iss-1`],
        machine: [machine(other), machine(tag, 2)],
      })
      expect(kinds.get('issue')?.get(`${other}-iss-1`)).toEqual([])
      expect(kinds.get('machine')?.get(machine(other))).toEqual([])
      expect(verbs(kinds.get('machine')?.get(machine(tag, 2)) ?? [])).toEqual([
        `${bob}:manage`,
        `${bob}:use`,
      ])
      expect([...new Set(await grants.machineIdsForGrantee(user(tag)))]).toEqual([machine(tag)])
      expect(await grants.machineIdsForGrantee(user(other))).toEqual([])
      const audiences = await grants.visibilityAudiencesFor('issue', [
        `${tag}-iss-1`,
        `${other}-iss-1`,
      ])
      expect(audiences.get(`${tag}-iss-1`)).toEqual([bob])
      expect(audiences.get(`${other}-iss-1`)).toEqual([])
    }
  })

  it('repositories', async () => {
    const [a, b] = await twoSeeded()
    for (const [store, tag] of pairs(a, b)) {
      const other = otherOf(tag)
      const repos = store.repos
      const listed = await repos.listRepos()
      expect(listed.map((row) => row.path).sort()).toEqual([root(tag), `${root(tag)}-scratch`])
      expect(await repos.listRepos(machine(other))).toEqual([])
      expect(await repos.listRepoPaths(machine(tag))).toEqual([root(tag)])
      expect(await repos.prefixForRepoId(repoIdOf(tag))).toBe(prefixOf(tag))
      expect(await repos.prefixForRepoId(repoIdOf(other))).toBeNull()
      expect(await repos.prefixForPath(`${root(tag)}/src`)).toBe(prefixOf(tag))
      expect(await repos.prefixForPath(`${root(other)}/src`)).toBeNull()
      expect((await repos.prefixResolver())(`${root(other)}/src`)).toBeNull()
      expect(await repos.isPrefixTaken(prefixOf(tag))).toBe(true)
      expect(await repos.isPrefixTaken(prefixOf(other))).toBe(false)
      expect(await repos.repoForPrefix(prefixOf(tag))).toEqual({
        repoId: repoIdOf(tag),
        path: root(tag),
      })
      expect(await repos.repoForPrefix(prefixOf(other))).toBeNull()
      expect(await repos.defaultParentBranchForRepoId(repoIdOf(tag))).toBe(`${tag}-main`)
      expect(await repos.defaultParentBranchForRepoId(repoIdOf(other))).toBeNull()
      expect(await repos.defaultParentBranchForIssueRepo(root(tag), machine(tag))).toBe(
        `${tag}-main`,
      )
      expect(await repos.reportingMachineFor(repoIdOf(tag), root(tag))).toBe(machine(tag))
      expect(await repos.reportingMachineFor(repoIdOf(other), root(other))).toBeNull()
      expect(await repos.machineHasRootContaining(`${root(tag)}/x`, machine(tag))).toBe(true)
      expect(await repos.machineHasRootContaining(`${root(other)}/x`, machine(other))).toBe(false)
      expect(await repos.resolveRepoIdForPath(`${root(tag)}/x`, machine(tag))).toBe(repoIdOf(tag))
      expect(await repos.resolveIssueRepoId(root(tag), machine(tag))).toBe(repoIdOf(tag))
      expect(await repos.resolveRepoIdForPath(`${root(other)}/x`, machine(other))).not.toBe(
        repoIdOf(other),
      )
      expect(await repos.legacyRepoResidue()).toEqual({ repoIdsMissing: 0, prefixesMissing: 0 })
      // The places name own machines only (a range's upper bound may spell another path).
      const places = await repos.prefixedPlaces()
      expect(places).not.toBe('everywhere')
      if (places !== 'everywhere') {
        const named = [...places.bounded, ...places.open].map(([machineId]) => machineId)
        expect(new Set(named)).toEqual(new Set([machine(tag), machine(tag, 2)]))
      }
    }
  })

  it('checkouts', async () => {
    const [a, b] = await twoSeeded()
    for (const [store, tag] of pairs(a, b)) {
      const other = otherOf(tag)
      const checkouts = store.checkouts
      const paths = [root(tag), `${root(tag)}/w1`, `${root(tag)}/w2`]
      expect((await checkouts.all()).map((row) => row.path)).toEqual(paths)
      expect((await checkouts.ofMachine(machine(tag))).map((row) => row.path)).toEqual(paths)
      expect(await checkouts.ofMachine(machine(other))).toEqual([])
      expect((await checkouts.ofMachines([machine(tag), machine(other)])).length).toBe(3)
      expect([...(await checkouts.pathsOfMachines([machine(tag), machine(other)])).keys()]).toEqual(
        [machine(tag)],
      )
      expect([
        ...(await checkouts.rootPathsOfMachines([machine(tag), machine(other)])).keys(),
      ]).toEqual([machine(tag)])
      const reach = await checkouts.reachOfMachines([machine(tag), machine(other)])
      expect([...reach.keys()]).toEqual([machine(tag)])
      expect([...(reach.get(machine(tag))?.keys() ?? [])].sort()).toEqual(
        [user(tag), user(tag, 'bob')].sort(),
      )
      const lost = await checkouts.lostOfMachines([machine(tag), machine(other)])
      expect([...lost.keys()]).toEqual([machine(tag)])
    }
  })

  it('managed accounts and native logins', async () => {
    const [a, b] = await twoSeeded()
    for (const [store, tag] of pairs(a, b)) {
      const other = otherOf(tag)
      const accounts = store.accounts
      expect((await accounts.list()).map((row) => row.ownerUserId)).toEqual([user(tag)])
      expect((await accounts.summaries()).map((row) => row.identity)).toEqual([`${tag}-identity`])
      expect((await accounts.listFor(user(tag))).map((row) => row.credential)).toEqual([
        `${tag}-secret`,
      ])
      expect(await accounts.listFor(user(other))).toEqual([])
      expect(await accounts.ownedBy(user(other))).toEqual([])
      expect((await accounts.getFor(user(tag), ANTHROPIC))?.credential).toBe(`${tag}-secret`)
      expect(await accounts.getFor(user(other), ANTHROPIC)).toBeUndefined()
      expect(await accounts.own(user(other), ANTHROPIC)).toBeUndefined()
      expect((await accounts.sharedWith(user(tag, 'bob'), ANTHROPIC)).length).toBe(1)
      expect(await accounts.sharedWith(user(other, 'bob'), ANTHROPIC)).toEqual([])
      expect((await accounts.sharedWithUser(user(tag, 'bob'))).length).toBe(1)
      expect(await accounts.sharedWithUser(user(other, 'bob'))).toEqual([])
      expect(await accounts.sentTo(user(tag), ANTHROPIC)).toEqual([machine(tag)])
      expect(await accounts.sentTo(user(other), ANTHROPIC)).toEqual([])
      expect([...(await accounts.sendsOf(user(tag))).keys()]).toEqual([ANTHROPIC])
      expect([...(await accounts.sendsOf(user(other))).keys()]).toEqual([])
      expect((await accounts.optInsFor(user(tag))).map((row) => row.fingerprint)).toEqual([
        `${tag}-fingerprint`,
      ])
      expect(await accounts.optInsFor(user(other))).toEqual([])
      expect(
        await accounts.optInFor(user(other), 'claude-code', `${other}-fingerprint`),
      ).toBeUndefined()
      expect((await accounts.transfersFor(user(tag))).map((row) => row.machineId)).toEqual([
        machine(tag),
      ])
      expect(await accounts.transfersFor(user(other))).toEqual([])
    }
  })

  it('old sign-ins, carry records and the period end', async () => {
    const [a, b] = await twoSeeded()
    for (const [store, tag] of pairs(a, b)) {
      const other = otherOf(tag)
      const carry = store.signInCarryOver
      expect(await carry.matches(`${tag}-old-login`, AT)).toBe(true)
      expect(await carry.matches(`${tag}-carried`, AT)).toBe(true)
      expect(await carry.matches(`${other}-old-login`, AT)).toBe(false)
      expect(await carry.matches(`${other}-carried`, AT)).toBe(false)
      expect(await carry.sealedOf(`${tag}-carried`, AT)).toBe(`${tag}-sealed`)
      expect(await carry.sealedOf(`${other}-carried`, AT)).toBeUndefined()
      expect(await carry.countHonoured()).toBe(2)
      expect(await carry.periodEnd()).toBe(`${tag}-period-end`)
    }
  })

  it('the audit trail, agent profiles and the fleet channel', async () => {
    const [a, b] = await twoSeeded()
    for (const [store, tag] of pairs(a, b)) {
      const other = otherOf(tag)
      const trail = await store.settingsAudit.list()
      expect(trail.length).toBeGreaterThan(1)
      onlyOwn(trail, tag)
      const events = await store.settingsAudit.securityEvents(100)
      expect(events.some((row) => row.command === 'machines.rename')).toBe(true)
      onlyOwn(events, tag)
      onlyOwn(await store.settingsAudit.securityEvents(100, undefined, { kind: 'people' }), tag)
      expect(
        await store.settingsAudit.securityEvents(100, undefined, { actor: user(other) }),
      ).toEqual([])

      const profiles = store.agentProfiles
      expect((await profiles.list()).map((row) => row.id)).toEqual([`${tag}-profile`])
      expect((await profiles.get(`${tag}-profile`))?.name).toBe(`${tag} profile`)
      expect(await profiles.get(`${other}-profile`)).toBeNull()
      expect((await profiles.getByName(`${tag.toUpperCase()} PROFILE`))?.id).toBe(`${tag}-profile`)
      expect(await profiles.getByName(`${other} profile`)).toBeNull()
      expect(await profiles.openIssueSeqsUsing(`${tag}-profile`)).toEqual([1])
      expect(await profiles.openIssueSeqsUsing(`${other}-profile`)).toEqual([])
    }
    // The fleet channel and the update execution are the install's (install keys of meta):
    // one value for every workspace, by design.
    expect(await a.machines.recordContext.setFleetChannel('dev')).toBe(true)
    expect((await b.machines.recordContext.read()).fleetChannel).toBe('dev')
  })
})

describe('writes in one workspace leave the other unchanged', () => {
  it("A's writes aimed at B's ids change nothing in B", async () => {
    const [a, b] = await twoSeeded()
    const before = rowsOf(a, 'b')

    // Machines: every writer addressed at B's machine finds no row in A.
    const m = machine('b')
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
    await expect(am.transferServerAssignment(m, machine('b', 2), 'r')).rejects.toThrow()
    expect(
      await am.adoptLegacyHostCredential(
        m,
        'ed25519:key',
        { server: false, agentExecution: true },
        { version: 1, source: 's', requestId: 'r' },
      ),
    ).toBe(false)
    await am.setMachineOwner(m, user('a'))
    await am.touchMachine(m, 'taken-host')
    await am.supersedeMachine(m, machine('a'))
    await am.revokeMachine(m)
    await am.deleteMachine(machine('b', 2))
    expect(
      await am.enrollMachine(
        {
          id: m,
          name: 'replaced',
          hostname: 'replaced',
          tokenHash: sha('replaced'),
          ownerUserId: user('a'),
          podiumManaged: true,
          assignment: { server: false, agentExecution: true },
          assignmentEvidence: { version: 1, source: 'enrollment', requestId: 'r' },
        },
        AT,
        sha(token('b')),
      ),
    ).toBe(false)

    // Grants.
    expect(await a.grants.remove('issue', 'b-iss-1', user('b', 'bob'), 'read')).toBe(false)
    await a.grants.removeAllForGrantee(user('b', 'bob'))
    await a.grants.removeAllForResource('machine', m)
    await a.grants.removeAllForResource('issue', 'b-iss-1')

    // Repositories: B's roots are not A's to rename, re-origin or remove.
    await a.repos.updateRepoOrigin(m, root('b'), 'https://example.test/other.git')
    await a.repos.removeRepo(root('b'), m)
    await a.repos.removeRepo(`${root('b')}-scratch`, machine('b', 2))

    // Checkouts: removals, reach drops and found lost checkouts of B's keys.
    await a.checkouts.apply(
      [],
      [
        { machineId: m, path: root('b'), root: root('b') },
        { machineId: m, path: `${root('b')}/w1`, root: root('b') },
      ],
      AT,
    )
    await a.checkouts.applyReach(
      {
        reach: [{ userId: user('b'), machineId: m, reach: 'none' }],
        found: [{ userId: user('b', 'bob'), machineId: m, path: `${root('b')}/w0` }],
      },
      AT,
    )

    // Managed accounts.
    expect(await a.accounts.share(user('b'), ANTHROPIC, [])).toBe(false)
    expect(await a.accounts.unmarkSent(user('b'), ANTHROPIC, m)).toBe(false)
    await a.accounts.markSent(user('b'), ANTHROPIC, machine('a'), AT)
    expect(await a.accounts.disconnect(user('b'), ANTHROPIC)).toBe(false)
    await a.accounts.removeFor(user('b'), ANTHROPIC)

    // Members.
    await expect(a.users.writeProfile(user('b'), 'taken over', null)).rejects.toThrow(
      'Member unavailable',
    )
    await a.users.endOldSignIns(user('b'))

    // The boot upgrade's retirement of the old upstream sign-ins: A's one row only.
    expect(await a.identityUpgrade.retireSessions()).toBe(1)

    // Old sign-ins: by token, member, label, expiry and the end of the period.
    const carry = a.signInCarryOver
    expect(await carry.consume('b-old-login', AT)).toBeUndefined()
    await carry.forget('b-carried')
    await carry.endForToken('b-old-mobile')
    await carry.endForMember(user('b'))
    await carry.endByLabel('login')
    await carry.deleteExpired(`${LATER}Z`)
    await carry.deleteEverything()
    await a.signInCarryOver.writePeriodEndIfAbsent('a-other-end')

    // Agent profiles.
    expect(
      await a.agentProfiles.update({
        id: 'b-profile',
        name: 'taken over',
        description: '',
        candidates: [],
        machineId: null,
        instructions: '',
        actor: user('a'),
        now: AT,
      }),
    ).toBe(false)
    expect(await a.agentProfiles.delete('b-profile')).toBe(false)

    expect(rowsOf(a, 'b')).toEqual(before)
    expect(await b.signInCarryOver.periodEnd()).toBe('b-period-end')
  })

  it("A's own writes, upserts and deletes leave B's rows unchanged", async () => {
    const [a, b] = await twoSeeded()
    const before = rowsOf(a, 'b')

    await a.users.memberRows.write(member('a', 'dave'))
    await a.users.memberRows.write(member('a', 'bob', { version: 2, role: 'admin' }))
    await a.users.memberRows.write(member('a', 'carol', { version: 3, state: 'removed' }))
    await a.users.writeProfile(user('a'), 'renamed', null)
    await a.users.audit('members.join', user('a'), { memberId: user('a', 'dave') })

    await a.machines.renameMachine(machine('a'), 'renamed')
    await a.machines.setMachineOwner(machine('a', 2), user('a'))
    await a.machines.revokeMachine(machine('a'))
    await a.machines.deleteMachine(machine('a', 2))

    await a.grants.upsert(grant('a', 'a-iss-2', user('a', 'bob'), 'read'))
    await a.grants.removeAllForGrantee(user('a', 'bob'))

    await a.repos.setRepoPrefix(machine('a'), root('a'), 'AAB')
    await a.repos.setRepoDefaultParentBranch(machine('a'), root('a'), 'a-next')
    expect(await a.repos.nextDraftSeq(repoIdOf('a'))).toBe(2)
    await a.repos.removeRepo(`${root('a')}-scratch`, machine('a', 2))

    await a.checkouts.apply(
      [checkout('a', `${root('a')}/w3`)],
      [
        { machineId: machine('a'), path: root('a'), root: root('a') },
        { machineId: machine('a'), path: `${root('a')}/w1`, root: root('a') },
      ],
      AT,
    )
    await a.checkouts.applyReach(
      {
        reach: [{ userId: user('a'), machineId: machine('a'), reach: 'none' }],
        found: [{ userId: user('a', 'bob'), machineId: machine('a'), path: `${root('a')}/w0` }],
      },
      AT,
    )

    expect(await a.accounts.disconnect(user('a'), ANTHROPIC)).toBe(true)
    await a.accounts.setOptIn(user('a'), 'claude-code', 'a-fingerprint', false, AT)

    await a.signInCarryOver.endByLabel('login')
    await a.signInCarryOver.deleteEverything()

    expect(await a.agentProfiles.delete('a-profile')).toBe(true)
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

    expect(rowsOf(a, 'b')).toEqual(before)
    // And A's own rows did change: the writes reached their workspace.
    const after = rowsOf(a, 'a')
    expect(after.carried_sign_ins).toEqual([])
    expect(after.agent_profiles).toEqual([])
    expect(after.accounts).toEqual([])
    expect((await b.users.get(user('b')))?.displayName).toBe('b alice')
  })

  it("the sentinel scan and the credential checks see only their own workspace's rows", async () => {
    const [a, b] = await twoSeeded()
    rawDb(b)
      .prepare(
        `INSERT INTO repos (workspace_id, machine_id, path, added_at) VALUES (?, 'local', ?, ?)`,
      )
      .run(WS.b, '/legacy-b', AT)
    expect(await a.machines.legacyMachineSentinelSites()).toEqual([])
    expect(await b.machines.legacyMachineSentinelSites()).toEqual(['repos.machine_id'])

    // A machine key adopted in B verifies in B only, and A cannot rotate it.
    const dir = mkdtempSync(join(tmpdir(), 'people-ws-key-'))
    keyDirs.push(dir)
    const key = createMachineCredential(dir)
    const wire = machinePublicKeyWire(key)
    expect(
      await b.machines.adoptLegacyHostCredential(
        machine('b'),
        wire,
        { server: false, agentExecution: true },
        { version: 1, source: 'adopt', requestId: 'b-adopt' },
      ),
    ).toBe(true)
    const signature = signWithMachine(key, 'hello')
    expect(await b.machines.verifyMachineSignature(machine('b'), 'hello', signature)).toBe(true)
    expect(await a.machines.verifyMachineSignature(machine('b'), 'hello', signature)).toBe(false)
    const next = createMachineCredential(join(dir, 'next'))
    const nextWire = machinePublicKeyWire(next)
    const before = rowsOf(a, 'b')
    expect(
      await a.machines.rotateCredential(
        machine('b'),
        {
          newKeyId: nextWire,
          newPublicKey: nextWire,
          newSignature: signWithMachine(next, 'rotate'),
          previous: { kind: 'ed25519', publicKey: wire, signature: signWithMachine(key, 'rotate') },
        },
        'rotate',
      ),
    ).toBe(false)
    expect(rowsOf(a, 'b')).toEqual(before)
  })
})

describe('one machine and one repository in both workspaces', () => {
  it('one repository origin gives the same repo_id in both, and they do not interfere', async () => {
    const [a, b] = await twoSeeded()
    const shared = 'https://example.test/shared/project.git'
    const sharedId = deriveRepoId({ originUrl: shared, machineId: machine('a'), path: '/shared-a' })
    expect(deriveRepoId({ originUrl: shared, machineId: machine('b'), path: '/shared-b' })).toBe(
      sharedId,
    )
    await a.repos.addRepo('/shared-a', machine('a'), shared, 'SHA')
    await b.repos.addRepo('/shared-b', machine('b'), shared)
    expect(await a.repos.resolveRepoIdForPath('/shared-a/x', machine('a'))).toBe(sharedId)
    expect(await b.repos.resolveRepoIdForPath('/shared-b/x', machine('b'))).toBe(sharedId)
    expect((await a.repos.listRepos()).filter((row) => row.repoId === sharedId)).toHaveLength(1)
    expect(
      (await b.repos.listRepos()).filter((row) => row.repoId === sharedId).map((row) => row.path),
    ).toEqual(['/shared-b'])
    expect(await a.repos.reportingMachineFor(sharedId, '/shared-a')).toBe(machine('a'))
    expect(await b.repos.reportingMachineFor(sharedId, '/shared-b')).toBe(machine('b'))
    expect(await a.repos.repoForPrefix('SHA')).toEqual({ repoId: sharedId, path: '/shared-a' })
    expect(await b.repos.repoForPrefix('SHA')).toBeNull()

    // A's removal of its root leaves B's root of the same repository.
    await a.repos.removeRepo('/shared-a', machine('a'))
    expect((await a.repos.listRepos()).some((row) => row.repoId === sharedId)).toBe(false)
    expect(
      (await b.repos.listRepos()).filter((row) => row.repoId === sharedId).map((row) => row.path),
    ).toEqual(['/shared-b'])

    if (keyLeadsWithWorkspace(a, 'repo_prefixes')) {
      // After C1 each workspace holds its own prefix row for the shared id.
      expect(await b.repos.prefixForRepoId(sharedId)).not.toBeNull()
      expect(await b.repos.prefixForRepoId(sharedId)).not.toBe('SHA')
    }
  })

  it('one machine id enrolled in both workspaces is two rows with their own grants and checkouts', async () => {
    const [a, b] = await twoSeeded()
    if (!keyLeadsWithWorkspace(a, 'machines')) {
      // Before C1 (POD-7024) the machines key is the id alone, so one id cannot have two rows.
      // What holds already: B's grants and checkouts on its own machine are B's alone.
      expect(await a.grants.loadForResource('machine', machine('b'))).toEqual([])
      expect(await a.checkouts.ofMachine(machine('b'))).toEqual([])
      return
    }
    const daemon = asMachineId('11111111-2222-4333-8444-555555555555')
    for (const [store, tag] of pairs(a, b)) {
      expect(
        await store.machines.enrollMachine({
          id: daemon,
          name: `${tag} shared box`,
          hostname: `${tag}-shared`,
          tokenHash: sha(`${tag}-shared-token`),
          ownerUserId: user(tag),
          podiumManaged: true,
          assignment: { server: false, agentExecution: true },
          assignmentEvidence: { version: 1, source: 'enrollment', requestId: `${tag}-shared` },
        }),
      ).toBe(true)
      await store.checkouts.apply([checkout(tag, `/shared-${tag}`, { machineId: daemon })], [], AT)
    }
    for (const [store, tag] of pairs(a, b)) {
      expect((await store.machines.getMachine(daemon))?.name).toBe(`${tag} shared box`)
      expect(await store.machines.custodian(daemon)).toBe(user(tag))
      expect(await store.machines.getMachineByToken(daemon, `${tag}-shared-token`)).toBe(true)
      expect(await store.machines.getMachineByToken(daemon, `${otherOf(tag)}-shared-token`)).toBe(
        false,
      )
      expect((await store.checkouts.ofMachine(daemon)).map((row) => row.path)).toEqual([
        `/shared-${tag}`,
      ])
    }
    await a.machines.revokeMachine(daemon)
    expect((await b.machines.getMachine(daemon))?.revokedAt).toBeNull()
    expect(await b.machines.custodian(daemon)).toBe(user('b'))
  })
})
