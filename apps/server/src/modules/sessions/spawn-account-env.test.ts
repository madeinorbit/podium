/**
 * The managed-credential WIRING (#216): resolveAccountEnv is unit-tested next
 * door, but the thing that actually pays the bill is the `...this.accountEnv()`
 * spread inside the spawn frame — and there are TWO of them (fresh spawn and
 * resurrect). Drop either and every other test in the repo still passes while
 * managed accounts silently fall back to whatever native login the machine has.
 *
 * These tests observe the real control frame the daemon receives, through the
 * production registry, at BOTH spawn sites:
 *   - POSITIVE: a managed account on the coding role puts its credential in `env`.
 *   - NEGATIVE: a native account leaves `env` ABSENT (not `{}`) — the pre-#216
 *     frame shape every existing user already spawns with.
 */

import { asAccountId, asUserId, firstAdminMemberId } from '@podium/model'
import type { ControlMessage } from '@podium/protocol/daemon'
import { afterEach, expect, it } from 'vitest'
import { SessionRegistry } from '../../relay'
import type { SessionStore } from '../../store'
import { type ManagedAccountWrite, SHARED_WITH_EVERYONE } from '../../store/accounts'
import { attachHostDaemon } from '../../test-support/host-daemon'
import { openTestStore } from '../../test-support/open-test-store'
import { MissingManagedKeyError } from './account-env'

const registries: SessionRegistry[] = []
afterEach(async () => {
  for (const r of registries.splice(0)) await r.dispose()
})

/** Another user of the instance: not the sessions' owner. */
const OTHER = asUserId('user:spawn-account-other')

/** A stored key; `owner` defaults to the sessions' owner (the first admin). */
type SeededKey = Omit<ManagedAccountWrite, 'ownerUserId'> & {
  owner?: ManagedAccountWrite['ownerUserId']
  sharedWith?: readonly string[]
}

/** A store whose coding role points at `accountId`, with the managed rows seeded. */
async function storeWith(accountId: string, ...accounts: SeededKey[]): Promise<SessionStore> {
  const store = await openTestStore(':memory:')
  const sessionOwner = await firstAdminMemberId(store)
  for (const { owner, sharedWith, ...a } of accounts) {
    const ownerUserId = owner ?? sessionOwner
    await store.accounts.connect({ ...a, ownerUserId })
    if (sharedWith) {
      await store.accounts.share(ownerUserId, a.accountKey, sharedWith)
      // The owner explicitly sends a shared key to the recipient's host. A
      // share alone never waives foreign-machine consent (POD-6300).
      await store.accounts.markSent(
        ownerUserId,
        a.accountKey,
        store.hostMachineId,
        '2026-11-03T00:00:00.000Z',
      )
    }
  }
  const settings = await store.settings.getSettings()
  await store.settings.setSettings({
    ...settings,
    roles: {
      ...settings.roles,
      coding: { ...settings.roles.coding, accountId: asAccountId(accountId) },
    },
  })
  return store
}

/** The connection of the instance's one member, who starts these sessions. */
const MANAGED_ANTHROPIC = {
  accountKey: asAccountId('managed:anthropic'),
  provider: 'anthropic',
  kind: 'api-key',
  credential: 'sk-ant-managed',
  identity: 'billing@example.com',
  scope: 'role',
  createdAt: 1,
} as const

/** Registry + the daemon's inbox of control frames. */
async function makeRegistry(
  store: SessionStore,
): Promise<{ reg: SessionRegistry; daemon: ControlMessage[] }> {
  const reg = await SessionRegistry.create(store, undefined, { instanceId: 'default' })
  registries.push(reg)
  const daemon: ControlMessage[] = []
  await attachHostDaemon(reg, (m) => daemon.push(m))
  return { reg, daemon }
}

const spawns = (daemon: ControlMessage[]) => daemon.filter((m) => m.type === 'spawn')

/** The frame for a fresh create (call site 1: SessionLifecycle.spawn). */
async function createFrame(
  store: SessionStore,
  agentKind: 'claude-code' | 'shell' = 'claude-code',
) {
  const { reg, daemon } = await makeRegistry(store)
  await reg.modules.sessions.createSession({ agentKind, cwd: '/proj' })
  const frame = spawns(daemon).at(-1)
  expect(frame).toBeDefined()
  return frame as Extract<ControlMessage, { type: 'spawn' }>
}

/** A codex session, bound and then hibernated: ready for a wake. */
async function hibernatedSession(store: SessionStore) {
  const { reg, daemon } = await makeRegistry(store)
  const { sessionId } = await reg.modules.issueSessionLifecycle.resumeSession({
    agentKind: 'codex',
    cwd: '/proj',
    resume: { kind: 'codex-thread', value: 't1' },
    conversationId: 'c1',
  })
  await reg.gateway.routeDaemonFrame(reg.sessionStore.hostMachineId, {
    type: 'bind',
    sessionId,
    cmd: 'codex',
    cwd: '/proj',
    agentKind: 'codex',
    geometry: { cols: 80, rows: 24 },
  })
  expect(await reg.modules.sessions.hibernateSession({ sessionId })).toEqual({ ok: true })
  return { reg, daemon, sessionId }
}

