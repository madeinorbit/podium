/**
 * SessionStart seams that mutation found silent after the POD-1396 extract
 * (POD-1433). Both rules predate the cut and moved with the code; neither had
 * an assertion that would fail if inverted/disabled.
 *
 *   1. create(): issue owner wins over an explicit ownerUserId
 *      (parentOwner ?? input.ownerUserId ?? …). Authorization-shaped: an
 *      issue-owned child inherits the issue owner (ADR 1).
 *   2. spawn(): refuse a client-supplied sessionId that already maps to a live
 *      Session. Without the guard the registry overwrites the live object and
 *      orphans its PTY/daemon binding.
 */

import { asSessionId, asUserId, FIRST_ADMIN_USER_ID } from '@podium/model'
import type { ControlMessage } from '@podium/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { SessionRegistry } from '../../relay'

const registries: SessionRegistry[] = []

afterEach(() => {
  for (const r of registries.splice(0)) r.dispose()
})

function makeRegistry(): { reg: SessionRegistry; daemon: ControlMessage[] } {
  const reg = new SessionRegistry(undefined, undefined, { instanceId: 'default' })
  registries.push(reg)
  const daemon: ControlMessage[] = []
  reg.gateway.attachDaemon(reg.sessionStore.hostMachineId, (m) => daemon.push(m))
  return { reg, daemon }
}

function spawns(daemon: ControlMessage[]) {
  return daemon.filter((m): m is Extract<ControlMessage, { type: 'spawn' }> => m.type === 'spawn')
}

describe('SessionStart: issue owner precedence', () => {
  // ADR 1: ownership per class — an issue-owned child inherits the issue owner.
  // Without this assertion, inverting parentOwner ?? input.ownerUserId stays green.
  it('ADR 1: createSession with issueId and a conflicting ownerUserId lands on the issue owner', () => {
    const issueOwner = asUserId('user:issue-owner')
    const conflicting = asUserId('user:explicit-conflict')
    expect(issueOwner).not.toBe(conflicting)
    expect(issueOwner).not.toBe(FIRST_ADMIN_USER_ID)

    const { reg, daemon } = makeRegistry()
    const issue = reg.issues.create({
      repoPath: '/r',
      title: 'Owned issue',
      startNow: false,
      ownerUserId: issueOwner,
    })
    expect(reg.sessionStore.issues.getIssue(issue.id)?.ownerUserId).toBe(issueOwner)

    const { sessionId } = reg.modules.sessions.createSession({
      agentKind: 'shell',
      cwd: '/r/.worktrees/a',
      issueId: issue.id,
      ownerUserId: conflicting,
    })

    // Durable row is the issue's owner — not the conflicting input.
    const row = reg.sessionStore.sessions.loadSessions().find((r) => r.id === sessionId)
    expect(row?.ownerUserId).toBe(issueOwner)

    // create() feeds one ownership answer into the daemon binding as well.
    const frame = spawns(daemon).at(-1)
    expect(frame?.sessionId).toBe(sessionId)
    expect(frame?.binding?.principal).toEqual({ kind: 'user', userId: issueOwner })
  })
})

describe('SessionStart: live session-id collision guard', () => {
  // Property is survival of the first live session, not merely that an error is thrown.
  it('refusing a live sessionId leaves the first session live and bound (not only throws)', () => {
    const sessionId = asSessionId('client-supplied-id')
    const { reg, daemon } = makeRegistry()

    reg.modules.sessions.createSession({
      agentKind: 'shell',
      cwd: '/proj',
      sessionId,
      title: 'first',
    })
    // Bind so the session is live — the silent-overwrite harm is orphaning a
    // bound PTY/daemon mapping, not merely losing the error path.
    reg.gateway.routeDaemonFrame(reg.sessionStore.hostMachineId, {
      type: 'bind',
      sessionId,
      cmd: 'bash',
      cwd: '/proj',
      agentKind: 'shell',
      geometry: { cols: 80, rows: 24 },
    })

    const first = reg.sessionStore.sessions.loadSessions().find((r) => r.id === sessionId)
    expect(first).toBeDefined()
    const durableLabel = first!.durableLabel
    expect(reg.modules.sessions.listSessions().find((s) => s.sessionId === sessionId)?.status).toBe(
      'live',
    )
    expect(spawns(daemon).filter((m) => m.sessionId === sessionId)).toHaveLength(1)

    expect(() =>
      reg.modules.sessions.createSession({
        agentKind: 'shell',
        cwd: '/other',
        sessionId,
        title: 'clobber attempt',
      }),
    ).toThrow(/refusing to reuse an existing session id/)

    // First session still the only occupant of that id — not overwritten.
    const after = reg.sessionStore.sessions.loadSessions().filter((r) => r.id === sessionId)
    expect(after).toHaveLength(1)
    expect(after[0]?.durableLabel).toBe(durableLabel)
    expect(after[0]?.cwd).toBe('/proj')
    expect(after[0]?.title).toBe('first')
    expect(reg.modules.sessions.listSessions().find((s) => s.sessionId === sessionId)?.status).toBe(
      'live',
    )
    // No second spawn frame — an overwrite would re-fire spawn for the same id.
    expect(spawns(daemon).filter((m) => m.sessionId === sessionId)).toHaveLength(1)
  })
})
