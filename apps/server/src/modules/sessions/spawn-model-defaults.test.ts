import type { AgentKind } from '@podium/model'
import { asAccountId, firstAdminMemberId } from '@podium/model'
import type { ControlMessage } from '@podium/protocol/daemon'
import { afterEach, expect, it } from 'vitest'
import { SessionRegistry } from '../../relay'
import type { SessionStore } from '../../store'
import { attachHostDaemon } from '../../test-support/host-daemon'
import { openTestStore } from '../../test-support/open-test-store'
import { sealCredentialSecret } from '../credentials/vault'

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
  await attachHostDaemon(registry, (message) => daemon.push(message))
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
  await registry.modules.sessions.createSession({ agentKind, cwd: '/proj', ...override })
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
  await registry.gateway.routeDaemonFrame(registry.sessionStore.hostMachine!.id, {
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

it('an omitted role account for another harness means no credential', async () => {
  const { registry } = await makeRegistry(await storeWithClaudeDefaults())
  const { sessionId } = await registry.modules.sessions.createSession({
    agentKind: 'opencode',
    cwd: '/proj',
  })
  const row = await registry.sessionStore.sessions.getSession(sessionId)
  expect(row?.credentialId ?? null).toBeNull()
  expect(row?.accountId ?? null).toBeNull()
})

it('a colliding native harness prefix in the role names no credential', async () => {
  const { registry } = await makeRegistry(await storeWithClaudeDefaults('native:opencodeevil'))
  const { sessionId } = await registry.modules.sessions.createSession({
    agentKind: 'opencode',
    cwd: '/proj',
  })
  expect(
    (await registry.sessionStore.sessions.getSession(sessionId))?.credentialId ?? null,
  ).toBeNull()
})

it('keeps the credential the launch names, and the requested driver', async () => {
  const store = await storeWithClaudeDefaults()
  const named = await store.credentials.insert({
    ownerUserId: await firstAdminMemberId(store),
    label: 'OpenRouter',
    type: 'openrouter.api-key',
  })
  expect(await sealCredentialSecret(store, named, 'sk-FAKE-openrouter-0003', 0)).toBe(1)
  const { registry, daemon } = await makeRegistry(store)
  const { sessionId } = await registry.modules.sessions.createSession({
    agentKind: 'opencode',
    cwd: '/proj',
    credentialId: named.id,
    requestedDriverId: 'opencode-server',
  })
  // The key rides the spawn's `access` field, never its env (credential management §9).
  expect(latestSpawn(daemon)).toMatchObject({
    requestedDriverId: 'opencode-server',
    access: {
      credentialId: named.id,
      delivery: { kind: 'env', variable: 'OPENROUTER_API_KEY', secret: 'sk-FAKE-openrouter-0003' },
    },
  })
  expect((await registry.sessionStore.sessions.getSession(sessionId))?.credentialId).toBe(named.id)
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

it('omits configured defaults when resurrecting the configured harness', async () => {
  const frame = await resurrectFrame('claude-code')
  expect(Object.hasOwn(frame, 'model')).toBe(false)
  expect(Object.hasOwn(frame, 'effort')).toBe(false)
})
