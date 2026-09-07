/**
 * Spawner-prescribed child session name at createSession [spec:SP-4ef9][spec:SP-eb60].
 * Lands in the curated `name` slot with nameSource='agent' — not the derived title.
 * Reuses setAgentName rules: user-set names stay sovereign.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { SessionRegistry } from '../../relay'

const registries: SessionRegistry[] = []

afterEach(async () => {
  for (const r of registries.splice(0)) await r.dispose()
})

async function makeRegistry(): Promise<SessionRegistry> {
  const registry = await SessionRegistry.create(undefined, undefined, { instanceId: 'default' })
  registries.push(registry)
  registry.gateway.attachDaemon(registry.sessionStore.hostMachineId, () => {})
  return registry
}

describe('createSession name (spawner-prescribed curated slot)', () => {
  it('lands in name with nameSource=agent, not the derived title', async () => {
    const reg = await makeRegistry()
    const { sessionId } = await reg.modules.sessions.createSession({
      agentKind: 'shell',
      cwd: '/proj',
      name: '  Spawn placement worker  ',
    })
    const meta = (await reg.modules.sessions.listSessions()).find((s) => s.sessionId === sessionId)
    expect(meta?.name).toBe('Spawn placement worker')
    expect(meta?.nameSource).toBe('agent')
    // Derived title is still the cwd basename default — name is the curated slot.
    expect(meta?.title).toBe('proj')
  })

  it('omits name when not passed (unchanged self-title path)', async () => {
    const reg = await makeRegistry()
    const { sessionId } = await reg.modules.sessions.createSession({
      agentKind: 'shell',
      cwd: '/proj',
    })
    const meta = (await reg.modules.sessions.listSessions()).find((s) => s.sessionId === sessionId)
    expect(meta?.name).toBeUndefined()
    expect(meta?.nameSource).toBeUndefined()
  })

  it('rejects empty / whitespace-only names before spawning', async () => {
    const reg = await makeRegistry()
    expect(() =>
      reg.modules.sessions.createSession({
        agentKind: 'shell',
        cwd: '/proj',
        name: '   ',
      }),
    ).toThrow(/title is empty/)
    expect(await reg.modules.sessions.listSessions()).toHaveLength(0)
  })

  it('a user-set name is never clobbered by setAgentName', async () => {
    const reg = await makeRegistry()
    const { sessionId } = await reg.modules.sessions.createSession({
      agentKind: 'shell',
      cwd: '/proj',
      name: 'Agent first name',
    })
    reg.modules.sessions.renameSession({ sessionId, name: 'Mike’s pet session' })
    const r = reg.modules.sessions.setAgentName({
      sessionId,
      name: 'Something the agent prefers',
    })
    expect(r).toMatchObject({ ok: false })
    expect(r.reason).toMatch(/named by the user/i)
    const meta = (await reg.modules.sessions.listSessions()).find((s) => s.sessionId === sessionId)
    expect(meta?.name).toBe('Mike’s pet session')
    expect(meta?.nameSource).toBe('user')
  })

  it('an agent may re-title its own agent-set name', async () => {
    const reg = await makeRegistry()
    const { sessionId } = await reg.modules.sessions.createSession({
      agentKind: 'shell',
      cwd: '/proj',
      name: 'First cut',
    })
    const r = reg.modules.sessions.setAgentName({ sessionId, name: 'Clearer name' })
    expect(r).toEqual({ ok: true, name: 'Clearer name' })
    const meta = (await reg.modules.sessions.listSessions()).find((s) => s.sessionId === sessionId)
    expect(meta?.name).toBe('Clearer name')
    expect(meta?.nameSource).toBe('agent')
  })
})
