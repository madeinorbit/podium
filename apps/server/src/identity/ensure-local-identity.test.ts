import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WorkspaceIdentity } from '@podium/identity'
import { asUserId, firstAdminMemberId, newInviteId, type UserId } from '@podium/model'
import { hashPassword } from '@podium/runtime/auth-store'
import { openDatabase } from '@podium/runtime/sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SessionStore } from '../store'
import { legacyIdentity } from '../store/fixtures/test-support'
import { seedLegacyClientSession } from '../test-support/legacy-client-session'
import { openTestStore } from '../test-support/open-test-store'
import { ensureLocalIdentity } from './ensure-local-identity'
import { createMemberOfRequest } from './member-of-request'
import { openServerIdentity } from './server-identity'

const AT = '2026-11-10T12:00:00.000Z'
const ALICE_PASSWORD = 'old-password-alice'
const BOB_PASSWORD = 'old-password-bob'
const CAROL_PASSWORD = 'old-password-carol'
const BOB = asUserId('mem_upgrade_bob')
const CAROL = asUserId('mem_upgrade_disabled')
const UNCLAIMED = asUserId('mem_upgrade_unclaimed')
const IDENTITY_TABLES = [
  'identity_user',
  'identity_account',
  'identity_session',
  'identity_membership',
  'identity_invitation',
  'identity_one_time_code',
  'identity_workspace_revision',
] as const

