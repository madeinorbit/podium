/**
 * THE SIGN-IN CARRY-OVER: WHEN AN OLD SIGN-IN IS NO LONGER HONOURED (POD-6751;
 * docs/design/sign-in-carry-over.md, section 10.4, and tests 12 and 31).
 *
 * An old sign-in is honoured only until its own expiry, only within the 30
 * days after the upgrade, and only for a member with an active membership.
 * Whatever ends a member's device sign-ins ends their old ones too. Alice is
 * the control wherever Bob is changed.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { SESSION_COOKIE } from '@podium/protocol'
import { openDatabase } from '@podium/runtime/sqlite'
import { serverControlSocketPath } from '@podium/runtime/user-socket'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { retainedSnapshotPaths } from './migrations/backup'
import { CARRY_OVER_PERIOD_MS } from './sign-in-carry-over'
import { CARRY_OVER_ENDS_AT_KEY } from './store/sign-in-carry-over'
import { countStatements } from './test-support/statement-count'
import {
  ALICE,
  BOB,
  DAY,
  OLD_TOKENS,
  oldCookie,
  PASSWORDS,
  startUpgradedInstance,
  UPGRADE_DAY,
  type UpgradedInstance,
  useUpgradeDayClock,
} from './test-support/upgraded-customer-instance'

let f: UpgradedInstance | undefined
beforeEach(() => useUpgradeDayClock())
afterEach(async () => {
  await f?.close()
  f = undefined
  vi.useRealTimers()
})

const start = async (...args: Parameters<typeof startUpgradedInstance>) => {
  f = await startUpgradedInstance(...args)
  return f
}
/** `Date` stands still at this instant, so "one second before" means it. */
const freezeAt = (at: string | Date) => vi.useFakeTimers({ toFake: ['Date'], now: new Date(at) })
const moveClock = (ms: number) => vi.setSystemTime(new Date(Date.now() + ms))
const hashOf = (token: string) => createHash('sha256').update(token).digest('hex')
const of = (member: string, rows: string[]) => rows.filter((row) => row.endsWith(member))
const carryRecordMembers = (i: UpgradedInstance) =>
  i
    .rows<{ member_id: string }>('SELECT member_id FROM carried_sign_ins ORDER BY member_id')
    .map((row) => row.member_id)

/** A member-administration call by Alice, confirmed with her password. */
const asAlice = (i: UpgradedInstance, cookie: string, action: string, id: string) =>
  i.request(`/auth/members/${action}`, {
    method: 'POST',
    cookie,
    body: { id, current: PASSWORDS[ALICE] },
  })

describe('expiry (test 11)', () => {
  it('an expired old sign-in gets nothing; one second before its expiry it is carried, at its expiry it is not', async () => {
    const i = await start('two-members')
    const none = await i.status()

    const expired = await i.status(oldCookie(OLD_TOKENS.aliceExpired))
    expect(expired.text).toBe(none.text)
    expect(expired.setCookies).toEqual([])
    expect(await i.deviceSignIns(ALICE)).toEqual([])

    // Alice's desktop row expires on 2026-12-02T09:00:00Z.
    freezeAt('2026-12-02T08:59:59.000Z')
    const justInTime = await i.status(oldCookie(OLD_TOKENS.aliceDesktop))
    expect(justInTime.body).toMatchObject({ authed: true, memberId: ALICE })

    // Bob's browser row expires on 2026-12-05T09:00:00Z, and at that instant it is over.
    freezeAt('2026-12-05T09:00:00.000Z')
    const atExpiry = await i.status(oldCookie(OLD_TOKENS.bobBrowser))
    expect(atExpiry.body).toMatchObject({ authed: false })
    expect(atExpiry.setCookies).toEqual([])
    expect(await i.deviceSignIns(BOB)).toEqual([])
    // Nothing extended it: the row still says what the old code last wrote.
    expect(
      i.rows(
        'SELECT expires_at FROM client_sessions WHERE token_hash = ?',
        hashOf(OLD_TOKENS.bobBrowser),
      ),
    ).toEqual([{ expires_at: '2026-12-05T09:00:00.000Z' }])

    // The sweep deletes what has expired, and nothing else. What is left: the
    // host session, Bob's phone, and the fixture's two rows that expire in 2030.
    await i.handle.signInCarryOver?.sweep()
    expect(i.oldSignIns()).toEqual([
      `break-glass of ${ALICE}`,
      `login of ${ALICE}`,
      `login of ${BOB}`,
      `mobile of ${BOB}`,
    ])
  }, 120_000)
})

