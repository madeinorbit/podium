/**
 * CREDENTIAL HEALTH AND RENEWAL (credential management §7, §8; epic Task 13).
 *
 * The handlers run over a real store and vault; the provider, the inbox and the
 * running sessions are fakes behind the health service's ports. Each describe
 * names the acceptance item it is evidence for. Every planted secret is
 * obviously fake, and each search for one first proves it can find it.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  asCredentialId,
  asMachineId,
  asSessionId,
  asUserId,
  type CredentialId,
  type CredentialTypeId,
  firstAdminMemberId,
  primeFirstAdminMember,
  type SessionId,
  type UserId,
} from '@podium/model'
import { TRPCError } from '@trpc/server'
import { afterEach, describe, expect, it } from 'vitest'
import { SessionStore } from '../../store'
import { memberFacts } from '../../store/fixtures/test-support'
import { fakeProvider } from '../../test-support/fake-provider'
import type { AccessRefusal } from './access'
import { CREDENTIAL_COMMANDS_TRPC, type CredentialsState } from './commands'
import {
  attentionNoticeKey,
  CredentialHealth,
  type CredentialNotice,
  type CredentialNoticePort,
  type CredentialSessionPort,
  classifyCredentialFailure,
  expiringNoticeKey,
  httpStatusOf,
  type SessionStanding,
  TURN_STOP_CEILING_MS,
} from './health'
import { Placements } from './placements'
import { withSecret } from './vault'

const OWNER = asUserId('user:health-owner')
const OTHER = asUserId('user:health-other')
const ADMIN_ACTOR = asUserId('user:health-admin')
const GOOD = 'FAKE-sk-ant-health-good-6900'
const BAD = 'FAKE-sk-ant-health-bad-6900'
const BUSY = 'FAKE-sk-ant-health-busy-6900'
const RENEWED = 'FAKE-sk-ant-health-renewed-6900'
const PROVIDER_REASON = 'invalid x-api-key (fake provider)'
const DAY = 86_400_000
const NOW = Date.parse('2026-11-13T12:00:00Z')

/** An inbox that keeps one open notice per key, as `emitNotice` does. */
function recordingNotices() {
  const emitted: CredentialNotice[] = []
  const open = new Set<string>()
  const resolved: string[] = []
  const port: CredentialNoticePort = {
    emit: async (notice) => {
      if (open.has(notice.dedupeKey)) return
      open.add(notice.dedupeKey)
      emitted.push(notice)
    },
    resolve: async (key) => {
      open.delete(key)
      resolved.push(key)
    },
  }
  return { port, emitted, open, resolved }
}

/** Running sessions, each mid-turn or between turns, recording what was done to them. */
function fakeSessions(on: Record<string, SessionId[]> = {}) {
  const standing = new Map<SessionId, SessionStanding>()
  const restarted: SessionId[] = []
  const stopped: SessionId[] = []
  const flagged: { sessionId: SessionId; label: string; refusal: AccessRefusal }[] = []
  /** What judging each session again answers; absent: still allowed. */
  const access = new Map<SessionId, AccessRefusal>()
  const judged: SessionId[] = []
  /** The running sessions on a credential, for a member who left (POD-7594). */
  const running: {
    sessionId: SessionId
    ownerUserId: UserId
    credentialId: CredentialId | null
  }[] = []
  const credentialOf = (id: SessionId): CredentialId =>
    (running.find((r) => r.sessionId === id)?.credentialId ??
      (Object.entries(on).find(([, ids]) => ids.includes(id))?.[0] as CredentialId | undefined) ??
      asCredentialId('cred_unknown')) as CredentialId
  const port: CredentialSessionPort = {
    liveSessionIds: async (id) => on[id] ?? [],
    runningOnCredentials: async () => running,
    standing: async (id) => standing.get(id) ?? 'not-running',
    restartWithResume: async (id) => {
      if (standing.get(id) === 'in-turn') return { ok: false, reason: 'agent is working' }
      restarted.push(id)
      return { ok: true }
    },
    stop: async (id) => {
      stopped.push(id)
      standing.set(id, 'not-running')
    },
    flagWithdrawn: async (sessionId, credential, refusal) => {
      flagged.push({ sessionId, label: credential.label, refusal })
    },
    accessOf: async (id) => {
      judged.push(id)
      const refusal = access.get(id)
      return refusal ? { ok: false, refusal, credentialId: credentialOf(id) } : { ok: true }
    },
  }
  return { port, standing, restarted, stopped, flagged, on, access, judged, running }
}

/** Timers the test fires by hand (the stop ceiling, POD-7594). */
function manualTimers() {
  const armed: { ms: number; run: () => void; cancelled: boolean }[] = []
  return {
    armed,
    schedule: (ms: number, run: () => void) => {
      const timer = { ms, run, cancelled: false }
      armed.push(timer)
      return {
        cancel: () => {
          timer.cancelled = true
        },
      }
    },
    /** Fire every live timer, then let what it started settle. */
    fire: async () => {
      for (const timer of armed.splice(0)) if (!timer.cancelled) timer.run()
      for (let i = 0; i < 10; i++) await Promise.resolve()
    },
    live: () => armed.filter((t) => !t.cancelled),
  }
}

