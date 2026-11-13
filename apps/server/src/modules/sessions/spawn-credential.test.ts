/**
 * THE CREDENTIAL A LAUNCH RUNS ON, observed on the spawn frame the daemon
 * receives (credential management §9; epic plan Task 3).
 *
 * Both spawn sites go through the resolver: a fresh create and a wake. These
 * tests read the real control frames through the production registry, so a
 * spawn site that skipped the resolver, or fell back to another login after a
 * refusal, shows up here. Planted secrets are obviously fake.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type AgentKind,
  asAccountId,
  asUserId,
  type CredentialId,
  firstAdminMemberId,
  type SessionId,
  type UserId,
} from '@podium/model'
import type { ControlMessage } from '@podium/protocol/daemon'
import { openDatabase } from '@podium/runtime/sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { SessionRegistry } from '../../relay'
import type { SessionStore } from '../../store'
import { memberFacts } from '../../store/fixtures/test-support'
import { attachHostDaemon } from '../../test-support/host-daemon'
import { openTestStore } from '../../test-support/open-test-store'
import { seedRows } from '../../test-support/seed-rows'
import { ACCESS_REFUSAL_MESSAGES } from '../credentials/access'
import { sealCredentialSecret } from '../credentials/vault'
import { CredentialRefusal } from './launch-config'

const registries: SessionRegistry[] = []
const dirs: string[] = []
afterEach(async () => {
  for (const r of registries.splice(0)) await r.dispose()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

type SpawnFrame = Extract<ControlMessage, { type: 'spawn' }>
const spawns = (daemon: ControlMessage[]) =>
  daemon.filter((m): m is SpawnFrame => m.type === 'spawn')

const AT = '2026-11-13T00:00:00.000Z'
const FAKE_A = 'sk-FAKE-credential-a-0001'
const FAKE_B = 'sk-FAKE-credential-b-0002'

async function credential(
  store: SessionStore,
  i: { type: string; secret?: string; owner?: UserId; legacyKey?: string; fingerprint?: string },
): Promise<CredentialId> {
  const record = await store.credentials.insert({
    ownerUserId: i.owner ?? (await firstAdminMemberId(store)),
    label: i.legacyKey ?? i.type,
    type: i.type,
    ...(i.legacyKey ? { legacyKey: i.legacyKey } : {}),
    ...(i.fingerprint ? { identity: { fingerprint: i.fingerprint } } : {}),
  })
  if (i.secret !== undefined) {
    expect(await sealCredentialSecret(store, record, i.secret, 0)).toBe(1)
  }
  return record.id
}

async function setDefault(store: SessionStore, harness: AgentKind, id: CredentialId) {
  const owner = await firstAdminMemberId(store)
  const current = (await store.settings.getSettingsFor(owner)).credentialDefaults
  // A setting the test sets up, not a write path under test: below the change
  // log, which a registry attaches (POD-6920).
  await seedRows(store, async () => {
    await store.settings.userPreferences.set(
      owner,
      'credentialDefaults',
      { ...current, [harness]: id },
      AT,
    )
  })
}

/** The pre-credential coding role, as settings written before this epic hold it. */
async function setLegacyRole(store: SessionStore, accountId: string) {
  const settings = await store.settings.getSettings()
  await seedRows(store, async () => {
    await store.settings.setSettings({
      ...settings,
      roles: {
        ...settings.roles,
        coding: { ...settings.roles.coding, accountId: asAccountId(accountId) },
      },
    })
  })
}

/** The host reports these harness logins (the default home). */
async function reportLogins(
  store: SessionStore,
  logins: { kind: AgentKind; fingerprint: string }[],
) {
  await store.machines.setMachineInventory(
    store.hostMachineId,
    JSON.stringify({
      os: 'linux',
      arch: 'x64',
      tools: [],
      agents: logins.map((l) => ({
        kind: l.kind,
        installed: true,
        login: { state: 'in', identity: { fingerprint: l.fingerprint } },
      })),
    }),
  )
}

async function makeRegistry(
  store: SessionStore,
): Promise<{ reg: SessionRegistry; daemon: ControlMessage[] }> {
  const reg = await SessionRegistry.create(store, undefined, { instanceId: 'default' })
  registries.push(reg)
  const daemon: ControlMessage[] = []
  await attachHostDaemon(reg, (m) => daemon.push(m))
  return { reg, daemon }
}

const RESUME = {
  'claude-code': { kind: 'claude-session', value: 'conv-1' },
  codex: { kind: 'codex-thread', value: 't1' },
} as const

