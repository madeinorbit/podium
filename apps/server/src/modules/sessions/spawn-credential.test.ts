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
import { harnessTerminalDriverId } from '@podium/harness'
import { harnessAccepts } from '@podium/harness/metadata'
import {
  type AgentKind,
  asAccountId,
  asUserId,
  CREDENTIAL_TYPES,
  type CredentialId,
  type CredentialTypeId,
  firstAdminMemberId,
  HarnessAgent,
  type SessionId,
  type UserId,
} from '@podium/model'
import type { ControlMessage } from '@podium/protocol/daemon'
import { openDatabase } from '@podium/runtime/sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { type DaemonLink, daemonLinkFactsOf } from '../../gateway/daemon-link-kind'
import { SessionRegistry } from '../../relay'
import { SELF_HOSTED_WORKSPACE_ID } from '../../self-hosted-workspace'
import { resolveTrustedProxyHops } from '../../server'
import type { SessionStore } from '../../store'
import { memberFacts } from '../../store/fixtures/test-support'
import { attachHostDaemon } from '../../test-support/host-daemon'
import { seedLegacyKeyCredential } from '../../test-support/legacy-key-credential'
import { openTestStore } from '../../test-support/open-test-store'
import { seedRows } from '../../test-support/seed-rows'
import { ACCESS_REFUSAL_MESSAGES } from '../credentials/access'
import type { ChatgptTokenSet } from '../credentials/chatgpt-plan/openai'
import { CREDENTIAL_RESOURCE_KIND, mayUse } from '../credentials/may-use'
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

/**
 * The secret a spawn frame delivers, as `{ variable: secret }` (epic Task 5):
 * it rides `access`, and the frame's plain `env` never holds a credential.
 */
function delivered(frame: SpawnFrame | undefined): Record<string, string> | undefined {
  expect(frame?.env).toBeUndefined()
  const delivery = frame?.access?.delivery
  return delivery?.kind === 'env' ? { [delivery.variable]: delivery.secret } : undefined
}

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
    store.hostMachine!.id,
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
  host: { caps?: readonly string[]; link?: DaemonLink } = {},
): Promise<{ reg: SessionRegistry; daemon: ControlMessage[] }> {
  const reg = await SessionRegistry.create(store, undefined, { instanceId: 'default' })
  registries.push(reg)
  const daemon: ControlMessage[] = []
  await attachHostDaemon(reg, (m) => daemon.push(m), host)
  return { reg, daemon }
}