/** The frame for a wake (call site 2: SessionLifecycle.resurrectSession). */
async function resurrectFrame(store: SessionStore) {
  const { reg, daemon, sessionId } = await hibernatedSession(store)
  const before = spawns(daemon).length
  expect(await reg.modules.issueSessionLifecycle.resurrectSession({ sessionId })).toEqual({
    ok: true,
  })
  const frame = spawns(daemon).at(-1)
  // A wake really did re-spawn — otherwise we'd be asserting on the create frame.
  expect(spawns(daemon).length).toBe(before + 1)
  expect(frame).toBeDefined()
  return frame as Extract<ControlMessage, { type: 'spawn' }>
}

it('createSession injects the managed credential into the spawn frame (#216)', async () => {
  const frame = await createFrame(await storeWith('managed:anthropic', MANAGED_ANTHROPIC))
  expect(frame.env).toEqual({ ANTHROPIC_API_KEY: 'sk-ant-managed' })
})

it('resurrectSession injects the managed credential into the spawn frame (#216)', async () => {
  const frame = await resurrectFrame(await storeWith('managed:anthropic', MANAGED_ANTHROPIC))
  expect(frame.env).toEqual({ ANTHROPIC_API_KEY: 'sk-ant-managed' })
})

it('createSession on a NATIVE account leaves env absent — not an empty object', async () => {
  const frame = await createFrame(await storeWith('native:claude-code'))
  expect(Object.hasOwn(frame, 'env')).toBe(false)
})

it('resurrectSession on a NATIVE account leaves env absent — not an empty object', async () => {
  const frame = await resurrectFrame(await storeWith('native:claude-code'))
  expect(Object.hasOwn(frame, 'env')).toBe(false)
})

/**
 * A SHELL pane is an interactive prompt the user drives, not an agent harness.
 * Injecting the coding role's credential into it puts the plaintext secret one
 * `env` away from the browser — and into persisted scrollback. The credential is
 * for the harness; a shell never gets it.
 */
it('never injects the managed credential into a SHELL pane (#216)', async () => {
  const frame = await createFrame(await storeWith('managed:anthropic', MANAGED_ANTHROPIC), 'shell')
  expect(frame.agentKind).toBe('shell')
  expect(Object.hasOwn(frame, 'env')).toBe(false)
  expect(JSON.stringify(frame)).not.toContain('sk-ant-managed')
})

// ---- WHOSE KEY (POD-6360, user decision 2026-11-04) -------------------------
// The session owner's own key first, then a key explicitly shared with them;
// another user's unshared key never; with neither, the spawn is refused with
// the missing key named, before anything is persisted or sent.

it("createSession uses a key another user explicitly shares with everyone", async () => {
  const frame = await createFrame(
    await storeWith('managed:anthropic', {
      ...MANAGED_ANTHROPIC,
      owner: OTHER,
      credential: 'sk-ant-shared',
      sharedWith: [SHARED_WITH_EVERYONE],
    }),
  )
  expect(frame.env).toEqual({ ANTHROPIC_API_KEY: 'sk-ant-shared' })
})

it("createSession prefers the owner's own key over a shared one", async () => {
  const frame = await createFrame(
    await storeWith(
      'managed:anthropic',
      { ...MANAGED_ANTHROPIC, owner: OTHER, credential: 'sk-ant-shared', sharedWith: ['*'] },
      { ...MANAGED_ANTHROPIC, credential: 'sk-ant-own' },
    ),
  )
  expect(frame.env).toEqual({ ANTHROPIC_API_KEY: 'sk-ant-own' })
})

it("createSession never uses another user's unshared key: refused, nothing persisted or sent", async () => {
  const store = await storeWith('managed:anthropic', {
    ...MANAGED_ANTHROPIC,
    owner: OTHER,
    credential: 'sk-ant-not-yours',
  })
  const { reg, daemon } = await makeRegistry(store)
  const sessionsBefore = (await store.sessions.loadSessions()).length
  const refusal = reg.modules.sessions.createSession({ agentKind: 'claude-code', cwd: '/proj' })
  await expect(refusal).rejects.toBeInstanceOf(MissingManagedKeyError)
  await expect(refusal).rejects.toThrow(/No Anthropic API key is available to you/)
  expect(spawns(daemon)).toEqual([])
  expect((await store.sessions.loadSessions()).length).toBe(sessionsBefore)
  expect(JSON.stringify(daemon)).not.toContain('sk-ant-not-yours')
})

it('a revoked share stops the next wake, with the reason, and sends no spawn', async () => {
  const store = await storeWith('managed:anthropic', {
    ...MANAGED_ANTHROPIC,
    owner: OTHER,
    credential: 'sk-ant-shared',
    sharedWith: [SHARED_WITH_EVERYONE],
  })
  const { reg, daemon, sessionId } = await hibernatedSession(store)
  expect(await store.accounts.share(OTHER, MANAGED_ANTHROPIC.accountKey, [])).toBe(true)
  const before = spawns(daemon).length
  const result = await reg.modules.issueSessionLifecycle.resurrectSession({ sessionId })
  expect(result).toMatchObject({ ok: false })
  expect((result as { reason?: string }).reason).toMatch(/No Anthropic API key is available to you/)
  expect(spawns(daemon).length).toBe(before)
})
