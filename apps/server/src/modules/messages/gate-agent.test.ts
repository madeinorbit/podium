// Cross-harness subagent spawn + bounded await (#237) [spec:SP-34d7
// cross-harness]: gate authz ordering, deliberate-only issue creation, #285
// pass-through metadata, parent provenance, and the never-hangs await contract.

import type { SessionMeta } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import type { Capability } from '../../issue-authz'
import { SessionStore } from '../../store'
import type { IssueService } from '../issues/service'
import { MessageGate, type MessageGateDeps } from './gate'
import { MessageDeliveryService } from './service'

const ISSUE = {
  id: 'iss_a',
  seq: 228,
  worktreePath: '/wt/a',
  repoPath: '/repo',
  defaultAgent: 'claude-code',
  defaultModel: 'auto',
  defaultEffort: 'auto',
}
const SENDER_ISSUE = { ...ISSUE, id: 'iss_b', seq: 212, worktreePath: '/wt/b' }

function fakeIssues(created: Record<string, unknown>[] = []) {
  const byId = new Map<string, Record<string, unknown>>([
    [ISSUE.id, ISSUE],
    [SENDER_ISSUE.id, SENDER_ISSUE],
  ])
  return {
    resolveRef: (ref: string) => {
      if (byId.has(ref)) return ref
      if (ref === `#${ISSUE.seq}`) return ISSUE.id
      throw new Error(`unknown ref ${ref}`)
    },
    get: (id: string) => byId.get(id),
    ancestorIds: () => [],
    create: (input: Record<string, unknown>) => {
      created.push(input)
      const id = 'iss_new'
      byId.set(id, { ...ISSUE, id, seq: 300, worktreePath: null })
      return byId.get(id)
    },
  } as unknown as IssueService
}

const OPERATOR: Capability = { role: 'admin', scope: { kind: 'all' } }
const PARENT: Capability = {
  role: 'worker',
  scope: { kind: 'subtree', rootId: SENDER_ISSUE.id },
  actorSessionId: 'sParent',
}

function harness(opts?: {
  sessions?: SessionMeta[]
  spawnSession?: MessageGateDeps['spawnSession']
  awaitPollMs?: number
}) {
  const store = new SessionStore(':memory:')
  const sessions = opts?.sessions ?? []
  const spawns: Record<string, unknown>[] = []
  const created: Record<string, unknown>[] = []
  const issues = fakeIssues(created)
  const svc = new MessageDeliveryService({
    messages: store.messages,
    events: store.events,
    issues: () => fakeIssues(),
    sessions: () => ({
      listSessions: () => sessions,
      sendText: () => ({ ok: true }),
      queueText: () => ({ ok: true, queued: true }),
      interruptText: () => ({ ok: true, queued: true }),
    }),
    now: () => new Date().toISOString(),
  })
  const gate = new MessageGate({
    messages: () => svc,
    issues: () => issues,
    listSessions: () => sessions,
    spawnSession:
      opts?.spawnSession ??
      ((i) => {
        spawns.push(i)
        return { sessionId: 'child1' }
      }),
    // The deliberate --new path registers in the same fake registry so the
    // follow-up issues.get() resolves it (mirrors the real IssueService).
    createIssue: (i) => (issues as unknown as { create(x: unknown): { id: string } }).create(i),
    appendEvent: (e) => store.events.appendEvent(e),
    sleep: () => Promise.resolve(), // never actually blocks the test
    awaitPollMs: opts?.awaitPollMs ?? 1,
  })
  return { gate, svc, store, spawns, created, sessions }
}

