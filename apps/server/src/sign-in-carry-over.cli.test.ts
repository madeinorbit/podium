/**
 * THE SIGN-IN CARRY-OVER AND THE `podium` COMMAND (POD-6751;
 * docs/design/sign-in-carry-over.md, section 6.1, test 29).
 *
 * The host's `podium` command cached the token of a host session minted
 * before shared sign-in. Against a real upgraded server, the command's own
 * client exchanges that cache once and goes on working.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeIssueClient } from '@podium/issue-client'
import { readCachedSessionToken, readOldFormSessionToken } from '@podium/runtime/session-token'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OLD_ENV_TOKEN_MESSAGE, operatorSessionToken } from '../../cli/src/operator-client'
import { CARRY_REPEAT_MS } from './sign-in-carry-over'
import {
  ALICE,
  OLD_TOKENS,
  oldCookie,
  startUpgradedInstance,
  type UpgradedInstance,
  useUpgradeDayClock,
} from './test-support/upgraded-customer-instance'

/** `auth.profile` names the caller by their address. */
const ALICE_EMAIL = 'alice@example.test'

let f: UpgradedInstance | undefined
beforeEach(() => useUpgradeDayClock())
afterEach(async () => {
  await f?.close()
  f = undefined
  vi.useRealTimers()
})

type ProfileClient = { auth: { profile: { query(): Promise<{ id?: string; userId?: string }> } } }

describe('the podium command with a session cached before the upgrade (test 29)', () => {
  it('the first command works and rewrites the cache; the second uses the new form; the old token then gains nothing', async () => {
    f = await startUpgradedInstance('one-person')
    const i = f
    const cache = join(i.stateDir, 'cli-session.json')
    // What `podium auth mint-session` wrote before the upgrade: no version, the bare token.
    writeFileSync(
      cache,
      `${JSON.stringify({ token: OLD_TOKENS.aliceHost, expiresAt: '2027-02-01T00:00:00.000Z' }, null, 2)}\n`,
      { mode: 0o600 },
    )
    const asked: string[] = []
    const fetchImpl = (async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      asked.push(new URL(String(input)).pathname)
      return await fetch(input, init)
    }) as typeof fetch
    /** One `podium` invocation: a client of its own, the credential found on its first call. */
    const command = () =>
      makeIssueClient(i.origin, {
        sessionToken: () => operatorSessionToken(i.origin, { env: {}, at: i.stateDir, fetchImpl }),
      }) as unknown as ProfileClient

    // Without the cache the server refuses the command: this instance requires sign-in.
    const bare = makeIssueClient(i.origin) as unknown as ProfileClient
    await expect(bare.auth.profile.query()).rejects.toThrow(/401/)

    // THE FIRST COMMAND works, as Alice, and rewrites the cache in the new form.
    const first = await command().auth.profile.query()
    expect(JSON.stringify(first)).toContain(ALICE_EMAIL)
    expect(asked).toEqual(['/auth/status'])
    const rewritten = JSON.parse(readFileSync(cache, 'utf8'))
    expect(rewritten.version).toBe(2)
    expect(rewritten.token).toContain('.')
    expect(readFileSync(cache, 'utf8')).not.toContain(OLD_TOKENS.aliceHost)
    // The host session keeps the expiry its operator chose.
    expect(
      Math.abs(Date.parse(rewritten.expiresAt) - Date.parse('2027-02-01T00:00:00.000Z')),
    ).toBeLessThan(60_000)
    expect(readOldFormSessionToken(i.stateDir)).toBeUndefined()
    expect(readCachedSessionToken(i.stateDir)).toBe(rewritten.token)
    const [device, ...others] = await i.deviceSignIns(ALICE)
    expect(others).toEqual([])
    expect(device).toMatchObject({ kind: 'host', deviceName: 'Host session' })
    expect(i.oldSignIns()).not.toContain(`break-glass of ${ALICE}`)

    // THE SECOND COMMAND uses the new form and asks the status route nothing.
    asked.length = 0
    const second = await command().auth.profile.query()
    expect(JSON.stringify(second)).toContain(ALICE_EMAIL)
    expect(asked).toEqual([])
    expect(await i.deviceSignIns(ALICE)).toHaveLength(1)

    // After ten minutes the old token is worth nothing, whoever presents it.
    vi.setSystemTime(new Date(Date.now() + CARRY_REPEAT_MS + 1_000))
    const none = await i.status()
    const late = await i.status(oldCookie(OLD_TOKENS.aliceHost))
    expect(late.text).toBe(none.text)
    expect(late.setCookies).toEqual([])
    // The command still works with its new cache.
    expect(JSON.stringify(await command().auth.profile.query())).toContain(ALICE_EMAIL)
  }, 120_000)

  it('an old token in PODIUM_SESSION_TOKEN is refused with the message that names the fix, and is not consumed', async () => {
    f = await startUpgradedInstance('one-person')
    const i = f
    const before = i.oldSignIns()
    const client = makeIssueClient(i.origin, {
      sessionToken: () =>
        operatorSessionToken(i.origin, {
          env: { PODIUM_SESSION_TOKEN: OLD_TOKENS.aliceHost },
          at: i.stateDir,
        }),
    }) as unknown as ProfileClient
    await expect(client.auth.profile.query()).rejects.toThrow(OLD_ENV_TOKEN_MESSAGE)
    expect(OLD_ENV_TOKEN_MESSAGE).toMatch(/before the upgrade/)
    expect(OLD_ENV_TOKEN_MESSAGE).toMatch(/podium auth mint-session/)
    expect(i.oldSignIns()).toEqual(before)
    expect(await i.deviceSignIns(ALICE)).toEqual([])
    // Sent as the new cookie by a client that does not know better, it is no credential either.
    const naive = makeIssueClient(i.origin, {
      sessionToken: OLD_TOKENS.aliceHost,
    }) as unknown as ProfileClient
    await expect(naive.auth.profile.query()).rejects.toThrow(/401/)
    expect(i.oldSignIns()).toEqual(before)
  }, 120_000)
})
