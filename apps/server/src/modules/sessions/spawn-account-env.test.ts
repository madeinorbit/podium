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

import { asAccountId, asUserId, firstAdminMemberId, type UserId } from '@podium/model'
import type { ControlMessage } from '@podium/protocol/daemon'
import { afterEach, expect, it } from 'vitest'
import { SessionRegistry } from '../../relay'
import type { SessionStore } from '../../store'
import { openTestStore } from '../../test-support/open-test-store'

const registries: SessionRegistry[] = []
afterEach(async () => {
  for (const r of registries.splice(0)) await r.dispose()
})

/**
 * A store whose coding role points at `accountId`, with the managed rows seeded
 * FOR THE OWNER THE SPAWN WILL RESOLVE (PDM-280).
 *
 * That owner is the instance's first admin here, because `createSession` is
 * called below without an explicit `ownerUserId` and `create()`'s last-term
 * fallback resolves one (PDM-276 owns closing that). Seeding under any other id
 * would make every positive case below fail for a reason unrelated to the wiring
 * they exist to pin.
 */
async function storeWith(
  accountId: string,
  ...accounts: Array<Parameters<SessionStore['accounts']['upsert']>[1]>
): Promise<SessionStore> {
  const store = await openTestStore(':memory:')
  const owner = await firstAdminMemberId(store)
  for (const a of accounts) await store.accounts.upsert(owner, a)
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

const MANAGED_ANTHROPIC = {
  id: asAccountId('managed:anthropic'),
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
  await reg.gateway.attachDaemon(reg.sessionStore.hostMachineId, (m) => daemon.push(m))
  return { reg, daemon }
}

const spawns = (daemon: ControlMessage[]) => daemon.filter((m) => m.type === 'spawn')

/** The frame for a fresh create (call site 1: SessionLifecycle.spawn). */
async function createFrame(
  store: SessionStore,
  agentKind: 'claude-code' | 'shell' = 'claude-code',
) {
  const { reg, daemon } = await makeRegistry(store)
  await reg.modules.sessions.createSession({ ownerUserId: firstAdminMemberId(), agentKind, cwd: '/proj' })
  const frame = spawns(daemon).at(-1)
  expect(frame).toBeDefined()
  return frame as Extract<ControlMessage, { type: 'spawn' }>
}

/** The frame for a wake (call site 2: SessionLifecycle.resurrectSession). */
async function resurrectFrame(store: SessionStore) {
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

/**
 * THE REFUSAL AT THE WIRING (PDM-280), which is where it has to be provable:
 * `resolveAccountEnv` throwing is a unit fact, but what matters is that the
 * spawn does not happen and the frame carrying somebody else's key is never
 * built.
 */
it('refuses to spawn for an owner with no credential, rather than borrowing the admin’s', async () => {
  const store = await storeWith('managed:anthropic', MANAGED_ANTHROPIC)
  const { reg, daemon } = await makeRegistry(store)
  const before = spawns(daemon).length
  const stranger: UserId = asUserId('mem_stranger')

  await expect(
    reg.modules.sessions.createSession({
      agentKind: 'claude-code',
      cwd: '/proj',
      ownerUserId: stranger,
    }),
  ).rejects.toThrow(/no managed credential for 'anthropic'/)

  // NOT MERELY "no env": no spawn frame at all, and the credential that was
  // sitting in the store one row away never reached the daemon.
  expect(spawns(daemon).length).toBe(before)
  expect(JSON.stringify(daemon)).not.toContain('sk-ant-managed')
})

it('still spawns for an owner who has their OWN credential at that slot', async () => {
  // The other direction: the refusal above must be about the missing row, not
  // about the caller being someone other than the first admin.
  const store = await storeWith('managed:anthropic', MANAGED_ANTHROPIC)
  const stranger: UserId = asUserId('mem_stranger')
  await store.accounts.upsert(stranger, { ...MANAGED_ANTHROPIC, credential: 'sk-ant-stranger' })
  const { reg, daemon } = await makeRegistry(store)

  await reg.modules.sessions.createSession({
    agentKind: 'claude-code',
    cwd: '/proj',
    ownerUserId: stranger,
  })

  const frame = spawns(daemon).at(-1) as Extract<ControlMessage, { type: 'spawn' }>
  expect(frame.env).toEqual({ ANTHROPIC_API_KEY: 'sk-ant-stranger' })
})
