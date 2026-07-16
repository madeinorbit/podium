import type { AgentKind, ControlMessage } from '@podium/protocol'
import { afterEach, expect, it } from 'vitest'
import { SessionRegistry } from '../../relay'
import { SessionStore } from '../../store'

const registries: SessionRegistry[] = []

afterEach(() => {
  for (const registry of registries.splice(0)) registry.dispose()
})

function storeWithClaudeDefaults(): SessionStore {
  const store = new SessionStore(':memory:')
  const settings = store.settings.getSettings()
  store.settings.setSettings({
    ...settings,
    roles: {
      ...settings.roles,
      coding: {
        ...settings.roles.coding,
        accountId: 'native:claude-code',
        harness: 'codex',
        model: 'claude-opus-4-8',
        effort: 'xhigh',
      },
    },
  })
  return store
}

function makeRegistry(store: SessionStore): {
  registry: SessionRegistry
  daemon: ControlMessage[]
} {
  const registry = new SessionRegistry(store)
  registries.push(registry)
  const daemon: ControlMessage[] = []
  registry.modules.sessions.attachDaemon('local', (message) => daemon.push(message))
  return { registry, daemon }
}

function latestSpawn(daemon: ControlMessage[]): Extract<ControlMessage, { type: 'spawn' }> {
  const frame = daemon.filter((message) => message.type === 'spawn').at(-1)
  expect(frame).toBeDefined()
  return frame as Extract<ControlMessage, { type: 'spawn' }>
}

function createFrame(
  agentKind: AgentKind,
  override: { model?: string; effort?: string } = {},
): Extract<ControlMessage, { type: 'spawn' }> {
  const { registry, daemon } = makeRegistry(storeWithClaudeDefaults())
  registry.modules.sessions.createSession({ agentKind, cwd: '/proj', ...override })
  return latestSpawn(daemon)
}

function resurrectFrame(agentKind: 'claude-code' | 'codex') {
  const { registry, daemon } = makeRegistry(storeWithClaudeDefaults())
  const resume =
    agentKind === 'codex'
      ? ({ kind: 'codex-thread', value: 'thread-1' } as const)
      : ({ kind: 'claude-session', value: 'session-1' } as const)
  const { sessionId } = registry.modules.sessions.resumeSession({
    agentKind,
    cwd: '/proj',
    resume,
    conversationId: 'conversation-1',
  })
  registry.modules.sessions.onDaemonMessageFrom('local', {
    type: 'bind',
    sessionId,
    cmd: agentKind === 'codex' ? 'codex' : 'claude',
    cwd: '/proj',
    agentKind,
    geometry: { cols: 80, rows: 24 },
  })
  expect(registry.modules.sessions.hibernateSession({ sessionId })).toEqual({ ok: true })
  expect(registry.modules.sessions.resurrectSession({ sessionId })).toEqual({ ok: true })
  return latestSpawn(daemon)
}

it('passes configured model and effort to the configured default harness', () => {
  const frame = createFrame('claude-code')
  expect(frame.model).toBe('claude-opus-4-8')
  expect(frame.effort).toBe('xhigh')
})

it('omits configured model and effort when another harness is selected', () => {
  const frame = createFrame('codex')
  expect(Object.hasOwn(frame, 'model')).toBe(false)
  expect(Object.hasOwn(frame, 'effort')).toBe(false)
})

it('keeps explicit overrides on another harness without filling missing defaults', () => {
  const frame = createFrame('codex', { model: 'gpt-5.5' })
  expect(frame.model).toBe('gpt-5.5')
  expect(Object.hasOwn(frame, 'effort')).toBe(false)
})

it('omits configured defaults when resurrecting another harness', () => {
  const frame = resurrectFrame('codex')
  expect(Object.hasOwn(frame, 'model')).toBe(false)
  expect(Object.hasOwn(frame, 'effort')).toBe(false)
})