/** A daemon on another computer over plain ws, as the server judges it. */
const PLAIN_LINK: DaemonLink = {
  url: 'http://server.invalid/daemon',
  hasProxyHeaders: false,
  clientAddress: '203.0.113.7',
  trustedProxyHops: 0,
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
  await reg.gateway.routeDaemonFrame(reg.sessionStore.hostMachine!.id, {
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
  it('a sign-in pane names the home its login goes into, and nothing secret (Task 9)', async () => {
    const store = await openTestStore(':memory:')
    const { reg, daemon } = await makeRegistry(store)
    const credentialId = 'cred_00000000-0000-4000-8000-0000000000c1' as CredentialId
    const spawned = await reg.modules.sessions.createSession({
      agentKind: 'shell',
      cwd: '/p',
      loginHarness: 'claude-code',
      loginHome: { credentialId, homeId: `${credentialId}:claude-code` },
    })
    const frame = spawns(daemon).at(-1)
    expect(frame?.loginHarness).toBe('claude-code')
    expect(frame?.access).toEqual({
      credentialId,
      delivery: { kind: 'home', homeId: `${credentialId}:claude-code` },
    })
    // The pane runs on no credential: it is how one comes into being.
    expect((await store.sessions.getSession(spawned.sessionId))?.credentialId).toBeFalsy()
  })

  it('a sign-in home without a sign-in harness is refused', async () => {
    const store = await openTestStore(':memory:')
    const { reg } = await makeRegistry(store)
    const credentialId = 'cred_00000000-0000-4000-8000-0000000000c2' as CredentialId
    await expect(
      reg.modules.sessions.createSession({
        agentKind: 'shell',
        cwd: '/p',
        loginHome: { credentialId, homeId: `${credentialId}:claude-code` },
      }),
    ).rejects.toThrow(/sign-in pane/)
  })

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
    expect(delivered(spawns(daemon).at(-1))).toEqual({ ANTHROPIC_API_KEY: FAKE_A })
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
    expect(delivered(spawns(daemon).at(-1))).toEqual({ ANTHROPIC_API_KEY: FAKE_B })
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
    expect(Object.hasOwn(spawns(daemon).at(-1) ?? {}, 'access')).toBe(false)
    expect(delivered(spawns(daemon).at(-1))).toBeUndefined()
  })

  it('runs on no credential when neither is set: no access field', async () => {
    const store = await openTestStore(':memory:')
    const { reg, daemon } = await makeRegistry(store)
    const spawned = await reg.modules.sessions.createSession({
      agentKind: 'claude-code',
      cwd: '/p',
    })
    expect(spawned.credentialId).toBeNull()
    expect(Object.hasOwn(spawns(daemon).at(-1) ?? {}, 'access')).toBe(false)
    expect(delivered(spawns(daemon).at(-1))).toBeUndefined()
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

/** A ChatGPT plan's sealed token set around `accessToken`, with two hours left. */
function planTokenSet(accessToken: string): string {
  const set: ChatgptTokenSet = {
    seq: 1,
    clientId: 'oaiapp_FAKE_client',
    accessToken,
    refreshToken: 'rt.FAKE-refresh',
    idToken: 'FAKE.id.token',
    // Two hours left: no renewal is needed for a session start.
    expiresAt: Date.now() + 2 * 3600_000,
    scopes: ['chatgpt.tokens.use.direct'],
    savedAt: Date.now(),
  }
  return JSON.stringify(set)
}

describe('a ChatGPT plan signed in to Podium (epic Task 15, acceptance 2)', () => {
  /** Obviously fake: the access token inside the sealed token set. */
  const PLAN_TOKEN = 'tok-FAKE-plan-launch-access-0015'

  async function planCredential(store: SessionStore): Promise<CredentialId> {
    return await credential(store, {
      type: 'openai.chatgpt-plan',
      secret: planTokenSet(PLAN_TOKEN),
    })
  }

  it('a launch naming the plan and no driver runs on the Codex server driver, with the token', async () => {
    const store = await openTestStore(':memory:')
    const id = await planCredential(store)
    const { reg, daemon } = await makeRegistry(store)
    const spawned = await reg.modules.sessions.createSession({
      agentKind: 'codex',
      cwd: '/p',
      credentialId: id,
    })
    const frame = spawns(daemon).at(-1)
    expect(frame?.requestedDriverId).toBe('codex-app-server')
    // The keeper's access token, not the sealed token set.
    expect(delivered(frame)).toEqual({ ACCESS_TOKEN: PLAN_TOKEN })
    expect((await store.sessions.getSession(spawned.sessionId))?.requestedDriverId).toBe(
      'codex-app-server',
    )
  })

  it('the plan on the Codex terminal driver is refused with wrong-type; nothing is sent', async () => {
    const store = await openTestStore(':memory:')
    const id = await planCredential(store)
    const { reg, daemon } = await makeRegistry(store)
    const terminal = harnessTerminalDriverId('codex')
    expect(terminal).toBeDefined()
    const refused = await reg.modules.sessions
      .createSession({
        agentKind: 'codex',
        cwd: '/p',
        credentialId: id,
        ...(terminal ? { requestedDriverId: terminal } : {}),
      })
      .catch((err: unknown) => err)
    expect(refused).toBeInstanceOf(CredentialRefusal)
    expect(refused).toMatchObject({ refusal: 'wrong-type' })
    expect(spawns(daemon)).toEqual([])
    expect(JSON.stringify(daemon)).not.toContain(PLAN_TOKEN)
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
    expect(delivered(frames[0])).toEqual({ OPENAI_API_KEY: FAKE_A })
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
      expect(delivered(frame)).toEqual(row.env)
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
      const reopened = await openTestStore(file, first.hostMachine!.id)
      const { reg, daemon } = await makeRegistry(reopened)
      await reportLogins(reopened, [{ kind: 'codex', fingerprint: 'fp-codex' }])
      expect((await reopened.sessions.getSession(sessionId))?.status).toBe('hibernated')
      const { result, frames } = await wake(reg, daemon, sessionId)
      expect(result).toEqual({ ok: true })
      expect(frames).toHaveLength(1)
      expect(delivered(frames[0])).toEqual(row.env)
    })
  }
})

// POD-6937 (review focus 4): an old `managed:*` id meant the person's own key,
// and with none, a key another member shared with them. It still does after the
// upgrade, for a role setting and for a stored session alike.
describe('an old account id and a key another member shared', () => {
  const BOB = asUserId('user:spawn-credential-shared-bob')

  /**
   * Before the upgrade, Alice (the first admin, custodian of the host) stored a
   * `managed:anthropic` key and shared it with Bob, who has none. With
   * `session`, Bob also has a hibernated session that recorded the old id. The
   * store is reopened, so the start's one-time import moves the key into a
   * credential and its sharing into a grant.
   */
  async function upgraded(session: boolean) {
    const dir = mkdtempSync(join(tmpdir(), 'spawn-credential-shared-'))
    dirs.push(dir)
    const file = join(dir, 'podium.db')
    const first = await openTestStore(file)
    const one = await makeRegistry(first)
    const alice = await firstAdminMemberId(first)
    // Alice's own session first: a resume with no owner needs a sole member.
    const sessionId = session ? await hibernated(one.reg, 'claude-code') : undefined
    await memberFacts(first).create(
      { id: BOB, displayName: 'Bob', email: null, role: 'member', createdAt: AT, disabledAt: null },
      'not-a-real-hash',
    )
    await one.reg.dispose()
    registries.splice(registries.indexOf(one.reg), 1)
    // Alice's key and its share with Bob, as a release before credentials stored them.
    const raw = openDatabase(file)
    raw
      .prepare(
        `INSERT INTO accounts (workspace_id, id, provider, kind, credential, identity, scope, created_at,
           owner_user_id, account_key, ref, shared_with)
         VALUES ('${SELF_HOSTED_WORKSPACE_ID}', ?, 'anthropic', 'api-key', ?, 'masked', 'role', 1, ?, 'managed:anthropic', NULL, ?)`,
      )
      .run(`managed:anthropic@${alice}`, FAKE_A, alice, JSON.stringify([BOB]))
    raw.close()
    if (sessionId) {
      // Bob's row as a release before credentials wrote it.
      const db = openDatabase(file)
      db.prepare(
        'UPDATE sessions SET account_id = ?, credential_id = NULL, owner_user_id = ? WHERE id = ?',
      ).run('managed:anthropic', BOB, sessionId)
      db.close()
    }

    const store = await openTestStore(file, first.hostMachine!.id)
    const { reg, daemon } = await makeRegistry(store)
    const aliceKey = (await store.credentials.findByLegacyKey(alice, 'managed:anthropic'))?.id
    if (!aliceKey) throw new Error('the import moved no key')
    // The import made the old share a grant: Bob may use Alice's key.
    expect(await mayUse(store, BOB, { id: aliceKey, ownerUserId: alice })).toBe('use')
    const current = await store.settings.getSettingsFor(BOB)
    await store.settings.setSettingsFor(
      BOB,
      {
        ...current,
        roles: {
          ...current.roles,
          coding: { ...current.roles.coding, accountId: asAccountId('managed:anthropic') },
        },
      },
      AT,
    )
    return { store, reg, daemon, aliceKey, sessionId }
  }

  const unshare = async (store: SessionStore, aliceKey: CredentialId) =>
    expect(await store.grants.remove(CREDENTIAL_RESOURCE_KIND, aliceKey, BOB, 'use')).toBe(true)

  /** Bob connects a key of his own under the old id, allowed on the host. */
  async function connectBobs(store: SessionStore): Promise<CredentialId> {
    return await seedLegacyKeyCredential(store, {
      owner: BOB,
      accountKey: 'managed:anthropic',
      type: 'anthropic.api-key',
      secret: FAKE_B,
      sentTo: [store.hostMachine!.id],
    })
  }

  const launchAsBob = (reg: SessionRegistry) =>
    reg.modules.sessions.createSession({ agentKind: 'claude-code', cwd: '/p', ownerUserId: BOB })

  describe('from settings', () => {
    it("runs on Alice's shared key when Bob has none", async () => {
      const { reg, daemon, aliceKey } = await upgraded(false)
      const spawned = await launchAsBob(reg)
      expect(spawned.credentialId).toBe(aliceKey)
      expect(delivered(spawns(daemon).at(-1))).toEqual({ ANTHROPIC_API_KEY: FAKE_A })
    })

    it('is refused not-found once Alice unshares, and her key is never sent', async () => {
      const { store, reg, daemon, aliceKey } = await upgraded(false)
      await unshare(store, aliceKey)
      const sent = spawns(daemon).length
      await expect(launchAsBob(reg)).rejects.toThrow(ACCESS_REFUSAL_MESSAGES['not-found'])
      expect(spawns(daemon).length).toBe(sent)
      expect(JSON.stringify(daemon)).not.toContain(FAKE_A)
    })

    it("runs on Bob's own key once he connects one, though Alice's is still shared", async () => {
      const { store, reg, daemon } = await upgraded(false)
      const bobs = await connectBobs(store)
      const spawned = await launchAsBob(reg)
      expect(spawned.credentialId).toBe(bobs)
      expect(delivered(spawns(daemon).at(-1))).toEqual({ ANTHROPIC_API_KEY: FAKE_B })
    })
  })

  describe('from a stored session', () => {
    it("revives on Alice's shared key when Bob has none", async () => {
      const { reg, daemon, sessionId } = await upgraded(true)
      if (!sessionId) throw new Error('no session')
      const { result, frames } = await wake(reg, daemon, sessionId)
      expect(result).toEqual({ ok: true })
      expect(frames).toHaveLength(1)
      expect(delivered(frames[0])).toEqual({ ANTHROPIC_API_KEY: FAKE_A })
    })

    it('is refused not-found once Alice unshares, and her key is never sent', async () => {
      const { store, reg, daemon, aliceKey, sessionId } = await upgraded(true)
      if (!sessionId) throw new Error('no session')
      await unshare(store, aliceKey)
      const { result, frames } = await wake(reg, daemon, sessionId)
      expect(result).toEqual({ ok: false, reason: ACCESS_REFUSAL_MESSAGES['not-found'] })
      expect(frames).toEqual([])
      expect(JSON.stringify(daemon)).not.toContain(FAKE_A)
    })

    it("revives on Bob's own key once he connects one, though Alice's is still shared", async () => {
      const { store, reg, daemon, sessionId } = await upgraded(true)
      if (!sessionId) throw new Error('no session')
      await connectBobs(store)
      const { result, frames } = await wake(reg, daemon, sessionId)
      expect(result).toEqual({ ok: true })
      expect(frames).toHaveLength(1)
      expect(delivered(frames[0])).toEqual({ ANTHROPIC_API_KEY: FAKE_B })
    })
  })
})

// Epic plan Task 5: the credential crosses only in `access`, only to a daemon
// that offered it, over a connection the server judged safe.
describe('delivery to the daemon (Task 5)', () => {
  it('an older daemon: daemon-too-old, nothing sent, no session, vault never opened (acceptance 1)', async () => {
    const store = await openTestStore(':memory:')
    const id = await credential(store, { type: 'anthropic.api-key', secret: FAKE_A })
    await setDefault(store, 'claude-code', id)
    const { reg, daemon } = await makeRegistry(store, { caps: [] })
    const open = vi.spyOn(store.vault, 'open')
    const sessionsBefore = (await store.sessions.loadSessions()).length
    const launch = reg.modules.sessions.createSession({ agentKind: 'claude-code', cwd: '/p' })
    await expect(launch).rejects.toBeInstanceOf(CredentialRefusal)
    await expect(launch).rejects.toThrow(ACCESS_REFUSAL_MESSAGES['daemon-too-old'])
    expect(spawns(daemon)).toEqual([])
    expect((await store.sessions.loadSessions()).length).toBe(sessionsBefore)
    expect(open).not.toHaveBeenCalled()
    expect(JSON.stringify(daemon)).not.toContain(FAKE_A)
  })

  it('a plain connection: connection-not-encrypted, nothing sent, vault never opened (acceptance 2)', async () => {
    const store = await openTestStore(':memory:')
    const id = await credential(store, { type: 'anthropic.api-key', secret: FAKE_A })
    await setDefault(store, 'claude-code', id)
    const { reg, daemon } = await makeRegistry(store, { link: PLAIN_LINK })
    const open = vi.spyOn(store.vault, 'open')
    const launch = reg.modules.sessions.createSession({ agentKind: 'claude-code', cwd: '/p' })
    await expect(launch).rejects.toThrow(ACCESS_REFUSAL_MESSAGES['connection-not-encrypted'])
    expect(spawns(daemon)).toEqual([])
    expect(open).not.toHaveBeenCalled()
  })

  /**
   * POD-7041: a proxy on the server's computer serving plain http to the
   * network forwards a remote daemon's `/daemon` with no X-Forwarded-* header.
   * The server is bound to loopback, so it trusts one proxy hop by default.
   * The link is judged from that upgrade request, as the socket accept does.
   */
  it('a same-computer proxy that forwards no X-Forwarded-* header: connection-not-encrypted, nothing sent', async () => {
    const hops = resolveTrustedProxyHops(undefined, {}, '127.0.0.1')
    expect(hops).toBe(1)
    const viaProxy = (url: string) => daemonLinkFactsOf(new Request(url), '127.0.0.1', hops)

    const store = await openTestStore(':memory:')
    const id = await credential(store, { type: 'anthropic.api-key', secret: FAKE_A })
    await setDefault(store, 'claude-code', id)
    const { reg, daemon } = await makeRegistry(store, {
      link: viaProxy('http://podium.example/daemon'),
    })
    const open = vi.spyOn(store.vault, 'open')
    const launch = reg.modules.sessions.createSession({ agentKind: 'claude-code', cwd: '/p' })
    await expect(launch).rejects.toThrow(ACCESS_REFUSAL_MESSAGES['connection-not-encrypted'])
    expect(spawns(daemon)).toEqual([])
    expect(open).not.toHaveBeenCalled()
    expect(JSON.stringify(daemon)).not.toContain(FAKE_A)

    // The control: the server's own daemon dialing loopback directly receives it.
    const direct = await openTestStore(':memory:')
    const directId = await credential(direct, { type: 'anthropic.api-key', secret: FAKE_A })
    await setDefault(direct, 'claude-code', directId)
    const local = await makeRegistry(direct, { link: viaProxy('http://127.0.0.1:18787/daemon') })
    await local.reg.modules.sessions.createSession({ agentKind: 'claude-code', cwd: '/p' })
    expect(delivered(spawns(local.daemon)[0])).toEqual({ ANTHROPIC_API_KEY: FAKE_A })
  })

  it('no credential: unchanged on an older daemon and on a plain connection (acceptance 3)', async () => {
    for (const host of [{ caps: [] }, { link: PLAIN_LINK }]) {
      const store = await openTestStore(':memory:')
      const { reg, daemon } = await makeRegistry(store, host)
      const spawned = await reg.modules.sessions.createSession({
        agentKind: 'claude-code',
        cwd: '/p',
      })
      expect(spawned.credentialId).toBeNull()
      expect(spawns(daemon)).toHaveLength(1)
      expect(Object.hasOwn(spawns(daemon)[0] ?? {}, 'access')).toBe(false)
    }
  })

  // Acceptance 9: every accepted vault type, on every harness that takes it.
  const VAULT_LINES = HarnessAgent.options.flatMap((harness) =>
    harnessAccepts(harness)
      .filter((line) => CREDENTIAL_TYPES[line.type as CredentialTypeId]?.store === 'vault')
      .map((line) => ({ harness, line })),
  )

  it('enumerates the vault lines it checks (canary)', () => {
    expect(VAULT_LINES.length).toBeGreaterThanOrEqual(3)
    expect(VAULT_LINES.map((v) => `${v.harness}:${v.line.type}`)).toContain(
      'claude-code:anthropic.api-key',
    )
  })

  for (const { harness, line } of VAULT_LINES) {
    it(`${harness} on ${line.type}: the secret is in access, never in env (acceptance 9)`, async () => {
      if (line.deliver.kind !== 'env') throw new Error('a vault line delivers by env')
      const store = await openTestStore(':memory:')
      // A type Podium renews is sealed as its token set; what a session gets
      // is the access token in it (epic Task 15).
      const renewed = CREDENTIAL_TYPES[line.type as CredentialTypeId]?.renewal === 'podium'
      const id = await credential(store, {
        type: line.type,
        secret: renewed ? planTokenSet(FAKE_A) : FAKE_A,
      })
      const { reg, daemon } = await makeRegistry(store)
      await reg.modules.sessions.createSession({
        agentKind: harness,
        cwd: '/p',
        credentialId: id,
        ...(line.drivers?.[0] ? { requestedDriverId: line.drivers[0] } : {}),
      })
      const frame = spawns(daemon).at(-1)
      expect(frame?.env?.[line.deliver.variable]).toBeUndefined()
      expect(JSON.stringify(frame?.env ?? {})).not.toContain(FAKE_A)
      expect(frame?.access).toEqual({
        credentialId: id,
        delivery: { kind: 'env', variable: line.deliver.variable, secret: FAKE_A },
      })
    })
  }
})

// Epic plan Task 5, acceptance 6 (the server half): a restarted daemon holds no
// secret, so the server sends it again when the daemon reconnects.
describe('after the daemon reconnects (Task 5)', () => {
  async function liveSession(
    reg: SessionRegistry,
    credentialId: CredentialId | null,
  ): Promise<SessionId> {
    const { sessionId } = await reg.modules.sessions.createSession({
      agentKind: 'claude-code',
      cwd: '/p',
      credentialId,
    })
    await reg.gateway.routeDaemonFrame(reg.sessionStore.hostMachine!.id, {
      type: 'bind',
      sessionId,
      cmd: 'claude',
      cwd: '/p',
      agentKind: 'claude-code',
      geometry: { cols: 80, rows: 24 },
    })
    return sessionId
  }

  async function reconnect(reg: SessionRegistry): Promise<ControlMessage[]> {
    reg.gateway.detachDaemon(reg.sessionStore.hostMachine!.id)
    const after: ControlMessage[] = []
    await attachHostDaemon(reg, (m) => after.push(m))
    return after
  }

  const indexOf = (frames: ControlMessage[], type: string, sessionId: SessionId) =>
    frames.findIndex(
      (m) => m.type === type && (m as { sessionId?: string }).sessionId === sessionId,
    )

  it('a live session on a vault credential gets its access again, before its reattach', async () => {
    const store = await openTestStore(':memory:')
    const id = await credential(store, { type: 'anthropic.api-key', secret: FAKE_A })
    const { reg } = await makeRegistry(store)
    const keyed = await liveSession(reg, id)
    const bare = await liveSession(reg, null)
    const after = await reconnect(reg)

    const refresh = indexOf(after, 'sessionAccessRefresh', keyed)
    const reattach = indexOf(after, 'reattach', keyed)
    expect(reattach).toBeGreaterThanOrEqual(0)
    expect(refresh).toBeGreaterThanOrEqual(0)
    expect(refresh).toBeLessThan(reattach)
    expect(after[refresh]).toEqual({
      type: 'sessionAccessRefresh',
      sessionId: keyed,
      access: {
        credentialId: id,
        delivery: { kind: 'env', variable: 'ANTHROPIC_API_KEY', secret: FAKE_A },
      },
    })
    // A session on the harness's own login has nothing to refresh.
    expect(indexOf(after, 'reattach', bare)).toBeGreaterThanOrEqual(0)
    expect(indexOf(after, 'sessionAccessRefresh', bare)).toBe(-1)
  })

  it('a credential that can no longer be used sends no refresh, and the refusal is recorded', async () => {
    const store = await openTestStore(':memory:')
    const id = await credential(store, { type: 'anthropic.api-key', secret: FAKE_A })
    const { reg } = await makeRegistry(store)
    const keyed = await liveSession(reg, id)
    await store.credentials.setStatus(id, 'attention', 'expired')
    const after = await reconnect(reg)
    expect(indexOf(after, 'sessionAccessRefresh', keyed)).toBe(-1)
    expect(JSON.stringify(after)).not.toContain(FAKE_A)
    const refused = (await store.settingsAudit.list(100)).filter(
      (row) => row.command === 'credentials.refuse',
    )
    expect(refused.length).toBeGreaterThan(0)
  })

  it('commits exactly one durable audit per refresh before sending it', async () => {
    const store = await openTestStore(':memory:')
    const id = await credential(store, { type: 'anthropic.api-key', secret: FAKE_A })
    const { reg } = await makeRegistry(store)
    const ids = await Promise.all(Array.from({ length: 3 }, () => liveSession(reg, id)))
    const before = (await store.settingsAudit.list(100)).length
    const append = store.settingsAudit.append.bind(store.settingsAudit)
    const committed: SessionId[] = []
    const sent: SessionId[] = []
    const audit = vi.spyOn(store.settingsAudit, 'append').mockImplementation(async (row) => {
      await append(row)
      if (row.command === 'credentials.deliver') {
        committed.push((row.detail as { sessionId: SessionId }).sessionId)
      }
    })
    try {
      reg.gateway.detachDaemon(store.hostMachine!.id)
      await attachHostDaemon(reg, (message) => {
        if (message.type !== 'sessionAccessRefresh') return
        sent.push(message.sessionId)
        expect(committed).toEqual(sent)
      })
    } finally {
      audit.mockRestore()
    }
    expect([...sent].sort()).toEqual([...ids].sort())
    const added = (await store.settingsAudit.list(100)).slice(before)
    expect(added.filter((row) => row.command === 'credentials.deliver')).toHaveLength(ids.length)
  })

  // POD-7574: an exited row's reattach is a passive probe that almost always
  // fails, so its credential is read and audited only once the daemon binds it.
  describe('an exited session on a terminal driver', () => {
    const bindFrame = (sessionId: SessionId) => ({
      type: 'bind' as const,
      sessionId,
      cmd: 'claude',
      cwd: '/p',
      agentKind: 'claude-code' as const,
      geometry: { cols: 80, rows: 24 },
      // A daemon binds a driver for every profiled agent: this one proves a PTY.
      driverId: 'generic-pty',
    })

    async function exitedSessions(count: number) {
      const store = await openTestStore(':memory:')
      const id = await credential(store, { type: 'anthropic.api-key', secret: FAKE_A })
      const { reg } = await makeRegistry(store)
      const host = store.hostMachine!.id
      const sessionIds: SessionId[] = []
      for (let n = 0; n < count; n++) {
        const { sessionId } = await reg.modules.sessions.createSession({
          agentKind: 'claude-code',
          cwd: '/p',
          credentialId: id,
        })
        await reg.gateway.routeDaemonFrame(host, bindFrame(sessionId))
        await reg.gateway.routeDaemonFrame(host, { type: 'agentExit', sessionId, code: 0 })
        sessionIds.push(sessionId)
      }
      const before = (await store.settingsAudit.list(100)).length
      const audit = async (command: string) =>
        (await store.settingsAudit.list(100)).slice(before).filter((row) => row.command === command)
      return { store, id, reg, host, sessionIds, audit }
    }

    it('is probed without its access, and gets it only when the daemon binds it', async () => {
      const { id, reg, host, sessionIds, audit } = await exitedSessions(2)
      const [alive, dead] = sessionIds as [SessionId, SessionId]
      const after = await reconnect(reg)

      for (const sessionId of [alive, dead]) {
        expect(indexOf(after, 'reattach', sessionId)).toBeGreaterThanOrEqual(0)
        expect(indexOf(after, 'sessionAccessRefresh', sessionId)).toBe(-1)
      }
      expect(JSON.stringify(after)).not.toContain(FAKE_A)
      expect(await audit('credentials.deliver')).toHaveLength(0)

      // The dead one answers reattachFailed: nothing is read or recorded for it.
      // So does another reattach of the live one, before its probe's bind
      // (review F1): the frame names no attempt, and the debt stands.
      for (const sessionId of [dead, alive]) {
        await reg.gateway.routeDaemonFrame(host, {
          type: 'reattachFailed',
          sessionId,
          reason: 'session not found',
        })
      }
      // The live one binds: its access follows, after its audit row.
      await reg.gateway.routeDaemonFrame(host, bindFrame(alive))
      expect(indexOf(after, 'sessionAccessRefresh', alive)).toBeGreaterThan(
        indexOf(after, 'reattach', alive),
      )
      expect(after[indexOf(after, 'sessionAccessRefresh', alive)]).toEqual({
        type: 'sessionAccessRefresh',
        sessionId: alive,
        access: {
          credentialId: id,
          delivery: { kind: 'env', variable: 'ANTHROPIC_API_KEY', secret: FAKE_A },
        },
      })
      expect(indexOf(after, 'sessionAccessRefresh', dead)).toBe(-1)
      const delivered = await audit('credentials.deliver')
      expect(delivered).toHaveLength(1)
      expect(delivered[0]!.detail).toMatchObject({ sessionId: alive })
      // Owed once: the next bind sends nothing more.
      await reg.gateway.routeDaemonFrame(host, bindFrame(alive))
      expect(after.filter((m) => m.type === 'sessionAccessRefresh')).toHaveLength(1)
    })

    // Review F8: the credential is judged at the bind, not at the probe.
    it('is refused at the bind when its credential was revoked after the probe', async () => {
      const { store, id, reg, host, sessionIds, audit } = await exitedSessions(1)
      const [alive] = sessionIds as [SessionId]
      const after = await reconnect(reg)
      expect(indexOf(after, 'reattach', alive)).toBeGreaterThanOrEqual(0)
      await store.credentials.setStatus(id, 'revoked')
      await reg.gateway.routeDaemonFrame(host, bindFrame(alive))
      expect(after.filter((m) => m.type === 'sessionAccessRefresh')).toHaveLength(0)
      expect(JSON.stringify(after)).not.toContain(FAKE_A)
      expect(await audit('credentials.deliver')).toHaveLength(0)
      expect((await audit('credentials.refuse')).length).toBeGreaterThan(0)
    })
  })

  // Review F2: an exited row not proven a PTY keeps its refresh first, because
  // its reattach may be an engine adopt that waits for the credential.
  it('an exited session bound to no named driver gets its access before its reattach', async () => {
    const store = await openTestStore(':memory:')
    const id = await credential(store, { type: 'anthropic.api-key', secret: FAKE_A })
    const { reg } = await makeRegistry(store)
    const host = store.hostMachine!.id
    const sessionId = await liveSession(reg, id)
    await reg.gateway.routeDaemonFrame(host, { type: 'agentExit', sessionId, code: 0 })
    const after = await reconnect(reg)
    const refresh = indexOf(after, 'sessionAccessRefresh', sessionId)
    expect(refresh).toBeGreaterThanOrEqual(0)
    expect(refresh).toBeLessThan(indexOf(after, 'reattach', sessionId))
  })

  it('refuses a credential revoked while the probe loop yields', async () => {
    const store = await openTestStore(':memory:')
    const id = await credential(store, { type: 'anthropic.api-key', secret: FAKE_A })
    const { reg } = await makeRegistry(store)
    for (let i = 0; i < 3; i++) await liveSession(reg, id)
    const before = (await store.settingsAudit.list(100)).length
    const after: ControlMessage[] = []
    let now = 0
    let revoke: Promise<void> | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => now)
    const get = store.credentials.get.bind(store.credentials)
    const reader = vi.spyOn(store.credentials, 'get').mockImplementation(async (credentialId) => {
      // On an async engine the revoke's I/O can outlive the yield timer.
      if (revoke) await revoke
      return await get(credentialId)
    })
    try {
      reg.gateway.detachDaemon(store.hostMachine!.id)
      await attachHostDaemon(reg, (message) => {
        after.push(message)
        if (message.type === 'sessionAccessRefresh' && timer === undefined) {
          now += 12
          timer = setTimeout(() => {
            revoke = store.credentials.setStatus(id, 'revoked')
          }, 0)
        }
      })
      await revoke
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      reader.mockRestore()
      clock.mockRestore()
    }
    expect(revoke).toBeDefined()
    expect(after.filter((message) => message.type === 'sessionAccessRefresh')).toHaveLength(1)
    expect(after.filter((message) => message.type === 'reattach')).toHaveLength(3)
    const added = (await store.settingsAudit.list(100)).slice(before)
    expect(added.filter((row) => row.command === 'credentials.deliver')).toHaveLength(1)
    expect(added.filter((row) => row.command === 'credentials.refuse')).toHaveLength(2)
  })
})