describe('the period (test 12)', () => {
  it('ends 30 days after the first start, even for a host session with a later expiry', async () => {
    const spare = 'fixture-old-host-token-with-an-expiry-after-the-period'
    const i = await start('two-members', {
      before: (db) =>
        db
          .prepare(
            "INSERT INTO client_sessions (token_hash, user_id, created_at, expires_at, label) VALUES (?, ?, '2026-11-02T12:00:00.000Z', '2027-01-15T00:00:00.000Z', 'break-glass')",
          )
          .run(hashOf(spare), ALICE),
    })
    const [period] = i.rows<{ value: string }>(
      'SELECT value FROM meta WHERE key = ?',
      CARRY_OVER_ENDS_AT_KEY,
    )
    const endsAt = Date.parse(period?.value ?? '')
    expect(Math.abs(endsAt - (UPGRADE_DAY.getTime() + CARRY_OVER_PERIOD_MS))).toBeLessThan(60_000)
    const none = await i.status()

    // One second before the end a host session that expires in February is still carried...
    freezeAt(new Date(endsAt - 1_000))
    expect((await i.status(oldCookie(OLD_TOKENS.aliceHost))).body).toMatchObject({
      authed: true,
      memberId: ALICE,
    })

    // ...and at the end the other one, which expires in January, gets nothing, before any sweep ran.
    freezeAt(new Date(endsAt))
    const late = await i.status(oldCookie(spare))
    expect(late.text).toBe(none.text)
    expect(late.setCookies).toEqual([])
    expect(i.oldSignIns()).toContain(`break-glass of ${ALICE}`)
    expect(await i.deviceSignIns(ALICE)).toHaveLength(1)

    // The sweep empties both tables.
    await i.handle.signInCarryOver?.sweep()
    expect(i.rows('SELECT 1 FROM client_sessions')).toEqual([])
    expect(i.rows('SELECT 1 FROM carried_sign_ins')).toEqual([])

    // From then on the status route runs no statement for an old cookie.
    const store = i.handle.registry.sessionStore
    const without = await countStatements(store, () => i.status())
    const withOld = await countStatements(store, () => i.status(oldCookie(spare)))
    expect([...withOld.byQuery].sort()).toEqual([...without.byQuery].sort())
    expect(withOld.result.text).toBe(none.text)
  }, 120_000)

  it('a start after the end empties both tables; a restart inside the period does not move its end', async () => {
    const first = await start('two-members')
    const read = (i: UpgradedInstance) =>
      i.rows<{ value: string }>('SELECT value FROM meta WHERE key = ?', CARRY_OVER_ENDS_AT_KEY)[0]
        ?.value
    const endsAt = read(first)
    const stateDir = first.stateDir
    const before = first.oldSignIns()
    await first.close({ keep: true })
    f = undefined

    moveClock(5 * DAY)
    const again = await start('two-members', { stateDir })
    expect(read(again)).toBe(endsAt)
    expect(again.oldSignIns()).toEqual(before)
    expect((await again.status(oldCookie(OLD_TOKENS.aliceBrowser))).body).toMatchObject({
      authed: true,
      memberId: ALICE,
    })
    await again.close({ keep: true })
    f = undefined

    moveClock(26 * DAY)
    const after = await start('two-members', { stateDir })
    expect(read(after)).toBe(endsAt)
    expect(after.rows('SELECT 1 FROM client_sessions')).toEqual([])
    expect(after.rows('SELECT 1 FROM carried_sign_ins')).toEqual([])
    expect((await after.status(oldCookie(OLD_TOKENS.aliceHost))).body).toMatchObject({
      authed: false,
    })
    // Alice's carried sign-in is an ordinary one and is not touched by the end of the period.
    expect(await after.deviceSignIns(ALICE)).toHaveLength(1)
  }, 180_000)
})