/** A session bound and then hibernated: ready for a wake. */
async function hibernated(
  reg: SessionRegistry,
  agentKind: 'claude-code' | 'codex',
): Promise<SessionId> {
  const { sessionId } = await reg.modules.issueSessionLifecycle.resumeSession({
    agentKind,
    cwd: '/proj',
    resume: RESUME[agentKind],
    conversationId: 'c1',
  })
  await reg.gateway.routeDaemonFrame(reg.sessionStore.hostMachineId, {
    type: 'bind',
    sessionId,
    cmd: agentKind === 'codex' ? 'codex' : 'claude',
    cwd: '/proj',
    agentKind,
    geometry: { cols: 80, rows: 24 },
  })
  expect(await reg.modules.sessions.hibernateSession({ sessionId })).toEqual({ ok: true })
  return sessionId
}

async function wake(reg: SessionRegistry, daemon: ControlMessage[], sessionId: SessionId) {
  const before = spawns(daemon).length
  const result = await reg.modules.issueSessionLifecycle.resurrectSession({ sessionId })
  return { result, frames: spawns(daemon).slice(before) }
}

describe('a new session', () => {
  it('runs on the default for its harness, delivered as the declared variable', async () => {
    const store = await openTestStore(':memory:')
    const id = await credential(store, { type: 'anthropic.api-key', secret: FAKE_A })
    await setDefault(store, 'claude-code', id)
    const { reg, daemon } = await makeRegistry(store)
    const spawned = await reg.modules.sessions.createSession({
      agentKind: 'claude-code',
      cwd: '/p',
    })
    expect(spawned.credentialId).toBe(id)
    expect(spawns(daemon).at(-1)?.env).toEqual({ ANTHROPIC_API_KEY: FAKE_A })
    expect((await store.sessions.getSession(spawned.sessionId))?.credentialId).toBe(id)
  })

  // Acceptance 8: named beats default beats none.
  it('takes the credential the launch names over the default', async () => {
    const store = await openTestStore(':memory:')
    const a = await credential(store, { type: 'anthropic.api-key', secret: FAKE_A })
    const b = await credential(store, { type: 'anthropic.api-key', secret: FAKE_B })
    await setDefault(store, 'claude-code', a)
    const { reg, daemon } = await makeRegistry(store)
    const spawned = await reg.modules.sessions.createSession({
      agentKind: 'claude-code',
      cwd: '/p',
      credentialId: b,
    })
    expect(spawned.credentialId).toBe(b)
    expect(spawns(daemon).at(-1)?.env).toEqual({ ANTHROPIC_API_KEY: FAKE_B })
  })

  it('takes "none" named at launch over the default', async () => {
    const store = await openTestStore(':memory:')
    const a = await credential(store, { type: 'anthropic.api-key', secret: FAKE_A })
    await setDefault(store, 'claude-code', a)
    const { reg, daemon } = await makeRegistry(store)
    const spawned = await reg.modules.sessions.createSession({
      agentKind: 'claude-code',
      cwd: '/p',
      credentialId: null,
    })
    expect(spawned.credentialId).toBeNull()
    expect(Object.hasOwn(spawns(daemon).at(-1) ?? {}, 'env')).toBe(false)
  })

  it('runs on no credential when neither is set: env absent, not an empty object', async () => {
    const store = await openTestStore(':memory:')
    const { reg, daemon } = await makeRegistry(store)
    const spawned = await reg.modules.sessions.createSession({
      agentKind: 'claude-code',
      cwd: '/p',
    })
    expect(spawned.credentialId).toBeNull()
    expect(Object.hasOwn(spawns(daemon).at(-1) ?? {}, 'env')).toBe(false)
  })

  it('never gives a shell pane a credential', async () => {
    const store = await openTestStore(':memory:')
    const id = await credential(store, { type: 'anthropic.api-key', secret: FAKE_A })
    await setDefault(store, 'claude-code', id)
    const { reg, daemon } = await makeRegistry(store)
    await reg.modules.sessions.createSession({ agentKind: 'shell', cwd: '/p' })
    const frame = spawns(daemon).at(-1)
    expect(frame?.agentKind).toBe('shell')
    expect(JSON.stringify(daemon)).not.toContain(FAKE_A)
  })
})

