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

import type { ControlMessage } from '@podium/protocol'
import { afterEach, expect, it } from 'vitest'
import { SessionRegistry } from '../../relay'
import { SessionStore } from '../../store'

const registries: SessionRegistry[] = []
afterEach(() => {
  for (const r of registries.splice(0)) r.dispose()
})

/** A store whose coding role points at `accountId`, with the managed rows seeded. */
function storeWith(
  accountId: string,
  ...accounts: Array<Parameters<SessionStore['accounts']['upsert']>[0]>
): SessionStore {
  const store = new SessionStore(':memory:')
  for (const a of accounts) store.accounts.upsert(a)
  const settings = store.settings.getSettings()
  store.settings.setSettings({
    ...settings,
    roles: { ...settings.roles, coding: { ...settings.roles.coding, accountId } },
  })
  return store
}

const MANAGED_ANTHROPIC = {
  id: 'managed:anthropic',
  provider: 'anthropic',
  kind: 'api-key',
  credential: 'sk-ant-managed',
  identity: 'billing@example.com',
  scope: 'role',
  createdAt: 1,
} as const

/** Registry + the daemon's inbox of control frames. */
function makeRegistry(store: SessionStore): { reg: SessionRegistry; daemon: ControlMessage[] } {
  const reg = new SessionRegistry(store)
  registries.push(reg)
  const daemon: ControlMessage[] = []
  reg.modules.sessions.attachDaemon('local', (m) => daemon.push(m))
  return { reg, daemon }
}

const spawns = (daemon: ControlMessage[]) => daemon.filter((m) => m.type === 'spawn')

/** The frame for a fresh create (call site 1: SessionsService.spawn). */
function createFrame(store: SessionStore, agentKind: 'claude-code' | 'shell' = 'claude-code') {
  const { reg, daemon } = makeRegistry(store)
  reg.modules.sessions.createSession({ agentKind, cwd: '/proj' })
  const frame = spawns(daemon).at(-1)
  expect(frame).toBeDefined()
  return frame as Extract<ControlMessage, { type: 'spawn' }>
}

/** The frame for a wake (call site 2: SessionsService.resurrectSession). */
function resurrectFrame(store: SessionStore) {
  const { reg, daemon } = makeRegistry(store)
  const { sessionId } = reg.modules.sessions.resumeSession({
    agentKind: 'codex',
    cwd: '/proj',
    resume: { kind: 'codex-thread', value: 't1' },
    conversationId: 'c1',
  })
  reg.modules.sessions.onDaemonMessageFrom('local', {
    type: 'bind',
    sessionId,
    cmd: 'codex',
    cwd: '/proj',
    agentKind: 'codex',
    geometry: { cols: 80, rows: 24 },
  })
  expect(reg.modules.sessions.hibernateSession({ sessionId })).toEqual({ ok: true })
  const before = spawns(daemon).length
  expect(reg.modules.sessions.resurrectSession({ sessionId })).toEqual({ ok: true })
  const frame = spawns(daemon).at(-1)
  // A wake really did re-spawn — otherwise we'd be asserting on the create frame.
  expect(spawns(daemon).length).toBe(before + 1)
  expect(frame).toBeDefined()
  return frame as Extract<ControlMessage, { type: 'spawn' }>
}

it('createSession injects the managed credential into the spawn frame (#216)', () => {
  const frame = createFrame(storeWith('managed:anthropic', MANAGED_ANTHROPIC))
  expect(frame.env).toEqual({ ANTHROPIC_API_KEY: 'sk-ant-managed' })
})

it('resurrectSession injects the managed credential into the spawn frame (#216)', () => {
  const frame = resurrectFrame(storeWith('managed:anthropic', MANAGED_ANTHROPIC))
  expect(frame.env).toEqual({ ANTHROPIC_API_KEY: 'sk-ant-managed' })
})

it('createSession on a NATIVE account leaves env absent — not an empty object', () => {
  const frame = createFrame(storeWith('native:claude-code'))
  expect(Object.hasOwn(frame, 'env')).toBe(false)
})

it('resurrectSession on a NATIVE account leaves env absent — not an empty object', () => {
  const frame = resurrectFrame(storeWith('native:claude-code'))
  expect(Object.hasOwn(frame, 'env')).toBe(false)
})

/**
 * A SHELL pane is an interactive prompt the user drives, not an agent harness.
 * Injecting the coding role's credential into it puts the plaintext secret one
 * `env` away from the browser — and into persisted scrollback. The credential is
 * for the harness; a shell never gets it.
 */
it('never injects the managed credential into a SHELL pane (#216)', () => {
  const frame = createFrame(storeWith('managed:anthropic', MANAGED_ANTHROPIC), 'shell')
  expect(frame.agentKind).toBe('shell')
  expect(Object.hasOwn(frame, 'env')).toBe(false)
  expect(JSON.stringify(frame)).not.toContain('sk-ant-managed')
})