describe('a member who may not act (tests 13, 14, 15)', () => {
  it.each([
    'disable',
    'remove',
  ] as const)('Bob’s old sign-ins end when Alice %ss him, and enabling brings none back', async (action) => {
    const i = await start('two-members')
    const alice = await i.status(oldCookie(OLD_TOKENS.aliceBrowser))
    expect(alice.body).toMatchObject({ authed: true, memberId: ALICE })
    // Bob's phone was carried a moment ago, so a carry record of his exists too.
    const phone = await i.status(oldCookie(OLD_TOKENS.bobPhone))
    expect(phone.body).toMatchObject({ authed: true, memberId: BOB })
    const before = i.oldSignIns()
    expect(of(BOB, before)).toEqual([`api of ${BOB}`, `login of ${BOB}`, `login of ${BOB}`])
    expect(carryRecordMembers(i)).toEqual([ALICE, BOB])

    expect((await asAlice(i, alice.cookie, action, BOB)).status).toBe(200)
    expect(of(BOB, i.oldSignIns())).toEqual([])
    expect(of(ALICE, i.oldSignIns())).toEqual(of(ALICE, before))
    expect(carryRecordMembers(i)).toEqual([ALICE])

    const none = await i.status()
    for (const token of [OLD_TOKENS.bobBrowser, OLD_TOKENS.bobPhone]) {
      const refused = await i.status(oldCookie(token))
      expect(refused.text).toBe(none.text)
      expect(refused.setCookies).toEqual([])
    }
    expect((await i.status(phone.cookie)).body).toMatchObject({ authed: false })

    if (action === 'disable') {
      expect((await asAlice(i, alice.cookie, 'enable', BOB)).status).toBe(200)
      for (const token of [OLD_TOKENS.bobBrowser, OLD_TOKENS.bobPhone]) {
        expect((await i.status(oldCookie(token))).body).toMatchObject({ authed: false })
      }
      expect(of(BOB, i.oldSignIns())).toEqual([])
    }
    expect(await i.deviceSignIns(BOB)).toEqual([])

    // Alice's other old sign-in still carries.
    expect((await i.status(oldCookie(OLD_TOKENS.aliceDesktop))).body).toMatchObject({
      authed: true,
      memberId: ALICE,
    })
  }, 120_000)

  it('a member disabled without that act: the old sign-in is deleted and nothing is issued (R7)', async () => {
    const i = await start('two-members')
    // The membership is disabled behind the routes' back, so the old row is still there.
    i.write("UPDATE identity_membership SET status = 'disabled' WHERE member_id = ?", BOB)
    const before = i.oldSignIns()
    const none = await i.status()
    const refused = await i.status(oldCookie(OLD_TOKENS.bobBrowser))
    expect(refused.text).toBe(none.text)
    expect(refused.setCookies).toEqual([])
    // Exactly the presented row is gone.
    const expected = [...before]
    expected.splice(expected.indexOf(`login of ${BOB}`), 1)
    expect(i.oldSignIns()).toEqual(expected)
    expect(i.rows('SELECT 1 FROM identity_session')).toEqual([])
    expect(i.rows('SELECT 1 FROM carried_sign_ins')).toEqual([])
    expect((await i.status(oldCookie(OLD_TOKENS.aliceBrowser))).body).toMatchObject({
      authed: true,
      memberId: ALICE,
    })
  }, 120_000)

  it('an invited membership: nothing is issued and the old row is deleted', async () => {
    const dave = 'mem_upgrade_dave'
    const daveToken = 'fixture-old-token-of-dave-who-never-had-a-password'
    const i = await start('two-members', {
      // Enabled, no password, other enabled members: the upgrade makes this membership `invited`.
      before: (db) => {
        db.prepare(
          "INSERT INTO users (id, display_name, role, created_at, disabled_at) VALUES (?, 'Dave', 'member', '2026-11-02T12:00:00.000Z', NULL)",
        ).run(dave)
        db.prepare(
          "INSERT INTO client_sessions (token_hash, user_id, created_at, expires_at, label) VALUES (?, ?, '2026-11-02T12:00:00.000Z', '2026-12-01T09:00:00.000Z', 'login')",
        ).run(hashOf(daveToken), dave)
      },
    })
    expect(
      i.rows('SELECT status, account_id FROM identity_membership WHERE member_id = ?', dave),
    ).toEqual([{ status: 'invited', account_id: null }])
    expect(i.oldSignIns()).toContain(`login of ${dave}`)
    const none = await i.status()
    const refused = await i.status(oldCookie(daveToken))
    expect(refused.text).toBe(none.text)
    expect(refused.setCookies).toEqual([])
    expect(i.oldSignIns()).not.toContain(`login of ${dave}`)
    expect(i.rows('SELECT 1 FROM identity_session')).toEqual([])
    expect(i.rows('SELECT 1 FROM carried_sign_ins')).toEqual([])
    // No member row, membership or generation changed (R20).
    expect(
      i.rows('SELECT status, account_id FROM identity_membership WHERE member_id = ?', dave),
    ).toEqual([{ status: 'invited', account_id: null }])
  }, 120_000)
})

