import type { AgentKind } from '@podium/model'
import { asAccountId, firstAdminMemberId } from '@podium/model'
import type { ControlMessage } from '@podium/protocol/daemon'
import { afterEach, expect, it } from 'vitest'
import { SessionRegistry } from '../../relay'
import type { SessionStore } from '../../store'
import { openTestStore } from '../../test-support/open-test-store'

const registries: SessionRegistry[] = []

afterEach(async () => {
  for (const registry of registries.splice(0)) await registry.dispose()
})

async function storeWithClaudeDefaults(accountId = 'native:claude-code'): Promise<SessionStore> {
  const store = await openTestStore(':memory:')
  const settings = await store.settings.getSettings()
  await store.settings.setSettings({
    ...settings,
    roles: {
      ...settings.roles,
      coding: {
        ...settings.roles.coding,
        accountId: asAccountId(accountId),
        harness: 'codex',
        model: 'claude-opus-4-8',
        effort: 'xhigh',
      },
    },
  })
  return store
}

async function makeRegistry(store: SessionStore): Promise<{
  registry: SessionRegistry
  daemon: ControlMessage[]
}> {
  const registry = await SessionRegistry.create(store, undefined, { instanceId: 'default' })
  registries.push(registry)
  const daemon: ControlMessage[] = []
  await registry.gateway.attachDaemon(registry.sessionStore.hostMachineId, (message) =>
    daemon.push(message),
  )
  return { registry, daemon }
}

function latestSpawn(daemon: ControlMessage[]): Extract<ControlMessage, { type: 'spawn' }> {
  const frame = daemon.filter((message) => message.type === 'spawn').at(-1)
  expect(frame).toBeDefined()
  return frame as Extract<ControlMessage, { type: 'spawn' }>
}

async function createFrame(
  agentKind: AgentKind,
  override: { model?: string; effort?: string } = {},
): Promise<Extract<ControlMessage, { type: 'spawn' }>> {
  const { registry, daemon } = await makeRegistry(await storeWithClaudeDefaults())
  await registry.modules.sessions.createSession({ ownerUserId: firstAdminMemberId(), agentKind, cwd: '/proj', ...override })
  return latestSpawn(daemon)
}

async function resurrectFrame(agentKind: 'claude-code' | 'codex') {
  const { registry, daemon } = await makeRegistry(await storeWithClaudeDefaults())
  const resume =
    agentKind === 'codex'
      ? ({ kind: 'codex-thread', value: 'thread-1' } as const)
      : ({ kind: 'claude-session', value: 'session-1' } as const)
  const { sessionId } = await registry.modules.issueSessionLifecycle.resumeSession({
    agentKind,
    cwd: '/proj',
    resume,
    conversationId: 'conversation-1',
  })
  await registry.gateway.routeDaemonFrame(registry.sessionStore.hostMachineId, {
    type: 'bind',
    sessionId,
    cmd: agentKind === 'codex' ? 'codex' : 'claude',
    cwd: '/proj',
    agentKind,
    geometry: { cols: 80, rows: 24 },
  })
  expect(await registry.modules.sessions.hibernateSession({ sessionId })).toEqual({ ok: true })
  expect(await registry.modules.issueSessionLifecycle.resurrectSession({ sessionId })).toEqual({
    ok: true,
  })
  return latestSpawn(daemon)
}

it('passes configured model and effort to the configured default harness', async () => {
  const frame = await createFrame('claude-code')
  expect(frame.model).toBe('claude-opus-4-8')
  expect(frame.effort).toBe('xhigh')
})

it('inherits configured defaults from auto issue overrides on the configured harness', async () => {
  const frame = await createFrame('claude-code', { model: 'auto', effort: 'auto' })
  expect(frame.model).toBe('claude-opus-4-8')
  expect(frame.effort).toBe('xhigh')
})

it('omits configured model and effort when another harness is selected', async () => {
  const frame = await createFrame('codex')
  expect(Object.hasOwn(frame, 'model')).toBe(false)
  expect(Object.hasOwn(frame, 'effort')).toBe(false)
})

it('resolves an omitted incompatible native role account to the selected agent', async () => {
  const { registry } = await makeRegistry(await storeWithClaudeDefaults())
  const { sessionId } = await registry.modules.sessions.createSession({
    ownerUserId: firstAdminMemberId(),
    agentKind: 'opencode',
    cwd: '/proj',
  })
  expect((await registry.sessionStore.sessions.getSession(sessionId))?.accountId).toBe('native:opencode')
})

