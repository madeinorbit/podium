/**
 * Archive stops the session process (POD-108): setArchived parks a running
 * session (kill sent, status hibernated/exited, resume ref kept) instead of
 * being pure metadata, and attachDaemon reaps legacy archived-but-live rows.
 */

import type { ControlMessage } from '@podium/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionRegistry } from '../../relay'

const registries: SessionRegistry[] = []

afterEach(() => {
  for (const r of registries.splice(0)) r.dispose()
})

function makeRegistry(): { reg: SessionRegistry; daemon: ControlMessage[] } {
  const reg = new SessionRegistry()
  registries.push(reg)
  const daemon: ControlMessage[] = []
  reg.modules.sessions.attachDaemon('local', (m) => daemon.push(m))
  return { reg, daemon }
}

function bindLive(
  reg: SessionRegistry,
  sessionId: string,
  cwd: string,
  opts: { resume?: boolean } = {},
): void {
  reg.modules.sessions.onDaemonMessageFrom('local', {
    type: 'bind',
    sessionId,
    cmd: 'claude',
    cwd,
    agentKind: 'claude-code',
    geometry: { cols: 80, rows: 24 },
  })
  if (opts.resume !== false) {
    reg.modules.sessions.onDaemonMessageFrom('local', {
      type: 'sessionResumeRef',
      sessionId,
      resume: { kind: 'claude-session', value: 'native-1' },
    })
  }
}

function meta(reg: SessionRegistry, sessionId: string) {
  return reg.modules.sessions.listSessions().find((s) => s.sessionId === sessionId)
}

describe('archive parks the session process [POD-108]', () => {
  it('archiving a live resumable session hibernates it and sends kill', () => {
    const { reg, daemon } = makeRegistry()
    const { sessionId } = reg.modules.sessions.createSession({
      agentKind: 'claude-code',
      cwd: '/r',
    })
    bindLive(reg, sessionId, '/r')
    reg.modules.sessions.markSessionRead(sessionId)
    expect(meta(reg, sessionId)?.status).toBe('live')

    const gitCleanup = vi.spyOn(reg.modules.issues, 'onSessionRemovedOrArchived')
    reg.modules.sessions.setArchived({ sessionId, archived: true })
    expect(gitCleanup).toHaveBeenCalledWith(sessionId)

    const m = meta(reg, sessionId)
    expect(m?.archived).toBe(true)
    expect(m?.status).toBe('hibernated')
    expect(m?.stoppedAt).toBeTruthy()
    expect(m?.stopReason).toBe('parent')
    // Cold resume stays possible: the resume ref survives the park.
    expect(m?.resume).toEqual({ kind: 'claude-session', value: 'native-1' })
    // Archiving is the acknowledgment — the park must not resurface it unread.
    expect(m?.unread).toBe(false)
    expect(daemon.some((c) => c.type === 'kill' && c.sessionId === sessionId)).toBe(true)
  })

  it('archiving a live session without a resume ref marks it exited', () => {
    const { reg, daemon } = makeRegistry()
    const { sessionId } = reg.modules.sessions.createSession({
      agentKind: 'claude-code',
      cwd: '/r',
    })
    bindLive(reg, sessionId, '/r', { resume: false })

    reg.modules.sessions.setArchived({ sessionId, archived: true })

    expect(meta(reg, sessionId)?.status).toBe('exited')
    expect(daemon.some((c) => c.type === 'kill' && c.sessionId === sessionId)).toBe(true)
  })

  it('archiving an already-parked session sends no kill', () => {
    const { reg, daemon } = makeRegistry()
    const { sessionId } = reg.modules.sessions.createSession({
      agentKind: 'claude-code',
      cwd: '/r',
    })
    bindLive(reg, sessionId, '/r')
    const r = reg.modules.sessions.hibernateSession({ sessionId })
    expect(r.ok).toBe(true)
    const killsAfterHibernate = daemon.filter((c) => c.type === 'kill').length

    reg.modules.sessions.setArchived({ sessionId, archived: true })

    expect(meta(reg, sessionId)?.status).toBe('hibernated')
    expect(daemon.filter((c) => c.type === 'kill').length).toBe(killsAfterHibernate)
  })

  it('unarchiving does not resurrect the process', () => {
    const { reg, daemon } = makeRegistry()
    const { sessionId } = reg.modules.sessions.createSession({
      agentKind: 'claude-code',
      cwd: '/r',
    })
    bindLive(reg, sessionId, '/r')
    reg.modules.sessions.setArchived({ sessionId, archived: true })
    const spawnsBefore = daemon.filter((c) => c.type === 'spawn').length

    reg.modules.sessions.setArchived({ sessionId, archived: false })

    const m = meta(reg, sessionId)
    expect(m?.archived).toBe(false)
    expect(m?.status).toBe('hibernated')
    expect(daemon.filter((c) => c.type === 'spawn').length).toBe(spawnsBefore)
  })

  it('attachDaemon parks legacy archived-but-live rows instead of reattaching', () => {
    const { reg, daemon } = makeRegistry()
    const { sessionId } = reg.modules.sessions.createSession({
      agentKind: 'claude-code',
      cwd: '/r',
    })
    bindLive(reg, sessionId, '/r')
    // Simulate a row archived before archive learned to kill: the flag is set
    // but the status is still live (17 such rows existed on the origin host).
    const internals = reg.modules.sessions as unknown as {
      sessions: Map<string, { archived: boolean }>
    }
    const row = internals.sessions.get(sessionId)
    if (!row) throw new Error('session row missing')
    row.archived = true
    expect(meta(reg, sessionId)?.status).toBe('live')

    const reattached: ControlMessage[] = []
    reg.modules.sessions.attachDaemon('local', (m) => {
      daemon.push(m)
      reattached.push(m)
    })

    const m = meta(reg, sessionId)
    expect(m?.status).toBe('hibernated')
    expect(m?.resume).toEqual({ kind: 'claude-session', value: 'native-1' })
    expect(reattached.some((c) => c.type === 'kill' && c.sessionId === sessionId)).toBe(true)
    expect(reattached.some((c) => c.type === 'reattach' && c.sessionId === sessionId)).toBe(false)
  })

  it('permanent removal clears issue-owned session attribution', () => {
    const { reg } = makeRegistry()
    const { sessionId } = reg.modules.sessions.createSession({
      agentKind: 'shell',
      cwd: '/r',
    })
    const gitCleanup = vi.spyOn(reg.modules.issues, 'onSessionRemovedOrArchived')

    reg.modules.sessions.killSession({ sessionId })

    expect(gitCleanup).toHaveBeenCalledWith(sessionId)
    expect(meta(reg, sessionId)).toBeUndefined()
  })
})
