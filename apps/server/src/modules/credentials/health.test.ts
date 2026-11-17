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
  const flagged: { sessionId: SessionId; label: string }[] = []
  const port: CredentialSessionPort = {
    liveSessionIds: async (id) => on[id] ?? [],
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
    flagRemoved: async (sessionId, credential) => {
      flagged.push({ sessionId, label: credential.label })
    },
  }
  return { port, standing, restarted, stopped, flagged, on }
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
  const health = new CredentialHealth({
    store,
    notices: notices.port,
    sessions: sessions.port,
    fetch: provider.fetch,
    now: () => now,
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
    f.sessions.on[credentialId] = [busy]
    f.sessions.standing.set(busy, 'in-turn')
    await f.health.removeEverywhere(credentialId, OWNER)
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
  it('both sessions are flagged and stop at their next turn boundary; nothing crashes', async () => {
    const f = await setup()
    const { credentialId } = await f.add(GOOD)
    const idle = asSessionId('ses_remove_idle')
    const busy = asSessionId('ses_remove_busy')
    f.sessions.on[credentialId] = [idle, busy]
    f.sessions.standing.set(idle, 'between-turns')
    f.sessions.standing.set(busy, 'in-turn')
    await f.handlers.remove.handler(f.state(), { credentialId })
    expect(f.sessions.flagged).toEqual([
      { sessionId: idle, label: 'Work key' },
      { sessionId: busy, label: 'Work key' },
    ])
    expect(f.sessions.stopped).toEqual([idle])
    expect(f.health.waitingFor(busy)).toBe('stop')
    f.sessions.standing.set(busy, 'between-turns')
    await f.health.onTurnBoundary(busy, credentialId)
    expect(f.sessions.stopped).toEqual([idle, busy])
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
    expect(f.sessions.flagged).toEqual([{ sessionId: othersSession, label: 'Work key' }])
    expect(f.health.waitingFor(othersSession)).toBe('stop')
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
