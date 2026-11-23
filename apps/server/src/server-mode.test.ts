/**
 * The server mode (POD-7308): one value, one derivation, and the lock
 * commands' shared `operator` holder refused on a hosted server.
 */
import { asSessionId, firstAdminMemberId, type SessionId } from '@podium/model'
import { afterAll, describe, expect, it } from 'vitest'
import { SessionRegistry } from './relay'
import { HostedModeRefusal, serverCapabilities } from './server-mode'
import { OPERATOR } from './test-support/capabilities'

describe('serverCapabilities', () => {
  it('keeps every host shortcut on a self-hosted server with its own machine', () => {
    expect(serverCapabilities()).toEqual({
      mode: 'self-hosted',
      hostMachine: true,
      sameMachineTrust: true,
      controlSocket: true,
      hostSignIn: true,
      earliestAdminDefault: true,
      operatorLocks: true,
      setupRoutes: true,
      devUpdateFeed: true,
      installationNamesWorkspace: true,
    })
    expect(serverCapabilities({ mode: 'self-hosted' })).toEqual(serverCapabilities())
  })

  it('drops only what needs the machine on a self-hosted server without one (POD-7225)', () => {
    expect(serverCapabilities({ hostMachine: false })).toEqual({
      mode: 'self-hosted',
      hostMachine: false,
      sameMachineTrust: false,
      controlSocket: true,
      hostSignIn: false,
      earliestAdminDefault: true,
      operatorLocks: true,
      setupRoutes: true,
      devUpdateFeed: false,
      installationNamesWorkspace: true,
    })
  })

  it('turns every host shortcut off on a hosted server', () => {
    const hosted = serverCapabilities({ mode: 'hosted' })
    expect(hosted.mode).toBe('hosted')
    const { mode: _mode, ...rest } = hosted
    expect(Object.values(rest).every((value) => value === false)).toBe(true)
  })

  it('refuses a mode it does not know', () => {
    expect(() => serverCapabilities({ mode: 'cloud' as never })).toThrow(
      "unknown server mode 'cloud'",
    )
  })
})

const hosted = await SessionRegistry.create(undefined, undefined, {
  instanceId: 'default',
  capabilities: serverCapabilities({ mode: 'hosted' }),
})
// A lock's repo resolves only through a machine that reported it; the registry's
// test store keeps its fixture machine.
const fixtureMachine = hosted.sessionStore.hostMachine
if (!fixtureMachine) throw new Error('the registry test store has no fixture machine')
await hosted.sessionStore.repos.addRepo('/repo', fixtureMachine.id)
afterAll(() => hosted.dispose())

describe('lock writes by a person without a session', () => {
  it('are refused on a hosted server with a typed error', async () => {
    const attempt = hosted.modules.lockCommands.dispatch({ capability: OPERATOR }, 'acquire', {
      repoPath: '/repo',
      name: 'merge:main',
    })
    await expect(attempt).rejects.toBeInstanceOf(HostedModeRefusal)
    await expect(attempt).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      feature: 'operator-lock',
    })
  })

  it('still take an agent session’s lease on a hosted server', async () => {
    const result = (await hosted.modules.lockCommands.dispatch(
      {
        capability: {
          role: 'worker',
          scope: { kind: 'none' },
          actorSessionId: asSessionId('sess_agent'),
          onBehalfOf: firstAdminMemberId(),
        },
      },
      'acquire',
      { repoPath: '/repo', name: 'build' },
    )) as { granted: boolean; lock: { holder: { sessionId: SessionId | null } } }
    expect(result.granted).toBe(true)
    expect(result.lock.holder.sessionId).toBe('sess_agent')
  })
})