describe('whatever ends all device sign-ins of a member (test 16)', () => {
  const generations = (i: UpgradedInstance) =>
    i.rows<{ id: string }>(
      'SELECT id, authz_generation, disabled_at, role, membership_version FROM users ORDER BY id',
    )
  const memberships = (i: UpgradedInstance) =>
    i.rows('SELECT * FROM identity_membership ORDER BY member_id')

  it('sign-out-everywhere by Bob himself deletes his old sign-ins and not Alice’s', async () => {
    const i = await start('two-members')
    const bob = await i.status(oldCookie(OLD_TOKENS.bobBrowser))
    expect(bob.body).toMatchObject({ authed: true, memberId: BOB })
    const before = i.oldSignIns()
    expect(of(BOB, before)).toContain(`mobile of ${BOB}`)

    const out = await i.request('/auth/members/sign-out-everywhere', {
      method: 'POST',
      cookie: bob.cookie,
      body: {},
    })
    expect(out.status).toBe(200)
    expect(of(BOB, i.oldSignIns())).toEqual([])
    expect(of(ALICE, i.oldSignIns())).toEqual(of(ALICE, before))
    expect(carryRecordMembers(i)).toEqual([])
    for (const token of [OLD_TOKENS.bobBrowser, OLD_TOKENS.bobPhone]) {
      expect((await i.status(oldCookie(token))).body).toMatchObject({ authed: false })
    }
    expect((await i.status(oldCookie(OLD_TOKENS.aliceBrowser))).body).toMatchObject({
      authed: true,
      memberId: ALICE,
    })
  }, 120_000)

  it('sign-out-everywhere by Alice for Bob does the same', async () => {
    const i = await start('two-members')
    const alice = await i.status(oldCookie(OLD_TOKENS.aliceBrowser))
    const before = i.oldSignIns()
    const out = await i.request('/auth/members/sign-out-everywhere', {
      method: 'POST',
      cookie: alice.cookie,
      body: { id: BOB },
    })
    expect(out.status).toBe(200)
    expect(of(BOB, i.oldSignIns())).toEqual([])
    expect(of(ALICE, i.oldSignIns())).toEqual(of(ALICE, before))
    expect((await i.status(oldCookie(OLD_TOKENS.bobBrowser))).body).toMatchObject({ authed: false })
    // Alice's own sign-in and her carry record are untouched.
    expect((await i.status(alice.cookie)).body).toMatchObject({ authed: true, memberId: ALICE })
    expect(carryRecordMembers(i)).toEqual([ALICE])
  }, 120_000)

  it('redeeming a password-reset code for Bob does the same', async () => {
    const i = await start('two-members')
    const untouched = { members: generations(i), memberships: memberships(i) }
    const alice = await i.status(oldCookie(OLD_TOKENS.aliceBrowser))
    const phone = await i.status(oldCookie(OLD_TOKENS.bobPhone))
    expect(phone.body).toMatchObject({ authed: true, memberId: BOB })
    // A carry never steps a generation and never changes a member row or a membership (R20).
    expect({ members: generations(i), memberships: memberships(i) }).toEqual(untouched)
    const before = i.oldSignIns()

    const recovery = await asAlice(i, alice.cookie, 'recovery', BOB)
    expect(recovery.status).toBe(200)
    const done = await i.request('/auth/members/complete', {
      method: 'POST',
      body: { token: recovery.body.invite.token, password: 'bob has a new password now' },
    })
    expect(done.status).toBe(200)
    expect(of(BOB, i.oldSignIns())).toEqual([])
    expect(of(ALICE, i.oldSignIns())).toEqual(of(ALICE, before))
    expect(carryRecordMembers(i)).toEqual([ALICE])
    for (const cookie of [
      oldCookie(OLD_TOKENS.bobBrowser),
      oldCookie(OLD_TOKENS.bobPhone),
      phone.cookie,
    ]) {
      expect((await i.status(cookie)).body).toMatchObject({ authed: false })
    }
    // Alice is as she was.
    expect(generations(i).filter((row) => row.id === ALICE)).toEqual(
      untouched.members.filter((row) => row.id === ALICE),
    )
  }, 120_000)
})