describe('refusals send nothing (no fallback)', () => {
  // Acceptance 5.
  it('a credential in attention: no spawn message at all, and a refuse event', async () => {
    const store = await openTestStore(':memory:')
    const id = await credential(store, { type: 'anthropic.api-key', secret: FAKE_A })
    await store.credentials.setStatus(id, 'attention', 'expired')
    await setDefault(store, 'claude-code', id)
    const { reg, daemon } = await makeRegistry(store)
    const sessionsBefore = (await store.sessions.loadSessions()).length
    const launch = reg.modules.sessions.createSession({ agentKind: 'claude-code', cwd: '/p' })
    await expect(launch).rejects.toBeInstanceOf(CredentialRefusal)
    await expect(launch).rejects.toThrow(ACCESS_REFUSAL_MESSAGES['needs-attention'])
    expect(spawns(daemon)).toEqual([])
    expect((await store.sessions.loadSessions()).length).toBe(sessionsBefore)
    const refused = (await store.settingsAudit.list(100)).filter(
      (row) => row.command === 'credentials.refuse',
    )
    expect(refused).toEqual([
      expect.objectContaining({
        detail: expect.objectContaining({ credentialId: id, detail: 'needs-attention' }),
      }),
    ])
  })

  it('a secret the vault cannot hand over refuses with needs-attention, nothing sent', async () => {
    const store = await openTestStore(':memory:')
    // Healthy by its record, but no secret was ever stored.
    const id = await credential(store, { type: 'anthropic.api-key' })
    await setDefault(store, 'claude-code', id)
    const { reg, daemon } = await makeRegistry(store)
    await expect(
      reg.modules.sessions.createSession({ agentKind: 'claude-code', cwd: '/p' }),
    ).rejects.toThrow(ACCESS_REFUSAL_MESSAGES['needs-attention'])
    expect(spawns(daemon)).toEqual([])
  })

  it('a named credential the harness cannot take: wrong-type, nothing sent', async () => {
    const store = await openTestStore(':memory:')
    const key = await credential(store, { type: 'anthropic.api-key', secret: FAKE_A })
    const { reg, daemon } = await makeRegistry(store)
    await expect(
      reg.modules.sessions.createSession({ agentKind: 'codex', cwd: '/p', credentialId: key }),
    ).rejects.toThrow(ACCESS_REFUSAL_MESSAGES['wrong-type'])
    expect(spawns(daemon)).toEqual([])
  })

  it('a default the harness cannot take: wrong-type, nothing sent', async () => {
    const store = await openTestStore(':memory:')
    const key = await credential(store, { type: 'anthropic.api-key', secret: FAKE_A })
    await setDefault(store, 'codex', key)
    const { reg, daemon } = await makeRegistry(store)
    await expect(
      reg.modules.sessions.createSession({ agentKind: 'codex', cwd: '/p' }),
    ).rejects.toThrow(ACCESS_REFUSAL_MESSAGES['wrong-type'])
    expect(spawns(daemon)).toEqual([])
  })

  it('a role still naming a stored key that no longer exists: not-found, nothing sent', async () => {
    const store = await openTestStore(':memory:')
    await setLegacyRole(store, 'managed:openai')
    const { reg, daemon } = await makeRegistry(store)
    await expect(
      reg.modules.sessions.createSession({ agentKind: 'codex', cwd: '/p' }),
    ).rejects.toThrow(ACCESS_REFUSAL_MESSAGES['not-found'])
    expect(spawns(daemon)).toEqual([])
  })

  // Acceptance 7.
  it('no credential: the custodian gets the default home, anyone else is refused', async () => {
    const store = await openTestStore(':memory:')
    const bob = asUserId('user:spawn-credential-bob')
    await memberFacts(store).create(
      { id: bob, displayName: 'Bob', email: null, role: 'member', createdAt: AT, disabledAt: null },
      'not-a-real-hash',
    )
    const { reg, daemon } = await makeRegistry(store)
    // The host's custodian is the first admin (setup enrollment's row).
    const own = await reg.modules.sessions.createSession({
      agentKind: 'claude-code',
      cwd: '/p',
      ownerUserId: await firstAdminMemberId(store),
    })
    expect(own.credentialId).toBeNull()
    const sent = spawns(daemon).length
    const theirs = reg.modules.sessions.createSession({
      agentKind: 'claude-code',
      cwd: '/p',
      ownerUserId: bob,
    })
    await expect(theirs).rejects.toThrow(ACCESS_REFUSAL_MESSAGES['own-credential-required'])
    expect(spawns(daemon).length).toBe(sent)
  })
})

describe('a wake', () => {
  // Acceptance 4.
  it('revives on the credential stored on the session after the default changed', async () => {
    const store = await openTestStore(':memory:')
    const a = await credential(store, { type: 'openai.api-key', secret: FAKE_A })
    const b = await credential(store, { type: 'openai.api-key', secret: FAKE_B })
    await setDefault(store, 'codex', a)
    const { reg, daemon } = await makeRegistry(store)
    const sessionId = await hibernated(reg, 'codex')
    await setDefault(store, 'codex', b)
    const { result, frames } = await wake(reg, daemon, sessionId)
    expect(result).toEqual({ ok: true })
    expect(frames).toHaveLength(1)
    expect(frames[0]?.env).toEqual({ OPENAI_API_KEY: FAKE_A })
  })

  it('a credential removed while the session slept stops the wake, with the reason', async () => {
    const store = await openTestStore(':memory:')
    const a = await credential(store, { type: 'openai.api-key', secret: FAKE_A })
    await setDefault(store, 'codex', a)
    const { reg, daemon } = await makeRegistry(store)
    const sessionId = await hibernated(reg, 'codex')
    await store.credentials.remove(a)
    const { result, frames } = await wake(reg, daemon, sessionId)
    expect(result).toEqual({ ok: false, reason: ACCESS_REFUSAL_MESSAGES.revoked })
    expect(frames).toEqual([])
  })
})

