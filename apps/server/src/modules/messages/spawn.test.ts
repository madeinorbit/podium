// Spawn-on-wake wiring (#237) [spec:SP-34d7 decision 4]: the makeSpawnOnWake
// adapter over the real session-spawn machinery — issue resolution, cwd
// choice, provenance stamping — plus the end-to-end wake→spawn→first-prompt
// path through MessageDeliveryService and the parent clamp it unlocks.

import type { SessionMeta } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import { SessionStore } from '../../store'
import type { IssueService } from '../issues/service'
import { type MessageDeliveryDeps, MessageDeliveryService } from './service'
import { makeSpawnOnWake, spawnedByForMessage } from './spawn'

const ISSUE = {
  id: 'iss_a',
  seq: 228,
  worktreePath: '/wt/a',
  repoPath: '/repo',
  defaultAgent: 'claude-code',
  defaultModel: 'auto',
  defaultEffort: 'auto',
}

function fakeIssues(over?: Partial<typeof ISSUE>) {
  const issue = { ...ISSUE, ...over }
  return {
    resolveRef: (ref: string) => {
      if (ref === issue.id || ref === `#${issue.seq}`) return issue.id
      throw new Error(`unknown ref ${ref}`)
    },
    get: (id: string) => (id === issue.id ? issue : undefined),
    getMeta: (id: string) => (id === issue.id ? issue : undefined),
    has: (id: string) => id === issue.id,
    ancestorIds: () => [],
  } as unknown as IssueService
}

function row(over: Record<string, unknown>) {
  return {
    id: 'msg_1',
    threadId: 'msg_1',
    inReplyTo: null,
    fromKind: 'agent',
    fromSession: null,
    fromIssue: null,
    toKind: 'issue',
    toId: ISSUE.id,
    kind: 'message',
    urgency: 'fyi',
    lifecycle: 'wake',
    body: 'b',
    expiresAt: null,
    createdAt: 't',
    status: 'queued',
    deliveredAt: null,
    deliveredTo: null,
    ackedBy: null,
    hop: 0,
    clampedFrom: null,
    remindedAt: null,
    // biome-ignore lint/suspicious/noExplicitAny: test literal
    ...over,
  } as any
}

describe('makeSpawnOnWake', () => {
  it('spawns on the issue worktree via createSession with issue defaults + parent provenance', () => {
    const calls: Record<string, unknown>[] = []
    const seam = makeSpawnOnWake({
      issues: () => fakeIssues({ machineId: 'm1' } as Partial<typeof ISSUE>),
      createSession: (i) => {
        calls.push(i)
        return { sessionId: 'child1' }
      },
    })
    const r = seam.spawn({
      issueId: ISSUE.id,
      message: row({ fromKind: 'agent', fromSession: 'sParent' }),
    })
    expect(r).toEqual({ ok: true, sessionId: 'child1' })
    expect(calls[0]).toMatchObject({
      cwd: '/wt/a',
      agentKind: 'claude-code',
      issueId: ISSUE.id,
      spawnedBy: 'session:sParent',
      machineId: 'm1',
    })
  })

  it('falls back to the repo root for an unstarted issue; never starts the issue itself', () => {
    const calls: Record<string, unknown>[] = []
    const seam = makeSpawnOnWake({
      issues: () => fakeIssues({ worktreePath: null } as unknown as Partial<typeof ISSUE>),
      createSession: (i) => {
        calls.push(i)
        return { sessionId: 'c' }
      },
    })
    expect(seam.spawn({ issueId: ISSUE.id, message: row({}) }).ok).toBe(true)
    expect(calls[0]!.cwd).toBe('/repo')
  })

  it('fails soft on a missing/unknown issue and on a throwing spawn', () => {
    const seam = makeSpawnOnWake({
      issues: () => fakeIssues(),
      createSession: () => {
        throw new Error('daemon offline')
      },
    })
    expect(seam.spawn({ issueId: null, message: row({}) }).ok).toBe(false)
    expect(seam.spawn({ issueId: 'iss_nope', message: row({}) }).ok).toBe(false)
    expect(seam.spawn({ issueId: ISSUE.id, message: row({}) })).toMatchObject({
      ok: false,
      reason: 'daemon offline',
    })
  })

  it('spawnedByForMessage maps every principal to an existing provenance shape', () => {
    expect(spawnedByForMessage(row({ fromKind: 'operator' }))).toBe('user')
    expect(spawnedByForMessage(row({ fromKind: 'superagent' }))).toBe('superagent')
    expect(spawnedByForMessage(row({ fromKind: 'system' }))).toBe('system')
    expect(spawnedByForMessage(row({ fromKind: 'agent', fromIssue: 'iss_b' }))).toBe('issue:iss_b')
  })
})

