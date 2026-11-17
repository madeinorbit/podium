/**
 * TWO CODEX SESSIONS ON ONE CHATGPT PLAN, THREE HOURS OF TOKEN REPLACEMENTS,
 * THE SERVER'S HALF (epic Task 15, acceptance 3 and 6 with a controlled clock).
 *
 * Everything the server does is real: the store and vault, the keeper renewing
 * against a fake OpenAI, `attachAccess` issuing each session's token, credential
 * health's restart at a turn boundary, and the renewal schedule. The sessions
 * are simulated: each holds the token its last start delivered and, while a
 * turn runs, calls a fake provider with it once a minute. The provider logs
 * every call with the token's expiry, so "no request with an expired token" is
 * read off the log. The engine half (a real Codex resuming its thread) is the
 * daemon's integration test.
 */

import {
  asMachineId,
  asSessionId,
  asUserId,
  type CredentialId,
  type SessionId,
} from '@podium/model'
import { CAP_SESSION_ACCESS } from '@podium/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import type { SessionStore } from '../../../store'
import { openTestStore } from '../../../test-support/open-test-store'
import type { SessionAccess } from '../access'
import { attachAccess } from '../attach-access'
import { CredentialHealth, type SessionStanding } from '../health'
import { sealCredentialSecret } from '../vault'
import { CHATGPT_PLAN_TYPE } from './authorize'
import { FAKE_CLIENT_ID, fakeOpenAi } from './fake-openai'
import { ChatgptPlanKeeper } from './keeper'
import type { ChatgptTokenSet } from './openai'
import { PlanSessionRenewal, SESSION_TOKEN_MIN_LEFT_MS } from './session-renewal'

const OWNER = asUserId('user:plan-flow-owner')
const MACHINE = asMachineId('machine-plan-flow')
const A = asSessionId('00000000-0000-4000-8000-0000000a0015')
const B = asSessionId('00000000-0000-4000-8000-0000000b0015')
const T0 = Date.parse('2026-11-17T09:00:00Z')
const MIN = 60_000

let store: SessionStore | undefined
afterEach(async () => {
  await store?.close()
  store = undefined
})

interface SimSession {
  token: string
  expiresAt: number
  standing: SessionStanding
  starts: number
}

async function world() {
  store = await openTestStore(':memory:')
  const s = store
  let now = T0
  const openai = fakeOpenAi({ now: () => now })
  const record = await s.credentials.insert({
    ownerUserId: OWNER,
    label: 'ChatGPT',
    type: CHATGPT_PLAN_TYPE,
  })
  const first: ChatgptTokenSet = {
    seq: 1,
    clientId: FAKE_CLIENT_ID,
    accessToken: 'FAKE-access-token-original',
    refreshToken: 'FAKE-refresh-token-original',
    idToken: 'FAKE.id.token',
    expiresAt: T0 + 60 * MIN,
    scopes: ['chatgpt.tokens.use.direct'],
    savedAt: T0,
  }
  expect(await sealCredentialSecret(s, record, JSON.stringify(first), 0)).toBe(1)
  const credentialId: CredentialId = record.id

  /** Every token ever handed out, with its expiry: what the provider checks against. */
  const expiryOf = new Map<string, number>([[first.accessToken, first.expiresAt]])
  const providerLog: { session: SessionId; token: string; at: number; expired: boolean }[] = []
  const sessions = new Map<SessionId, SimSession>()
  const timers: { at: number; fn: () => void; live: boolean }[] = []

  const keeper = new ChatgptPlanKeeper({ store: s, fetch: openai.fetch, now: () => now })
  let health: CredentialHealth
  const renewal = new PlanSessionRenewal({
    now: () => now,
    setTimer: (at, fn) => {
      const timer = { at, fn, live: true }
      timers.push(timer)
      return () => {
        timer.live = false
      }
    },
    restartAtTurnBoundary: async (id) => await health.restartAtTurnBoundary(id),
  })
  const plan: SessionAccess = {
    ok: true,
    credentialId,
    delivery: { kind: 'env', variable: 'ACCESS_TOKEN' },
  }
  /** A process start for the session: what the relay binds, end to end. */
  const start = async (id: SessionId): Promise<void> => {
    const attached = await attachAccess(
      {
        store: s,
        daemonSupports: (_m, cap) => cap === CAP_SESSION_ACCESS,
        daemonLinkKind: () => 'local',
        issueToken: async (cid, to) => {
          const issued = await keeper.issue(cid, { minLeftMs: SESSION_TOKEN_MIN_LEFT_MS })
          expiryOf.set(issued.token, issued.expiresAt)
          if (to.sessionId) renewal.delivered(to.sessionId, issued.expiresAt, 'start')
          return { secret: issued.token, expiresAt: issued.expiresAt }
        },
      },
      plan,
      { machineId: MACHINE, actingUserId: OWNER, sessionId: id },
    )
    if (!attached.ok || attached.access?.delivery.kind !== 'env') {
      throw new Error(`no access for ${id}: ${JSON.stringify(attached)}`)
    }
    const token = attached.access.delivery.secret
    const previous = sessions.get(id)
    sessions.set(id, {
      token,
      expiresAt: expiryOf.get(token) ?? 0,
      standing: 'between-turns',
      starts: (previous?.starts ?? 0) + 1,
    })
  }
  health = new CredentialHealth({
    store: s,
    now: () => now,
    sessions: {
      liveSessionIds: async () => [...sessions.keys()],
      standing: async (id) => sessions.get(id)?.standing ?? 'not-running',
      restartWithResume: async (id) => {
        if (sessions.get(id)?.standing === 'in-turn') return { ok: false, reason: 'in a turn' }
        await start(id)
        return { ok: true }
      },
      stop: async () => {},
      flagRemoved: async () => {},
    },
  })
  const settle = async () => {
    for (let i = 0; i < 50; i += 1) await new Promise((resolve) => setImmediate(resolve))
  }
  /** One minute passes: due timers fire, every session in a turn calls the provider. */
  const tick = async () => {
    now += MIN
    for (const timer of timers) {
      if (timer.live && timer.at <= now) {
        timer.live = false
        timer.fn()
      }
    }
    await settle()
    for (const [id, session] of sessions) {
      if (session.standing !== 'in-turn') continue
      const expiry = expiryOf.get(session.token) ?? 0
      providerLog.push({ session: id, token: session.token, at: now, expired: expiry <= now })
    }
  }
  const beginTurn = (id: SessionId) => {
    const session = sessions.get(id)
    if (session) session.standing = 'in-turn'
  }
  const endTurn = async (id: SessionId) => {
    const session = sessions.get(id)
    if (session) session.standing = 'between-turns'
    await health.onTurnBoundary(id, credentialId)
    await settle()
  }
  return {
    start,
    tick,
    beginTurn,
    endTurn,
    sessions,
    providerLog,
    openai,
    renewal,
    now: () => now,
  }
}

