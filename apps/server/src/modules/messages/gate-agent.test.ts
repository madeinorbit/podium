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
    getMeta: (id: string) => byId.get(id),
    has: (id: string) => byId.has(id),
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
  /** Poll-sleep seam (blocking-send / await tests drive confirmation here). */
  sleep?: (ms: number) => Promise<void>
  /** Fake clock shared by service + gate (awaitAgent freshness tests). */
  now?: () => string
  /** Reuse a prior harness's store — simulates a server restart. */
  store?: SessionStore
  /** Optional override; default wires store.notificationFacts.retire (POD-917). */
  retireNotificationFact?: MessageGateDeps['retireNotificationFact']
  /** When true, omit retireNotificationFact entirely (optional-safe path). */
  omitRetireNotificationFact?: boolean
}) {
  const store = opts?.store ?? new SessionStore(':memory:')
  const sessions = opts?.sessions ?? []
  const spawns: Record<string, unknown>[] = []
  const created: Record<string, unknown>[] = []
  const issues = fakeIssues(created)
  const sent: { fn: string; sessionId: string; text: string }[] = []
  const retired: { factKey: string; target: string }[] = []
  const svc = new MessageDeliveryService({
    messages: store.messages,
    notificationFacts: store.notificationFacts,
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
  const defaultRetire: MessageGateDeps['retireNotificationFact'] = (factKey, target) => {
    retired.push({ factKey, target })
    store.notificationFacts.retire(factKey, target, opts?.now?.() ?? new Date().toISOString())
  }
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
    ...(opts?.resolveExecutionProfile
      ? { resolveExecutionProfile: opts.resolveExecutionProfile }
      : {}),
    // The deliberate --new path registers in the same fake registry so the
    // follow-up issues.get() resolves it (mirrors the real IssueService).
    createIssue: (i) => (issues as unknown as { create(x: unknown): { id: string } }).create(i),
    appendEvent: (e) => store.events.appendEvent(e),
    sleep: opts?.sleep ?? (() => Promise.resolve()), // never actually blocks the test
    awaitPollMs: opts?.awaitPollMs ?? 1,
    ...(opts?.now ? { now: opts.now } : {}),
    ...(opts?.omitRetireNotificationFact
      ? {}
      : {
          retireNotificationFact: opts?.retireNotificationFact ?? defaultRetire,
        }),
  })
  return { gate, svc, store, spawns, created, sessions, sent, retired }
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

  it('returns and audits the placement actually produced by the spawn seam', async () => {
    const { gate, store } = harness({
      spawnSession: () => ({
        sessionId: 'child-actual',
        agentId: 'child-actual',
        harness: 'codex',
        model: 'fallback-model',
        effort: 'medium',
        machine: 'fallback-box',
        machineId: 'machine-fallback',
        accountId: 'native:codex',
      }),
    })
    const result = await gate.dispatch(PARENT, true, 'spawnAgent', {
      issue: ISSUE.id,
      prompt: 'use actual placement',
      harness: 'claude-code',
      model: 'requested-model',
      effort: 'low',
    })
    expect(result).toMatchObject({
      agentId: 'child-actual',
      harness: 'codex',
      model: 'fallback-model',
      effort: 'medium',
      machine: 'fallback-box',
    })
    const events = store.events.listEventsSince(0, { kinds: ['agent.spawned'] })
    expect(events[0]?.payload).toMatchObject({
      harness: 'codex',
      model: 'fallback-model',
      effort: 'medium',
      machineId: 'machine-fallback',
      accountId: 'native:codex',
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

  it('maps input.title to spawnSession.name (curated slot, not derived title)', async () => {
    const { gate, spawns } = harness()
    await gate.dispatch(PARENT, true, 'spawnAgent', {
      issue: ISSUE.id,
      prompt: 'implement placement',
      title: 'Spawn placement worker',
    })
    expect(spawns[0]).toMatchObject({
      name: 'Spawn placement worker',
      initialPrompt: 'implement placement',
    })
    // Must not land in a derived-title field on the spawn seam.
    expect(spawns[0]).not.toHaveProperty('title')
  })

  it('omits name on spawnSession when no title is passed (child self-titles)', async () => {
    const { gate, spawns } = harness()
    await gate.dispatch(PARENT, true, 'spawnAgent', {
      issue: ISSUE.id,
      prompt: 'x',
    })
    expect(spawns[0]).not.toHaveProperty('name')
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
      agentState: { phase: 'working', since: 't', nativeSubagentCount: 0 },
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

  // Actionable result split (docs/agent-comms-target.html §09-D/§09-E): parent
  // must never get a false "working" when the child is blocked/done/gone.
  it('phase needs_user → blocked (overnight-stall: child waiting on a question)', async () => {
    const { gate } = harness({
      sessions: [
        child({
          agentState: {
            phase: 'needs_user',
            since: 't',
            nativeSubagentCount: 0,
            need: { kind: 'question', summary: 'pick a model' },
          },
        }),
      ],
    })
    const r = (await gate.dispatch(PARENT, undefined, 'awaitAgent', {
      sessionId: 'child1',
      timeoutSeconds: 300,
    })) as { done: boolean; result: string; snapshot: { phase?: string; need?: unknown } }
    expect(r).toMatchObject({
      done: true,
      result: 'blocked',
      snapshot: {
        phase: 'needs_user',
        need: { kind: 'question', summary: 'pick a model' },
      },
    })
  })

  it('phase errored → blocked (needs escalation)', async () => {
    const { gate } = harness({
      sessions: [
        child({
          agentState: {
            phase: 'errored',
            since: 't',
            nativeSubagentCount: 0,
            error: { class: 'rate_limit', retryable: true },
          },
        }),
      ],
    })
    const r = (await gate.dispatch(PARENT, undefined, 'awaitAgent', {
      sessionId: 'child1',
      timeoutSeconds: 300,
    })) as { done: boolean; result: string; snapshot: { phase?: string; error?: unknown } }
    expect(r).toMatchObject({
      done: true,
      result: 'blocked',
      snapshot: {
        phase: 'errored',
        error: { class: 'rate_limit', retryable: true },
      },
    })
  })

  it('phase idle → done', async () => {
    const { gate } = harness({
      sessions: [child({ agentState: { phase: 'idle', since: 't', nativeSubagentCount: 0 } })],
    })
    const r = (await gate.dispatch(PARENT, undefined, 'awaitAgent', {
      sessionId: 'child1',
      timeoutSeconds: 300,
    })) as { done: boolean; result: string }
    expect(r).toMatchObject({ done: true, result: 'done' })
  })

  it('phase ended → done', async () => {
    const { gate } = harness({
      sessions: [child({ agentState: { phase: 'ended', since: 't', nativeSubagentCount: 0 } })],
    })
    const r = (await gate.dispatch(PARENT, undefined, 'awaitAgent', {
      sessionId: 'child1',
      timeoutSeconds: 300,
    })) as { done: boolean; result: string }
    expect(r).toMatchObject({ done: true, result: 'done' })
  })

  it('status hibernated → done (parked cleanly)', async () => {
    const { gate } = harness({ sessions: [child({ status: 'hibernated' })] })
    const r = (await gate.dispatch(PARENT, undefined, 'awaitAgent', {
      sessionId: 'child1',
      timeoutSeconds: 300,
    })) as { done: boolean; result: string }
    expect(r).toMatchObject({ done: true, result: 'done' })
  })

  it('status exited with NO ack since waitStart → gone (exit-without-report)', async () => {
    const { gate } = harness({ sessions: [child({ status: 'exited' })] })
    const r = (await gate.dispatch(PARENT, undefined, 'awaitAgent', {
      sessionId: 'child1',
      timeoutSeconds: 300,
    })) as { done: boolean; result: string; snapshot: { status?: string } }
    expect(r).toMatchObject({ done: true, result: 'gone', snapshot: { status: 'exited' } })
  })

  it('session missing mid-await → gone', async () => {
    // Authz sees the child (parent provenance); the row vanishes before the
    // next poll — the documented "session missing → gone" path inside the loop.
    const sessions = [child({})]
    const { gate } = harness({
      sessions,
      awaitPollMs: 1,
      sleep: async () => {
        sessions.length = 0
      },
    })
    const r = (await gate.dispatch(PARENT, undefined, 'awaitAgent', {
      sessionId: 'child1',
      timeoutSeconds: 5,
    })) as { done: boolean; result: string; snapshot: null }
    expect(r).toMatchObject({ done: true, result: 'gone', snapshot: null })
  })

  it('surfaces the child ack (rich result wins over settle / exit)', async () => {
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

  it('status exited WITH a fresh ack → acked (reported-then-exited, not gone)', async () => {
    let t = 1_000
    const now = () => new Date(t).toISOString()
    const sessions = [child({ status: 'exited' })]
    const { gate, svc } = harness({ sessions, now })
    const sent = svc.send(
      { kind: 'agent', sessionId: 'sParent', issueId: SENDER_ISSUE.id },
      { to: { kind: 'session', id: 'child1' }, body: 'report in' },
    )
    sessions.push(child({ sessionId: 'sParent', status: 'live', spawnedBy: undefined }))
    // Ack after waitStart but child already exited — ack wins over gone.
    t = 2_000
    svc.sendReply(
      { kind: 'agent', sessionId: 'child1', issueId: ISSUE.id },
      { inReplyTo: sent.message.id, body: 'shipped; exiting' },
    )
    const r = (await gate.dispatch(PARENT, undefined, 'awaitAgent', {
      sessionId: 'child1',
      timeoutSeconds: 300,
    })) as { done: boolean; result: string; ack?: { body: string } }
    expect(r.done).toBe(true)
    expect(r.result).toBe('acked')
    expect(r.ack?.body).toBe('shipped; exiting')
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
    // Child is exited with no fresh report → gone (not a false working/settled).
    t = 600_000
    const r = (await gate.dispatch(PARENT, undefined, 'awaitAgent', {
      sessionId: 'child1',
      timeoutSeconds: 0,
    })) as { done: boolean; result: string }
    expect(r).toMatchObject({ done: true, result: 'gone' })
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

  // POD-917/POD-923: parent await observing settled consumes the session-parent
  // wake sticky so a later genuine re-completion can re-fire once.
  it('parent await on settled child retires sessionparentnudge:phase-reported (consume-on-ack)', async () => {
    const now = () => '2026-01-01T00:00:00.000Z'
    const { gate, store, retired } = harness({
      sessions: [child({ agentState: { phase: 'idle', since: 't', nativeSubagentCount: 0 } })],
      now,
    })
    // Pre-claim as the steward would after the first parent wake.
    expect(
      store.notificationFacts.claim({
        factKey: 'sessionparentnudge:phase-reported:child1',
        target: 'sParent',
        source: 'steward.session-parent-nudge:done',
        issueId: null,
        createdAt: now(),
        expiresAt: '2026-01-02T00:00:00.000Z',
      }),
    ).toBe(true)

    const r = (await gate.dispatch(PARENT, undefined, 'awaitAgent', {
      sessionId: 'child1',
      timeoutSeconds: 300,
    })) as { done: boolean; result: string }
    expect(r).toMatchObject({ done: true, result: 'done' })
    expect(retired).toEqual([
      { factKey: 'sessionparentnudge:phase-reported:child1', target: 'sParent' },
    ])
    // Fact is re-claimable after consume (genuine later re-completion path).
    expect(
      store.notificationFacts.claim({
        factKey: 'sessionparentnudge:phase-reported:child1',
        target: 'sParent',
        source: 'steward.session-parent-nudge:done',
        issueId: null,
        createdAt: now(),
        expiresAt: '2026-01-02T00:00:00.000Z',
      }),
    ).toBe(true)
  })

  it('parent await on working child does NOT retire the sticky', async () => {
    const h = harness({ sessions: [child({})] })
    const r = (await h.gate.dispatch(PARENT, undefined, 'awaitAgent', {
      sessionId: 'child1',
      timeoutSeconds: 0,
    })) as { result: string }
    expect(r.result).toBe('working')
    expect(h.retired).toEqual([])
  })

  it('parent await gone/exited also consumes the sticky', async () => {
    const h = harness({ sessions: [child({ status: 'exited' })] })
    await h.gate.dispatch(PARENT, undefined, 'awaitAgent', {
      sessionId: 'child1',
      timeoutSeconds: 300,
    })
    expect(h.retired).toEqual([
      { factKey: 'sessionparentnudge:phase-reported:child1', target: 'sParent' },
    ])
  })

  it('missing retireNotificationFact dep is optional-safe (await still returns)', async () => {
    const { gate } = harness({
      sessions: [child({ agentState: { phase: 'idle', since: 't', nativeSubagentCount: 0 } })],
      omitRetireNotificationFact: true,
    })
    const r = (await gate.dispatch(PARENT, undefined, 'awaitAgent', {
      sessionId: 'child1',
      timeoutSeconds: 300,
    })) as { done: boolean; result: string }
    expect(r).toMatchObject({ done: true, result: 'done' })
  })
})

describe('urgency-gated blocking send (gate wiring) [spec:SP-cb9f] [POD-854]', () => {
  // A target on the PARENT's own issue subtree, so `messages.send` authz passes.
  const target = (over: Partial<SessionMeta>): SessionMeta =>
    ({
      sessionId: 's1',
      cwd: '/wt/b',
      agentKind: 'claude-code',
      status: 'live',
      createdAt: 't',
      issueId: SENDER_ISSUE.id,
      agentState: { phase: 'idle', since: 't', nativeSubagentCount: 0 },
      ...over,
    }) as SessionMeta

  it('a next-turn mail send BLOCKS until the boundary confirms, then reports delivered', async () => {
    const sessions = [target({})] // live idle
    // The confirmation fires during the first poll sleep (turn boundary). The hook
    // is late-bound because `svc` is created inside the harness.
    let confirm: () => void = () => {}
    const { gate, svc } = harness({
      sessions,
      awaitPollMs: 5,
      now: () => new Date(0).toISOString(), // constant clock: deadline never reached
      sleep: async () => confirm(),
    })
    confirm = () => svc.onSessionIdle(target({}))
    const r = (await gate.dispatch(PARENT, undefined, 'send', {
      to: 's1',
      body: 'x',
      urgency: 'next-turn',
    })) as { disposition: string }
    expect(r.disposition).toBe('delivered')
  })

  it('a next-turn send to a BUSY target returns accepted at the budget (never spins)', async () => {
    let t = 1_000
    const { gate } = harness({
      sessions: [target({ agentState: { phase: 'working', since: 't', nativeSubagentCount: 0 } })],
      now: () => new Date(t).toISOString(),
      awaitPollMs: 1_000_000, // one sleep jumps past the 25s budget
      sleep: async (ms) => void (t += ms),
    })
    const r = (await gate.dispatch(PARENT, undefined, 'send', {
      to: 's1',
      body: 'x',
      urgency: 'next-turn',
    })) as { disposition: string }
    expect(r.disposition).toBe('accepted')
    expect(t).toBeGreaterThanOrEqual(26_000)
  })

  it('clears the stale queued flag when blocking upgrades a busy send to delivered', async () => {
    const sessions = [
      target({ agentState: { phase: 'working', since: 't', nativeSubagentCount: 0 } }),
    ]
    // First idle drains the held row into the PTY; the second confirms it at the
    // boundary. The sync send returned queued:true (busy-held) — the delivered
    // result must NOT still carry it.
    let confirm: () => void = () => {}
    const { gate, svc } = harness({
      sessions,
      awaitPollMs: 5,
      now: () => new Date(0).toISOString(),
      sleep: async () => confirm(),
    })
    confirm = () => svc.onSessionIdle(target({}))
    const r = (await gate.dispatch(PARENT, undefined, 'send', {
      to: 's1',
      body: 'x',
      urgency: 'next-turn',
    })) as { disposition: string; queued?: boolean }
    expect(r.disposition).toBe('delivered')
    expect(r.queued).not.toBe(true)
  })

  it('an fyi send returns at queued without blocking', async () => {
    const { gate } = harness({
      sessions: [target({ agentState: { phase: 'working', since: 't', nativeSubagentCount: 0 } })],
    })
    const r = (await gate.dispatch(PARENT, undefined, 'send', {
      to: 's1',
      body: 'note',
      urgency: 'fyi',
    })) as { disposition: string }
    expect(r.disposition).toBe('queued')
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
      agentState: { phase: 'idle', since: 't', nativeSubagentCount: 0 },
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

describe('mail status — sender-queryable lifecycle (#834 [POD-834 §04d])', () => {
  it('the SENDER (an agent) can pull the lifecycle of a message it sent', async () => {
    // Unlike the operator-only ledger, an agent may query its OWN send — this is
    // how a sender learns delivered/read/dead_letter after a sync send at queued.
    const { gate, svc } = harness()
    const r = svc.send(
      { kind: 'agent', issueId: SENDER_ISSUE.id, sessionId: 'sParent' },
      { to: { kind: 'issue', id: ISSUE.id }, body: 'status me' },
    )
    const wire = (await gate.dispatch(PARENT, undefined, 'status', {
      id: r.message.id,
    })) as Record<string, unknown>
    expect(wire).toMatchObject({ id: r.message.id, status: 'queued' })
    // The lifecycle timestamps are on the wire (all null until they transition).
    expect(wire).toHaveProperty('deliveredAt')
    expect(wire).toHaveProperty('readAt')
    expect(wire).toHaveProperty('deadLetteredAt')
  })

  it('refuses a message the caller neither sent nor received', async () => {
    const { gate, svc } = harness()
    // A message between two OTHER principals (operator → a foreign issue box).
    const r = svc.send({ kind: 'operator' }, { to: { kind: 'issue', id: ISSUE.id }, body: 'x' })
    await expect(gate.dispatch(PARENT, undefined, 'status', { id: r.message.id })).rejects.toThrow(
      /neither sent nor received/,
    )
  })
})

describe('mail dismiss — recipient-only clear', () => {
  it('marks recipient mail read and removes it from the unread queue', async () => {
    const { gate, svc, store } = harness()
    const sent = svc.send(
      { kind: 'agent', issueId: SENDER_ISSUE.id, sessionId: 'sParent' },
      { to: { kind: 'issue', id: ISSUE.id }, body: 'dismiss me' },
    )
    const recipient: Capability = {
      role: 'worker',
      scope: { kind: 'subtree', rootId: ISSUE.id },
      actorSessionId: 'sRecipient',
    }
    const wire = (await gate.dispatch(recipient, undefined, 'dismiss', {
      id: sent.message.id,
    })) as Record<string, unknown>
    expect(wire).toMatchObject({ id: sent.message.id, status: 'read' })
    expect(store.messages.countPending({ kind: 'issue', id: ISSUE.id })).toBe(0)
    await expect(
      gate.dispatch(PARENT, undefined, 'dismiss', { id: sent.message.id }),
    ).rejects.toThrow(/only the recipient/)
  })
})
