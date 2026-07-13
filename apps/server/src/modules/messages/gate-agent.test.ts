// Cross-harness subagent spawn + bounded await (#237) [spec:SP-34d7
// cross-harness]: gate authz ordering, deliberate-only issue creation, #285
// pass-through metadata, parent provenance, and the never-hangs await contract.

import type { SessionMeta } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import type { Capability } from '../../issue-authz'
import { SessionStore } from '../../store'
import type { IssueService } from '../issues/service'
import { MessageGate, type MessageGateDeps } from './gate'
import { MessageDeliveryService, SPAWN_BUDGET_PER_DAY } from './service'

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
  resolveExecutionProfile?: MessageGateDeps['resolveExecutionProfile']
  awaitPollMs?: number
  /** Fake clock shared by service + gate (awaitAgent freshness tests). */
  now?: () => string
  /** Reuse a prior harness's store — simulates a server restart. */
  store?: SessionStore
}) {
  const store = opts?.store ?? new SessionStore(':memory:')
  const sessions = opts?.sessions ?? []
  const spawns: Record<string, unknown>[] = []
  const created: Record<string, unknown>[] = []
  const issues = fakeIssues(created)
  const sent: { fn: string; sessionId: string; text: string }[] = []
  const svc = new MessageDeliveryService({
    messages: store.messages,
    events: store.events,
    issues: () => fakeIssues(),
    sessions: () => ({
      listSessions: () => sessions,
      sendText: (i) => {
        sent.push({ fn: 'sendText', ...i })
        return { ok: true }
      },
      queueText: (i) => {
        sent.push({ fn: 'queueText', ...i })
        return { ok: true, queued: true }
      },
      interruptText: (i) => {
        sent.push({ fn: 'interruptText', ...i })
        return { ok: true, queued: true }
      },
    }),
    now: opts?.now ?? (() => new Date().toISOString()),
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
    ...(opts?.resolveExecutionProfile ? { resolveExecutionProfile: opts.resolveExecutionProfile } : {}),
    // The deliberate --new path registers in the same fake registry so the
    // follow-up issues.get() resolves it (mirrors the real IssueService).
    createIssue: (i) => (issues as unknown as { create(x: unknown): { id: string } }).create(i),
    appendEvent: (e) => store.events.appendEvent(e),
    sleep: () => Promise.resolve(), // never actually blocks the test
    awaitPollMs: opts?.awaitPollMs ?? 1,
    ...(opts?.now ? { now: opts.now } : {}),
  })
  return { gate, svc, store, spawns, created, sessions, sent }
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

  it('uses a resolved execution profile as the authoritative launch preset and audits it', async () => {
    const { gate, spawns, store } = harness({
      resolveExecutionProfile: (input) => {
        expect(input).toEqual({
          profileId: 'prof_review',
          runId: 'run_1',
          stepId: 'review',
        })
        return {
          id: 'prof_review',
          accountId: 'native:codex',
          machineId: 'machine-review',
          harness: 'codex',
          model: 'gpt-5.6',
          effort: 'medium',
        }
      },
    })
    await gate.dispatch(PARENT, true, 'spawnAgent', {
      issue: ISSUE.id,
      prompt: 'review the change',
      harness: 'claude-code',
      model: 'wrong-model',
      effort: 'low',
      workflowRunId: 'run_1',
      workflowStepId: 'review',
      executionProfileId: 'prof_review',
    })
    expect(spawns[0]).toMatchObject({
      agentKind: 'codex',
      model: 'gpt-5.6',
      effort: 'medium',
      machineId: 'machine-review',
      workflowRunId: 'run_1',
      workflowStepId: 'review',
      executionProfileId: 'prof_review',
    })
    const events = store.events.listEventsSince(0, { kinds: ['agent.spawned'] })
    expect(events[0]?.payload).toMatchObject({
      harness: 'codex',
      model: 'gpt-5.6',
      effort: 'medium',
      machineId: 'machine-review',
      accountId: 'native:codex',
      executionProfileId: 'prof_review',
    })
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

  it('brake 2: agent spawns share the per-issue daily budget; the Nth is refused + ledgered', async () => {
    const { gate, store, spawns } = harness()
    for (let i = 0; i < SPAWN_BUDGET_PER_DAY; i++) {
      await gate.dispatch(PARENT, true, 'spawnAgent', { issue: ISSUE.id, prompt: 'x' })
    }
    expect(spawns).toHaveLength(SPAWN_BUDGET_PER_DAY)
    await expect(
      gate.dispatch(PARENT, true, 'spawnAgent', { issue: ISSUE.id, prompt: 'x' }),
    ).rejects.toThrow(/spawn budget exhausted/)
    expect(spawns).toHaveLength(SPAWN_BUDGET_PER_DAY) // the refused spawn never ran
    // Durably ledgered for the audit trail.
    const evs = store.events.listEventsSince(0, { kinds: ['agent.spawn_budget_exhausted'] })
    expect(evs).toHaveLength(1)
    // Operator spawns are never budgeted.
    await expect(
      gate.dispatch(OPERATOR, undefined, 'spawnAgent', { issue: ISSUE.id, prompt: 'x' }),
    ).resolves.toMatchObject({ ok: true })
  })

  it('brake 2 survives a server restart (agent.spawned budgetIssue rides the event ledger)', async () => {
    const first = harness()
    for (let i = 0; i < SPAWN_BUDGET_PER_DAY; i++) {
      await first.gate.dispatch(PARENT, true, 'spawnAgent', { issue: ISSUE.id, prompt: 'x' })
    }
    // Fresh service + gate over the SAME store: the budget is still spent.
    const second = harness({ store: first.store })
    await expect(
      second.gate.dispatch(PARENT, true, 'spawnAgent', { issue: ISSUE.id, prompt: 'x' }),
    ).rejects.toThrow(/spawn budget exhausted/)
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
    let t = 1_000
    const now = () => new Date(t).toISOString()
    const sessions = [child({})] // live + working: the await actually waits
    const { gate, svc } = harness({ sessions, now })
    // Parent messages the child; the child acks back to the parent session.
    const sent = svc.send(
      { kind: 'agent', sessionId: 'sParent', issueId: SENDER_ISSUE.id },
      { to: { kind: 'session', id: 'child1' }, body: 'report in' },
    )
    sessions.push(child({ sessionId: 'sParent', status: 'live', spawnedBy: undefined }))
    t = 2_000
    const p = gate.dispatch(PARENT, undefined, 'awaitAgent', {
      sessionId: 'child1',
      timeoutSeconds: 5,
    }) as Promise<{ done: boolean; result: string; ack?: { body: string } }>
    // The ack postdates the await start (the freshness contract).
    t = 3_000
    svc.sendReply(
      { kind: 'agent', sessionId: 'child1', issueId: ISSUE.id },
      { inReplyTo: sent.message.id, body: 'done: merged 3 commits' },
    )
    const r = await p
    expect(r.done).toBe(true)
    expect(r.result).toBe('acked')
    expect(r.ack?.body).toBe('done: merged 3 commits')
  })

  it('a stale ack from a previous round never satisfies a NEW await', async () => {
    let t = 1_000
    const now = () => new Date(t).toISOString()
    const sessions = [child({ status: 'exited' })]
    const { gate, svc } = harness({ sessions, now })
    // Round 1: parent asked, child acked, parent awaited — all in the past.
    const sent = svc.send(
      { kind: 'agent', sessionId: 'sParent', issueId: SENDER_ISSUE.id },
      { to: { kind: 'session', id: 'child1' }, body: 'first instruction' },
    )
    sessions.push(child({ sessionId: 'sParent', status: 'live', spawnedBy: undefined }))
    svc.sendReply(
      { kind: 'agent', sessionId: 'child1', issueId: ISSUE.id },
      { inReplyTo: sent.message.id, body: 'round 1 done' },
    )
    // Round 2: a NEW await must not be satisfied by the round-1 ack.
    t = 600_000
    const r = (await gate.dispatch(PARENT, undefined, 'awaitAgent', {
      sessionId: 'child1',
      timeoutSeconds: 0,
    })) as { done: boolean; result: string }
    expect(r).toMatchObject({ done: true, result: 'settled' })
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

describe('session ask — the seance (#237 tier 4)', () => {
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
      agentState: { phase: 'idle', since: 't', openTaskCount: 0 },
      ...over,
    }) as SessionMeta

  it('round-trips: question → delivery with the answer-then-resume envelope → ack carries the answer back', async () => {
    const { gate, svc, sent } = harness({ sessions: [child({})] })
    const p = gate.dispatch(PARENT, true, 'ask', {
      sessionId: 'child1',
      question: 'which port does the relay use?',
      timeoutSeconds: 5,
    }) as Promise<{ answered: boolean; answer?: string; questionId: string }>
    // The question is delivered inline (idle target) as a kind:'question'
    // envelope that CONSTRAINS the receiver: answer, then resume — server-
    // rendered, so a body can never fake or omit it.
    expect(sent).toHaveLength(1)
    const text = sent[0]!.text
    expect(text).toContain('which port does the relay use?')
    expect(text).toContain('this is a question')
    expect(text).toContain('RETURN TO WHAT YOU WERE DOING')
    const id = /podium message (msg_\S+) /.exec(text)![1]!
    expect(text).toContain(`podium mail reply ${id}`)
    // The child answers via the ack — only the answer crosses back.
    svc.sendReply(
      { kind: 'agent', sessionId: 'child1', issueId: ISSUE.id },
      { inReplyTo: id, body: 'port 18787' },
    )
    const r = await p
    expect(r).toMatchObject({ answered: true, questionId: id, answer: 'port 18787' })
  })

  it('an OPERATOR ask against a live idle target round-trips: the question frame carries the reply pointer', async () => {
    const { gate, svc, sent } = harness({ sessions: [child({ spawnedBy: 'user' })] })
    const p = gate.dispatch(OPERATOR, undefined, 'ask', {
      sessionId: 'child1',
      question: 'which port does the relay use?',
      timeoutSeconds: 5,
    }) as Promise<{ answered: boolean; answer?: string; questionId: string }>
    // Operator bodies normally land unwrapped, but a QUESTION must carry the
    // reply frame or the target can never ack (the ask would always time out).
    expect(sent).toHaveLength(1)
    const text = sent[0]?.text ?? ''
    expect(text).toContain('which port does the relay use?')
    expect(text).toContain('from the operator')
    expect(text).toContain('this is a question')
    const id = /podium message (msg_\S+) /.exec(text)?.[1] ?? ''
    expect(id).not.toBe('')
    expect(text).toContain(`podium mail reply ${id}`)
    // The target acks with the answer — the round trip completes.
    svc.sendReply(
      { kind: 'agent', sessionId: 'child1', issueId: ISSUE.id },
      { inReplyTo: id, body: 'port 18787' },
    )
    const r = await p
    expect(r).toMatchObject({ answered: true, questionId: id, answer: 'port 18787' })
  })

  it('ask on a parked session resumes it (wake → queueText, harness-native resume path)', async () => {
    const { gate, sent } = harness({ sessions: [child({ status: 'hibernated' })] })
    const r = (await gate.dispatch(OPERATOR, undefined, 'ask', {
      sessionId: 'child1',
      question: 'status?',
      timeoutSeconds: 0,
    })) as { answered: boolean; snapshot: { status: string } }
    // wake lifecycle rides queueText, which durably queues + resurrects.
    expect(sent[0]).toMatchObject({ fn: 'queueText', sessionId: 'child1' })
    // Bounded wait returned instead of hanging: no answer yet + snapshot.
    expect(r.answered).toBe(false)
    expect(r.snapshot).toMatchObject({ sessionId: 'child1', status: 'hibernated' })
  })

  it('is subject to the session-target scope gate: denied outside the subtree without --outside-scope', async () => {
    const { gate } = harness({ sessions: [child({ spawnedBy: 'user' })] })
    await expect(
      gate.dispatch(PARENT, undefined, 'ask', {
        sessionId: 'child1',
        question: 'q',
        timeoutSeconds: 0,
      }),
    ).rejects.toThrow(/outside your subtree/)
    const r = (await gate.dispatch(PARENT, true, 'ask', {
      sessionId: 'child1',
      question: 'q',
      timeoutSeconds: 0,
    })) as { answered: boolean }
    expect(r.answered).toBe(false)
  })
})

// The web ledger view (#237) [spec:SP-34d7 web]: operator-only, per-issue /
// per-session, pure read (never consumes queued status), newest first, and
// carries the delivery-ledger fields the CLI wire previously omitted.
describe('message ledger (gate)', () => {
  it('operator reads an issue ledger with delivery fields; reads never consume', async () => {
    let t = 1_000 // fake clock: 'second' must strictly postdate 'first'
    const { gate, svc } = harness({ now: () => new Date(t).toISOString() })
    svc.send(
      { kind: 'agent', issueId: SENDER_ISSUE.id, sessionId: 'sX' },
      {
        to: { kind: 'issue', id: ISSUE.id },
        body: 'first',
      },
    )
    t = 2_000
    svc.send({ kind: 'operator' }, { to: { kind: 'issue', id: ISSUE.id }, body: 'second' })
    const rows = (await gate.dispatch(OPERATOR, undefined, 'ledger', {
      issueId: ISSUE.id,
    })) as Record<string, unknown>[]
    expect(rows).toHaveLength(2)
    // Newest first.
    expect(rows.map((r) => r.body)).toEqual(['second', 'first'])
    expect(rows[1]).toMatchObject({ from: 'issue:#212', to: 'issue:#228', status: 'queued' })
    // Ledger fields present on the wire.
    expect(rows[0]).toHaveProperty('deliveredAt')
    expect(rows[0]).toHaveProperty('clampedFrom')
    expect(rows[0]).toHaveProperty('hop')
    // A second read sees the SAME statuses — the ledger never consumes.
    const again = (await gate.dispatch(OPERATOR, undefined, 'ledger', {
      issueId: ISSUE.id,
    })) as Record<string, unknown>[]
    expect(again.map((r) => r.status)).toEqual(rows.map((r) => r.status))
  })

  it('a session ledger sees sent, addressed and delivered-to rows', async () => {
    const sessions = [
      {
        sessionId: 's1',
        cwd: '/wt/a',
        agentKind: 'claude-code',
        status: 'live',
        busy: false,
        issueId: ISSUE.id,
      } as unknown as SessionMeta,
    ]
    const { gate, svc } = harness({ sessions })
    svc.send({ kind: 'operator' }, { to: { kind: 'session', id: 's1' }, body: 'to the session' })
    svc.send(
      { kind: 'agent', issueId: ISSUE.id, sessionId: 's1' },
      { to: { kind: 'issue', id: SENDER_ISSUE.id }, body: 'from the session' },
    )
    const rows = (await gate.dispatch(OPERATOR, undefined, 'ledger', {
      sessionId: 's1',
    })) as Record<string, unknown>[]
    expect(rows.map((r) => r.body).sort()).toEqual(['from the session', 'to the session'])
  })

  it('agents are refused — the ledger is an operator surface', async () => {
    const { gate } = harness()
    await expect(gate.dispatch(PARENT, undefined, 'ledger', { issueId: ISSUE.id })).rejects.toThrow(
      /operator surface/,
    )
  })
})
