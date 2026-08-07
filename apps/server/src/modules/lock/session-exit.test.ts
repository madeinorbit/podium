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
/** Lock repo scope — independent of each session's workspace root. */
const REPO = '/repo'

const bind = (sessionId: SessionId, cwd: string) =>
  ({
    type: 'bind',
    sessionId,
    cmd: 'claude',
    cwd,
    agentKind: 'claude-code',
    geometry: G,
  }) as const

function regWithDaemon() {
  const reg = new SessionRegistry(undefined, undefined, { instanceId: 'default' })
  reg.gateway.attachDaemon(reg.sessionStore.hostMachineId, () => {})
  return reg
}

/**
 * Live session at `cwd`. Multi-session queue tests MUST use distinct cwds:
 * POD-556 refuses co-located (shared-worktree) acquire/queue unless
 * `--allow-sibling`, and these cases pin death → release → advance — not the
 * sibling refuse path.
 */
function liveSession(reg: SessionRegistry, cwd = `${REPO}/.worktrees/solo`): string {
  const { sessionId } = reg.modules.sessions.createSession({
    agentKind: 'claude-code',
    cwd,
  })
  reg.gateway.routeDaemonFrame(reg.sessionStore.hostMachineId, bind(sessionId, cwd))
  return sessionId
}

/** Acquire `name` as the given live session via the relay dispatcher. */
async function acquireAs(reg: SessionRegistry, sessionId: string, name: string): Promise<void> {
  const r = (await reg.modules.lockCommands.dispatch(
    { capability: { role: 'worker', scope: { kind: 'none' }, actorSessionId: asSessionId(sessionId) } },
    'acquire',
    { repoPath: REPO, name },
  )) as { granted: boolean; lock: { holder: { sessionId: string | null } } }
  expect(r.granted).toBe(true)
  expect(r.lock.holder.sessionId).toBe(sessionId)
}

function lockNames(reg: SessionRegistry): string[] {
  return reg.modules.locks.status({ repoPath: REPO }).map((l) => l.name)
}

describe('session.exited → lock auto-release wiring', () => {
  it('daemon agentExit releases the dead session locks and prunes its queue entries', async () => {
    const reg = regWithDaemon()
    // Distinct workspaces: not co-located siblings (POD-556).
    const dying = liveSession(reg, `${REPO}/.worktrees/dying`)
    const survivor = liveSession(reg, `${REPO}/.worktrees/survivor`)
    await acquireAs(reg, dying, 'held-by-dying')
    await acquireAs(reg, survivor, 'held-by-survivor')
    // dying also queues behind the survivor's lock
    const q = (await reg.modules.lockCommands.dispatch(
      { capability: { role: 'worker', scope: { kind: 'none' }, actorSessionId: asSessionId(dying) } },
      'acquire',
      { repoPath: REPO, name: 'held-by-survivor' },
    )) as { granted: boolean }
    expect(q.granted).toBe(false)

    reg.gateway.routeDaemonFrame(reg.sessionStore.hostMachineId, {
      type: 'agentExit',
      sessionId: asSessionId(dying),
      code: 0,
    })
    expect(lockNames(reg)).toEqual(['held-by-survivor'])
    expect(
      reg.modules.locks.status({ repoPath: REPO, name: 'held-by-survivor' })[0]?.queue,
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
    // Distinct workspaces so the waiter can enqueue without --allow-sibling.
    const victim = liveSession(reg, `${REPO}/.worktrees/victim`)
    const waiter = liveSession(reg, `${REPO}/.worktrees/waiter`)
    await acquireAs(reg, victim, 'merge:main')
    await reg.modules.lockCommands.dispatch(
      { capability: { role: 'worker', scope: { kind: 'none' }, actorSessionId: asSessionId(waiter) } },
      'acquire',
      { repoPath: REPO, name: 'merge:main' },
    )
    reg.modules.sessions.killSession({ sessionId: asSessionId(victim) })
    const after = reg.modules.locks.status({ repoPath: REPO, name: 'merge:main' })
    expect(after[0]?.holder.sessionId).toBe(waiter)
    reg.dispose()
  })

  it('hibernation keeps the leases (intentional park, not a death)', async () => {
    const reg = regWithDaemon()
    const parked = liveSession(reg)
    reg.gateway.routeDaemonFrame(reg.sessionStore.hostMachineId, {
      type: 'sessionResumeRef',
      sessionId: asSessionId(parked),
      resume: { kind: 'claude', value: 'conv-1' },
    })
    await acquireAs(reg, parked, 'merge:main')
    const r = reg.modules.sessions.hibernateSession({ sessionId: asSessionId(parked) })
    expect(r.ok).toBe(true)
    // The hibernate kill produces an agentExit like any death — still no release.
    reg.gateway.routeDaemonFrame(reg.sessionStore.hostMachineId, {
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
    reg.gateway.routeDaemonFrame(reg.sessionStore.hostMachineId, {
      type: 'spawnError',
      sessionId: asSessionId(doomed),
      message: 'boom',
    })
    expect(lockNames(reg)).toEqual([])
    reg.dispose()
  })
})