describe('two sessions on one ChatGPT plan across token replacements', () => {
  it('both restart on a fresh token before theirs runs out; no call ever carries an expired token', async () => {
    const w = await world()
    await w.start(A)
    await w.start(B)
    // Both start on the signed-in token: an hour left is more than 40 minutes.
    expect(w.sessions.get(A)?.token).toBe('FAKE-access-token-original')
    expect(w.sessions.get(B)?.token).toBe('FAKE-access-token-original')
    expect(w.renewal.deadlineOf(A)).toBe(T0 + 35 * MIN)

    // Three hours: A works in short turns, B in turns of 20 minutes that
    // straddle its deadlines.
    for (let minute = 1; minute <= 180; minute += 1) {
      if (minute % 5 === 1) w.beginTurn(A)
      if (minute % 5 === 3) await w.endTurn(A)
      if (minute % 30 === 20) w.beginTurn(B)
      if (minute % 30 === 10 && minute > 10) await w.endTurn(B)
      await w.tick()
    }

    // Acceptance 3: no request with an expired token, by either session.
    expect(w.providerLog.length).toBeGreaterThan(100)
    expect(w.providerLog.filter((call) => call.expired)).toEqual([])
    // Each session was restarted for fresh tokens several times (one per
    // deadline), and is on a token from a renewal now.
    expect(w.sessions.get(A)?.starts).toBeGreaterThanOrEqual(4)
    expect(w.sessions.get(B)?.starts).toBeGreaterThanOrEqual(4)
    expect(w.sessions.get(A)?.token).toMatch(/^FAKE-access-token-\d+$/)
    expect(w.sessions.get(B)?.token).toMatch(/^FAKE-access-token-\d+$/)
    // Acceptance 6: two sessions share one plan; each replacement renewed once
    // for both (never more renewals than restarts of one session).
    const renewals = w.openai.state.tokenForms.length
    expect(renewals).toBeGreaterThanOrEqual(3)
    expect(renewals).toBeLessThanOrEqual(w.sessions.get(A)?.starts ?? 0)
    // Every token a session holds now has time left.
    for (const session of w.sessions.values()) expect(session.expiresAt).toBeGreaterThan(w.now())
  })

  it('a session mid-turn at its deadline keeps its turn and restarts at the boundary', async () => {
    const w = await world()
    await w.start(A)
    w.beginTurn(A)
    for (let minute = 1; minute <= 36; minute += 1) await w.tick()
    // Past the deadline (35 minutes): still in its turn, on its first token.
    expect(w.sessions.get(A)?.starts).toBe(1)
    expect(w.sessions.get(A)?.token).toBe('FAKE-access-token-original')
    await w.endTurn(A)
    expect(w.sessions.get(A)?.starts).toBe(2)
    expect(w.sessions.get(A)?.token).toBe('FAKE-access-token-1')
    expect(w.providerLog.filter((call) => call.expired)).toEqual([])
  })
})