describe('agent spawn (gate)', () => {
  it('spawns a full session on the issue with parent provenance + #285 metadata pass-through', async () => {
    const { gate, spawns, created, store } = harness()
    const r = (await gate.dispatch(PARENT, true, 'spawnAgent', {
      issue: `#${ISSUE.seq}`,
      harness: 'codex',
      prompt: 'do the thing',
      model: 'gpt-5.2',
      effort: 'high',
      workflowRunId: 'run_1',
      workflowStepId: 'step_2',
      executionProfileId: 'prof_3',
    })) as { ok: boolean; sessionId: string; issueId: string }
    expect(r).toMatchObject({ ok: true, sessionId: 'child1', issueId: ISSUE.id })
    expect(spawns[0]).toMatchObject({
      cwd: '/wt/a',
      agentKind: 'codex',
      initialPrompt: 'do the thing',
      issueId: ISSUE.id,
      spawnedBy: 'session:sParent', // parent-grade clamps unlock off this
      model: 'gpt-5.2',
      effort: 'high',
      workflowRunId: 'run_1',
      workflowStepId: 'step_2',
      executionProfileId: 'prof_3',
    })
    // No issue auto-created when one was supplied.
    expect(created).toHaveLength(0)
    // Ledgered.
    const evs = store.events.listEventsSince(0, { kinds: ['agent.spawned'] })
    expect(evs).toHaveLength(1)
    expect(evs[0]!.payload).toMatchObject({ sessionId: 'child1', workflowRunId: 'run_1' })
  })

  it('authz: a subtree caller spawning onto ANOTHER issue needs --outside-scope', async () => {
    const { gate } = harness()
    await expect(
      gate.dispatch(PARENT, undefined, 'spawnAgent', { issue: ISSUE.id, prompt: 'x' }),
    ).rejects.toThrow(/outside your subtree/)
  })

  it('--new is the DELIBERATE issue-create path (parented under the caller scope)', async () => {
    const { gate, created, spawns } = harness()
    const r = (await gate.dispatch(PARENT, undefined, 'spawnAgent', {
      newTitle: 'follow-up work',
      prompt: 'go',
    })) as { ok: boolean }
    expect(r.ok).toBe(true)
    expect(created).toHaveLength(1)
    expect(created[0]).toMatchObject({
      title: 'follow-up work',
      repoPath: SENDER_ISSUE.repoPath,
      parentId: SENDER_ISSUE.id,
      origin: 'agent',
    })
    expect(spawns[0]).toMatchObject({ issueId: 'iss_new' })
  })

  it('rejects --issue AND --new together, and neither', async () => {
    const { gate } = harness()
    await expect(
      gate.dispatch(OPERATOR, undefined, 'spawnAgent', {
        issue: ISSUE.id,
        newTitle: 't',
        prompt: 'x',
      }),
    ).rejects.toThrow(/not both/)
    await expect(gate.dispatch(OPERATOR, undefined, 'spawnAgent', { prompt: 'x' })).rejects.toThrow(
      /--issue|--new/,
    )
  })

  it('--worktree on an unstarted issue refuses (issue start stays deliberate)', async () => {
    const { gate } = harness()
    await gate.dispatch(PARENT, undefined, 'spawnAgent', { newTitle: 'w', prompt: 'x' }) // iss_new: no worktree
    await expect(
      gate.dispatch(OPERATOR, undefined, 'spawnAgent', {
        issue: 'iss_new',
        prompt: 'x',
        worktree: true,
      }),
    ).rejects.toThrow(/podium issue start/)
  })
})

describe('agent await (bounded, never hangs)', () => {
  const child = (over: Partial<SessionMeta>): SessionMeta =>
    ({
      sessionId: 'child1',
      cwd: '/wt/a',
      agentKind: 'claude-code',
      status: 'live',
      title: 'child',
      createdAt: 't',
      issueId: ISSUE.id,
      spawnedBy: 'session:sParent',
      agentState: { phase: 'working', since: 't', openTaskCount: 0 },
      ...over,
    }) as SessionMeta

  it('returns "still working" + a status snapshot at the deadline instead of hanging', async () => {
    const { gate } = harness({ sessions: [child({})] })
    const r = (await gate.dispatch(PARENT, undefined, 'awaitAgent', {
      sessionId: 'child1',
      timeoutSeconds: 0,
    })) as { done: boolean; result: string; snapshot: { phase?: string } }
    expect(r.done).toBe(false)
    expect(r.result).toBe('working')
    expect(r.snapshot).toMatchObject({ sessionId: 'child1', status: 'live', phase: 'working' })
  })

  it('returns a settle immediately when the child is parked/idle', async () => {
    const { gate } = harness({ sessions: [child({ status: 'exited' })] })
    const r = (await gate.dispatch(PARENT, undefined, 'awaitAgent', {
      sessionId: 'child1',
      timeoutSeconds: 300,
    })) as { done: boolean; result: string }
    expect(r).toMatchObject({ done: true, result: 'settled' })
  })

  it('surfaces the child ack (rich result wins over settle)', async () => {
    const sessions = [child({ status: 'exited' })]
    const { gate, svc } = harness({ sessions })
    // Parent messages the child; the child acks back to the parent session.
    const sent = svc.send(
      { kind: 'agent', sessionId: 'sParent', issueId: SENDER_ISSUE.id },
      { to: { kind: 'session', id: 'child1' }, body: 'report in' },
    )
    // Ack must postdate the await start; simulate the child replying.
    sessions.push(child({ sessionId: 'sParent', status: 'live', spawnedBy: undefined }))
    svc.sendReply(
      { kind: 'agent', sessionId: 'child1', issueId: ISSUE.id },
      { inReplyTo: sent.message.id, body: 'done: merged 3 commits' },
    )
    const r = (await gate.dispatch(PARENT, undefined, 'awaitAgent', {
      sessionId: 'child1',
      timeoutSeconds: 1,
    })) as { done: boolean; result: string; ack?: { body: string } }
    expect(r.done).toBe(true)
    expect(r.result).toBe('acked')
    expect(r.ack?.body).toBe('done: merged 3 commits')
  })

  it('the parent relationship alone authorizes await; strangers hit the scope gate', async () => {
    const { gate } = harness({ sessions: [child({})] })
    const stranger: Capability = {
      role: 'worker',
      scope: { kind: 'subtree', rootId: SENDER_ISSUE.id },
      actorSessionId: 'sStranger',
    }
    await expect(
      gate.dispatch(stranger, undefined, 'awaitAgent', { sessionId: 'child1', timeoutSeconds: 0 }),
    ).rejects.toThrow(/outside your subtree/)
    // Same scope, but the PARENT session: allowed without --outside-scope.
    const r = (await gate.dispatch(PARENT, undefined, 'awaitAgent', {
      sessionId: 'child1',
      timeoutSeconds: 0,
    })) as { result: string }
    expect(r.result).toBe('working')
  })
})