const dirs: string[] = []
let open: SessionStore | undefined
afterEach(async () => {
  await open?.close()
  open = undefined
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

async function setup(opts: { now?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'podium-cred-health-'))
  dirs.push(dir)
  // A store-level fixture with no change log attached (POD-6920): the
  // service under test writes the credential tables directly.
  const store = await SessionStore.open(join(dir, 'podium.db'), undefined, {
    vaultKeyFile: join(dir, 'vault.key'),
    changeCapture: 'whenLogAttaches',
  })
  open = store
  primeFirstAdminMember(await firstAdminMemberId(store))
  for (const id of [OWNER, OTHER, ADMIN_ACTOR]) {
    await memberFacts(store).create(
      {
        id,
        displayName: id === OWNER ? 'Olive' : id === OTHER ? 'Otto' : 'Ada',
        role: 'member',
        createdAt: new Date().toISOString(),
        disabledAt: null,
      },
      'not-a-real-hash',
    )
  }
  let now = opts.now ?? NOW
  const provider = fakeProvider({ reject: [BAD], limit: [BUSY], reason: PROVIDER_REASON })
  const notices = recordingNotices()
  const sessions = fakeSessions()
  const timers = manualTimers()
  const health = new CredentialHealth({
    store,
    notices: notices.port,
    sessions: sessions.port,
    fetch: provider.fetch,
    now: () => now,
    schedule: timers.schedule,
  })
  const state = (callerUserId: UserId = OWNER): CredentialsState => ({
    store,
    callerUserId,
    health,
  })
  const handlers = CREDENTIAL_COMMANDS_TRPC
  const add = async (
    secret: string,
    type: CredentialTypeId = 'anthropic.api-key',
    label = 'Work key',
  ) =>
    (await handlers.add.handler(state(), { type, label, secret })) as { credentialId: CredentialId }
  const events = async (kind: string) =>
    (await store.settingsAudit.list(1000)).filter((row) => row.command === `credentials.${kind}`)
  return {
    store,
    health,
    provider,
    notices,
    sessions,
    timers,
    state,
    handlers,
    add,
    events,
    setNow: (at: number) => {
      now = at
    },
  }
}

async function refusalOf(p: Promise<unknown>): Promise<TRPCError> {
  try {
    await p
  } catch (err) {
    if (err instanceof TRPCError) return err
    throw err
  }
  throw new Error('expected a refusal')
}

describe('acceptance 1: verification on add', () => {
  it('a key the provider rejects is refused with its reason and stores nothing', async () => {
    const f = await setup()
    const refused = await refusalOf(f.add(BAD))
    expect(refused.code).toBe('BAD_REQUEST')
    expect(refused.message).toContain(PROVIDER_REASON)
    expect(refused.message).not.toContain(BAD)
    expect(f.provider.calls).toEqual(['https://api.anthropic.com/v1/models?limit=1'])
    expect(await f.store.credentials.listVisibleTo(OWNER)).toEqual([])
    expect(await f.events('add')).toEqual([])
  })

  it('a key the provider accepts is stored with verifiedAt', async () => {
    const f = await setup()
    const { credentialId } = await f.add(GOOD)
    const record = await f.store.credentials.get(credentialId)
    expect(record?.verifiedAt).toBe(new Date(NOW).toISOString())
    expect(record?.status).toBe('ok')
    expect(await withSecret(f.store, credentialId, async (s) => s)).toBe(GOOD)
  })

  it('a rate-limited answer still means the key is real: it is accepted', async () => {
    const f = await setup()
    const { credentialId } = await f.add(BUSY)
    expect((await f.store.credentials.get(credentialId))?.status).toBe('ok')
  })

  it('each key type asks its own provider once', async () => {
    const f = await setup()
    await f.add('FAKE-sk-openai-6900', 'openai.api-key', 'OpenAI')
    await f.add('FAKE-sk-or-6900', 'openrouter.api-key', 'Router')
    expect(f.provider.calls).toEqual([
      'https://api.openai.com/v1/models',
      'https://openrouter.ai/api/v1/key',
    ])
  })

  it('a Claude token is checked for its shape, expires a year after it was added, and calls no provider', async () => {
    const f = await setup()
    const refused = await refusalOf(f.add('FAKE-not-a-token', 'anthropic.claude-token', 'Token'))
    expect(refused.message).toMatch(/claude setup-token/)
    const { credentialId } = await f.add(
      'sk-ant-oat01-FAKEFAKEFAKEFAKEFAKEFAKE-6900',
      'anthropic.claude-token',
      'Token',
    )
    const record = await f.store.credentials.get(credentialId)
    expect(record?.expiresAt).toBe(new Date(NOW + 365 * DAY).toISOString())
    expect(record?.verifiedAt).toBeNull()
    expect(f.provider.calls).toEqual([])
  })

  it('renewing with a rejected key is refused and keeps the old secret', async () => {
    const f = await setup()
    const { credentialId } = await f.add(GOOD)
    const refused = await refusalOf(
      f.handlers.renew.handler(f.state(), { credentialId, secret: BAD }),
    )
    expect(refused.message).toContain(PROVIDER_REASON)
    expect(await withSecret(f.store, credentialId, async (s) => s)).toBe(GOOD)
    expect((await f.store.credentials.latestSecret(credentialId))?.version).toBe(1)
  })
})

describe('acceptance 2 and 3: rejections and limits', () => {
  it('a rejection moves it to attention with the reason and raises exactly one notice; other credentials are unaffected', async () => {
    const f = await setup()
    const { credentialId: a } = await f.add(GOOD)
    const { credentialId: b } = await f.add(RENEWED, 'anthropic.api-key', 'Other key')
    const reject = () =>
      f.health.noteFailure({
        credentialId: a,
        failure: 'rejected',
        reason: 'Authentication failed: invalid x-api-key',
        actorUserId: OTHER,
        sessionId: asSessionId('ses_health_1'),
      })
    await reject()
    const record = await f.store.credentials.get(a)
    expect(record?.status).toBe('attention')
    expect(record?.statusReason).toBe('Authentication failed: invalid x-api-key')
    expect(f.notices.emitted).toEqual([
      expect.objectContaining({
        recipientUserId: OWNER,
        kind: 'credential-attention',
        subject: { kind: 'credential', id: a },
        dedupeKey: attentionNoticeKey(a),
      }),
    ])
    await reject()
    expect(f.notices.emitted).toHaveLength(1)
    expect(await f.events('attention')).toHaveLength(1)
    expect((await f.store.credentials.get(b))?.status).toBe('ok')
  })

  it('the resolver then refuses it with needs-attention', async () => {
    const f = await setup()
    const { credentialId } = await f.add(GOOD)
    await f.health.noteFailure({ credentialId, failure: 'rejected', reason: 'rejected' })
    const { resolveInferenceAccess } = await import('./access')
    const access = await resolveInferenceAccess(f.store, { credentialId, actingUserId: OWNER })
    expect(access).toMatchObject({ ok: false, refusal: 'needs-attention' })
  })

  it('a plan or rate limit records until when and is not attention', async () => {
    const f = await setup()
    const { credentialId } = await f.add(GOOD)
    await f.health.noteFailure({ credentialId, failure: 'limit', reason: 'Usage limit reached' })
    const record = await f.store.credentials.get(credentialId)
    expect(record?.status).toBe('ok')
    expect(record?.limitReachedUntil).toBe(new Date(NOW + 60 * 60_000).toISOString())
    expect(f.notices.emitted).toEqual([])
    expect(await f.events('attention')).toEqual([])
  })

  it('classifies each signal: auth is rejected, limits and billing are limits, the rest says nothing', () => {
    expect(classifyCredentialFailure({ errorClass: 'authentication' })).toBe('rejected')
    expect(classifyCredentialFailure({ errorClass: 'authentication_error' })).toBe('rejected')
    // What Claude Code's StopFailure hook sends for a rejected token (live drive).
    expect(classifyCredentialFailure({ errorClass: 'authentication_failed' })).toBe('rejected')
    expect(classifyCredentialFailure({ errorClass: 'usage_limit' })).toBe('limit')
    expect(classifyCredentialFailure({ errorClass: 'rate_limit' })).toBe('limit')
    expect(classifyCredentialFailure({ errorClass: 'billing_error' })).toBe('limit')
    expect(classifyCredentialFailure({ errorClass: 'server_error' })).toBe('other')
    expect(classifyCredentialFailure({ turnFailure: 'auth-expired' })).toBe('rejected')
    expect(classifyCredentialFailure({ turnFailure: 'rate-limit' })).toBe('limit')
    expect(classifyCredentialFailure({ turnFailure: 'timeout' })).toBe('other')
    expect(classifyCredentialFailure({ httpStatus: 401 })).toBe('rejected')
    expect(classifyCredentialFailure({ httpStatus: 403 })).toBe('rejected')
    expect(classifyCredentialFailure({ httpStatus: 429 })).toBe('limit')
    expect(classifyCredentialFailure({ httpStatus: 500 })).toBe('other')
    expect(httpStatusOf(new Error('anthropic 401: {"error":{}}'))).toBe(401)
    expect(httpStatusOf(new Error('https://api.openai.com/v1 429: slow down'))).toBe(429)
    expect(httpStatusOf(new Error('request timed out after 30s'))).toBeUndefined()
  })
})

describe('acceptance 4: expiry', () => {
  async function tokenExpiringIn(days: number) {
    const f = await setup()
    const record = await f.store.credentials.insert({
      ownerUserId: OWNER,
      label: 'Token',
      type: 'anthropic.claude-token',
      expiresAt: new Date(NOW + days * DAY).toISOString(),
    })
    return { f, id: record.id }
  }

  it('thirteen days ahead raises one notice, also when the sweep runs again', async () => {
    const { f, id } = await tokenExpiringIn(13)
    await f.health.checkExpiry()
    await f.health.checkExpiry()
    expect(f.notices.emitted).toEqual([
      expect.objectContaining({
        recipientUserId: OWNER,
        title: 'Token expires in 13 days',
        dedupeKey: expiringNoticeKey(id),
      }),
    ])
    expect((await f.store.credentials.get(id))?.status).toBe('ok')
  })

  it('fifteen days ahead raises none', async () => {
    const { f } = await tokenExpiringIn(15)
    await f.health.checkExpiry()
    expect(f.notices.emitted).toEqual([])
  })

  it('an expired credential needs attention, with one notice', async () => {
    const { f, id } = await tokenExpiringIn(-1)
    await f.health.checkExpiry()
    await f.health.checkExpiry()
    const record = await f.store.credentials.get(id)
    expect(record?.status).toBe('attention')
    expect(record?.statusReason).toMatch(/expired/)
    expect(f.notices.emitted).toHaveLength(1)
    expect(f.notices.emitted[0]?.dedupeKey).toBe(attentionNoticeKey(id))
  })
})

describe('acceptance 5: renew', () => {
  it('keeps the id, raises the version, resolves the notice and returns the status to ok', async () => {
    const f = await setup()
    const { credentialId } = await f.add(GOOD)
    await f.health.noteFailure({ credentialId, failure: 'rejected', reason: 'rejected' })
    await f.health.noteFailure({ credentialId, failure: 'limit', reason: 'limit' })
    await f.handlers.renew.handler(f.state(), { credentialId, secret: RENEWED })
    const record = await f.store.credentials.get(credentialId)
    expect(record?.id).toBe(credentialId)
    expect(record?.status).toBe('ok')
    expect(record?.statusReason).toBeNull()
    expect(record?.limitReachedUntil).toBeNull()
    expect((await f.store.credentials.latestSecret(credentialId))?.version).toBe(2)
    expect(await withSecret(f.store, credentialId, async (s) => s)).toBe(RENEWED)
    expect(f.notices.resolved).toContain(attentionNoticeKey(credentialId))
    expect(f.notices.open.has(attentionNoticeKey(credentialId))).toBe(false)
  })

  it('two sessions on the old secret restart with resume at their turn boundary; a turn in progress is not interrupted', async () => {
    const f = await setup()
    const { credentialId } = await f.add(GOOD)
    const idle = asSessionId('ses_renew_idle')
    const busy = asSessionId('ses_renew_busy')
    f.sessions.on[credentialId] = [idle, busy]
    f.sessions.standing.set(idle, 'between-turns')
    f.sessions.standing.set(busy, 'in-turn')
    await f.handlers.renew.handler(f.state(), { credentialId, secret: RENEWED })
    // Between turns: restarted now. Mid-turn: left alone, waiting.
    expect(f.sessions.restarted).toEqual([idle])
    expect(f.health.waitingFor(busy)).toBe('restart')
    // Its turn ends: now it restarts, once.
    f.sessions.standing.set(busy, 'between-turns')
    await f.health.onTurnBoundary(busy, credentialId)
    await f.health.onTurnBoundary(busy, credentialId)
    expect(f.sessions.restarted).toEqual([idle, busy])
    expect(f.health.waitingFor(busy)).toBeUndefined()
  })

  it('a session whose next turn began before the restart keeps waiting for that turn to end', async () => {
    const f = await setup()
    const { credentialId } = await f.add(GOOD)
    const racing = asSessionId('ses_renew_racing')
    f.sessions.on[credentialId] = [racing]
    f.sessions.standing.set(racing, 'in-turn')
    await f.handlers.renew.handler(f.state(), { credentialId, secret: RENEWED })
    // The boundary arrives, but a new turn opened before the restart could run.
    await f.health.onTurnBoundary(racing, credentialId)
    expect(f.sessions.restarted).toEqual([])
    expect(f.health.waitingFor(racing)).toBe('restart')
  })
})

describe('restartAtTurnBoundary: one session, before its token runs out (epic Task 15)', () => {
  it('between turns: restarts now, once', async () => {
    const f = await setup()
    const idle = asSessionId('ses_plan_idle')
    f.sessions.standing.set(idle, 'between-turns')
    await f.health.restartAtTurnBoundary(idle)
    expect(f.sessions.restarted).toEqual([idle])
    expect(f.health.waitingFor(idle)).toBeUndefined()
  })

  it('in a turn: waits for the boundary, then restarts once', async () => {
    const f = await setup()
    const busy = asSessionId('ses_plan_busy')
    f.sessions.standing.set(busy, 'in-turn')
    await f.health.restartAtTurnBoundary(busy)
    expect(f.sessions.restarted).toEqual([])
    expect(f.health.waitingFor(busy)).toBe('restart')
    f.sessions.standing.set(busy, 'between-turns')
    await f.health.onTurnBoundary(busy, null)
    await f.health.onTurnBoundary(busy, null)
    expect(f.sessions.restarted).toEqual([busy])
  })

  it('a stop already waiting wins', async () => {
    const f = await setup()
    const { credentialId } = await f.add(GOOD)
    const busy = asSessionId('ses_plan_removed')
    f.sessions.standing.set(busy, 'in-turn')
    // A machine withdrawn: the stop waits for the turn boundary (POD-7591).
    await f.health.accessWithdrawn(busy, credentialId, 'machine-not-allowed')
    await f.health.restartAtTurnBoundary(busy)
    expect(f.health.waitingFor(busy)).toBe('stop')
  })

  it('a session that is not running is left for its next revival', async () => {
    const f = await setup()
    const parked = asSessionId('ses_plan_parked')
    f.sessions.standing.set(parked, 'not-running')
    await f.health.restartAtTurnBoundary(parked)
    expect(f.sessions.restarted).toEqual([])
    expect(f.health.waitingFor(parked)).toBeUndefined()
  })
})

describe('acceptance 6: removal with running sessions (review focus 2)', () => {
  // POD-7591 (coordinator decision): removal cuts the running turn; before, the
  // stop waited for the turn boundary.
  it('both sessions are flagged and stop at once, a running turn cut; nothing crashes', async () => {
    const f = await setup()
    const { credentialId } = await f.add(GOOD)
    const idle = asSessionId('ses_remove_idle')
    const busy = asSessionId('ses_remove_busy')
    f.sessions.on[credentialId] = [idle, busy]
    f.sessions.standing.set(idle, 'between-turns')
    f.sessions.standing.set(busy, 'in-turn')
    await f.handlers.remove.handler(f.state(), { credentialId })
    expect(f.sessions.flagged).toEqual([
      { sessionId: idle, label: 'Work key', refusal: 'revoked' },
      { sessionId: busy, label: 'Work key', refusal: 'revoked' },
    ])
    expect(f.sessions.stopped).toEqual([idle, busy])
    expect(f.health.waitingFor(busy)).toBeUndefined()
    expect(f.health.holdsInput(busy, credentialId)).toBe(false)
    expect((await f.store.credentials.get(credentialId))?.status).toBe('revoked')
    expect(await f.store.credentials.latestSecret(credentialId)).toBeNull()
  })

  it('a session on a removed credential stops at its turn boundary even when no intent survived (a server restart)', async () => {
    const f = await setup()
    const { credentialId } = await f.add(GOOD)
    await f.handlers.remove.handler(f.state(), { credentialId })
    const survivor = asSessionId('ses_remove_survivor')
    f.sessions.standing.set(survivor, 'between-turns')
    await f.health.onTurnBoundary(survivor, credentialId)
    expect(f.sessions.stopped).toEqual([survivor])
    // A session on a live credential is left alone.
    const { credentialId: live } = await f.add(RENEWED, 'anthropic.api-key', 'Live key')
    const other = asSessionId('ses_remove_other')
    f.sessions.standing.set(other, 'between-turns')
    await f.health.onTurnBoundary(other, live)
    expect(f.sessions.stopped).toEqual([survivor])
  })

  it('the next revival is refused with revoked', async () => {
    const f = await setup()
    const { credentialId } = await f.add(GOOD)
    const machineId = asMachineId('machine:health-desk')
    await f.store.machines.upsertMachine({
      id: machineId,
      name: 'desk',
      hostname: 'desk.local',
      tokenHash: 'hash-desk',
      ownerUserId: OWNER,
    })
    await f.handlers.remove.handler(f.state(), { credentialId })
    const { resolveSessionAccess } = await import('./access')
    const access = await resolveSessionAccess(f.store, {
      harness: 'claude-code',
      credentialId,
      actingUserId: OWNER,
      machineId,
      sessionId: asSessionId('ses_remove_revive'),
    })
    expect(access).toMatchObject({ ok: false, refusal: 'revoked' })
  })
})

describe('acceptance 7: a placement on an offline machine', () => {
  it('stays removal-pending, visibly, and becomes removed when the machine reconnects', async () => {
    const f = await setup()
    const { credentialId } = await f.add(GOOD)
    const machineId = asMachineId('machine:health-laptop')
    const placement = { credentialId, machineId, kind: 'propagated-file' as const }
    await f.store.credentials.recordPlacement(placement)
    let online = false
    const removed: string[] = []
    const placements = new Placements({
      store: f.store,
      transport: {
        isOnline: () => online,
        removers: {
          'propagated-file': async (machine, credential) => {
            removed.push(`${machine}:${credential.id}`)
            return true
          },
        },
      },
    })
    f.health.placements = placements
    await f.handlers.remove.handler(f.state(), { credentialId })
    expect((await f.store.credentials.listPlacements(credentialId))[0]?.state).toBe(
      'removal-pending',
    )
    // Visibly: the owner's list still shows it, removed, with the pending machine.
    const { listCredentials } = await import('./queries')
    expect(await listCredentials(f.store, OWNER)).toEqual([
      expect.objectContaining({
        id: credentialId,
        status: 'revoked',
        homes: [{ machineId, homeId: 'default', state: 'removal-pending' }],
      }),
    ])
    expect(removed).toEqual([])
    online = true
    await placements.retryPendingOn(machineId)
    expect(removed).toEqual([`${machineId}:${credentialId}`])
    const after = (await f.store.credentials.listPlacements(credentialId))[0]
    expect(after?.state).toBe('removed')
    expect(after?.removedAt).not.toBeNull()
    expect(await listCredentials(f.store, OWNER)).toEqual([])
  })

  it('a machine that does not confirm keeps it pending', async () => {
    const f = await setup()
    const credentialId = asCredentialId('cred_00000000-0000-4000-8000-000000006900')
    await f.store.credentials.insert({
      id: credentialId,
      ownerUserId: OWNER,
      label: 'x',
      type: 'anthropic.claude-login',
    })
    const machineId = asMachineId('machine:health-flaky')
    const placement = { credentialId, machineId, kind: 'propagated-file' as const }
    await f.store.credentials.recordPlacement(placement)
    const placements = new Placements({
      store: f.store,
      transport: {
        isOnline: () => true,
        removers: {
          'propagated-file': async () => {
            throw new Error('daemon said no')
          },
        },
      },
    })
    expect(await placements.removePlacement(placement)).toBe('pending')
    expect(await f.store.credentials.listPendingPlacementsOn(machineId)).toHaveLength(1)
  })
})

// POD-7591: a running session whose right to its credential is withdrawn stops
// at its next turn boundary, as on removal, and takes no input meanwhile.
describe('a withdrawn credential stops the sessions that run on it', () => {
  it('unshare re-judges each running session; a refused one is flagged and stopped at once', async () => {
    const f = await setup()
    const { credentialId } = await f.add(GOOD)
    await f.handlers.share.handler(f.state(), {
      credentialId,
      grantee: { userId: OTHER },
      verb: 'use',
      acknowledgeDisclosure: true,
    })
    const idle = asSessionId('ses_withdraw_idle')
    const busy = asSessionId('ses_withdraw_busy')
    const owners = asSessionId('ses_withdraw_owner')
    const parked = asSessionId('ses_withdraw_parked')
    f.sessions.on[credentialId] = [idle, busy, owners, parked]
    f.sessions.standing.set(idle, 'between-turns')
    f.sessions.standing.set(busy, 'in-turn')
    f.sessions.standing.set(owners, 'between-turns')
    f.sessions.access.set(idle, 'not-yours')
    f.sessions.access.set(busy, 'not-yours')
    f.sessions.access.set(parked, 'not-yours')
    await f.handlers.unshare.handler(f.state(), {
      credentialId,
      grantee: { userId: OTHER },
      verb: 'use',
    })
    // A parked session holds no secret: it is not judged, its revival is.
    expect(f.sessions.judged).toEqual([idle, busy, owners])
    expect(f.sessions.flagged).toEqual([
      { sessionId: idle, label: 'Work key', refusal: 'not-yours' },
      { sessionId: busy, label: 'Work key', refusal: 'not-yours' },
    ])
    // The grant was taken back: the running turn is cut too.
    expect(f.sessions.stopped).toEqual([idle, busy])
    expect(f.health.holdsInput(idle, credentialId)).toBe(false)
    expect(f.health.holdsInput(busy, credentialId)).toBe(false)
    expect(f.health.holdsInput(owners, credentialId)).toBe(false)
  })

  it('disallowing a machine stops a session there at its turn boundary, its input held meanwhile', async () => {
    const f = await setup()
    const { credentialId } = await f.add(GOOD)
    const machineId = asMachineId('machine:withdraw-desk')
    const idle = asSessionId('ses_withdraw_there_idle')
    const busy = asSessionId('ses_withdraw_there_busy')
    f.sessions.on[credentialId] = [idle, busy]
    f.sessions.standing.set(idle, 'between-turns')
    f.sessions.standing.set(busy, 'in-turn')
    f.sessions.access.set(idle, 'machine-not-allowed')
    f.sessions.access.set(busy, 'machine-not-allowed')
    await f.handlers.disallowMachine.handler(f.state(), { credentialId, machineId })
    expect(f.sessions.flagged).toEqual([
      { sessionId: idle, label: 'Work key', refusal: 'machine-not-allowed' },
      { sessionId: busy, label: 'Work key', refusal: 'machine-not-allowed' },
    ])
    expect(f.sessions.stopped).toEqual([idle])
    // The running turn finishes; no input reaches the session until it stops.
    expect(f.health.holdsInput(busy, credentialId)).toBe(true)
    expect(f.health.waitingFor(busy)).toBe('stop')
    f.sessions.standing.set(busy, 'between-turns')
    await f.health.onTurnBoundary(busy, credentialId)
    expect(f.sessions.stopped).toEqual([idle, busy])
    expect(f.health.holdsInput(busy, credentialId)).toBe(false)
  })

  it('a refused refresh stops only on a withdrawal; a delivery condition leaves the process', async () => {
    const f = await setup()
    const { credentialId } = await f.add(GOOD)
    const withdrawn = asSessionId('ses_refresh_withdrawn')
    const offline = asSessionId('ses_refresh_offline')
    const attention = asSessionId('ses_refresh_attention')
    const placed = asSessionId('ses_refresh_placed')
    // Review F4: read from the machine's reported logins, so a delivery condition.
    const notSignedIn = asSessionId('ses_refresh_not_signed_in')
    for (const id of [withdrawn, placed, offline, attention, notSignedIn]) {
      f.sessions.standing.set(id, 'in-turn')
    }
    await f.health.accessWithdrawn(withdrawn, credentialId, 'revoked')
    await f.health.accessWithdrawn(placed, credentialId, 'machine-not-allowed')
    await f.health.accessWithdrawn(offline, credentialId, 'machine-offline')
    await f.health.accessWithdrawn(attention, credentialId, 'needs-attention')
    await f.health.accessWithdrawn(notSignedIn, credentialId, 'not-on-this-machine')
    expect(f.sessions.flagged).toEqual([
      { sessionId: withdrawn, label: 'Work key', refusal: 'revoked' },
      { sessionId: placed, label: 'Work key', refusal: 'machine-not-allowed' },
    ])
    expect(f.health.holdsInput(notSignedIn, credentialId)).toBe(false)
    // Removed: stopped at once. A placement refusal waits for the turn's end.
    expect(f.sessions.stopped).toEqual([withdrawn])
    expect(f.health.waitingFor(placed)).toBe('stop')
    expect(f.health.holdsInput(placed, credentialId)).toBe(true)
    expect(f.health.waitingFor(offline)).toBeUndefined()
    expect(f.health.holdsInput(attention, credentialId)).toBe(false)
  })

  it('a stop that fails keeps the input held and is tried again at the next turn boundary', async () => {
    const f = await setup()
    const { credentialId } = await f.add(GOOD)
    const stuck = asSessionId('ses_withdraw_stuck')
    f.sessions.standing.set(stuck, 'between-turns')
    const stop = f.sessions.port.stop
    f.sessions.port.stop = async () => {
      throw new Error('daemon did not answer')
    }
    await f.health.accessWithdrawn(stuck, credentialId, 'not-yours')
    expect(f.sessions.stopped).toEqual([])
    expect(f.health.holdsInput(stuck, credentialId)).toBe(true)
    expect(f.health.waitingFor(stuck)).toBe('stop')
    f.sessions.port.stop = stop
    await f.health.onTurnBoundary(stuck, credentialId)
    expect(f.sessions.stopped).toEqual([stuck])
    expect(f.health.holdsInput(stuck, credentialId)).toBe(false)
  })

  // Review F1: the stop parked the row and queued the kill, but the daemon did
  // not confirm it. No turn boundary will come; nothing may wait for one.
  it('a stop whose kill is not confirmed but parked the row leaves no hold and no stop behind', async () => {
    const f = await setup()
    const { credentialId } = await f.add(GOOD)
    const { credentialId: other } = await f.add(RENEWED, 'anthropic.api-key', 'Other key')
    const parked = asSessionId('ses_withdraw_unconfirmed')
    f.sessions.standing.set(parked, 'between-turns')
    f.sessions.port.stop = async () => {
      f.sessions.standing.set(parked, 'not-running')
      throw new Error('process retirement was not confirmed')
    }
    await f.health.accessWithdrawn(parked, credentialId, 'not-yours')
    expect(f.health.holdsInput(parked, credentialId)).toBe(false)
    expect(f.health.waitingFor(parked)).toBeUndefined()
    // Switched to another key and woken: its first turn boundary stops nothing.
    f.sessions.standing.set(parked, 'between-turns')
    const before = f.sessions.flagged.length
    await f.health.onTurnBoundary(parked, other)
    expect(f.sessions.flagged).toHaveLength(before)
    expect(f.health.holdsInput(parked, other)).toBe(false)
  })

  it('a stop waiting for one credential is dropped when the session moved to another', async () => {
    const f = await setup()
    const { credentialId } = await f.add(GOOD)
    const { credentialId: other } = await f.add(RENEWED, 'anthropic.api-key', 'Other key')
    const moved = asSessionId('ses_withdraw_moved')
    f.sessions.standing.set(moved, 'in-turn')
    await f.health.accessWithdrawn(moved, credentialId, 'machine-not-allowed')
    expect(f.health.holdsInput(moved, credentialId)).toBe(true)
    // The hold is the withdrawn credential's, never the session's next one.
    expect(f.health.holdsInput(moved, other)).toBe(false)
    f.sessions.standing.set(moved, 'between-turns')
    await f.health.onTurnBoundary(moved, other)
    expect(f.sessions.stopped).toEqual([])
    expect(f.health.waitingFor(moved)).toBeUndefined()
    expect(f.health.holdsInput(moved, credentialId)).toBe(false)
  })

  // Review F3: the hold exists before anything awaits, and from the probe on.
  it('holds input from the probe refusal, and releases it when the refusal is dropped', async () => {
    const f = await setup()
    const { credentialId } = await f.add(GOOD)
    const probed = asSessionId('ses_withdraw_probed')
    f.health.holdFor(probed, credentialId, 'machine-not-allowed')
    expect(f.health.holdsInput(probed, credentialId)).toBe(true)
    f.health.releaseHold(probed, credentialId)
    expect(f.health.holdsInput(probed, credentialId)).toBe(false)
    // A delivery condition is never held.
    f.health.holdFor(probed, credentialId, 'machine-offline')
    expect(f.health.holdsInput(probed, credentialId)).toBe(false)
    // A release does not lift a hold whose stop now waits.
    f.sessions.standing.set(probed, 'in-turn')
    let heldDuringFlag = false
    f.sessions.port.flagWithdrawn = async () => {
      heldDuringFlag = f.health.holdsInput(probed, credentialId)
    }
    await f.health.accessWithdrawn(probed, credentialId, 'machine-not-allowed')
    expect(heldDuringFlag).toBe(true)
    f.health.releaseHold(probed, credentialId)
    expect(f.health.holdsInput(probed, credentialId)).toBe(true)
  })

  // Review F8: one flag per session and credential, none for a parked session.
  it('flags once while a stop waits, and never flags a parked session', async () => {
    const f = await setup()
    const { credentialId } = await f.add(GOOD)
    const busy = asSessionId('ses_withdraw_flag_busy')
    const parked = asSessionId('ses_withdraw_flag_parked')
    f.sessions.standing.set(busy, 'in-turn')
    f.sessions.standing.set(parked, 'not-running')
    await f.health.accessWithdrawn(busy, credentialId, 'machine-not-allowed')
    await f.health.accessWithdrawn(busy, credentialId, 'machine-not-allowed')
    await f.health.accessWithdrawn(parked, credentialId, 'revoked')
    expect(f.sessions.flagged).toEqual([
      { sessionId: busy, label: 'Work key', refusal: 'machine-not-allowed' },
    ])
    expect(f.health.holdsInput(parked, credentialId)).toBe(false)
  })
})

// POD-7594, review F9 and the final review's nits: a stop that waits for a turn
// boundary has a worst case, and a judgement holds input from its first await.
describe('a stop waiting for a turn boundary has a ceiling', () => {
  it('a turn that never ends is cut after the ceiling', async () => {
    const f = await setup()
    const { credentialId } = await f.add(GOOD)
    const hung = asSessionId('ses_ceiling_hung')
    f.sessions.standing.set(hung, 'in-turn')
    await f.health.accessWithdrawn(hung, credentialId, 'machine-not-allowed')
    expect(f.sessions.stopped).toEqual([])
    expect(f.timers.live().map((t) => t.ms)).toEqual([TURN_STOP_CEILING_MS])
    // Still in its turn when the ceiling comes: the turn is cut.
    await f.timers.fire()
    expect(f.sessions.stopped).toEqual([hung])
    expect(f.health.waitingFor(hung)).toBeUndefined()
    expect(f.health.holdsInput(hung, credentialId)).toBe(false)
  })

  it('a stop that ran at the turn boundary cancels its ceiling', async () => {
    const f = await setup()
    const { credentialId } = await f.add(GOOD)
    const busy = asSessionId('ses_ceiling_boundary')
    f.sessions.standing.set(busy, 'in-turn')
    await f.health.accessWithdrawn(busy, credentialId, 'machine-not-allowed')
    f.sessions.standing.set(busy, 'between-turns')
    await f.health.onTurnBoundary(busy, credentialId)
    expect(f.sessions.stopped).toEqual([busy])
    expect(f.timers.live()).toEqual([])
    await f.timers.fire()
    expect(f.sessions.stopped).toEqual([busy])
  })

  it('a stop at once that fails in a turn that never ends is tried again after the ceiling', async () => {
    const f = await setup()
    const { credentialId } = await f.add(GOOD)
    const stuck = asSessionId('ses_ceiling_retry')
    f.sessions.standing.set(stuck, 'in-turn')
    const stop = f.sessions.port.stop
    f.sessions.port.stop = async () => {
      throw new Error('daemon did not answer')
    }
    await f.health.accessWithdrawn(stuck, credentialId, 'not-yours')
    expect(f.health.holdsInput(stuck, credentialId)).toBe(true)
    expect(f.timers.live()).toHaveLength(1)
    f.sessions.port.stop = stop
    await f.timers.fire()
    expect(f.sessions.stopped).toEqual([stuck])
    expect(f.health.holdsInput(stuck, credentialId)).toBe(false)
  })

  it('a ceiling left from a stop that was dropped stops nothing', async () => {
    const f = await setup()
    const { credentialId } = await f.add(GOOD)
    const { credentialId: other } = await f.add(RENEWED, 'anthropic.api-key', 'Other key')
    const moved = asSessionId('ses_ceiling_moved')
    f.sessions.standing.set(moved, 'in-turn')
    await f.health.accessWithdrawn(moved, credentialId, 'machine-not-allowed')
    // Switched to another credential: its stop and its ceiling go.
    await f.health.onTurnBoundary(moved, other)
    expect(f.timers.live()).toEqual([])
    await f.timers.fire()
    expect(f.sessions.stopped).toEqual([])
  })
})

describe('the judgement of a running session (POD-7591 final review nits)', () => {
  it('a credential read that fails still flags and stops the session (N-a)', async () => {
    const f = await setup()
    const { credentialId } = await f.add(GOOD)
    const idle = asSessionId('ses_label_read_fails')
    f.sessions.standing.set(idle, 'between-turns')
    const get = f.store.credentials.get.bind(f.store.credentials)
    f.store.credentials.get = async () => {
      throw new Error('store unavailable')
    }
    try {
      await f.health.accessWithdrawn(idle, credentialId, 'not-yours')
    } finally {
      f.store.credentials.get = get
    }
    expect(f.sessions.flagged).toEqual([
      { sessionId: idle, label: 'its credential', refusal: 'not-yours' },
    ])
    expect(f.sessions.stopped).toEqual([idle])
    expect(f.health.holdsInput(idle, credentialId)).toBe(false)
  })

  it('afterWithdraw holds the session from before its first await, and releases a passed one (N-b)', async () => {
    const f = await setup()
    const { credentialId } = await f.add(GOOD)
    const passes = asSessionId('ses_judged_passes')
    const refused = asSessionId('ses_judged_refused')
    const probed = asSessionId('ses_judged_probed')
    f.sessions.on[credentialId] = [passes, refused, probed]
    for (const id of [passes, refused, probed]) f.sessions.standing.set(id, 'in-turn')
    f.sessions.access.set(refused, 'machine-not-allowed')
    // A hold someone else set (a reattach probe's refusal) is not lifted here.
    f.health.holdFor(probed, credentialId, 'machine-not-allowed')
    const heldWhileJudged = new Map<SessionId, boolean>()
    const standing = f.sessions.port.standing
    f.sessions.port.standing = async (id) => {
      if (!heldWhileJudged.has(id)) heldWhileJudged.set(id, f.health.holdsInput(id, credentialId))
      return await standing(id)
    }
    await f.health.afterWithdraw({ id: credentialId, label: 'Work key' })
    expect(heldWhileJudged).toEqual(
      new Map([
        [passes, true],
        [refused, true],
        [probed, true],
      ]),
    )
    expect(f.health.holdsInput(passes, credentialId)).toBe(false)
    expect(f.health.holdsInput(refused, credentialId)).toBe(true)
    expect(f.health.waitingFor(refused)).toBe('stop')
    expect(f.health.holdsInput(probed, credentialId)).toBe(true)
  })

  it('a judgement that throws releases its own hold (fail-open, as before)', async () => {
    const f = await setup()
    const { credentialId } = await f.add(GOOD)
    const broken = asSessionId('ses_judged_throws')
    f.sessions.on[credentialId] = [broken]
    f.sessions.standing.set(broken, 'between-turns')
    f.sessions.port.accessOf = async () => {
      throw new Error('resolver failed')
    }
    await f.health.afterWithdraw({ id: credentialId, label: 'Work key' })
    expect(f.health.holdsInput(broken, credentialId)).toBe(false)
    expect(f.sessions.stopped).toEqual([])
  })
})

// POD-7594, review F2: removing or disabling a member judges again every
// running session whose right to its credential could hang on them.
describe('a member removed or disabled', () => {
  it('stops their sessions on a key shared with them at once, and judges only the sessions that may hang on them', async () => {
    const f = await setup()
    const { credentialId: shared } = await f.add(GOOD)
    const { credentialId: othersOwn } = await f.add(RENEWED, 'anthropic.api-key', 'Own key')
    const onShared = asSessionId('ses_left_on_shared')
    const busyOnShared = asSessionId('ses_left_busy_on_shared')
    const parked = asSessionId('ses_left_parked')
    const legacy = asSessionId('ses_left_legacy')
    const ownersOwn = asSessionId('ses_left_owner_on_own')
    const adminsShared = asSessionId('ses_left_admin_on_shared')
    const unrelatedOwn = asSessionId('ses_left_unrelated_own')
    f.sessions.running.push(
      { sessionId: onShared, ownerUserId: OTHER, credentialId: shared },
      { sessionId: busyOnShared, ownerUserId: OTHER, credentialId: shared },
      { sessionId: parked, ownerUserId: OTHER, credentialId: shared },
      // An old account id only the resolver reads: still the member's own.
      { sessionId: legacy, ownerUserId: OTHER, credentialId: null },
      // The owner's session on the owner's key does not hang on Otto.
      { sessionId: ownersOwn, ownerUserId: OWNER, credentialId: shared },
      // Another member on a key someone else made: Otto may have given the grant.
      { sessionId: adminsShared, ownerUserId: ADMIN_ACTOR, credentialId: shared },
      { sessionId: unrelatedOwn, ownerUserId: OWNER, credentialId: othersOwn },
    )
    f.sessions.standing.set(onShared, 'between-turns')
    f.sessions.standing.set(busyOnShared, 'in-turn')
    f.sessions.standing.set(legacy, 'between-turns')
    f.sessions.standing.set(ownersOwn, 'between-turns')
    f.sessions.standing.set(adminsShared, 'in-turn')
    f.sessions.standing.set(unrelatedOwn, 'between-turns')
    for (const id of [onShared, busyOnShared, parked]) f.sessions.access.set(id, 'not-yours')
    await f.health.afterMemberLeft(OTHER, 'removed')
    // A parked session holds no secret: its revival is judged.
    expect(f.sessions.judged).toEqual([onShared, busyOnShared, legacy, adminsShared])
    expect(f.sessions.flagged).toEqual([
      { sessionId: onShared, label: 'Work key', refusal: 'not-yours' },
      { sessionId: busyOnShared, label: 'Work key', refusal: 'not-yours' },
    ])
    // Taken back: the running turn is cut too.
    expect(f.sessions.stopped).toEqual([onShared, busyOnShared])
    expect(f.health.holdsInput(adminsShared, shared)).toBe(false)
  })

  it("stops another member's session on the leaving member's own key", async () => {
    const f = await setup()
    // Olive made this key and leaves; Otto runs a session on it.
    const { credentialId: olives } = await f.add(GOOD)
    const onLeaversKey = asSessionId('ses_left_on_members_key')
    f.sessions.running.push({ sessionId: onLeaversKey, ownerUserId: OTHER, credentialId: olives })
    f.sessions.standing.set(onLeaversKey, 'between-turns')
    f.sessions.access.set(onLeaversKey, 'not-yours')
    await f.health.afterMemberLeft(OWNER, 'removed')
    expect(f.sessions.judged).toEqual([onLeaversKey])
    expect(f.sessions.stopped).toEqual([onLeaversKey])
  })

  it('a disable lets the running turn finish, its input held, then stops it (let-finish)', async () => {
    const f = await setup()
    const { credentialId: shared } = await f.add(GOOD)
    const idle = asSessionId('ses_disabled_idle')
    const busy = asSessionId('ses_disabled_busy')
    f.sessions.running.push(
      { sessionId: idle, ownerUserId: OTHER, credentialId: shared },
      { sessionId: busy, ownerUserId: OTHER, credentialId: shared },
    )
    f.sessions.standing.set(idle, 'between-turns')
    f.sessions.standing.set(busy, 'in-turn')
    for (const id of [idle, busy]) f.sessions.access.set(id, 'not-yours')
    await f.health.afterMemberLeft(OTHER, 'disabled')
    // Between turns: nothing to finish. In a turn: it finishes, taking no input.
    expect(f.sessions.stopped).toEqual([idle])
    expect(f.health.waitingFor(busy)).toBe('stop')
    expect(f.health.holdsInput(busy, shared)).toBe(true)
    expect(f.timers.live().map((t) => t.ms)).toEqual([TURN_STOP_CEILING_MS])
    f.sessions.standing.set(busy, 'between-turns')
    await f.health.onTurnBoundary(busy, shared)
    expect(f.sessions.stopped).toEqual([idle, busy])
    expect(f.health.holdsInput(busy, shared)).toBe(false)
  })

  it('a session on a removed credential is judged and stopped too', async () => {
    const f = await setup()
    const { credentialId } = await f.add(GOOD)
    await f.store.credentials.remove(credentialId)
    const left = asSessionId('ses_left_on_removed')
    f.sessions.running.push({ sessionId: left, ownerUserId: OWNER, credentialId })
    f.sessions.standing.set(left, 'between-turns')
    f.sessions.access.set(left, 'revoked')
    await f.health.afterMemberLeft(OTHER, 'removed')
    expect(f.sessions.stopped).toEqual([left])
  })

  it('a listing that fails changes nothing and does not throw', async () => {
    const f = await setup()
    f.sessions.port.runningOnCredentials = async () => {
      throw new Error('no session runtime')
    }
    await expect(f.health.afterMemberLeft(OTHER, 'removed')).resolves.toBeUndefined()
    expect(f.sessions.stopped).toEqual([])
  })
})

describe('acceptance 8: removing a member', () => {
  it("removes all their credentials everywhere and flags another member's session on one", async () => {
    const f = await setup()
    const { credentialId: first } = await f.add(GOOD)
    const { credentialId: second } = await f.add(RENEWED, 'openai.api-key', 'OpenAI')
    const othersSession = asSessionId('ses_member_other')
    f.sessions.on[first] = [othersSession]
    f.sessions.standing.set(othersSession, 'in-turn')
    await f.health.removeMemberCredentials(OWNER, ADMIN_ACTOR)
    for (const id of [first, second]) {
      expect((await f.store.credentials.get(id))?.status).toBe('revoked')
      expect(await f.store.credentials.latestSecret(id)).toBeNull()
    }
    expect(f.sessions.flagged).toEqual([
      { sessionId: othersSession, label: 'Work key', refusal: 'revoked' },
    ])
    expect(f.sessions.stopped).toEqual([othersSession])
    const removes = await f.events('remove')
    expect(removes).toHaveLength(2)
    expect(removes.every((row) => row.actorId === ADMIN_ACTOR)).toBe(true)
  })
})

describe('acceptance 9: sharing', () => {
  it('raises one credential-shared notice for the grantee', async () => {
    const f = await setup()
    const { credentialId } = await f.add(GOOD)
    await f.handlers.share.handler(f.state(), {
      credentialId,
      grantee: { userId: OTHER },
      verb: 'use',
      acknowledgeDisclosure: true,
    })
    expect(f.notices.emitted).toEqual([
      expect.objectContaining({
        recipientUserId: OTHER,
        kind: 'credential-shared',
        subject: { kind: 'credential', id: credentialId },
        title: 'Olive shared Work key with you',
      }),
    ])
  })
})

describe('acceptance 10: the attention, renew and remove events', () => {
  it('name the actor and contain no secret', async () => {
    const f = await setup()
    const { credentialId } = await f.add(GOOD)
    await f.health.noteFailure({
      credentialId,
      failure: 'rejected',
      reason: 'Authentication failed',
      actorUserId: OTHER,
    })
    await f.handlers.renew.handler(f.state(), { credentialId, secret: RENEWED })
    await f.handlers.remove.handler(f.state(), { credentialId })
    const rows = [
      ...(await f.events('attention')),
      ...(await f.events('renew')),
      ...(await f.events('remove')),
    ]
    expect(rows.map((row) => [row.command, row.actorId])).toEqual([
      ['credentials.attention', OTHER],
      ['credentials.renew', OWNER],
      ['credentials.remove', OWNER],
    ])
    // Canary: the search finds a planted value where it is.
    expect(JSON.stringify([{ planted: GOOD }])).toContain(GOOD)
    const trail = JSON.stringify(await f.store.settingsAudit.list(1000))
    expect(trail).toContain(credentialId)
    for (const secret of [GOOD, RENEWED]) expect(trail).not.toContain(secret)
    expect(JSON.stringify(f.notices.emitted)).not.toContain(GOOD)
  })

  it('a provider that echoes the key does not put it in the reason', async () => {
    const f = await setup()
    const echoing = new CredentialHealth({
      store: f.store,
      fetch: async () =>
        new Response(JSON.stringify({ error: { message: `bad key ${BAD}` } }), { status: 401 }),
    })
    const verdict = await echoing.verify('anthropic.api-key', BAD)
    expect(verdict.ok).toBe(false)
    expect(JSON.stringify(verdict)).toContain('[redacted]')
    expect(JSON.stringify(verdict)).not.toContain(BAD)
  })
})