describe('the host and sign-out (tests 17, 18)', () => {
  it('revoking host sign-ins on the control socket deletes the break-glass old sign-ins and no others', async () => {
    const spare = 'fixture-old-host-token-that-is-never-presented'
    const i = await start('two-members', {
      before: (db) =>
        db
          .prepare(
            "INSERT INTO client_sessions (token_hash, user_id, created_at, expires_at, label) VALUES (?, ?, '2026-11-02T12:00:00.000Z', '2027-01-15T00:00:00.000Z', 'break-glass')",
          )
          .run(hashOf(spare), ALICE),
    })
    const host = await i.status(oldCookie(OLD_TOKENS.aliceHost))
    expect(host.body).toMatchObject({ authed: true, memberId: ALICE })
    const browser = await i.status(oldCookie(OLD_TOKENS.bobBrowser))
    const before = i.oldSignIns()
    expect(before.filter((row) => row.startsWith('break-glass'))).toEqual([
      `break-glass of ${ALICE}`,
    ])

    const response = await fetch('http://localhost/v1/sign-ins/revoke', {
      unix: serverControlSocketPath({ instanceId: i.handle.instanceId }),
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    } as RequestInit)
    expect(await response.json()).toEqual({ ok: true, revoked: 1 })

    expect(i.oldSignIns()).toEqual(before.filter((row) => !row.startsWith('break-glass')))
    expect(carryRecordMembers(i)).toEqual([BOB])
    for (const cookie of [oldCookie(OLD_TOKENS.aliceHost), oldCookie(spare), host.cookie]) {
      expect((await i.status(cookie)).body).toMatchObject({ authed: false })
    }
    // Bob's browser sign-in is not a host sign-in.
    expect((await i.status(browser.cookie)).body).toMatchObject({ authed: true, memberId: BOB })
  }, 120_000)

  it('sign-out with only an old cookie deletes that row, clears the cookie and issues nothing', async () => {
    const i = await start('two-members')
    const before = i.oldSignIns()
    const out = await i.request('/auth/logout', {
      method: 'POST',
      cookie: oldCookie(OLD_TOKENS.aliceBrowser),
    })
    expect(out.status).toBe(200)
    expect(out.setCookies.some((value) => /^podium_session=;.*Max-Age=0/i.test(value))).toBe(true)
    expect(out.setCookies.join('\n')).not.toMatch(/session_token=[^;]/)
    const after = i.oldSignIns()
    expect(after).toHaveLength(before.length - 1)
    expect(of(BOB, after)).toEqual(of(BOB, before))
    expect(i.rows('SELECT 1 FROM identity_session')).toEqual([])
    expect((await i.status(oldCookie(OLD_TOKENS.aliceBrowser))).body).toMatchObject({
      authed: false,
    })

    // Sign-out with an old cookie that was carried a moment ago ends the repeat too.
    const carried = await i.status(oldCookie(OLD_TOKENS.aliceDesktop))
    expect(carried.body).toMatchObject({ authed: true })
    expect(carryRecordMembers(i)).toEqual([ALICE])
    await i.request('/auth/logout', {
      method: 'POST',
      cookie: `${carried.cookie}; ${oldCookie(OLD_TOKENS.aliceDesktop)}`,
    })
    expect(carryRecordMembers(i)).toEqual([])
    expect((await i.status(oldCookie(OLD_TOKENS.aliceDesktop))).body).toMatchObject({
      authed: false,
    })
    expect(await i.deviceSignIns(ALICE)).toEqual([])

    // A request with no old cookie is not told to clear one.
    const plain = await i.request('/auth/logout', { method: 'POST' })
    expect(plain.setCookies.join('\n')).not.toContain(`${SESSION_COOKIE}=`)
  }, 120_000)
})

describe('rollback (test 31)', () => {
  it('the backup the upgrade took still holds Alice’s old sign-in, which the cookie her browser kept matches', async () => {
    const i = await start('two-members')
    const carried = await i.status(oldCookie(OLD_TOKENS.aliceBrowser))
    expect(carried.body).toMatchObject({ authed: true, memberId: ALICE })
    // The server never told the browser to drop the old cookie.
    expect(carried.setCookies.join('\n')).not.toContain(`${SESSION_COOKIE}=`)
    expect(
      i.rows('SELECT 1 FROM client_sessions WHERE token_hash = ?', hashOf(OLD_TOKENS.aliceBrowser)),
    ).toEqual([])

    // Rollback restores the backup the migration took, with the older binary.
    const [backup] = retainedSnapshotPaths(i.dbPath)
    expect(backup).toBeDefined()
    expect(readFileSync(backup as string).length).toBeGreaterThan(0)
    const old = openDatabase(backup as string, { readOnly: true })
    try {
      // The older schema: no table of the new sign-in, none of the carry-over.
      const tables = (
        old.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all() as {
          name: string
        }[]
      ).map((table) => table.name)
      expect(tables).toContain('client_sessions')
      expect(tables).not.toContain('carried_sign_ins')
      expect(tables).not.toContain('identity_session')
      expect(
        old
          .prepare('SELECT user_id, label, expires_at FROM client_sessions WHERE token_hash = ?')
          .all(hashOf(OLD_TOKENS.aliceBrowser)),
      ).toEqual([{ user_id: ALICE, label: 'login', expires_at: '2026-12-01T09:00:00.000Z' }])
    } finally {
      old.close()
    }
  }, 120_000)
})
