import { asSessionId, type SessionId } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { SessionRegistry } from '../../relay'

/**
 * The session-exit → lock auto-release seam [spec:SP-85d1]: `session.exited`
 * must fire on EVERY real death path — daemon agentExit, killSession (which
 * deletes the row before the daemon's agentExit arrives), and spawnError —
 * and relay.ts must wire it to LockService.releaseForSession. Hibernation is
 * an intentional park and must keep the leases.
 */

const G = { cols: 80, rows: 24 }
const bind = (sessionId: SessionId) =>
  ({
    type: 'bind',
    sessionId,
    cmd: 'claude',
    cwd: '/repo',
    agentKind: 'claude-code',
    geometry: G,
  }) as const

function regWithDaemon() {
  const reg = new SessionRegistry()
  reg.gateway.attachDaemon('local', () => {})
  return reg
}

function liveSession(reg: SessionRegistry): string {
  const { sessionId } = reg.modules.sessions.createSession({
    agentKind: 'claude-code',
    cwd: '/repo',
  })
  reg.gateway.routeDaemonFrame('local', bind(sessionId))
  return sessionId
}

/** Acquire `name` as the given live session via the relay dispatcher. */
async function acquireAs(reg: SessionRegistry, sessionId: string, name: string): Promise<void> {
  const r = (await reg.modules.lockCommands.dispatch(
    { capability: { role: 'worker', scope: { kind: 'none' }, actorSessionId: asSessionId(sessionId) } },
    'acquire',
    { repoPath: '/repo', name },
  )) as { granted: boolean; lock: { holder: { sessionId: string | null } } }
  expect(r.granted).toBe(true)
  expect(r.lock.holder.sessionId).toBe(sessionId)
}

function lockNames(reg: SessionRegistry): string[] {
  return reg.modules.locks.status({ repoPath: '/repo' }).map((l) => l.name)
}

describe('session.exited → lock auto-release wiring', () => {
  it('daemon agentExit releases the dead session locks and prunes its queue entries', async () => {
    const reg = regWithDaemon()
    const dying = liveSession(reg)
    const survivor = liveSession(reg)
    await acquireAs(reg, dying, 'held-by-dying')
    await acquireAs(reg, survivor, 'held-by-survivor')
    // dying also queues behind the survivor's lock
    const q = (await reg.modules.lockCommands.dispatch(
      { capability: { role: 'worker', scope: { kind: 'none' }, actorSessionId: asSessionId(dying) } },
      'acquire',
      { repoPath: '/repo', name: 'held-by-survivor' },
    )) as { granted: boolean }
    expect(q.granted).toBe(false)

    reg.gateway.routeDaemonFrame('local', {
      type: 'agentExit',
      sessionId: asSessionId(dying),
      code: 0,
    })
    expect(lockNames(reg)).toEqual(['held-by-survivor'])
    expect(
      reg.modules.locks.status({ repoPath: '/repo', name: 'held-by-survivor' })[0]?.queue,
    ).toEqual([])
    reg.dispose()
  })

  it('killSession releases locks even though the row is deleted before agentExit (finding 1)', async () => {
    const reg = regWithDaemon()
    const victim = liveSession(reg)
    await acquireAs(reg, victim, 'merge:main')
    reg.modules.sessions.killSession({ sessionId: asSessionId(victim) })
    expect(lockNames(reg)).toEqual([])
    reg.dispose()
  })

  it('kill advances the queue to a live waiter (grant survives the kill)', async () => {
    const reg = regWithDaemon()
    const victim = liveSession(reg)
    const waiter = liveSession(reg)
    await acquireAs(reg, victim, 'merge:main')
    await reg.modules.lockCommands.dispatch(
      { capability: { role: 'worker', scope: { kind: 'none' }, actorSessionId: asSessionId(waiter) } },
      'acquire',
      { repoPath: '/repo', name: 'merge:main' },
    )
    reg.modules.sessions.killSession({ sessionId: asSessionId(victim) })
    const after = reg.modules.locks.status({ repoPath: '/repo', name: 'merge:main' })
    expect(after[0]?.holder.sessionId).toBe(waiter)
    reg.dispose()
  })

  it('hibernation keeps the leases (intentional park, not a death)', async () => {
    const reg = regWithDaemon()
    const parked = liveSession(reg)
    reg.gateway.routeDaemonFrame('local', {
      type: 'sessionResumeRef',
      sessionId: asSessionId(parked),
      resume: { kind: 'claude', value: 'conv-1' },
    })
    await acquireAs(reg, parked, 'merge:main')
    const r = reg.modules.sessions.hibernateSession({ sessionId: asSessionId(parked) })
    expect(r.ok).toBe(true)
    // The hibernate kill produces an agentExit like any death — still no release.
    reg.gateway.routeDaemonFrame('local', {
      type: 'agentExit',
      sessionId: asSessionId(parked),
      code: 0,
    })
    expect(lockNames(reg)).toEqual(['merge:main'])
    reg.dispose()
  })

  it('spawnError releases locks too (status flips to exited without an agentExit round-trip)', async () => {
    const reg = regWithDaemon()
    const doomed = liveSession(reg)
    await acquireAs(reg, doomed, 'merge:main')
    reg.gateway.routeDaemonFrame('local', {
      type: 'spawnError',
      sessionId: asSessionId(doomed),
      message: 'boom',
    })
    expect(lockNames(reg)).toEqual([])
    reg.dispose()
  })
})