describe('ensureLocalIdentity', () => {
  let dir: string
  let path: string
  let store: SessionStore
  let workspace: WorkspaceIdentity

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'podium-ensure-local-identity-'))
    path = join(dir, 'podium.db')
    store = await openTestStore(path)
    // The core as the server builds it, without the boot step this file tests.
    workspace = (await openServerIdentity(store, { readOnly: true })).workspace
  })

  afterEach(async () => {
    await store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  function withDb<T>(use: (db: ReturnType<typeof openDatabase>) => T): T {
    const db = openDatabase(path)
    try {
      return use(db)
    } finally {
      db.close()
    }
  }

  /** Compare the actual rows, including ids, revisions and times. */
  const snapshot = () =>
    withDb((db) => ({
      users: db.prepare('SELECT * FROM users ORDER BY id').all(),
      credentials: db.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'user_credentials'").get()
        ? db.prepare('SELECT * FROM user_credentials ORDER BY user_id').all()
        : null,
      invites: db.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'member_invites'").get()
        ? db.prepare('SELECT * FROM member_invites ORDER BY id').all()
        : null,
      sessions: db.prepare('SELECT * FROM client_sessions ORDER BY token_hash').all(),
      identity: Object.fromEntries(
        IDENTITY_TABLES.map((table) => [
          table,
          db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all(),
        ]),
      ),
    }))

  const memberFacts = () =>
    withDb((db) =>
      db
        .prepare(
          'SELECT id, display_name, email, avatar, role, disabled_at, authz_generation, authz_changed_at FROM users ORDER BY id',
        )
        .all(),
    )

  async function legacyInvite(input: { memberId?: UserId; email?: string; expiresAt?: Date } = {}) {
    const token = randomBytes(32).toString('base64url')
    const tokenHash = createHash('sha256').update(token).digest('hex')
    const expiresAt = input.expiresAt ?? new Date(Date.now() + 86_400_000)
    await legacyIdentity(store).insertInvite({
      id: newInviteId(),
      tokenHash,
      email: input.email ?? null,
      memberId: input.memberId ?? null,
      role: 'member',
      createdBy: firstAdminMemberId(),
      createdAt: AT,
      expiresAt: expiresAt.toISOString(),
    })
    return { token, tokenHash, expiresAt }
  }

  let peer = 0
  async function login(password: string, email?: string) {
    const facts = {
      scheme: 'https',
      sameMachine: false,
      clientAddress: `192.0.2.${++peer}`,
    } as const
    const signIn = await workspace.core.signIn.password(
      {
        ...(email ? { email } : {}),
        password,
        device: { kind: 'phone' },
        delivery: 'bearer',
      },
      facts,
    )
    if ('refused' in signIn) return signIn
    return await workspace.resolve(
      new Request('https://podium.example.test', {
        headers: { authorization: `Bearer ${signIn.bearer}` },
      }),
      facts,
    )
  }

  it('gives the sole member of a fresh database an active membership and an account with no login method', async () => {
    const first = firstAdminMemberId()
    await ensureLocalIdentity(store, workspace)
    const [membership, ...rest] = await workspace.memberships.list()
    expect(rest).toEqual([])
    expect(membership).toMatchObject({
      memberId: first,
      role: 'admin',
      status: 'active',
      hasPassword: false,
    })
    const row = await store.users.get(first)
    expect(row?.accountId).toBe(membership?.account?.id)
    expect(row?.role).toBe('admin')
    expect(snapshot().identity.identity_user).toHaveLength(1)
    expect(snapshot().identity.identity_account).toHaveLength(0)

    // The one-person server works as before: no sign-in on its own machine.
    expect(await workspace.signInRequired()).toBe(false)
    const memberOfRequest = createMemberOfRequest({
      identity: workspace,
      users: store.users,
      trustedProxyHops: 0,
    })
    expect(
      await memberOfRequest(
        new Request('http://127.0.0.1:18787/trpc/x', {
          headers: { 'x-podium-peer-address': '127.0.0.1' },
        }),
      ),
    ).toMatchObject({ kind: 'member', memberId: first, deviceSignIn: null })
  })

  it('signs in the sole legacy member with their old password and no email', async () => {
    const first = firstAdminMemberId()
    const hash = await hashPassword(ALICE_PASSWORD)
    await legacyIdentity(store).setPasswordHash(first, hash, AT)
    await ensureLocalIdentity(store, workspace)

    expect(await workspace.core.signIn.prompt()).toBe('password')
    expect(await login(ALICE_PASSWORD)).toMatchObject({
      kind: 'member',
      memberId: first,
      role: 'admin',
    })
    expect(await login('wrong-password')).toEqual({ refused: 'invalid' })
    expect(await workspace.memberships.list()).toMatchObject([
      { memberId: first, status: 'active', account: { email: null }, hasPassword: true },
    ])
    withDb((db) => {
      const user = db.prepare('SELECT email FROM identity_user').get() as { email: string }
      expect(user.email).toMatch(/^no-email-[0-9a-f]{32}@no-email\.invalid$/)
      expect(db.prepare('SELECT email FROM users WHERE id = ?').get(first)).toEqual({ email: null })
      expect(db.prepare('SELECT password FROM identity_account').get()).toEqual({ password: hash })
    })
  })

  it('keeps open access for a sole admin with an old invitation to set their password', async () => {
    const alice = firstAdminMemberId()
    const { token } = await legacyInvite({ memberId: alice, email: 'alice@example.test' })
    expect(await ensureLocalIdentity(store, workspace)).toMatchObject({
      skippedSoleMemberInvitations: 1,
    })
    expect(await workspace.signInRequired()).toBe(false)
    expect(await workspace.memberships.list()).toMatchObject([
      { memberId: alice, status: 'active' },
    ])
    await expect(workspace.memberships.inspectInvitation(token)).rejects.toMatchObject({
      code: 'invitation-invalid',
    })
  })

  it('adopts Alice and Bob in place, retaining Carol’s password and disabled state', async () => {
    const alice = firstAdminMemberId()
    const aliceEmail = 'alice@example.test'
    const bobEmail = 'bob@example.test'
    const carolEmail = 'carol@example.test'
    const [aliceHash, bobHash, carolHash] = await Promise.all([
      hashPassword(ALICE_PASSWORD),
      hashPassword(BOB_PASSWORD),
      hashPassword(CAROL_PASSWORD),
    ])
    await legacyIdentity(store).setEmail(alice, aliceEmail)
    await legacyIdentity(store).setPasswordHash(alice, aliceHash, AT)
    await legacyIdentity(store).create(
      {
        id: BOB,
        displayName: 'Bob',
        role: 'member',
        email: bobEmail,
        createdAt: AT,
        disabledAt: null,
      },
      bobHash,
    )
    await legacyIdentity(store).create(
      {
        id: CAROL,
        displayName: 'Carol',
        role: 'admin',
        email: carolEmail,
        createdAt: AT,
        disabledAt: null,
      },
      carolHash,
    )
    await legacyIdentity(store).disable(CAROL, AT)
    withDb((db) =>
      db
        .prepare('UPDATE users SET avatar = ?, authz_generation = 9 WHERE id = ?')
        .run('https://example.test/alice.png', alice),
    )
    const before = memberFacts()
    await ensureLocalIdentity(store, workspace)

    expect(await login(ALICE_PASSWORD, aliceEmail)).toMatchObject({
      kind: 'member',
      memberId: alice,
      role: 'admin',
    })
    expect(await login(BOB_PASSWORD, bobEmail)).toMatchObject({
      kind: 'member',
      memberId: BOB,
      role: 'member',
    })
    expect(await login(CAROL_PASSWORD, carolEmail)).toEqual({ refused: 'invalid' })
    const memberships = await workspace.memberships.list()
    expect(memberships).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          memberId: alice,
          role: 'admin',
          status: 'active',
          hasPassword: true,
        }),
        expect.objectContaining({
          memberId: BOB,
          role: 'member',
          status: 'active',
          hasPassword: true,
        }),
        expect.objectContaining({
          memberId: CAROL,
          role: 'admin',
          status: 'disabled',
          hasPassword: true,
        }),
      ]),
    )
    const carolAccount = memberships.find((member) => member.memberId === CAROL)?.account
    if (!carolAccount) throw new Error('The disabled member’s account was not adopted')
    expect(await workspace.core.accounts.verifyPassword(carolAccount.id, CAROL_PASSWORD)).toBe(true)
    expect(memberFacts()).toEqual(before)
    expect(snapshot().credentials).toBeNull()
  })

  it('adopts a legacy member when another member already has an identity', async () => {
    const alice = firstAdminMemberId()
    const adopted = await workspace.memberships.adopt({
      by: 'upgrade',
      memberId: alice,
      role: 'admin',
      status: 'active',
      account: {
        kind: 'new',
        name: 'Alice',
        email: 'alice@example.test',
        password: ALICE_PASSWORD,
      },
    })
    await legacyIdentity(store).create(
      {
        id: BOB,
        displayName: 'Bob',
        email: 'bob@example.test',
        role: 'member',
        createdAt: AT,
        disabledAt: null,
      },
      await hashPassword(BOB_PASSWORD),
    )
    await ensureLocalIdentity(store, workspace)
    expect(await login(BOB_PASSWORD, 'bob@example.test')).toMatchObject({
      kind: 'member',
      memberId: BOB,
    })
    expect(
      (await workspace.memberships.list()).find((member) => member.memberId === alice),
    ).toEqual(adopted)
  })

  it('keeps pending invitation and recovery links usable once and skips expired links', async () => {
    const alice = firstAdminMemberId()
    await legacyIdentity(store).setPasswordHash(alice, await hashPassword(ALICE_PASSWORD), AT)
    await legacyIdentity(store).create(
      {
        id: BOB,
        displayName: 'Bob',
        role: 'member',
        createdAt: AT,
        disabledAt: null,
      },
      await hashPassword(BOB_PASSWORD),
    )
    await legacyIdentity(store).create({
      id: UNCLAIMED,
      displayName: 'Unclaimed',
      email: null,
      role: 'admin',
      createdAt: AT,
      disabledAt: null,
    })
    const unbound = await legacyInvite({ email: 'new@example.test' })
    const bound = await legacyInvite({ memberId: UNCLAIMED, email: 'invited@example.test' })
    const recovery = await legacyInvite({ memberId: alice })
    const expired = await legacyInvite({ expiresAt: new Date(AT) })
    await ensureLocalIdentity(store, workspace)

    const unclaimedMembership = (await workspace.memberships.list()).find(
      (member) => member.memberId === UNCLAIMED,
    )
    expect(unclaimedMembership).toMatchObject({ status: 'invited', role: 'admin', account: null })
    expect(
      withDb((db) =>
        db
          .prepare('SELECT membership_version, email, disabled_at FROM users WHERE id = ?')
          .get(UNCLAIMED),
      ),
    ).toEqual({
      membership_version: unclaimedMembership?.version,
      email: null,
      disabled_at: null,
    })

    for (const link of [unbound, bound]) {
      const invite = await workspace.memberships.inspectInvitation(link.token)
      expect(invite.expiresAt).toEqual(link.expiresAt)
      await expect(
        workspace.memberships.accept({
          token: link.token,
          account: { kind: 'new', name: 'Wrong', email: 'wrong@example.test' },
        }),
      ).rejects.toMatchObject({ code: 'email-mismatch' })
      const accept = () =>
        workspace.memberships.accept({
          token: link.token,
          account: {
            kind: 'new',
            name: 'Invitee',
            email: invite.email ?? '',
            password: 'new-password',
          },
        })
      const accepted = await accept()
      if (link === bound) {
        expect(accepted.memberId).toBe(UNCLAIMED)
        expect((await store.users.get(UNCLAIMED))?.role).toBe('admin')
      }
      await expect(accept()).rejects.toMatchObject({ code: 'invitation-invalid' })
    }
    await expect(workspace.memberships.inspectInvitation(expired.token)).rejects.toMatchObject({
      code: 'invitation-invalid',
    })
    expect(await workspace.core.codes.inspectPasswordReset(recovery.token)).toMatchObject({
      expiresAt: recovery.expiresAt,
    })
    const redeem = () =>
      workspace.core.codes.redeemPasswordReset({
        code: recovery.token,
        password: 'new-alice-password',
      })
    expect(await redeem()).toBeDefined()
    expect(await redeem()).toBeUndefined()
    expect(snapshot().invites).toBeNull()
    const after = snapshot()
    await ensureLocalIdentity(store, workspace)
    expect(snapshot()).toEqual(after)
  })

  it('deletes retired session labels and preserves the device rows byte for byte', async () => {
    const alice = firstAdminMemberId()
    for (const label of [
      'login',
      'mobile',
      'break-glass',
      'unknown',
      'upstream',
      'server-transfer-claim',
    ]) {
      await seedLegacyClientSession(
        store,
        `hash-${label}`,
        alice,
        '2030-01-01T00:00:00.000Z',
        label,
        {
          sessionId: `session-${label}`,
          deviceId: `device-${label}`,
          deviceName: 'Legacy fixture device',
          platform: 'desktop',
          lastSeenAt: AT,
        },
      )
    }
    const before = snapshot().sessions as { label: string }[]
    await ensureLocalIdentity(store, workspace)
    expect(snapshot().sessions).toEqual(
      before.filter(({ label }) => label !== 'upstream' && label !== 'server-transfer-claim'),
    )
  })

  it('rolls back earlier writes when importing a pending link fails and retries on boot', async () => {
    const alice = firstAdminMemberId()
    await legacyIdentity(store).setPasswordHash(alice, await hashPassword(ALICE_PASSWORD), AT)
    const { token, tokenHash } = await legacyInvite({ email: 'invitee@example.test' })
    withDb((db) =>
      db.exec(`CREATE TRIGGER fail_invitation BEFORE INSERT ON identity_invitation
      BEGIN SELECT RAISE(ABORT, 'fixture invitation failure'); END`),
    )
    const before = snapshot()
    const failure = ensureLocalIdentity(store, workspace)
    await expect(failure).rejects.toMatchObject({
      message: 'Local identity upgrade database error',
      cause: { message: 'fixture invitation failure' },
    })
    await expect(failure).rejects.not.toThrow(tokenHash)
    expect(snapshot()).toEqual(before)
    withDb((db) => db.exec('DROP TRIGGER fail_invitation'))
    await ensureLocalIdentity(store, workspace)
    await expect(workspace.memberships.inspectInvitation(token)).resolves.toMatchObject({
      email: 'invitee@example.test',
    })
  })
  it('retires imported storage only after Alice and Bob can use the shared identity', async () => {
    const alice = firstAdminMemberId()
    await legacyIdentity(store).setPasswordHash(alice, await hashPassword(ALICE_PASSWORD), AT)
    await legacyIdentity(store).create(
      {
        id: BOB,
        displayName: 'Bob',
        email: 'bob@example.test',
        role: 'member',
        createdAt: AT,
        disabledAt: null,
      },
      await hashPassword(BOB_PASSWORD),
    )
    await ensureLocalIdentity(store, workspace)
    expect(await login(ALICE_PASSWORD)).toMatchObject({ kind: 'member', memberId: alice })
    expect(await login(BOB_PASSWORD, 'bob@example.test')).toMatchObject({
      kind: 'member',
      memberId: BOB,
    })
    expect(
      withDb((db) =>
        db
          .prepare(
            "SELECT name FROM sqlite_schema WHERE name IN ('user_credentials', 'member_invites')",
          )
          .all(),
      ),
    ).toEqual([])
    expect(await store.settings.legacyIdentityLinksImported()).toBe(true)
    await ensureLocalIdentity(store, workspace)
    await store.close()
    store = await openTestStore(path)
    workspace = (await openServerIdentity(store)).workspace
    expect(snapshot().credentials).toBeNull()
    expect(snapshot().invites).toBeNull()
    expect(await login(ALICE_PASSWORD)).toMatchObject({ kind: 'member', memberId: alice })
    expect(await login(BOB_PASSWORD, 'bob@example.test')).toMatchObject({
      kind: 'member',
      memberId: BOB,
    })
  })
})