describe('wake → spawn → first prompt (service integration)', () => {
  function harness() {
    const store = new SessionStore(':memory:')
    const sessions: SessionMeta[] = []
    const queued: { sessionId: string; text: string }[] = []
    const interrupted: { sessionId: string; text: string }[] = []
    const deps: MessageDeliveryDeps = {
      messages: store.messages,
      events: store.events,
      issues: () => fakeIssues(),
      sessions: () => ({
        listSessions: () => sessions,
        sendText: () => ({ ok: true }),
        queueText: (i) => {
          queued.push(i)
          return { ok: true, queued: true }
        },
        interruptText: (i) => {
          interrupted.push(i)
          return { ok: true, queued: true }
        },
      }),
      spawnOnWake: makeSpawnOnWake({
        issues: () => fakeIssues(),
        createSession: (i) => {
          // The real createSession registers the session; mirror that so
          // follow-up sends resolve the child.
          sessions.push({
            sessionId: 'child1',
            cwd: i.cwd,
            agentKind: 'claude-code',
            status: 'live',
            createdAt: 't',
            agentState: { phase: 'working', since: 't', openTaskCount: 0 },
            spawnedBy: i.spawnedBy,
            issueId: i.issueId,
          } as SessionMeta)
          return { sessionId: 'child1' }
        },
      }),
      now: () => '2026-07-13T00:00:00.000Z',
    }
    return { svc: new MessageDeliveryService(deps), queued, interrupted, sessions }
  }

  it('a wake to an empty issue spawns a fresh agent and the message is its first prompt', () => {
    const { svc, queued } = harness()
    const r = svc.send(
      { kind: 'agent', sessionId: 'sParent', issueId: 'iss_b' },
      { to: { kind: 'issue', id: ISSUE.id }, body: 'get going', lifecycle: 'wake' },
    )
    // Enqueued to the fresh agent's boot queue; queued until it drains + echoes.
    expect(r.message.status).toBe('queued')
    expect(r.disposition).toBe('spawning')
    expect(r.message.deliveredTo).toBe('child1')
    expect(queued).toHaveLength(1)
    expect(queued[0]!.sessionId).toBe('child1')
    expect(queued[0]!.text).toContain('get going')
  })

  it('the spawn unlocks parent-grade clamps: the waker may interrupt its child', () => {
    const { svc, interrupted } = harness()
    svc.send(
      { kind: 'agent', sessionId: 'sParent', issueId: 'iss_b' },
      { to: { kind: 'issue', id: ISSUE.id }, body: 'go', lifecycle: 'wake' },
    )
    const r = svc.send(
      { kind: 'agent', sessionId: 'sParent', issueId: 'iss_b' },
      { to: { kind: 'session', id: 'child1' }, body: 'stop!', urgency: 'interrupt' },
    )
    expect(r.message.urgency).toBe('interrupt') // not clamped to next-turn
    expect(r.message.clampedFrom).toBeNull()
    expect(interrupted).toHaveLength(1)
    // A PEER (not the parent) is still clamped.
    const peer = svc.send(
      { kind: 'agent', sessionId: 'sOther', issueId: 'iss_b' },
      { to: { kind: 'session', id: 'child1' }, body: 'hey', urgency: 'interrupt' },
    )
    expect(peer.message.urgency).toBe('next-turn')
  })
})
