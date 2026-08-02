/**
 * CHARACTERIZATION — spawnAgent / awaitAgent / ask lifecycle as they behave
 * TODAY (POD-727, for POD-728 / POD-729).
 *
 * The load-bearing property here is BOUNDEDNESS: every wait returns. `await`
 * hands back the child's ack/settle result, or "still working" plus a status
 * snapshot at the timeout — it must never hang, whatever the child is doing.
 *
 * No test in this file sleeps before an assertion (POD-757): the timeout arms
 * use a zero budget so the bound is exercised on the first poll, and the
 * harness's poll seam advances an INJECTED clock rather than the wall clock.
 */

import { asIssueId, asSessionId, type SessionId, asMachineId} from '@podium/model'
import { describe, expect, it } from 'vitest'
import { mailHarness, OPERATOR, phaseState } from './characterization-support'
import { MessageGate } from './gate'
import { SPAWN_BUDGET_PER_DAY } from './service'

// ---------------------------------------------------------------------------
// S1 — spawn target resolution. No issue is EVER auto-created: `--new` is the
// deliberate path.
// ---------------------------------------------------------------------------

describe('characterization: spawn target resolution (S1)', () => {
  it('spawns on the named issue with parent provenance and never auto-creates an issue', async () => {
    const h = mailHarness()
    const parent = h.createIssue({ title: 'parent' })
    const target = h.createIssue({ title: 'target' })
    h.setWorktree(target.id, '/wt/target')

    const r = (await h.gate.dispatch(
      h.agentCap(parent.id, asSessionId('sParent')),
      true,
      'spawnAgent',
      {
        issue: `#${target.seq}`,
        prompt: 'do the thing',
        harness: 'codex',
        model: 'gpt-5.6',
        effort: 'high',
        force: true,
        title: 'Curated child name',
        workflowRunId: 'run_1',
        workflowStepId: 'step_2',
      },
    )) as Record<string, unknown>

    expect(h.gateSpawns[0]).toMatchObject({
      cwd: '/wt/target',
      agentKind: 'codex',
      initialPrompt: 'do the thing',
      issueId: target.id,
      // The caller becomes the child's PARENT — which is what unlocks the
      // parent-grade clamps (interrupt + wake) in the clamp matrix.
      spawnedBy: 'session:sParent',
      model: 'gpt-5.6',
      effort: 'high',
      forceUnknownModel: true,
      // The spawner-prescribed title lands in the CURATED `name` slot, not the
      // derived title [spec:SP-4ef9][spec:SP-eb60].
      name: 'Curated child name',
      workflowRunId: 'run_1',
      workflowStepId: 'step_2',
    })
    expect(h.gateSpawns[0]).not.toHaveProperty('title')
    expect(r).toMatchObject({
      ok: true,
      issueId: target.id,
      issueSeq: target.seq,
      cwd: '/wt/target',
    })
    // Only the two issues the test created — the spawn made none.
    expect(
      h.issues
        .list()
        .map((i) => i.id)
        .sort(),
    ).toEqual([parent.id, target.id].sort())
    expect(h.events(['agent.spawned'])).toHaveLength(1)
  })

  it('spawns at the repo root when the issue has no worktree, and refuses --worktree there', async () => {
    const h = mailHarness()
    const target = h.createIssue({ title: 'unstarted' })
    await expect(
      h.gate.dispatch(OPERATOR, undefined, 'spawnAgent', {
        issue: target.id,
        prompt: 'p',
        worktree: true,
      }),
    ).rejects.toThrow(`issue #${target.seq} has no worktree — run \`podium issue start\` first`)
    // Starting an issue stays a deliberate coordinator action; spawn never forks
    // a second one.
    expect(h.gateSpawns).toEqual([])

    await h.gate.dispatch(OPERATOR, undefined, 'spawnAgent', { issue: target.id, prompt: 'p' })
    expect(h.gateSpawns[0]).toMatchObject({ cwd: '/repo' })
  })

  it('takes --new as the deliberate issue-create path, inheriting the caller’s repo and parent', async () => {
    const h = mailHarness()
    const mine = h.createIssue({ title: 'mine', repoPath: '/repo' })
    const r = (await h.gate.dispatch(
      h.agentCap(mine.id, asSessionId('sMine')),
      undefined,
      'spawnAgent',
      {
        newTitle: 'a fresh child',
        prompt: 'the brief',
      },
    )) as { issueId: string }
    const created = h.issues.getMeta(r.issueId)!
    expect(created).toMatchObject({ title: 'a fresh child', repoPath: '/repo', parentId: mine.id })
    // The prompt becomes the new issue's description, and origin follows the
    // caller: an agent-scoped capability creates an 'agent'-origin issue.
    expect(h.issues.get(r.issueId)).toMatchObject({ description: 'the brief' })
  })

  it('needs --repo for --new when the caller has no issue scope to inherit from', async () => {
    const h = mailHarness()
    await expect(
      h.gate.dispatch(OPERATOR, undefined, 'spawnAgent', { newTitle: 'orphan', prompt: 'p' }),
    ).rejects.toThrow('--new needs --repo (no issue scope to inherit a repo from)')
    const r = (await h.gate.dispatch(OPERATOR, undefined, 'spawnAgent', {
      newTitle: 'orphan',
      prompt: 'p',
      repo: '/other-repo',
    })) as { issueId: string }
    expect(h.issues.getMeta(r.issueId)).toMatchObject({ repoPath: '/other-repo', parentId: null })
  })

  it('refuses both --issue and --new, and refuses neither', async () => {
    const h = mailHarness()
    const iss = h.createIssue({ title: 'x' })
    await expect(
      h.gate.dispatch(OPERATOR, undefined, 'spawnAgent', {
        issue: iss.id,
        newTitle: 'y',
        prompt: 'p',
      }),
    ).rejects.toThrow('pass --issue OR --new, not both')
    await expect(
      h.gate.dispatch(OPERATOR, undefined, 'spawnAgent', { prompt: 'p' }),
    ).rejects.toThrow('pass --issue <ref> or --new "title"')
  })

  it('reports an unwired spawn seam instead of pretending', async () => {
    // Partial deployments / test harnesses leave the seam absent; the proc must
    // say so rather than fail obscurely. Built here without spawnSession.
    const h = mailHarness()
    const iss = h.createIssue({ title: 'x' })
    const unwired = new MessageGate({
      messages: h.svc,
      issues: h.issues,
      listSessions: () => h.sessions,
    })
    await expect(
      unwired.dispatch(OPERATOR, undefined, 'spawnAgent', { issue: iss.id, prompt: 'p' }),
    ).rejects.toThrow('agent spawn is not wired on this server')
    // The check is the FIRST thing spawnAgent does, so even the --new path never
    // creates an issue on an unwired server.
    await expect(
      unwired.dispatch(OPERATOR, undefined, 'spawnAgent', {
        newTitle: 'n',
        prompt: 'p',
        repo: '/r',
      }),
    ).rejects.toThrow('agent spawn is not wired on this server')
    expect(h.issues.list().map((i) => i.id)).toEqual([iss.id])
  })

  it('lets a resolved execution profile OVERRIDE the caller’s launch preset, and audits it', async () => {
    const h = mailHarness({
      resolveExecutionProfile: (input) => {
        expect(input).toMatchObject({ profileId: 'prof_review', runId: 'run_1', stepId: 'review' })
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
    const iss = h.createIssue({ title: 'target' })
    await h.gate.dispatch(OPERATOR, undefined, 'spawnAgent', {
      issue: iss.id,
      prompt: 'review it',
      harness: 'claude-code',
      model: 'wrong-model',
      effort: 'low',
      workflowRunId: 'run_1',
      workflowStepId: 'review',
      executionProfileId: 'prof_review',
    })
    expect(h.gateSpawns[0]).toMatchObject({
      agentKind: 'codex',
      model: 'gpt-5.6',
      effort: 'medium',
      machineId: 'machine-review',
      accountId: 'native:codex',
    })
    expect(h.events(['agent.spawned'])[0]!.payload).toMatchObject({
      harness: 'codex',
      model: 'gpt-5.6',
      machineId: 'machine-review',
      accountId: 'native:codex',
    })
  })
})

// ---------------------------------------------------------------------------
// S2 — machine placement, including the UNREACHABLE arm. POD-728 adds a
// use-grant check (§3.1.4 M5) that must be DISTINGUISHABLE from unreachable;
// this pins the unreachable arm now so the two can be told apart later.
// ---------------------------------------------------------------------------

describe('characterization: machine placement and the unreachable arm (S2)', () => {
  it('inherits the issue’s machine pin and reports the machine the spawn landed on', async () => {
    const h = mailHarness({
      spawnSession: (input) => ({
        sessionId: asSessionId('child1'),
        machineId: input.machineId,
        machine: 'Builder',
      }),
    })
    const iss = h.createIssue({ title: 'pinned' })
    h.issues.update(iss.id, { machineId: asMachineId('machine-b') })
    const r = (await h.gate.dispatch(OPERATOR, undefined, 'spawnAgent', {
      issue: iss.id,
      prompt: 'p',
    })) as { machine: string | null }
    expect(r.machine).toBe('Builder')
    expect(h.events(['agent.spawned'])[0]!.payload).toMatchObject({ machineId: asMachineId('machine-b') })
  })

  it('propagates an UNREACHABLE machine as the spawn seam’s own error, spawning nothing', async () => {
    const h = mailHarness({
      spawnSession: () => {
        // The production text from MachinesService.requireAgent: today the ONLY
        // machine-related refusal a spawn can produce. POD-728 adds a use-grant
        // denial, which must NOT read like this one.
        throw new Error("machine 'Builder' is offline")
      },
    })
    const iss = h.createIssue({ title: 'pinned' })
    h.issues.update(iss.id, { machineId: asMachineId('machine-b') })
    await expect(
      h.gate.dispatch(OPERATOR, undefined, 'spawnAgent', { issue: iss.id, prompt: 'p' }),
    ).rejects.toThrow("machine 'Builder' is offline")
    // No session, and NO agent.spawned event: the ledger records only spawns
    // that happened.
    expect(h.events(['agent.spawned'])).toEqual([])
  })

  it('charges an agent’s failed spawn against the daily budget anyway (budget is taken BEFORE the spawn)', async () => {
    const h = mailHarness({
      spawnSession: () => {
        throw new Error("machine 'Builder' is offline")
      },
    })
    const iss = h.createIssue({ title: 'pinned' })
    const cap = h.agentCap(iss.id, asSessionId('sMe'))
    await expect(
      h.gate.dispatch(cap, undefined, 'spawnAgent', { issue: iss.id, prompt: 'p' }),
    ).rejects.toThrow("machine 'Builder' is offline")
    // TODAY'S BEHAVIOUR, recorded as-is rather than judged: takeSpawnBudget
    // consumes a unit before the spawn seam runs, and the in-memory counter is
    // not refunded when the spawn throws. It is not durable either (no
    // agent.spawned event), so a restart forgives it.
    expect(h.svc.takeSpawnBudget(iss.id).count).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// S3 — the daily spawn budget (brake 2), and the operator's exemption from it.
// ---------------------------------------------------------------------------

describe('characterization: the daily spawn budget (S3)', () => {
  it('stops a looping agent at the per-issue daily budget with a verbatim, actionable error', async () => {
    const h = mailHarness()
    const iss = h.createIssue({ title: 'busy issue' })
    const cap = h.agentCap(iss.id, asSessionId('sMe'))
    for (let i = 0; i < SPAWN_BUDGET_PER_DAY; i++) {
      await h.gate.dispatch(cap, undefined, 'spawnAgent', { issue: iss.id, prompt: `p${i}` })
    }
    await expect(
      h.gate.dispatch(cap, undefined, 'spawnAgent', { issue: iss.id, prompt: 'one too many' }),
    ).rejects.toThrow(
      `spawn budget exhausted for issue #${iss.seq} (${SPAWN_BUDGET_PER_DAY}/day); ` +
        'message the issue instead, or ask the operator',
    )
    expect(h.gateSpawns).toHaveLength(SPAWN_BUDGET_PER_DAY)
    expect(h.events(['agent.spawn_budget_exhausted'])).toHaveLength(1)
    // The budget rides the DURABLE event ledger (budgetIssue on agent.spawned),
    // so brake 2 survives a restart.
    expect(
      h
        .events(['agent.spawned'])
        .every((e) => (e.payload as { budgetIssue?: string }).budgetIssue === iss.id),
    ).toBe(true)
  })

  it('exempts the OPERATOR from the budget entirely, and records no budgetIssue', async () => {
    const h = mailHarness()
    const iss = h.createIssue({ title: 'operator issue' })
    for (let i = 0; i < SPAWN_BUDGET_PER_DAY + 3; i++) {
      await h.gate.dispatch(OPERATOR, undefined, 'spawnAgent', { issue: iss.id, prompt: `p${i}` })
    }
    // SINGLE-OPERATOR ARTEFACT: "operator intent is never braked" is safe only
    // while there is exactly one operator. POD-728 must decide whether every
    // named person inherits this exemption.
    expect(h.gateSpawns).toHaveLength(SPAWN_BUDGET_PER_DAY + 3)
    expect(h.events(['agent.spawned']).some((e) => 'budgetIssue' in (e.payload as object))).toBe(
      false,
    )
    // ... and the unbudgeted spawns did not consume an agent's budget either.
    expect(h.svc.takeSpawnBudget(iss.id)).toEqual({ ok: true, count: 1 })
  })

  it('rolls the budget over per UTC day', () => {
    const h = mailHarness({ startedAt: '2026-07-20T23:59:00.000Z' })
    const iss = h.createIssue({ title: 'rollover' })
    for (let i = 0; i < SPAWN_BUDGET_PER_DAY; i++) h.svc.takeSpawnBudget(iss.id)
    expect(h.svc.takeSpawnBudget(iss.id).ok).toBe(false)
    h.advance(2 * 60_000) // past midnight UTC
    expect(h.svc.takeSpawnBudget(iss.id)).toEqual({ ok: true, count: 1 })
  })
})

// ---------------------------------------------------------------------------
// S4 — awaitAgent is BOUNDED: it always returns.
// ---------------------------------------------------------------------------

describe('characterization: awaitAgent always returns (S4)', () => {
  const parentCapFor = (h: ReturnType<typeof mailHarness>, issueId: string) =>
    h.agentCap(asIssueId(issueId), asSessionId('sParent'))

  it('returns "working" plus a status snapshot at the timeout instead of hanging', async () => {
    const h = mailHarness()
    const iss = h.createIssue({ title: 'child issue' })
    h.put({
      sessionId: asSessionId('sChild'),
      issueId: iss.id,
      phase: 'working',
      spawnedBy: 'session:sParent',
      lastActiveAt: '2026-07-20T11:58:00.000Z',
      queuedMessageCount: 2,
      title: 'the child',
    })
    const r = (await h.gate.dispatch(parentCapFor(h, iss.id), undefined, 'awaitAgent', {
      sessionId: asSessionId('sChild'),
      timeoutSeconds: 0,
    })) as { done: boolean; result: string; snapshot: Record<string, unknown> }
    expect(r.done).toBe(false)
    expect(r.result).toBe('working')
    // The snapshot is what makes the timeout actionable rather than a shrug.
    expect(r.snapshot).toEqual({
      sessionId: asSessionId('sChild'),
      status: 'live',
      phase: 'working',
      title: 'the child',
      issueId: iss.id,
      lastActiveAt: '2026-07-20T11:58:00.000Z',
      queuedMessageCount: 2,
    })
  })

  it('classifies gone / blocked / done rather than reading them as "working"', async () => {
    const h = mailHarness()
    const iss = h.createIssue({ title: 'child issue' })
    const cap = parentCapFor(h, iss.id)
    const await0 = (sessionId: SessionId) =>
      h.gate.dispatch(cap, undefined, 'awaitAgent', { sessionId, timeoutSeconds: 0 }) as Promise<{
        done: boolean
        result: string
        snapshot: unknown
      }>

    // (1) A session that never existed does NOT come back as `gone`: the
    // session-target gate runs first and cannot find it, so the caller gets a
    // throw. `gone` is reserved for a child that disappears mid-wait (below).
    h.put({ sessionId: asSessionId('sOther'), issueId: iss.id, spawnedBy: 'session:sParent' })
    await expect(await0(asSessionId('sVanished'))).rejects.toThrow('session not found')

    // (2) exited without a fresh report — nothing to re-prompt (an
    // overnight-stall case: the parent must not wait on a dead child).
    const [child] = h.put({
      sessionId: asSessionId('sChild'),
      issueId: iss.id,
      spawnedBy: 'session:sParent',
      status: 'exited',
    })
    expect((await await0(asSessionId('sChild'))).result).toBe('gone')

    // (3) blocked: needs parent/human, or errored.
    child!.status = 'live'
    child!.agentState = phaseState('needs_user')
    expect((await await0(asSessionId('sChild'))).result).toBe('blocked')
    child!.agentState = phaseState('errored')
    expect((await await0(asSessionId('sChild'))).result).toBe('blocked')

    // (4) clean finish.
    child!.agentState = phaseState('idle')
    expect((await await0(asSessionId('sChild'))).result).toBe('done')
    child!.agentState = phaseState('ended')
    expect((await await0(asSessionId('sChild'))).result).toBe('done')
    child!.agentState = undefined
    child!.status = 'hibernated'
    expect((await await0(asSessionId('sChild'))).result).toBe('done')
  })

  it('returns `gone` when the child disappears DURING the wait', async () => {
    // Removing the row from the poll seam is what makes this deterministic: the
    // wait's next iteration observes the disappearance immediately (no sleeping).
    let removeOnce: (() => void) | null = null
    const h = mailHarness({
      awaitPollMs: 1,
      onPoll: () => {
        const fire = removeOnce
        removeOnce = null
        fire?.()
      },
    })
    const iss = h.createIssue({ title: 'child issue' })
    h.put({
      sessionId: asSessionId('sChild'),
      issueId: iss.id,
      phase: 'working',
      spawnedBy: 'session:sParent',
    })
    removeOnce = () => {
      h.sessions.length = 0
    }
    const r = (await h.gate.dispatch(parentCapFor(h, iss.id), undefined, 'awaitAgent', {
      sessionId: asSessionId('sChild'),
      timeoutSeconds: 1,
    })) as { done: boolean; result: string; snapshot: unknown }
    expect(r).toEqual({ done: true, result: 'gone', snapshot: null })
  })

  it('counts only acks SINCE THE WAIT BEGAN, and returns the ack body when one lands', async () => {
    const h = mailHarness()
    const parentIssue = h.createIssue({ title: 'parent' })
    const childIssue = h.createIssue({ title: 'child' })
    h.put({ sessionId: asSessionId('sParent'), issueId: parentIssue.id, phase: 'idle' })
    h.put({
      sessionId: asSessionId('sChild'),
      issueId: childIssue.id,
      phase: 'working',
      spawnedBy: 'session:sParent',
    })
    const cap = h.agentCap(parentIssue.id, asSessionId('sParent'))

    // A message from the parent, and the child's ack for it — this is the STALE
    // ack: it predates the next wait and must not satisfy it.
    const asked = h.svc.send(
      { kind: 'agent', issueId: parentIssue.id, sessionId: asSessionId('sParent') },
      { to: { kind: 'session', id: 'sChild' }, body: 'round 1', urgency: 'next-turn' },
    )
    h.svc.sendReply(
      { kind: 'agent', issueId: childIssue.id, sessionId: asSessionId('sChild') },
      { inReplyTo: asked.message.id, body: 'round 1 done' },
    )
    // Move the clock so the next wait starts strictly after that ack.
    h.advance(1000)
    const stale = (await h.gate.dispatch(cap, undefined, 'awaitAgent', {
      sessionId: asSessionId('sChild'),
      timeoutSeconds: 0,
    })) as { result: string }
    // Believing a stale ack would tell the parent that NEW work finished.
    expect(stale.result).toBe('working')

    // A fresh ack, after the wait's start, IS the answer — and it wins over
    // exit/settle classification (reported-then-exited is `acked`, not `gone`).
    const asked2 = h.svc.send(
      { kind: 'agent', issueId: parentIssue.id, sessionId: asSessionId('sParent') },
      { to: { kind: 'session', id: 'sChild' }, body: 'round 2', urgency: 'next-turn' },
    )
    h.advance(1000)
    const ack = h.svc.sendReply(
      { kind: 'agent', issueId: childIssue.id, sessionId: asSessionId('sChild') },
      { inReplyTo: asked2.message.id, body: 'round 2 done' },
    )
    const r = (await h.gate.dispatch(cap, undefined, 'awaitAgent', {
      sessionId: asSessionId('sChild'),
      timeoutSeconds: 0,
    })) as { done: boolean; result: string; ack: { id: string; body: string } }
    expect(r).toMatchObject({ done: true, result: 'acked' })
    expect(r.ack).toMatchObject({ id: ack.message.id, body: 'round 2 done' })
  })

  it('lets a PARENT await across issue scopes but makes everyone else pass the session-target gate', async () => {
    const h = mailHarness()
    const parentIssue = h.createIssue({ title: 'parent' })
    const childIssue = h.createIssue({ title: 'child' })
    h.put({
      sessionId: asSessionId('sChild'),
      issueId: childIssue.id,
      phase: 'working',
      spawnedBy: 'session:sParent',
    })
    // The parent relationship (spawnedBy provenance) is sufficient authority —
    // it already crossed the scope, confirmed, at spawn time.
    const asParent = (await h.gate.dispatch(
      h.agentCap(parentIssue.id, asSessionId('sParent')),
      undefined,
      'awaitAgent',
      { sessionId: asSessionId('sChild'), timeoutSeconds: 0 },
    )) as { result: string }
    expect(asParent.result).toBe('working')

    // A stranger does not get a free pass.
    const stranger = h.createIssue({ title: 'stranger' })
    await expect(
      h.gate.dispatch(h.agentCap(stranger.id, asSessionId('sStranger')), undefined, 'awaitAgent', {
        sessionId: asSessionId('sChild'),
        timeoutSeconds: 0,
      }),
    ).rejects.toThrow(
      `issue ${childIssue.id} is outside your subtree; re-run with --outside-scope to confirm`,
    )
    await expect(
      h.gate.dispatch(OPERATOR, undefined, 'awaitAgent', {
        sessionId: asSessionId('sNoSuchSession'),
        timeoutSeconds: 0,
      }),
    ).rejects.toThrow('session not found')
  })

  it('retires the session-parent wake sticky when the parent observes the child settle', async () => {
    const h = mailHarness()
    const childIssue = h.createIssue({ title: 'child' })
    const parentIssue = h.createIssue({ title: 'parent' })
    h.put({
      sessionId: asSessionId('sChild'),
      issueId: childIssue.id,
      phase: 'idle',
      spawnedBy: 'session:sParent',
    })
    const factKey = 'sessionparentnudge:phase-reported:sChild'
    const facts = h.store.notificationFacts
    facts.claim({
      factKey,
      target: 'sParent',
      source: 'test',
      issueId: null,
      createdAt: h.now(),
      expiresAt: null,
    })
    expect(facts.hasActive(factKey, 'sParent', h.now())).toBe(true)

    await h.gate.dispatch(
      h.agentCap(parentIssue.id, asSessionId('sParent')),
      undefined,
      'awaitAgent',
      {
        sessionId: asSessionId('sChild'),
        timeoutSeconds: 0,
      },
    )
    // POD-917/POD-923: cleared so a later GENUINE re-completion can re-wake once.
    expect(facts.hasActive(factKey, 'sParent', h.now())).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// S5 — `ask` (the seance): a message plus a BOUNDED wait for the answer. It is
// not a new mechanism, so the clamps/cooldown/hop brake all apply unchanged.
// ---------------------------------------------------------------------------

describe('characterization: ask is a question message plus a bounded wait (S5)', () => {
  it('rides the send pipeline as a next-turn + wake question, and returns "no answer yet" at the bound', async () => {
    const h = mailHarness()
    const iss = h.createIssue({ title: 'target' })
    h.put({ sessionId: asSessionId('s1'), issueId: iss.id, phase: 'working' })
    const r = (await h.gate.dispatch(OPERATOR, undefined, 'ask', {
      sessionId: asSessionId('s1'),
      question: 'what is the status?',
      timeoutSeconds: 0,
    })) as { answered: boolean; questionId: string; reason: string; snapshot: unknown }
    expect(r.answered).toBe(false)
    expect(r.reason).toBe(
      'no answer yet — the question is delivered/queued; check back or await the ack',
    )
    expect(r.snapshot).toEqual({
      sessionId: asSessionId('s1'),
      status: 'live',
      phase: 'working',
      issueId: iss.id,
    })
    const row = h.svc.message(r.questionId)!
    expect(row).toMatchObject({
      kind: 'question',
      urgency: 'next-turn',
      lifecycle: 'wake',
      // A question always wants an answer.
      expectsResponse: true,
    })
  })

  it('is clamped like any other send — a peer asking is NOT exempt', async () => {
    const h = mailHarness()
    const mine = h.createIssue({ title: 'mine' })
    const theirs = h.createIssue({ title: 'theirs' })
    h.put({ sessionId: asSessionId('sTheirs'), issueId: theirs.id, status: 'hibernated' })
    // First ask: a peer keeps wake.
    await h.gate.dispatch(h.agentCap(mine.id, asSessionId('sMine')), true, 'ask', {
      sessionId: asSessionId('sTheirs'),
      question: 'q1',
      timeoutSeconds: 0,
    })
    // Second within the cooldown window: clamped to wait, and the caller is told.
    const r = (await h.gate.dispatch(h.agentCap(mine.id, asSessionId('sMine')), true, 'ask', {
      sessionId: asSessionId('sTheirs'),
      question: 'q2',
      timeoutSeconds: 0,
    })) as { clamped?: boolean; questionId: string }
    expect(r.clamped).toBe(true)
    expect(h.svc.message(r.questionId)!.lifecycle).toBe('wait')
  })

  it('returns the ANSWER when the ack lands during the bounded wait', async () => {
    let answerOnce: (() => void) | null = null
    const h = mailHarness({
      awaitPollMs: 500,
      onPoll: () => {
        const fire = answerOnce
        answerOnce = null
        fire?.()
      },
    })
    const iss = h.createIssue({ title: 'target' })
    h.put({ sessionId: asSessionId('s1'), issueId: iss.id, phase: 'idle' })
    answerOnce = () => {
      const q = h.svc.inbox([{ kind: 'session', id: 's1' }]).find((m) => m.kind === 'question')!
      h.svc.sendReply(
        { kind: 'agent', issueId: iss.id, sessionId: asSessionId('s1') },
        { inReplyTo: q.id, body: 'the answer' },
      )
    }
    const r = (await h.gate.dispatch(OPERATOR, undefined, 'ask', {
      sessionId: asSessionId('s1'),
      question: 'q',
      timeoutSeconds: 30,
    })) as { answered: boolean; answer: string; ackId: string }
    expect(r.answered).toBe(true)
    expect(r.answer).toBe('the answer')
  })
})

// ---------------------------------------------------------------------------
// S6 — the spawn-on-wake seam's own arms (unwired, budget, provenance).
// ---------------------------------------------------------------------------

describe('characterization: the spawn-on-wake seam (S6)', () => {
  it('surfaces needs-attention and HOLDS the row when the seam is not wired', () => {
    const h = mailHarness({ omitSpawnOnWake: true })
    const iss = h.createIssue({ title: 'nobody' })
    const r = h.svc.send(
      { kind: 'operator' },
      { to: { kind: 'issue', id: iss.id }, body: 'wake', lifecycle: 'wake' },
    )
    expect(r).toMatchObject({ ok: true, queued: true, reason: 'unresumable', disposition: 'held' })
    expect(h.events().map((e) => e.kind)).toContain('message.needs_attention')
    // Nothing is dropped: the row stays queued for a real session later.
    expect(h.svc.message(r.message.id)!.status).toBe('queued')
  })

  it('derives the child’s provenance from the waking sender', () => {
    const h = mailHarness()
    const iss = h.createIssue({ title: 'target' })
    h.setWorktree(iss.id, '/wt/target')
    const sender = h.createIssue({ title: 'sender' })
    h.svc.send(
      { kind: 'agent', issueId: sender.id, sessionId: asSessionId('sWaker') },
      { to: { kind: 'issue', id: iss.id }, body: 'wake', lifecycle: 'wake' },
    )
    // A session-identified agent sender becomes the child's PARENT, so the waker
    // gets parent-grade rights over what it woke.
    expect(h.wakeSpawns[0]).toMatchObject({
      cwd: '/wt/target',
      issueId: iss.id,
      spawnedBy: 'session:sWaker',
    })
  })

  it('holds the row and ledgers the exhaustion when the wake spawn budget is spent', () => {
    const h = mailHarness()
    const iss = h.createIssue({ title: 'target' })
    h.setWorktree(iss.id, '/wt/target')
    for (let i = 0; i < SPAWN_BUDGET_PER_DAY; i++) h.svc.takeSpawnBudget(iss.id)
    const r = h.svc.send(
      { kind: 'operator' },
      { to: { kind: 'issue', id: iss.id }, body: 'wake', lifecycle: 'wake' },
    )
    expect(r).toMatchObject({ disposition: 'held', reason: 'spawn budget exhausted' })
    expect(h.wakeSpawns).toEqual([])
    expect(h.events().map((e) => e.kind)).toContain('message.spawn_budget_exhausted')
  })

  it('records a wake spawn against the cooldown so the sweep does not re-run the seam', () => {
    const h = mailHarness()
    const iss = h.createIssue({ title: 'target' })
    h.setWorktree(iss.id, '/wt/target')
    const sender = h.createIssue({ title: 'sender' })
    h.svc.send(
      { kind: 'agent', issueId: sender.id, sessionId: asSessionId('sWaker') },
      { to: { kind: 'issue', id: iss.id }, body: 'wake', lifecycle: 'wake' },
    )
    expect(h.wakeSpawns).toHaveLength(1)
    expect(h.store.messages.getWakeCooldown(`agent:sWaker|${iss.id}`)).toBe(h.now())
    // A sweep inside the window must not spawn a second agent every 60s.
    h.svc.sweep()
    expect(h.wakeSpawns).toHaveLength(1)
  })

  it('keeps a spawned child listed so the parent can await it', async () => {
    const h = mailHarness()
    const iss = h.createIssue({ title: 'target' })
    h.setWorktree(iss.id, '/wt/target')
    const r = (await h.gate.dispatch(OPERATOR, undefined, 'spawnAgent', {
      issue: iss.id,
      prompt: 'p',
    })) as { sessionId: SessionId; agentId: string }
    // agentId defaults to the session id when the spawn seam reports none.
    expect(r.agentId).toBe(r.sessionId)
    expect(h.sessions.map((s) => s.sessionId)).toContain(r.sessionId)
  })
})
