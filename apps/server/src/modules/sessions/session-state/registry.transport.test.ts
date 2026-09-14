/**
 * TRANSPORT-LEVEL second-member cases for the session-state envelope (PDM-432).
 *
 * `registry.test.ts` drives `SessionStateRegistry.execute` with constructed
 * principals. That is the enforcement point. These cases drive the tRPC surface
 * the oracle already uses, after `/auth/login` has minted two real members with
 * their own `user_credentials` rows — the path the file header used to say the
 * transport could not produce.
 *
 * A constructed `createCaller` principal would skip `requestUserId` →
 * `userCommandPrincipal`, which is the wiring a shared-password world never
 * exercised. Each cookie here is a login, and `/auth/status` must name two
 * different people before any isolation assertion runs.
 *
 * Denials are silent no-ops on this class (§3.1.5). Every denial is paired with
 * the same call succeeding for the person who owns the row, so a surface that
 * refuses everyone still fails.
 *
 * THE SECOND PERSON IS A SECOND ADMIN. `userCommandPrincipal` mints `owned` for
 * a `member` and `all` for an admin; per-user writes (`pins` / `snoozes` /
 * `tabs`) require `self` (see the `owned` denial in `registry.test.ts`). A
 * member login therefore cannot produce the ALLOW half of these assertions —
 * that is a real transport fact, not a fixture convenience, and it is filed
 * separately. Two admins are two people who can both write, which is what
 * isolation needs.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { firstAdminMemberId } from '@podium/model'
import { hashPassword } from '@podium/runtime/auth-store'
import { createTRPCClient, httpBatchLink } from '@trpc/client'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { noJanitorWorkerForTests } from '../../../janitor-host'
import type { AppRouter } from '../../../router'
import { startServer } from '../../../server'
import { defaultDbPath } from '../../../store'

const priorStateDir = process.env.PODIUM_STATE_DIR
const adminEmail = 'admin-transport@example.com'
const adminPassword = 'admin-transport-password'
const memberEmail = 'second-admin-transport@example.com'
const memberPassword = 'second-admin-transport-password'

describe('session-state tRPC isolation between two logged-in members', () => {
  let stateDir: string
  let handle: Awaited<ReturnType<typeof startServer>>
  let adminId: string
  let memberId: string
  let adminCookie: string
  let memberCookie: string
  let admin: ReturnType<typeof createTRPCClient<AppRouter>>
  let member: ReturnType<typeof createTRPCClient<AppRouter>>
  let adminSessionId: string
  let memberSessionId: string

  const url = (path: string) => `http://127.0.0.1:${handle.port}${path}`
  const post = (path: string, body: unknown, cookie?: string) =>
    fetch(url(path), {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      body: JSON.stringify(body),
    })

  function clientFor(cookie: string) {
    return createTRPCClient<AppRouter>({
      links: [httpBatchLink({ url: url('/trpc'), headers: { cookie } })],
    })
  }

  async function readJson(response: Response): Promise<unknown> {
    const text = await response.text()
    try {
      return JSON.parse(text) as unknown
    } catch {
      throw new Error(`${response.status} ${response.url}: ${text}`)
    }
  }

  async function login(email: string, password: string, userId: string) {
    const response = await post('/auth/login', { email, password })
    const body = await readJson(response)
    expect(response.status).toBe(200)
    expect(body).toEqual({ ok: true, userId })
    const cookie = response.headers.get('set-cookie')?.split(';')[0]
    expect(cookie).toMatch(/^podium_session=.+/)
    return cookie!
  }

  beforeAll(async () => {
    stateDir = mkdtempSync(join(tmpdir(), 'podium-session-state-transport-'))
    writeFileSync(
      join(stateDir, 'config.json'),
      JSON.stringify({ configVersion: 2, mode: 'all-in-one', persistence: 'systemd' }),
    )
    process.env.PODIUM_STATE_DIR = stateDir
    handle = await startServer({
      dbPath: defaultDbPath(),
      port: 0,
      janitorWorkerForTests: noJanitorWorkerForTests,
    })
    const users = handle.registry.sessionStore.users
    adminId = firstAdminMemberId()
    await users.setEmail(adminId, adminEmail)
    await users.setPasswordHash(adminId, await hashPassword(adminPassword), new Date().toISOString())

    adminCookie = await login(adminEmail, adminPassword, adminId)
    const invited = await post(
      '/auth/members/invite',
      { email: memberEmail, role: 'admin' },
      adminCookie,
    )
    const invitedBody = (await readJson(invited)) as { invite: { token: string } }
    expect(invited.status).toBe(200)
    const claimed = await post('/auth/members/complete', {
      token: invitedBody.invite.token,
      email: memberEmail,
      displayName: 'Transport Second Admin',
      password: memberPassword,
    })
    const claimedBody = (await readJson(claimed)) as { userId: string }
    expect(claimed.status).toBe(200)
    memberId = claimedBody.userId
    expect(memberId).toBeTruthy()
    expect(memberId).not.toBe(adminId)
    memberCookie = await login(memberEmail, memberPassword, memberId)
    admin = clientFor(adminCookie)
    member = clientFor(memberCookie)

    const cwd = mkdtempSync(join(tmpdir(), 'podium-session-state-transport-cwd-'))
    adminSessionId = (await admin.sessions.create.mutate({ agentKind: 'shell', cwd })).sessionId
    memberSessionId = (await member.sessions.create.mutate({ agentKind: 'shell', cwd })).sessionId
  }, 60_000)

  afterAll(async () => {
    await handle?.close()
    if (priorStateDir === undefined) delete process.env.PODIUM_STATE_DIR
    else process.env.PODIUM_STATE_DIR = priorStateDir
    if (stateDir) rmSync(stateDir, { recursive: true, force: true })
  })

  it('the two cookies are two people, not two devices of one person', async () => {
    const asAdmin = await fetch(url('/auth/status'), { headers: { cookie: adminCookie } })
    const asMember = await fetch(url('/auth/status'), { headers: { cookie: memberCookie } })
    expect(await asAdmin.json()).toMatchObject({ authed: true, userId: adminId })
    expect(await asMember.json()).toMatchObject({ authed: true, userId: memberId })
    expect(adminId).not.toBe(memberId)
    expect(await admin.auth.profile.query()).toMatchObject({ email: adminEmail })
    expect(await member.auth.profile.query()).toMatchObject({ email: memberEmail })
  })

  it('pins.set / list are the CALLER’s rows — two logins, two maps', async () => {
    const pin = { kind: 'panel' as const, id: 'panel-shared-label', pinned: true }
    expect(await admin.pins.set.mutate(pin)).toMatchObject({ panels: ['panel-shared-label'] })
    expect(await member.pins.set.mutate(pin)).toMatchObject({ panels: ['panel-shared-label'] })

    await admin.pins.set.mutate({ ...pin, pinned: false })

    expect((await admin.pins.list.query()).panels).toEqual([])
    expect((await member.pins.list.query()).panels).toEqual(['panel-shared-label'])
  })

  it('snoozes.set on the other person’s session is a silent no-op, and the owner’s same call applies', async () => {
    const until = new Date(Date.now() + 60_000).toISOString()
    const other = new Date(Date.now() + 120_000).toISOString()

    expect(await admin.snoozes.set.mutate({ sessionId: adminSessionId, until })).toEqual({
      [adminSessionId]: until,
    })
    // THE DENIAL: member cannot write a per-user row on a session they cannot
    // read. Silent no-op — same answer as a missing session, so this assertion
    // is on BOTH lists, not on an error code.
    await member.snoozes.set.mutate({ sessionId: adminSessionId, until: other })
    expect(await admin.snoozes.list.query()).toEqual({ [adminSessionId]: until })
    expect(await member.snoozes.list.query()).toEqual({})

    // THE ALLOW: the identical call on a session the member owns applies, so
    // the refusal above is not a surface wired shut.
    expect(await member.snoozes.set.mutate({ sessionId: memberSessionId, until: other })).toEqual({
      [memberSessionId]: other,
    })
    expect(await member.snoozes.list.query()).toEqual({ [memberSessionId]: other })
    expect(await admin.snoozes.list.query()).toEqual({ [adminSessionId]: until })
  })

  it("one principal’s CLEAR does not un-snooze the other", async () => {
    expect(await admin.snoozes.clear.mutate({ sessionId: adminSessionId })).toEqual({})
    expect(await admin.snoozes.list.query()).toEqual({})
    expect(Object.keys(await member.snoozes.list.query())).toContain(memberSessionId)
  })

  it('a userId in the PAYLOAD cannot redirect the write onto the other member', async () => {
    const until = new Date(Date.now() + 180_000).toISOString()
    await admin.snoozes.set.mutate({
      sessionId: adminSessionId,
      until,
      userId: memberId,
      onBehalfOf: memberId,
    } as { sessionId: string; until: string })
    expect(await admin.snoozes.list.query()).toEqual({ [adminSessionId]: until })
    expect(Object.keys(await member.snoozes.list.query())).not.toContain(adminSessionId)
  })

  it('tab order is per-principal, and a list containing the other person’s session is refused', async () => {
    const adminOrder = { worktree: '/w', sessionIds: [adminSessionId] }
    const memberOrder = { worktree: '/w', sessionIds: [memberSessionId] }
    expect(await admin.tabs.setOrder.mutate(adminOrder)).toEqual({ '/w': [adminSessionId] })
    expect(await member.tabs.setOrder.mutate(memberOrder)).toEqual({ '/w': [memberSessionId] })

    await admin.tabs.setOrder.mutate({ worktree: '/w', sessionIds: [adminSessionId, memberSessionId] })
    expect(await admin.tabs.listOrders.query()).toEqual({ '/w': [adminSessionId] })
    expect(await member.tabs.listOrders.query()).toEqual({ '/w': [memberSessionId] })

    await admin.tabs.setOrder.mutate({ worktree: '/w', sessionIds: [] })
    expect(await admin.tabs.listOrders.query()).toEqual({})
    expect(await member.tabs.listOrders.query()).toEqual({ '/w': [memberSessionId] })
  })

  it('sessions.list does not include the other person’s session', async () => {
    const adminList = (await admin.sessions.list.query()).map((row) => row.sessionId)
    const memberList = (await member.sessions.list.query()).map((row) => row.sessionId)
    expect(adminList).toContain(adminSessionId)
    expect(adminList).not.toContain(memberSessionId)
    expect(memberList).toContain(memberSessionId)
    expect(memberList).not.toContain(adminSessionId)
  })
})
