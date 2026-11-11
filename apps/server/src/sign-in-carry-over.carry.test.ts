/**
 * THE SIGN-IN CARRY-OVER: CARRYING, AND ONLY ONCE (POD-6751;
 * docs/design/sign-in-carry-over.md, sections 10.2 and 10.3).
 *
 * Every test starts from a customer-upgrade fixture, upgraded by the server's
 * own start, and talks to it over real HTTP with real `Cookie` headers. Alice
 * is the control wherever Bob is changed, and Bob wherever Alice is.
 */
import { CLIENT_WIRE_VERSION, SESSION_COOKIE } from '@podium/protocol'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import { CARRY_REPEAT_MS, openCarriedAnswer, sealCarriedAnswer } from './sign-in-carry-over'
import {
  ALICE,
  BOB,
  DAY,
  https,
  MINUTE,
  OLD_TOKENS,
  oldCookie,
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
const moveClock = (ms: number) => vi.setSystemTime(new Date(Date.now() + ms))

/** The outcome of opening `/client` with this cookie: 'open', or the HTTP status of the refusal. */
const openSocket = async (
  instance: UpgradedInstance,
  cookie: string,
): Promise<{ outcome: 'open' | number; ws?: WebSocket; closed: () => boolean }> => {
  const url = `ws://127.0.0.1:${instance.handle.port}/client?v=${CLIENT_WIRE_VERSION}&cap=sync.http.v1`
  return await new Promise((resolve) => {
    const ws = new WebSocket(url, { headers: { cookie } })
    let closed = false
    ws.on('close', () => {
      closed = true
    })
    ws.on('open', () => resolve({ outcome: 'open', ws, closed: () => closed }))
    ws.on('unexpected-response', (_req, res) => {
      resolve({ outcome: res.statusCode ?? 0, closed: () => true })
      ws.terminate()
    })
    ws.on('error', () => resolve({ outcome: 0, closed: () => true }))
  })
}

const until = async (pred: () => boolean, ms = 5_000): Promise<void> => {
  const deadline = performance.now() + ms
  while (!pred()) {
    if (performance.now() > deadline) throw new Error('timed out waiting for condition')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

const carryRecords = (instance: UpgradedInstance) =>
  instance.rows<{ device_sign_in_id: string; member_id: string; old_label: string }>(
    'SELECT device_sign_in_id, member_id, old_label FROM carried_sign_ins ORDER BY old_token_hash',
  )
const carryAudits = (instance: UpgradedInstance) =>
  instance.rows<{ actor_id: string; detail_json: string }>(
    "SELECT actor_id, detail_json FROM settings_audit_events WHERE command = 'members.signInCarried' ORDER BY id",
  )

describe('a browser signed in before the upgrade stays signed in (tests 1, 2, 7, 9, 24, 30)', () => {
  it('carries Alice’s browser once, on every transport, as an ordinary device sign-in', async () => {
    const i = await start('two-members')
    const before = i.oldSignIns()
    expect(before).toContain(`login of ${ALICE}`)

    // Before: the browser is not signed in to anything the new sign-in path knows.
    const none = await i.status()
    expect(none.body).toMatchObject({ authed: false, needsAuth: true })
    expect(await i.deviceSignIns(ALICE)).toEqual([])

    // TEST 1. The next HTTP request of Alice's browser.
    const old = oldCookie(OLD_TOKENS.aliceBrowser)
    const carried = await i.status(old)
    expect(carried.status).toBe(200)
    expect(carried.body).toMatchObject({ authed: true, userId: ALICE, memberId: ALICE })
    expect(carried.setCookies).toHaveLength(1)
    expect(carried.cookie).toMatch(/^podium\.session_token=/)
    expect(carried.headers.get('cache-control')).toBe('no-store')
    // The old cookie is left in the browser (section 4.5).
    expect(carried.setCookies.join('\n')).not.toContain(`${SESSION_COOKIE}=`)

    // Her old row is gone; exactly one device sign-in exists, an ordinary one.
    const after = i.oldSignIns()
    expect(after).toHaveLength(before.length - 1)
    expect(
      i.rows('SELECT 1 FROM client_sessions WHERE device_name = ?', 'Firefox on Linux'),
    ).toEqual([])
    const [device, ...others] = await i.deviceSignIns(ALICE)
    expect(others).toEqual([])
    expect(device).toMatchObject({
      kind: 'browser',
      deviceName: 'Firefox on Linux',
      platform: 'linux',
    })
    const life = (device?.expiresAt.getTime() ?? 0) - Date.now()
    expect(Math.abs(life - 30 * DAY)).toBeLessThan(MINUTE)

    // Bob is untouched: his old rows and his (absent) device sign-ins.
    expect(after.filter((row) => row.endsWith(BOB))).toEqual(
      before.filter((row) => row.endsWith(BOB)),
    )
    expect(await i.deviceSignIns(BOB)).toEqual([])

    // TEST 2 and 24. The new cookie alone is accepted on every transport.
    const fresh = carried.cookie
    // "Accepted" is the guard's answer: tRPC serves the caller; the sync and
    // file routes get past the guard (what they answer then depends on the
    // sync worker and the daemon, which this fixture does not run).
    const refusals = [400, 401, 403]
    expect((await i.request('/trpc/auth.profile', { cookie: fresh })).status).toBe(200)
    expect(refusals).not.toContain((await i.request('/sync/bootstrap', { cookie: fresh })).status)
    const asset = `/files/asset?${new URLSearchParams({ sessionId: 'session-alice-history', path: 'probe.txt' })}`
    expect(refusals).not.toContain((await i.request(asset, { cookie: fresh })).status)
    for (const path of ['/trpc/auth.profile', '/sync/bootstrap', asset]) {
      expect((await i.request(path, { cookie: old })).status).toBe(401)
    }
    expect((await openSocket(i, old)).outcome).toBe(401)
    const socket = await openSocket(i, fresh)
    expect(socket.outcome).toBe('open')
    expect((await i.status(fresh)).body).toMatchObject({ authed: true, memberId: ALICE })

    // TEST 30. One audit row: the member, the old label, the new sign-in. No token, no hash.
    const [audit, ...moreAudits] = carryAudits(i)
    expect(moreAudits).toEqual([])
    expect(audit?.actor_id).toBe(ALICE)
    expect(JSON.parse(audit?.detail_json ?? '{}')).toEqual({
      memberId: ALICE,
      label: 'login',
      deviceSignInId: device?.id,
    })
    const everyAudit = JSON.stringify(i.rows('SELECT * FROM settings_audit_events'))
    expect(everyAudit).not.toContain(OLD_TOKENS.aliceBrowser)
    expect(everyAudit).not.toContain(
      i.rows<{ old_token_hash: string }>('SELECT old_token_hash FROM carried_sign_ins')[0]
        ?.old_token_hash,
    )

    // TEST 7. The same old cookie again, within ten minutes: the same cookie, nothing created.
    moveClock(5 * MINUTE)
    const again = await i.status(old)
    expect(again.body).toMatchObject({ authed: true, memberId: ALICE })
    expect(again.setCookies).toEqual(carried.setCookies)
    expect(await i.deviceSignIns(ALICE)).toHaveLength(1)
    expect(carryRecords(i)).toEqual([
      { device_sign_in_id: device?.id, member_id: ALICE, old_label: 'login' },
    ])
    expect(carryAudits(i)).toHaveLength(1)
    expect(i.oldSignIns()).toEqual(after)

    // The device list shows it, and it is signed out there (R19).
    const list = await i.request('/auth/client-sessions', { cookie: fresh })
    expect(list.body.signIns.map((signIn: { id: string }) => signIn.id)).toEqual([device?.id])
    const revoked = await i.request('/auth/client-sessions/revoke', {
      method: 'POST',
      cookie: fresh,
      body: { id: device?.id },
    })
    expect(revoked.status).toBe(200)
    // The socket held the new sign-in: ending it closes the socket (test 24).
    await until(() => socket.closed())
    expect((await i.status(fresh)).body).toMatchObject({ authed: false })

    // TEST 9. A repeat within the ten minutes now gets nothing, and the record goes.
    const dead = await i.status(old)
    expect(dead.body).toMatchObject({ authed: false })
    expect(dead.setCookies).toEqual([])
    expect(dead.text).toBe(none.text)
    expect(carryRecords(i)).toEqual([])
    expect(await i.deviceSignIns(ALICE)).toEqual([])
  }, 120_000)
})

describe('each kind of old sign-in (test 3)', () => {
  it('desktop, phone cookie and host session become their own kinds; the host session keeps its expiry', async () => {
    const i = await start('two-members')

    const desktop = await i.status(oldCookie(OLD_TOKENS.aliceDesktop))
    expect(desktop.body).toMatchObject({ authed: true, memberId: ALICE })
    const host = await i.status(oldCookie(OLD_TOKENS.aliceHost))
    expect(host.body).toMatchObject({ authed: true, memberId: ALICE })
    const phone = await i.status(oldCookie(OLD_TOKENS.bobPhone))
    expect(phone.body).toMatchObject({ authed: true, memberId: BOB })

    const alices = await i.deviceSignIns(ALICE)
    expect(alices.map((signIn) => signIn.kind).sort()).toEqual(['desktop', 'host'])
    expect(alices.find((signIn) => signIn.kind === 'desktop')).toMatchObject({
      deviceName: 'Podium desktop on macOS',
      platform: 'macos',
    })
    const hostSignIn = alices.find((signIn) => signIn.kind === 'host')
    expect(hostSignIn).toMatchObject({ deviceName: 'Host session' })
    // Exactly the expiry its operator chose, not a fresh 30 days.
    expect(hostSignIn?.expiresAt.toISOString()).toBe('2027-02-01T00:00:00.000Z')

    const [bobs, ...moreBobs] = await i.deviceSignIns(BOB)
    expect(moreBobs).toEqual([])
    expect(bobs).toMatchObject({ kind: 'phone', deviceName: 'Bob’s phone', platform: 'ios' })
    expect(
      i.rows<{ device_id: string }>(
        'SELECT device_id FROM identity_session WHERE id = ?',
        bobs?.id,
      ),
    ).toEqual([{ device_id: 'fixture-phone-device-bob' }])
    // Bob's other old sign-in is still his to carry; Alice's browser too.
    expect(i.oldSignIns()).toEqual(expect.arrayContaining([`login of ${BOB}`, `login of ${ALICE}`]))

    // A day later a renewing sign-in is renewed where a response can carry
    // the cookie; the host session never is.
    moveClock(2 * DAY)
    const renewedDesktop = await i.request('/trpc/auth.profile', { cookie: desktop.cookie })
    expect(renewedDesktop.status).toBe(200)
    expect(renewedDesktop.setCookies).toHaveLength(1)
    const sameHost = await i.request('/trpc/auth.profile', { cookie: host.cookie })
    expect(sameHost.status).toBe(200)
    expect(sameHost.setCookies).toEqual([])
    const later = await i.deviceSignIns(ALICE)
    expect(later.find((signIn) => signIn.kind === 'host')?.expiresAt.toISOString()).toBe(
      '2027-02-01T00:00:00.000Z',
    )
    const desktopLife =
      (later.find((signIn) => signIn.kind === 'desktop')?.expiresAt.getTime() ?? 0) - Date.now()
    expect(Math.abs(desktopLife - 30 * DAY)).toBeLessThan(MINUTE)
  }, 120_000)
})

describe('one person (test 4)', () => {
  it('with a password: carried, over HTTPS from another machine', async () => {
    const i = await start('one-person')
    expect((await i.status(undefined, https)).body).toMatchObject({
      authed: false,
      needsAuth: true,
    })
    const carried = await i.status(oldCookie(OLD_TOKENS.aliceBrowser), https)
    expect(carried.body).toMatchObject({ authed: true, memberId: ALICE })
    expect(carried.cookie).toMatch(/^__Secure-podium\.session_token=/)
    expect((await i.status(carried.cookie, https)).body).toMatchObject({
      authed: true,
      memberId: ALICE,
    })
    expect((await i.deviceSignIns(ALICE)).map((signIn) => signIn.kind)).toEqual(['browser'])
  }, 120_000)

  it('without a password on the same machine: signed in before and after, and carried too', async () => {
    const i = await start('sole-operator')
    const member = i.soleMemberId()
    // The same-machine rule admits the only member without any sign-in.
    const before = await i.status()
    expect(before.body).toMatchObject({ authed: true, memberId: member, needsAuth: false })
    expect(before.setCookies).toEqual([])
    expect(await i.deviceSignIns(member)).toEqual([])

    const carried = await i.status(oldCookie(OLD_TOKENS.soleBrowser))
    expect(carried.body).toMatchObject({ authed: true, memberId: member, needsAuth: false })
    expect(carried.setCookies).toHaveLength(1)
    const [device, ...others] = await i.deviceSignIns(member)
    expect(others).toEqual([])
    expect(device?.kind).toBe('browser')
    // With the device sign-in the device list works on this machine.
    const list = await i.request('/auth/client-sessions', { cookie: carried.cookie })
    expect(list.body.signIns.map((signIn: { id: string }) => signIn.id)).toEqual([device?.id])
    // The host session is still there to be carried by the `podium` command.
    expect(i.oldSignIns()).toEqual([`break-glass of ${member}`])
  }, 120_000)
})

describe('at the same moment (test 5)', () => {
  it('twenty requests with one old cookie make one device sign-in and get the same cookie', async () => {
    const i = await start('two-members')
    const old = oldCookie(OLD_TOKENS.aliceBrowser)
    const answers = await Promise.all(Array.from({ length: 20 }, () => i.status(old)))
    expect(answers.map((answer) => answer.status)).toEqual(Array(20).fill(200))
    expect(answers.map((answer) => answer.body.memberId)).toEqual(Array(20).fill(ALICE))
    expect(new Set(answers.map((answer) => answer.cookie)).size).toBe(1)
    expect(answers[0]?.cookie).toMatch(/^podium\.session_token=/)
    expect(await i.deviceSignIns(ALICE)).toHaveLength(1)
    expect(carryRecords(i)).toHaveLength(1)
    expect(carryAudits(i)).toHaveLength(1)
    expect(i.rows('SELECT id FROM identity_session')).toHaveLength(1)
  }, 120_000)
})

describe('after the ten minutes (test 8)', () => {
  it('the old token gains nothing, and the sweep deletes the record', async () => {
    const i = await start('two-members')
    const none = await i.status()
    const old = oldCookie(OLD_TOKENS.bobBrowser)
    const carried = await i.status(old)
    expect(carried.body).toMatchObject({ authed: true, memberId: BOB })

    moveClock(CARRY_REPEAT_MS - 5_000)
    expect((await i.status(old)).setCookies).toEqual(carried.setCookies)

    moveClock(6_000)
    const late = await i.status(old)
    expect(late.status).toBe(none.status)
    expect(late.text).toBe(none.text)
    expect(late.setCookies).toEqual([])
    // The record is still stored, and unusable; the sweep removes it.
    expect(carryRecords(i)).toHaveLength(1)
    await i.handle.signInCarryOver?.sweep()
    expect(carryRecords(i)).toEqual([])
    // Bob's device sign-in is an ordinary one and lives on.
    expect((await i.status(carried.cookie)).body).toMatchObject({ authed: true, memberId: BOB })
    expect(await i.deviceSignIns(BOB)).toHaveLength(1)
  }, 120_000)
})

describe('a failure inside the carry (test 10)', () => {
  it('rolls everything back: the old row is still there and the next request carries', async () => {
    const i = await start('two-members')
    const before = i.oldSignIns()
    const { deviceSignIns } = i.handle.identity.core
    const create = deviceSignIns.create
    let faults = 0
    // The fault strikes after the library wrote the device sign-in.
    deviceSignIns.create = async (...args) => {
      await create(...args)
      faults += 1
      throw new Error('injected fault after the device sign-in was written')
    }
    const old = oldCookie(OLD_TOKENS.aliceBrowser)
    try {
      expect((await i.status(old)).status).toBe(500)
    } finally {
      deviceSignIns.create = create
    }
    expect(faults).toBe(1)
    expect(i.oldSignIns()).toEqual(before)
    expect(i.rows('SELECT id FROM identity_session')).toEqual([])
    expect(carryRecords(i)).toEqual([])
    expect(carryAudits(i)).toEqual([])

    const carried = await i.status(old)
    expect(carried.body).toMatchObject({ authed: true, memberId: ALICE })
    expect(await i.deviceSignIns(ALICE)).toHaveLength(1)
  }, 120_000)
})

describe('the sealed answer of a carry record (section 4.4)', () => {
  const token = OLD_TOKENS.aliceBrowser
  const cookies = ['podium.session_token=value.signature; Path=/; HttpOnly; SameSite=Lax']

  it('opens only with the old token, and only for the hash it was sealed under', () => {
    const sealed = sealCarriedAnswer(token, 'hash-of-token', cookies)
    expect(openCarriedAnswer(token, 'hash-of-token', sealed)).toEqual(cookies)
    expect(openCarriedAnswer(OLD_TOKENS.bobBrowser, 'hash-of-token', sealed)).toBeUndefined()
    expect(openCarriedAnswer(token, 'another-hash', sealed)).toBeUndefined()
    expect(openCarriedAnswer(token, 'hash-of-token', `${sealed.slice(0, -2)}AA`)).toBeUndefined()
    expect(openCarriedAnswer(token, 'hash-of-token', '')).toBeUndefined()
    // Nothing of the answer is readable in the stored form, and two seals differ.
    expect(Buffer.from(sealed, 'base64url').toString('latin1')).not.toContain('signature')
    expect(sealCarriedAnswer(token, 'hash-of-token', cookies)).not.toBe(sealed)
  })
})

// The upgrade day is the reference of every date above.
it('the fixture clock is the upgrade day', () => {
  expect(Math.abs(Date.now() - UPGRADE_DAY.getTime())).toBeLessThan(MINUTE)
})