it('normalizes an omitted colliding native harness prefix', async () => {
  const { registry } = await makeRegistry(await storeWithClaudeDefaults('native:opencodeevil'))
  const { sessionId } = await registry.modules.sessions.createSession({
    ownerUserId: firstAdminMemberId(),
    agentKind: 'opencode',
    cwd: '/proj',
  })
  expect((await registry.sessionStore.sessions.getSession(sessionId))?.accountId).toBe('native:opencode')
})

/**
 * A MANAGED SLOT NEEDS A ROW FOR THE SESSION'S OWNER, OR THE SPAWN REFUSES
 * (PDM-280, PDM-316).
 *
 * `resolveAccountEnv` used to return `{}` for an absent credential row; since
 * PDM-280 it throws, by name, and never borrows another person's key. That made
 * this file's `managed:anthropic` row red: it selects a managed slot and
 * connects nothing, so the spawn is refused before the account id it exists to
 * check is ever stored. The refusal is correct — the repair is to connect the
 * credential, not to soften what the case asserts. The two sibling `native:`
 * rows are green either way: `resolveAccountEnv` returns `{}` for a non-managed
 * id and never reaches the lookup.
 */
const MANAGED_ANTHROPIC = {
  id: asAccountId('managed:anthropic'),
  provider: 'anthropic',
  kind: 'api-key',
  credential: 'sk-ant-managed',
  identity: 'billing@example.com',
  scope: 'role',
  createdAt: 1,
} as const

it.each([
  'native:opencode',
  'native:claude-code',
  'managed:anthropic',
])('preserves the explicit account %s exactly', async (accountId) => {
  // ONE owner value, used three times: the credential is connected for this
  // person, the session is started for this person, and the row is asserted to
  // belong to this person. PDM-276 made the owner explicit here; seeding under
  // the same expression rather than re-deriving it from the store is what makes
  // "the credential follows the session's owner" true by construction in this
  // fixture instead of by two lookups agreeing.
  const owner = firstAdminMemberId()
  const store = await storeWithClaudeDefaults()
  if (accountId.startsWith('managed:')) await store.accounts.upsert(owner, MANAGED_ANTHROPIC)
  const { registry, daemon } = await makeRegistry(store)
  const { sessionId } = await registry.modules.sessions.createSession({
    ownerUserId: owner,
    agentKind: 'opencode',
    cwd: '/proj',
    accountId: asAccountId(accountId),
    runtimeContract: 'opencode-server',
  })
  const session = await registry.sessionStore.sessions.getSession(sessionId)
  expect(latestSpawn(daemon)).toMatchObject({ runtimeContract: 'opencode-server' })
  expect(session?.accountId).toBe(accountId)
  // PIN THE PROPERTY THE SEED ABOVE RELIES ON (false-green catalogue #19): the
  // credential was connected for `owner`, so this case only stays green while
  // the session created here is owned by that same person. If `create()` ever
  // stores a different owner than the one it was given, this line says so by
  // name instead of the managed row quietly reverting to a refusal that looks
  // like a stale fixture. It is a tripwire, not the witness: that the credential
  // follows the SESSION'S owner rather than the first admin is proved next door
  // in `spawn-account-env.test.ts`, where a stranger is refused the admin's key
  // and spawns on their own.
  expect(session?.ownerUserId).toBe(owner)
})

it('keeps auto issue overrides isolated from another harness', async () => {
  const frame = await createFrame('codex', { model: 'auto', effort: 'auto' })
  expect(Object.hasOwn(frame, 'model')).toBe(false)
  expect(Object.hasOwn(frame, 'effort')).toBe(false)
})

it('keeps explicit overrides on another harness without filling missing defaults', async () => {
  const frame = await createFrame('codex', { model: 'gpt-5.5' })
  expect(frame.model).toBe('gpt-5.5')
  expect(Object.hasOwn(frame, 'effort')).toBe(false)
})

it('omits configured defaults when resurrecting another harness', async () => {
  const frame = await resurrectFrame('codex')
  expect(Object.hasOwn(frame, 'model')).toBe(false)
  expect(Object.hasOwn(frame, 'effort')).toBe(false)
})

it('restores configured defaults when resurrecting the configured harness', async () => {
  const frame = await resurrectFrame('claude-code')
  expect(frame.model).toBe('claude-opus-4-8')
  expect(frame.effort).toBe('xhigh')
})