// Acceptance 3 (review focus 4): old values mean what they meant.
const LEGACY: {
  value: string
  harness: 'claude-code' | 'codex'
  seed?: { type: string; legacyKey?: string; fingerprint?: string }
  env?: Record<string, string>
  credential: boolean
}[] = [
  { value: '', harness: 'claude-code', credential: false },
  { value: 'native:claude-code', harness: 'claude-code', credential: false },
  {
    value: 'native:codex:fp-codex',
    harness: 'codex',
    seed: { type: 'openai.chatgpt-login', fingerprint: 'fp-codex' },
    credential: true,
  },
  {
    value: 'managed:anthropic',
    harness: 'claude-code',
    seed: { type: 'anthropic.api-key', legacyKey: 'managed:anthropic' },
    env: { ANTHROPIC_API_KEY: FAKE_A },
    credential: true,
  },
  {
    value: 'managed:claude-oauth',
    harness: 'claude-code',
    seed: { type: 'anthropic.claude-token', legacyKey: 'managed:claude-oauth' },
    env: { CLAUDE_CODE_OAUTH_TOKEN: FAKE_A },
    credential: true,
  },
  {
    value: 'managed:anthropic:earlier-workspace',
    harness: 'claude-code',
    seed: { type: 'anthropic.api-key', legacyKey: 'managed:anthropic:earlier-workspace' },
    env: { ANTHROPIC_API_KEY: FAKE_A },
    credential: true,
  },
  // The role was shared by every harness: a key codex cannot take meant its own login.
  {
    value: 'managed:anthropic',
    harness: 'codex',
    seed: { type: 'anthropic.api-key', legacyKey: 'managed:anthropic' },
    credential: false,
  },
]

/** Seed after the daemon attached: its attach replaces the host's inventory. */
async function seedLegacy(store: SessionStore, row: (typeof LEGACY)[number]) {
  await reportLogins(store, [{ kind: 'codex', fingerprint: 'fp-codex' }])
  if (!row.seed) return null
  return await credential(store, {
    ...row.seed,
    ...(row.seed.type.endsWith('-login') ? {} : { secret: FAKE_A }),
  })
}

describe('old account ids', () => {
  for (const row of LEGACY) {
    it(`from settings: ${row.harness} with "${row.value}"`, async () => {
      const store = await openTestStore(':memory:')
      const { reg, daemon } = await makeRegistry(store)
      const seeded = await seedLegacy(store, row)
      await setLegacyRole(store, row.value)
      const spawned = await reg.modules.sessions.createSession({
        agentKind: row.harness,
        cwd: '/p',
      })
      expect(spawned.credentialId).toBe(row.credential ? seeded : null)
      const frame = spawns(daemon).at(-1)
      if (row.env) expect(frame?.env).toEqual(row.env)
      else expect(Object.hasOwn(frame ?? {}, 'env')).toBe(false)
    })

    it(`from a stored session: ${row.harness} with "${row.value}"`, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'spawn-credential-'))
      dirs.push(dir)
      const file = join(dir, 'podium.db')
      const first = await openTestStore(file)
      const one = await makeRegistry(first)
      await seedLegacy(first, row)
      const sessionId = await hibernated(one.reg, row.harness)
      await one.reg.dispose()
      registries.splice(registries.indexOf(one.reg), 1)

      // The row as a release before credentials wrote it.
      const db = openDatabase(file)
      db.prepare('UPDATE sessions SET account_id = ?, credential_id = NULL WHERE id = ?').run(
        row.value,
        sessionId,
      )
      db.close()

      // The same host: a reopened test store otherwise mints a new machine id.
      const reopened = await openTestStore(file, first.hostMachineId)
      const { reg, daemon } = await makeRegistry(reopened)
      await reportLogins(reopened, [{ kind: 'codex', fingerprint: 'fp-codex' }])
      expect((await reopened.sessions.getSession(sessionId))?.status).toBe('hibernated')
      const { result, frames } = await wake(reg, daemon, sessionId)
      expect(result).toEqual({ ok: true })
      expect(frames).toHaveLength(1)
      if (row.env) expect(frames[0]?.env).toEqual(row.env)
      else expect(Object.hasOwn(frames[0] ?? {}, 'env')).toBe(false)
    })
  }
})
