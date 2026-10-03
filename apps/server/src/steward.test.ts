import {
  asIssueId,
  asSessionId,
  asThreadId,
  MessageId,
  type SessionMeta,
  type SessionMetaInput,
} from '@podium/model'
import { normalizeSettings } from '@podium/runtime'
import { describe, expect, it, vi } from 'vitest'
import { firstAdminMemberId, userCommandPrincipal } from './command-principal'
import { type IssueDeps, IssueService } from './modules/issues/service'
import { issueTestPlumbing } from './modules/issues/service/test-plumbing'
import {
  isAcceptedLiveTerminalEvent,
  JANITOR_STEWARD_EVENT_LIMIT,
  noticeMessageId,
  type StewardDeps,
  StewardService,
  subscriptionEventKinds,
  TRIGGER_RULES,
} from './steward'
import type { SessionStore } from './store'
import { NotificationArbiter } from './store/notification-facts'
import { captureLogs } from './test-support/capture-logs'
import { openTestStore } from './test-support/open-test-store'
import { metasAsFacts, sessionReadPorts } from './test-support/session-facts'

/** The fixture's caller. `addComment` requires a principal (POD-1315) — these
 *  tests exercise the operator seam, so they say so rather than defaulting. */
const AS_OPERATOR = userCommandPrincipal(firstAdminMemberId(), 'admin')

async function harness(
  opts: { enabled?: boolean; sessions?: SessionMeta[]; seedCursor?: boolean } = {},
) {
  const store = await openTestStore(':memory:')
  // Issues are placed on a machine that reported their repo (2b803efb5 refuses
  // implicit placement), so the fixture's repo is reported by the host machine.
  await store.repos.addRepo('/r', store.hostMachineId)
  // Most tests want the events they emit consumed — pin the cursor to the log
  // start, as if the steward had been enabled since boot. First-enable seeding
  // tests pass seedCursor: false to exercise the absent-row path.
  if (opts.seedCursor !== false) await store.events.setStewardState('cursor', '0')
  const sessions = opts.sessions ?? []
  const settings = normalizeSettings({
    steward: { enabled: opts.enabled ?? true },
    gitWorkflow: { defaultParentBranch: '', mergeStyle: 'ff-only', autoRebaseBeforeMerge: true },
    sessionDefaults: { agent: 'claude-code' },
  })
  // Incrementing clock: a pinned constant made same-batch comments share
  // created_at, so order assertions fell to the cmt_<uuid> tie-break (flaky).
  let clockMs = Date.parse('2026-07-02T00:00:00.000Z')
  const now = () => new Date(clockMs++).toISOString()
  const advanceTime = (ms: number) => {
    clockMs += ms
  }
  const issueDeps: IssueDeps = {
    store,
    ...sessionReadPorts(() => sessions),
    getSettings: async () => settings,
    spawnSession: vi.fn(async () => ({
      sessionId: asSessionId('s1'),
      machine: 'machine-under-test',
    })),
    repoOp: vi.fn(async () => ({ ok: true, output: '' })),
    ...issueTestPlumbing(),
    now,
  }
  const issues = await IssueService.create(issueDeps)
  const sendNotice = vi.fn()
  // The external-notification seam (#470) [spec:SP-17db] — injected, so the unit
  // tests assert the call without ever reaching ntfy/Telegram.
  const notify = vi.fn()
  const deps: StewardDeps = {
    store: store.events,
    facts: store.notificationFacts,
    messages: store.messages,
    issues,
    sessionFacts: () => metasAsFacts(sessions),
    sessionById: async (sessionId) => sessions.find((s) => s.sessionId === sessionId),
    sendNotice,
    notify,
    getSettings: async () => settings,
    now,
  }
  return {
    store,
    issues,
    sendNotice,
    notify,
    deps,
    arbiter: new NotificationArbiter(store.notificationFacts, now),
    advanceTime,
    steward: new StewardService(deps),
  }
}

const fakeSession = (s: Partial<SessionMetaInput>): SessionMeta =>
  ({
    sessionId: asSessionId('s?'),
    agentKind: 'claude-code',
    cwd: '/',
    status: 'live',
    ...s,
  }) as never

// #175: comment bodies left IssueProjection — read the thread via IssueService.comments.
const stewardComments = async (issues: IssueService, id: string) =>
  (await issues.reports.comments(id)).filter((c) => c.author === 'steward')

/** Seeds a message row proving `fromIssue` already told `to` directly — the
 *  already-communicated fixture (§07b, POD-913). `createdAt` defaults to the
 *  real wall clock, which always lands after the harness's simulated
 *  2026-07-02 event clock, so it satisfies the "since the change" window
 *  without threading the exact event timestamp through every test. */
async function seedTold(
  store: SessionStore,
  fromIssue: string,
  to: { kind: 'session' | 'issue'; id: string },
  opts: { createdAt?: string; id?: string } = {},
) {
  const id = opts.id ?? `msg_${to.kind}_${to.id}`
  await store.messages.addMessage({
    id,
    threadId: asThreadId(id),
    inReplyTo: null,
    fromKind: 'agent',
    fromSession: null,
    fromIssue: asIssueId(fromIssue),
    toKind: to.kind,
    toId: to.id,
    kind: 'message',
    urgency: 'next-turn',
    lifecycle: 'wait',
    body: 'already told you directly',
    expiresAt: null,
    createdAt: opts.createdAt ?? new Date().toISOString(),
    deliveryStatus: 'stored',
    deliveredAt: null,
    deliveredTo: null,
    ackedBy: null,
    hop: 0,
    clampedFrom: null,
    remindedAt: null,
    expectsResponse: false,
  })
}

describe('TRIGGER_RULES', () => {
  it('maps closed/ready to a per-repo unblock key and needs_human to a per-issue key', () => {
    const e = { id: 1, ts: 't', kind: '', subject: 'iss_x', repoPath: '/r', payload: {} }
    expect(TRIGGER_RULES['issue.closed']!({ ...e, kind: 'issue.closed' })).toBe('unblock:/r')
    expect(TRIGGER_RULES['issue.ready']!({ ...e, kind: 'issue.ready' })).toBe('unblock:/r')
    expect(TRIGGER_RULES['issue.needs_human']!({ ...e, kind: 'issue.needs_human' })).toBe(
      'needshuman:iss_x',
    )
    expect(TRIGGER_RULES['issue.created']).toBeUndefined()
  })

  it('issue.closed with a parentId fans out to unblock AND parentnudge keys', () => {
    const e = { id: 1, ts: 't', kind: 'issue.closed', subject: 'iss_c', repoPath: '/r' }
    expect(
      TRIGGER_RULES['issue.closed']!({ ...e, payload: { seq: 3, parentId: 'iss_p' } }),
    ).toEqual(['unblock:/r', 'parentnudge:closed:iss_p'])
    // No parentId → single unblock key only (no parentnudge batch is formed).
    expect(TRIGGER_RULES['issue.closed']!({ ...e, payload: { seq: 3 } })).toBe('unblock:/r')
  })

  it('issue.stage_changed→review with a parentId keys a review parent-nudge; other stages ignored', () => {
    const e = { id: 1, ts: 't', kind: 'issue.stage_changed', subject: 'iss_c', repoPath: '/r' }
    expect(
      TRIGGER_RULES['issue.stage_changed']!({
        ...e,
        payload: { seq: 3, to: 'review', parentId: 'iss_p' },
      }),
    ).toBe('parentnudge:review:iss_p')
    // to !== review → no key; to === review but no parent → no key.
    expect(
      TRIGGER_RULES['issue.stage_changed']!({
        ...e,
        payload: { seq: 3, to: 'in_progress', parentId: 'iss_p' },
      }),
    ).toBeUndefined()
    expect(
      TRIGGER_RULES['issue.stage_changed']!({ ...e, payload: { seq: 3, to: 'review' } }),
    ).toBeUndefined()
  })

  it('issue.needs_human always breadcrumbs; with a parentId ALSO keys a parent-nudge', () => {
    const e = { id: 1, ts: 't', kind: 'issue.needs_human', subject: 'iss_c', repoPath: '/r' }
    expect(TRIGGER_RULES['issue.needs_human']!({ ...e, payload: { seq: 3 } })).toBe(
      'needshuman:iss_c',
    )
    expect(
      TRIGGER_RULES['issue.needs_human']!({ ...e, payload: { seq: 3, parentId: 'iss_p' } }),
    ).toEqual(['needshuman:iss_c', 'parentnudge:needs_human:iss_p'])
  })
})

describe('Steward causal terminal gate [spec:SP-cdb2]', () => {
  const baseEvent = {
    id: 1,
    ts: 't',
    kind: 'session.phase',
    subject: 'child',
    repoPath: null,
  }
  const accepted = {
    phase: 'idle',
    verdict: 'done',
    transitionId: 'terminal-1',
    transitionKind: 'turn_terminal',
    provenance: 'live',
    observerGeneration: 7,
    providerCursor: { segmentId: 'claude:one', components: { transcript: 40 } },
    turnEpoch: 1,
    priorPhase: 'working',
    nextPhase: 'idle',
  }

  it('rejects bootstrap, replay, same-phase refresh, and no-input causal terminals', () => {
    for (const payload of [
      { ...accepted, provenance: 'bootstrap' },
      { ...accepted, provenance: 'replay' },
      { ...accepted, transitionKind: 'activity' },
      { ...accepted, priorPhase: 'idle' },
      { ...accepted, turnEpoch: 0 },
      { phase: 'idle', verdict: 'done', transitionId: 'partial-v1' },
    ]) {
      const event = { ...baseEvent, payload }
      expect(isAcceptedLiveTerminalEvent(event)).toBe(false)
      expect(TRIGGER_RULES['session.phase']!(event)).toBe('ackfallback:child')
    }
  })

  it('nudges a parent once for one accepted live terminal cursor; duplicate/restart replay is inert', async () => {
    const sessions = [
      fakeSession({ sessionId: asSessionId('parent'), status: 'hibernated', cwd: '/r/p' }),
      fakeSession({
        sessionId: asSessionId('child'),
        status: 'live',
        cwd: '/r/c',
        spawnedBy: 'session:parent',
      }),
    ]
    const { steward, sendNotice, store } = await harness({ sessions })
    await store.events.appendEvent({
      ts: 't1',
      kind: 'session.phase',
      subject: 'child',
      payload: accepted,
    })
    await steward.tick()
    expect(sendNotice).toHaveBeenCalledTimes(1)
    await store.events.appendEvent({
      ts: 't2',
      kind: 'session.phase',
      subject: 'child',
      payload: accepted,
    })
    await steward.tick()
    expect(sendNotice).toHaveBeenCalledTimes(1)
    await store.events.appendEvent({
      ts: 't3',
      kind: 'session.phase',
      subject: 'child',
      payload: {
        ...accepted,
        transitionId: 'bootstrap-restart',
        provenance: 'bootstrap',
        observerGeneration: 8,
      },
    })
    await steward.tick()
    expect(sendNotice).toHaveBeenCalledTimes(1)
  })
  it('nudges exactly once when final child bookkeeping closes working to idle', async () => {
    const sessions = [
      fakeSession({ sessionId: asSessionId('parent'), status: 'hibernated', cwd: '/r/p' }),
      fakeSession({
        sessionId: asSessionId('child'),
        status: 'live',
        cwd: '/r/c',
        spawnedBy: 'session:parent',
      }),
    ]
    const { steward, sendNotice, store } = await harness({ sessions })
    const closure = {
      ...accepted,
      transitionId: 'child-close-1',
      transitionKind: 'subagent_bookkeeping',
      providerCursor: { segmentId: 'claude:one', components: { transcript: 55 } },
    }
    expect(isAcceptedLiveTerminalEvent({ ...baseEvent, payload: closure })).toBe(true)
    expect(
      isAcceptedLiveTerminalEvent({
        ...baseEvent,
        payload: { ...closure, priorPhase: 'idle' },
      }),
    ).toBe(false)

    await store.events.appendEvent({
      ts: 't1',
      kind: 'session.phase',
      subject: 'child',
      payload: closure,
    })
    await steward.tick()
    expect(sendNotice).toHaveBeenCalledTimes(1)

    await store.events.appendEvent({
      ts: 't2',
      kind: 'session.phase',
      subject: 'child',
      payload: closure,
    })
    await steward.tick()
    expect(sendNotice).toHaveBeenCalledTimes(1)
  })
})

describe('StewardService cursor', () => {
  it('consumes events exactly once and persists the cursor across re-instantiation', async () => {
    const { store, deps, steward } = await harness()
    await store.events.appendEvent({
      ts: 't',
      kind: 'issue.created',
      subject: 'iss_a',
      repoPath: '/r',
    })
    const id2 = await store.events.appendEvent({
      ts: 't',
      kind: 'issue.created',
      subject: 'iss_b',
      repoPath: '/r',
    })
    await steward.tick()
    expect(await store.events.getStewardState('cursor')).toBe(String(id2))
    // Crash-resume: a fresh instance over the same store starts past the batch.
    const reborn = new StewardService(deps)
    const listSpy = vi.spyOn(store.events, 'listEventsSince')
    await reborn.tick()
    expect(listSpy).toHaveBeenCalledExactlyOnceWith(id2, undefined)
  })

  it('does not advance the cursor past a batch until its handlers ran', async () => {
    const { store, issues, steward } = await harness()
    const a = await issues.crud.create({ repoPath: '/r', title: 'A', startNow: false })
    const b = await issues.crud.create({ repoPath: '/r', title: 'B', startNow: false })
    await issues.hierarchy.addDep(b.id, a.id, 'blocks')
    await issues.crud.close(a.id)
    let cursorDuringHandler: string | undefined
    const orig = issues.commentsMail.addComment.bind(issues.commentsMail)
    vi.spyOn(issues.commentsMail, 'addComment').mockImplementation(
      async (id, author, body, principal) => {
        cursorDuringHandler = await store.events.getStewardState('cursor')
        return await orig(id, author, body, principal)
      },
    )
    await steward.tick()
    expect(cursorDuringHandler).toBe('0') // still pre-batch while handling
    expect(Number(await store.events.getStewardState('cursor'))).toBeGreaterThan(0)
  })

  it('first enable seeds the cursor to the log head — dark-run history never replays', async () => {
    const { store, issues, steward, sendNotice } = await harness({ seedCursor: false })
    // Events accumulated while the steward ran dark (no cursor row yet).
    const a = await issues.crud.create({ repoPath: '/r', title: 'A', startNow: false })
    const b = await issues.crud.create({ repoPath: '/r', title: 'B', startNow: false })
    await issues.hierarchy.addDep(b.id, a.id, 'blocks')
    await issues.crud.close(a.id)
    const max = await store.events.maxEventId()
    expect(max).toBeGreaterThan(0)
    await steward.tick()
    expect(await store.events.getStewardState('cursor')).toBe(String(max))
    expect(await stewardComments(issues, b.id)).toEqual([])
    expect(sendNotice).not.toHaveBeenCalled()
  })

  it('first janitor ownership skips the source topology dark-run history once', async () => {
    const { store, issues, steward, sendNotice } = await harness()
    const blocker = await issues.crud.create({ repoPath: '/r', title: 'Blocker', startNow: false })
    const dependent = await issues.crud.create({ repoPath: '/r', title: 'Dependent', startNow: false })
    await issues.hierarchy.addDep(dependent.id, blocker.id, 'blocks')
    await issues.crud.close(blocker.id)
    const darkHead = await store.events.maxEventId()

    await steward.tick({ owner: 'janitor', limit: JANITOR_STEWARD_EVENT_LIMIT })

    expect(await store.events.getStewardState('cursor')).toBe(String(darkHead))
    expect(await store.events.getStewardState('janitor-ownership-v1')).toBe(String(darkHead))
    expect(await stewardComments(issues, dependent.id)).toEqual([])
    expect(sendNotice).not.toHaveBeenCalled()

    const liveEvent = await store.events.appendEvent({
      ts: 't',
      kind: 'issue.created',
      subject: 'iss_live',
      repoPath: '/r',
    })
    await steward.tick({ owner: 'janitor', limit: JANITOR_STEWARD_EVENT_LIMIT })
    expect(await store.events.getStewardState('cursor')).toBe(String(liveEvent))
  })

  it('bounds later janitor catch-up without changing ordinary steward polls', async () => {
    const { store, steward } = await harness()
    // Establish ownership at an empty head, then create a genuine post-activation
    // backlog. The first bounded pass must not consume beyond its budget.
    await steward.tick({ owner: 'janitor', limit: JANITOR_STEWARD_EVENT_LIMIT })
    const ids: number[] = []
    for (let index = 0; index < JANITOR_STEWARD_EVENT_LIMIT + 2; index++) {
      ids.push(
        await store.events.appendEvent({
          ts: 't',
          kind: 'test.unmatched',
          subject: 'subject-' + index,
          repoPath: '/r',
        }),
      )
    }
    const listSpy = vi.spyOn(store.events, 'listEventsSince')

    await steward.tick({ owner: 'janitor', limit: JANITOR_STEWARD_EVENT_LIMIT })

    expect(listSpy).toHaveBeenLastCalledWith(0, { limit: JANITOR_STEWARD_EVENT_LIMIT })
    expect(await store.events.getStewardState('cursor')).toBe(
      String(ids[JANITOR_STEWARD_EVENT_LIMIT - 1]),
    )
    await steward.tick()
    expect(listSpy).toHaveBeenLastCalledWith(ids[JANITOR_STEWARD_EVENT_LIMIT - 1], undefined)
    expect(await store.events.getStewardState('cursor')).toBe(String(ids.at(-1)))
  })

  it('a corrupt cursor re-seeds to the log head instead of wedging', async () => {
    const { store, issues, steward } = await harness()
    await store.events.setStewardState('cursor', 'garbage')
    const a = await issues.crud.create({ repoPath: '/r', title: 'A', startNow: false })
    const logs = captureLogs()
    await expect(steward.tick()).resolves.toBeUndefined()
    expect(logs.at('warn')).toContainEqual(
      expect.objectContaining({
        ns: 'server:steward',
        msg: expect.stringContaining('corrupt cursor'),
      }),
    )
    expect(await store.events.getStewardState('cursor')).toBe(
      String(await store.events.maxEventId()),
    )
    logs.restore()
    // Recovered: the next event past the re-seed is consumed normally.
    await issues.crud.setNeedsHuman(a.id, 'q')
    await steward.tick()
    expect((await store.events.listEventsSince(0, { kinds: ['steward.observed'] })).length).toBe(1)
  })
})

describe('StewardService unblock handler', () => {
  it('posting the unblock comment carries the closed issue completion note', async () => {
    const { issues, steward } = await harness()
    const a = await issues.crud.create({ repoPath: '/r', title: 'A', startNow: false })
    const b = await issues.crud.create({ repoPath: '/r', title: 'B', startNow: false })
    await issues.hierarchy.addDep(b.id, a.id, 'blocks')
    await issues.commentsMail.addComment(a.id, 'agent', '[completion-note] shipped X', AS_OPERATOR)
    await issues.crud.close(a.id)
    await steward.tick()
    const posted = await stewardComments(issues, b.id)
    expect(posted.length).toBe(1)
    expect(posted[0]!.body).toContain(`Unblocked by #${a.seq}:`)
    expect(posted[0]!.body).toContain('shipped X')
  })

  it('replayed events do not duplicate the comment or nudge (reset-cursor idempotence)', async () => {
    const sessions = [fakeSession({ sessionId: asSessionId('s1'), cwd: '/r/.worktrees/issue-2-b' })]
    const { store, issues, steward, sendNotice } = await harness({ sessions })
    const a = await issues.crud.create({ repoPath: '/r', title: 'A', startNow: false })
    const b = await issues.crud.create({ repoPath: '/r', title: 'B', startNow: false })
    await issues.crud.update(b.id, { worktreePath: '/r/.worktrees/issue-2-b' })
    await issues.hierarchy.addDep(b.id, a.id, 'blocks')
    await issues.crud.close(a.id)
    await steward.tick()
    expect((await stewardComments(issues, b.id)).length).toBe(1)
    expect(sendNotice).toHaveBeenCalledTimes(1)
    // Crash-replay: rewind the cursor so the SAME events are read again.
    await store.events.setStewardState('cursor', '0')
    await steward.tick()
    expect((await stewardComments(issues, b.id)).length).toBe(1)
    expect(sendNotice).toHaveBeenCalledTimes(1)
  })

  it('retries a missing nudge after the comment was durably written', async () => {
    const sessions = [fakeSession({ sessionId: asSessionId('s1'), cwd: '/r/.worktrees/issue-2-b' })]
    const { store, issues, steward, sendNotice } = await harness({ sessions })
    const a = await issues.crud.create({ repoPath: '/r', title: 'A', startNow: false })
    const b = await issues.crud.create({ repoPath: '/r', title: 'B', startNow: false })
    await issues.crud.update(b.id, { worktreePath: '/r/.worktrees/issue-2-b' })
    await issues.hierarchy.addDep(b.id, a.id, 'blocks')
    await issues.crud.close(a.id)
    sendNotice.mockImplementationOnce(() => {
      throw new Error('crash after comment')
    })
    const logs = captureLogs()

    await steward.tick()
    expect(await stewardComments(issues, b.id)).toHaveLength(1)
    expect(sendNotice).toHaveBeenCalledTimes(1)
    expect(await store.events.getStewardState('cursor')).toBe('0')

    await steward.tick()
    expect(await stewardComments(issues, b.id)).toHaveLength(1)
    expect(sendNotice).toHaveBeenCalledTimes(2)
    expect(Number(await store.events.getStewardState('cursor'))).toBeGreaterThan(0)
    logs.restore()
  })

  it('a nudge whose send FAILS LATER is not claimed, and the next pass resends it under the same id', async () => {
    const sessions = [fakeSession({ sessionId: asSessionId('s1'), cwd: '/r/.worktrees/issue-2-b' })]
    const { store, issues, steward, sendNotice } = await harness({ sessions })
    const a = await issues.crud.create({ repoPath: '/r', title: 'A', startNow: false })
    const b = await issues.crud.create({ repoPath: '/r', title: 'B', startNow: false })
    await issues.crud.update(b.id, { worktreePath: '/r/.worktrees/issue-2-b' })
    await issues.hierarchy.addDep(b.id, a.id, 'blocks')
    await issues.crud.close(a.id)
    // A send that fails AFTER it was started — the shape a durable queue write
    // that loses its connection has. Unawaited, this failure was invisible and
    // the fact was claimed anyway: the notice was lost for good.
    sendNotice.mockImplementationOnce(async () => {
      await Promise.resolve()
      throw new Error('queue write failed')
    })
    const logs = captureLogs()

    await steward.tick()
    expect(await store.events.getStewardState('cursor')).toBe('0')

    await steward.tick()
    expect(sendNotice).toHaveBeenCalledTimes(2)
    const [first, second] = sendNotice.mock.calls.map((call) => call[2])
    expect(second).toBe(first)
    const ready = (await store.events.listEventsSince(0)).find(
      (e) => e.kind === 'issue.ready' && e.subject === b.id,
    )
    if (!ready) throw new Error('the close emitted no issue.ready for the dependent')
    expect(second).toBe(noticeMessageId(`unblock:${b.id}:${a.seq}`, asSessionId('s1'), ready.id))
    expect(Number(await store.events.getStewardState('cursor'))).toBeGreaterThan(0)
    logs.restore()
  })

  it('dedup is colon-anchored: a prior #<seq><digit> comment does not swallow #<seq>', async () => {
    const { issues, steward } = await harness()
    const a = await issues.crud.create({ repoPath: '/r', title: 'A', startNow: false }) // seq 1
    const b = await issues.crud.create({ repoPath: '/r', title: 'B', startNow: false })
    // A steward comment for a DIFFERENT closer whose seq starts with a's seq
    // ('#15' contains '#1') — must not match a's marker 'Unblocked by #1:'.
    await issues.commentsMail.addComment(b.id, 'steward', 'Unblocked by #15: earlier thing', AS_OPERATOR)
    await issues.hierarchy.addDep(b.id, a.id, 'blocks')
    await issues.crud.close(a.id)
    await steward.tick()
    const posted = (await stewardComments(issues, b.id)).filter((c) =>
      c.body.startsWith(`Unblocked by #${a.seq}:`),
    )
    expect(posted.length).toBe(1)
  })

  it('falls back to the closed issue title when it has no completion note', async () => {
    const { issues, steward } = await harness()
    const a = await issues.crud.create({
      repoPath: '/r',
      title: 'Fix the flux capacitor',
      startNow: false,
    })
    const b = await issues.crud.create({ repoPath: '/r', title: 'B', startNow: false })
    await issues.hierarchy.addDep(b.id, a.id, 'blocks')
    await issues.crud.close(a.id)
    await steward.tick()
    expect((await stewardComments(issues, b.id))[0]!.body).toBe(
      `Unblocked by #${a.seq}: Fix the flux capacitor`,
    )
  })

  it('nudges only live/starting agent sessions — never shells, never parked sessions', async () => {
    const sessions = [
      // queueText would resurrect this via its resume ref — must be skipped.
      fakeSession({
        sessionId: asSessionId('parked'),
        cwd: '/r/.worktrees/issue-2-b',
        status: 'exited',
      }),
      fakeSession({
        sessionId: asSessionId('hib'),
        cwd: '/r/.worktrees/issue-2-b',
        status: 'hibernated',
      }),
      // a shell would have the nudge typed into bash — must be skipped.
      fakeSession({
        sessionId: asSessionId('sh'),
        cwd: '/r/.worktrees/issue-2-b',
        agentKind: 'shell',
      }),
      fakeSession({ sessionId: asSessionId('live1'), cwd: '/r/.worktrees/issue-2-b' }),
      fakeSession({ sessionId: asSessionId('elsewhere'), cwd: '/other' }),
    ]
    const { issues, steward, sendNotice } = await harness({ sessions })
    const a = await issues.crud.create({ repoPath: '/r', title: 'A', startNow: false })
    const b = await issues.crud.create({ repoPath: '/r', title: 'B', startNow: false })
    await issues.crud.update(b.id, { worktreePath: '/r/.worktrees/issue-2-b' })
    await issues.hierarchy.addDep(b.id, a.id, 'blocks')
    await issues.commentsMail.addComment(a.id, 'agent', '[completion-note] shipped $(dangerous) X', AS_OPERATOR)
    await issues.crud.close(a.id)
    await steward.tick()
    expect(sendNotice).toHaveBeenCalledTimes(1)
    const [target, text] = sendNotice.mock.calls[0] as [string, string]
    expect(target).toBe('live1')
    // It reaches a live session and has no business waking a parked one: a
    // wait-lifecycle message is held for a parked session's next run.
    expect(sendNotice.mock.calls[0]?.[3]).toBe('wait')
    // Defense in depth: single line, no backticks, no agent-authored note text.
    expect(text).toBe(
      `Blocker #${a.seq} closed — you are unblocked. See the steward comment on your issue, or run: podium issue prime`,
    )
    expect(text).not.toContain('`')
    expect(text).not.toContain('shipped')
    expect(text).not.toContain('\n')
  })

  it('routes an unblock nudge only to the eligible dependent coordinator', async () => {
    const sessions = [
      fakeSession({ sessionId: asSessionId('worker'), cwd: '/r/.worktrees/issue-2-b' }),
      fakeSession({
        sessionId: asSessionId('coordinator'),
        cwd: '/r/.worktrees/issue-2-b',
        status: 'starting',
      }),
    ]
    const { issues, steward, sendNotice } = await harness({ sessions })
    const blocker = await issues.crud.create({ repoPath: '/r', title: 'Blocker', startNow: false })
    const dependent = await issues.crud.create({ repoPath: '/r', title: 'Dependent', startNow: false })
    await issues.crud.update(dependent.id, { worktreePath: '/r/.worktrees/issue-2-b' })
    await issues.crud.setCoordinator(dependent.id, asSessionId('coordinator'))
    await issues.hierarchy.addDep(dependent.id, blocker.id, 'blocks')

    await issues.crud.close(blocker.id)
    await steward.tick()

    expect(sendNotice.mock.calls.map((call) => call[0])).toEqual(['coordinator'])
  })

  it('no live session → no nudge, but the comment still lands', async () => {
    const { issues, steward, sendNotice } = await harness()
    const a = await issues.crud.create({ repoPath: '/r', title: 'A', startNow: false })
    const b = await issues.crud.create({ repoPath: '/r', title: 'B', startNow: false })
    await issues.hierarchy.addDep(b.id, a.id, 'blocks')
    await issues.crud.close(a.id)
    await steward.tick()
    expect(sendNotice).not.toHaveBeenCalled()
    expect((await stewardComments(issues, b.id)).length).toBe(1)
  })

  it('suppresses the nudge to the session that caused the close, still nudges others', async () => {
    const sessions = [
      // The agent that closed the blocker: it already knows — must NOT be nudged.
      fakeSession({ sessionId: asSessionId('causer'), cwd: '/r/.worktrees/issue-2-b' }),
      fakeSession({ sessionId: asSessionId('other'), cwd: '/r/.worktrees/issue-2-b' }),
    ]
    const { issues, steward, sendNotice } = await harness({ sessions })
    const a = await issues.crud.create({ repoPath: '/r', title: 'A', startNow: false })
    const b = await issues.crud.create({ repoPath: '/r', title: 'B', startNow: false })
    await issues.crud.update(b.id, { worktreePath: '/r/.worktrees/issue-2-b' })
    await issues.hierarchy.addDep(b.id, a.id, 'blocks')
    await issues.crud.close(a.id, 'done', { actorSessionId: asSessionId('causer') })
    await steward.tick()
    // Comment/audit trail is unchanged — the note still lands on the dependent.
    expect((await stewardComments(issues, b.id)).length).toBe(1)
    // Only the non-actor live session is nudged.
    const targets = sendNotice.mock.calls.map((c) => (c as [string, string])[0])
    expect(targets).toEqual(['other'])
  })

  it('already-communicated (§07b, POD-913): suppresses the nudge when the closer already messaged the dependent directly', async () => {
    const sessions = [
      fakeSession({ sessionId: asSessionId('other'), cwd: '/r/.worktrees/issue-2-b' }),
    ]
    const { issues, steward, sendNotice, store } = await harness({ sessions })
    const a = await issues.crud.create({ repoPath: '/r', title: 'A', startNow: false })
    const b = await issues.crud.create({ repoPath: '/r', title: 'B', startNow: false })
    await issues.crud.update(b.id, { worktreePath: '/r/.worktrees/issue-2-b' })
    await issues.hierarchy.addDep(b.id, a.id, 'blocks')
    // A's agent already told the dependent session directly, ahead of closing.
    await seedTold(store, a.id, { kind: 'session', id: 'other' })
    await issues.crud.close(a.id)
    await steward.tick()
    // The audit-trail comment still lands — only the redundant nudge is cut.
    expect((await stewardComments(issues, b.id)).length).toBe(1)
    expect(sendNotice).not.toHaveBeenCalled()
  })
})

describe('StewardService parent-nudge handler', () => {
  it('child close → parent comment with note excerpt + one nudge with correct counts', async () => {
    const sessions = [
      fakeSession({ sessionId: asSessionId('plive'), cwd: '/r/.worktrees/issue-1-epic' }),
    ]
    const { issues, steward, sendNotice } = await harness({ sessions })
    const parent = await issues.crud.create({ repoPath: '/r', title: 'Epic', startNow: false }) // seq 1
    await issues.crud.update(parent.id, { worktreePath: '/r/.worktrees/issue-1-epic' })
    const c1 = await issues.crud.create({
      repoPath: '/r',
      title: 'Child 1',
      parentId: parent.id,
      startNow: false,
    })
    await issues.crud.create({ repoPath: '/r', title: 'Child 2', parentId: parent.id, startNow: false })
    await issues.crud.create({ repoPath: '/r', title: 'Child 3', parentId: parent.id, startNow: false })
    await issues.commentsMail.addComment(
      c1.id,
      'agent',
      '[completion-note] shipped the widget\nsecond line ignored',
      AS_OPERATOR,
    )
    await issues.crud.close(c1.id)
    await steward.tick()
    const posted = await stewardComments(issues, parent.id)
    expect(posted.length).toBe(1)
    expect(posted[0]!.body).toBe(`Child #${c1.seq} closed: shipped the widget`)
    expect(sendNotice).toHaveBeenCalledTimes(1)
    const [target, text] = sendNotice.mock.calls[0] as [string, string]
    expect(target).toBe('plive')
    expect(sendNotice.mock.calls[0]?.[3]).toBe('wait')
    expect(text).toBe(
      `Child issue #${c1.seq} closed — 2 of 3 children remain. See the steward comment, or run: podium issue prime`,
    )
    // Comment-only excerpt: the agent-authored note never reaches the nudge.
    expect(text).not.toContain('widget')
    expect(text).not.toContain('\n')
  })

  it('routes a child-event nudge only to the parent coordinator', async () => {
    const sessions = [
      fakeSession({ sessionId: asSessionId('worker'), cwd: '/r/.worktrees/issue-1-epic' }),
      fakeSession({
        sessionId: asSessionId('coordinator'),
        cwd: '/r/.worktrees/issue-1-epic',
      }),
    ]
    const { issues, steward, sendNotice } = await harness({ sessions })
    const parent = await issues.crud.create({ repoPath: '/r', title: 'Epic', startNow: false })
    await issues.crud.update(parent.id, { worktreePath: '/r/.worktrees/issue-1-epic' })
    await issues.crud.setCoordinator(parent.id, asSessionId('coordinator'))
    const child = await issues.crud.create({
      repoPath: '/r',
      title: 'Child',
      parentId: parent.id,
      startNow: false,
    })

    await issues.crud.close(child.id)
    await steward.tick()

    expect(sendNotice.mock.calls.map((call) => call[0])).toEqual(['coordinator'])
  })

  it('already-communicated (§07b, POD-913): suppresses the nudge when the child already messaged the parent directly', async () => {
    const sessions = [
      fakeSession({ sessionId: asSessionId('plive'), cwd: '/r/.worktrees/issue-1-epic' }),
    ]
    const { issues, steward, sendNotice, store } = await harness({ sessions })
    const parent = await issues.crud.create({ repoPath: '/r', title: 'Epic', startNow: false })
    await issues.crud.update(parent.id, { worktreePath: '/r/.worktrees/issue-1-epic' })
    const c1 = await issues.crud.create({
      repoPath: '/r',
      title: 'Child 1',
      parentId: parent.id,
      startNow: false,
    })
    await issues.crud.create({ repoPath: '/r', title: 'Child 2', parentId: parent.id, startNow: false })
    // The child already told the parent's live session directly.
    await seedTold(store, c1.id, { kind: 'session', id: 'plive' })
    await issues.crud.close(c1.id)
    await steward.tick()
    // The audit-trail comment still lands — only the redundant nudge is cut.
    expect((await stewardComments(issues, parent.id)).length).toBe(1)
    expect(sendNotice).not.toHaveBeenCalled()
  })

  it('two children closing in one batch → two comments, ONE nudge with latest counts', async () => {
    const sessions = [
      fakeSession({ sessionId: asSessionId('plive'), cwd: '/r/.worktrees/issue-1-epic' }),
    ]
    const { issues, steward, sendNotice } = await harness({ sessions })
    const parent = await issues.crud.create({ repoPath: '/r', title: 'Epic', startNow: false })
    await issues.crud.update(parent.id, { worktreePath: '/r/.worktrees/issue-1-epic' })
    const c1 = await issues.crud.create({
      repoPath: '/r',
      title: 'Child 1',
      parentId: parent.id,
      startNow: false,
    })
    const c2 = await issues.crud.create({
      repoPath: '/r',
      title: 'Child 2',
      parentId: parent.id,
      startNow: false,
    })
    await issues.crud.create({ repoPath: '/r', title: 'Child 3', parentId: parent.id, startNow: false })
    await issues.crud.close(c1.id)
    await issues.crud.close(c2.id)
    await steward.tick()
    const posted = await stewardComments(issues, parent.id)
    expect(posted.map((c) => c.body)).toEqual([
      `Child #${c1.seq} closed: Child 1`,
      `Child #${c2.seq} closed: Child 2`,
    ])
    expect(sendNotice).toHaveBeenCalledTimes(1)
    expect((sendNotice.mock.calls[0] as [string, string])[1]).toBe(
      `Child issue #${c2.seq} closed — 1 of 3 children remain. See the steward comment, or run: podium issue prime`,
    )
  })

  it('cursor-rewind replay posts no duplicate comment and no second nudge', async () => {
    const sessions = [
      fakeSession({ sessionId: asSessionId('plive'), cwd: '/r/.worktrees/issue-1-epic' }),
    ]
    const { store, issues, steward, sendNotice } = await harness({ sessions })
    const parent = await issues.crud.create({ repoPath: '/r', title: 'Epic', startNow: false })
    await issues.crud.update(parent.id, { worktreePath: '/r/.worktrees/issue-1-epic' })
    const c1 = await issues.crud.create({
      repoPath: '/r',
      title: 'Child 1',
      parentId: parent.id,
      startNow: false,
    })
    await issues.crud.close(c1.id)
    await steward.tick()
    expect((await stewardComments(issues, parent.id)).length).toBe(1)
    expect(sendNotice).toHaveBeenCalledTimes(1)
    await store.events.setStewardState('cursor', '0')
    await steward.tick()
    expect((await stewardComments(issues, parent.id)).length).toBe(1)
    expect(sendNotice).toHaveBeenCalledTimes(1)
  })

  it('closing an issue without a parentId produces no parent-nudge activity', async () => {
    const { issues, steward, sendNotice } = await harness()
    const solo = await issues.crud.create({ repoPath: '/r', title: 'Solo', startNow: false })
    await issues.crud.close(solo.id)
    await steward.tick()
    // No parent exists; nothing to comment on, nothing to nudge.
    expect(sendNotice).not.toHaveBeenCalled()
    // #175: bodies left the wire — assert via counts + the thread read.
    expect((await issues.reports.list('/r')).every((w) => (w.commentCount ?? 0) === 0)).toBe(true)
    const comments = await Promise.all((await issues.reports.list('/r')).map((w) => issues.reports.comments(w.id)))
    expect(comments.flat()).toEqual([])
  })

  it('suppresses the nudge to the session that caused the child close, comment still lands', async () => {
    const sessions = [
      // The orchestrator session that closed the child itself — no self-nudge.
      fakeSession({ sessionId: asSessionId('causer'), cwd: '/r/.worktrees/issue-1-epic' }),
      fakeSession({ sessionId: asSessionId('other'), cwd: '/r/.worktrees/issue-1-epic' }),
    ]
    const { issues, steward, sendNotice } = await harness({ sessions })
    const parent = await issues.crud.create({ repoPath: '/r', title: 'Epic', startNow: false })
    await issues.crud.update(parent.id, { worktreePath: '/r/.worktrees/issue-1-epic' })
    const c1 = await issues.crud.create({
      repoPath: '/r',
      title: 'Child 1',
      parentId: parent.id,
      startNow: false,
    })
    await issues.crud.create({ repoPath: '/r', title: 'Child 2', parentId: parent.id, startNow: false })
    await issues.crud.close(c1.id, 'done', { actorSessionId: asSessionId('causer') })
    await steward.tick()
    // The parent comment is unchanged.
    expect((await stewardComments(issues, parent.id)).length).toBe(1)
    // The causer is excluded from the single coalesced nudge; 'other' still gets it.
    const targets = sendNotice.mock.calls.map((c) => (c as [string, string])[0])
    expect(targets).toEqual(['other'])
  })

  it('shell and exited sessions in the parent worktree get nothing', async () => {
    const sessions = [
      fakeSession({
        sessionId: asSessionId('parked'),
        cwd: '/r/.worktrees/issue-1-epic',
        status: 'exited',
      }),
      fakeSession({
        sessionId: asSessionId('sh'),
        cwd: '/r/.worktrees/issue-1-epic',
        agentKind: 'shell',
      }),
    ]
    const { issues, steward, sendNotice } = await harness({ sessions })
    const parent = await issues.crud.create({ repoPath: '/r', title: 'Epic', startNow: false })
    await issues.crud.update(parent.id, { worktreePath: '/r/.worktrees/issue-1-epic' })
    const c1 = await issues.crud.create({
      repoPath: '/r',
      title: 'Child 1',
      parentId: parent.id,
      startNow: false,
    })
    await issues.crud.close(c1.id)
    await steward.tick()
    expect(sendNotice).not.toHaveBeenCalled()
    expect((await stewardComments(issues, parent.id)).length).toBe(1) // comment still lands
  })

  it('note excerpt is first-line-only and capped at 200 chars', async () => {
    const { issues, steward } = await harness()
    const parent = await issues.crud.create({ repoPath: '/r', title: 'Epic', startNow: false })
    const c1 = await issues.crud.create({
      repoPath: '/r',
      title: 'Child 1',
      parentId: parent.id,
      startNow: false,
    })
    await issues.commentsMail.addComment(
      c1.id,
      'agent',
      `[completion-note] ${'x'.repeat(500)}\nmore lines`,
      AS_OPERATOR,
    )
    await issues.crud.close(c1.id)
    await steward.tick()
    const body = (await stewardComments(issues, parent.id))[0]!.body
    expect(body).toBe(`Child #${c1.seq} closed: ${'x'.repeat(200)}`)
    expect(body).not.toContain('\n')
  })
})

describe('StewardService child→review parent nudge', () => {
  it('a child moving to review notifies the parent (comment + nudge), other stages ignored', async () => {
    const sessions = [
      fakeSession({ sessionId: asSessionId('plive'), cwd: '/r/.worktrees/issue-1-epic' }),
    ]
    const { issues, steward, sendNotice } = await harness({ sessions })
    const parent = await issues.crud.create({ repoPath: '/r', title: 'Epic', startNow: false })
    await issues.crud.update(parent.id, { worktreePath: '/r/.worktrees/issue-1-epic' })
    const c1 = await issues.crud.create({
      repoPath: '/r',
      title: 'Child 1',
      parentId: parent.id,
      startNow: false,
    })
    await issues.commentsMail.addComment(
      c1.id,
      'agent',
      '[completion-note] widget ready for review',
      AS_OPERATOR,
    )
    await issues.crud.update(c1.id, { stage: 'in_progress' }) // backlog→in_progress: NOT a review transition
    await issues.crud.update(c1.id, { stage: 'review' }) // in_progress→review: fires
    await steward.tick()
    const posted = await stewardComments(issues, parent.id)
    expect(posted.length).toBe(1)
    expect(posted[0]!.body).toBe(`Child #${c1.seq} in review: widget ready for review`)
    expect(sendNotice).toHaveBeenCalledTimes(1)
    const [target, text] = sendNotice.mock.calls[0] as [string, string]
    expect(target).toBe('plive')
    expect(text).toContain(`Child issue #${c1.seq} moved to review`)
    expect(text).not.toContain('\n')
  })

  it('suppresses the review nudge to the session that caused the transition (#116 carried)', async () => {
    const sessions = [
      fakeSession({ sessionId: asSessionId('causer'), cwd: '/r/.worktrees/issue-1-epic' }),
      fakeSession({ sessionId: asSessionId('other'), cwd: '/r/.worktrees/issue-1-epic' }),
    ]
    const { issues, steward, sendNotice } = await harness({ sessions })
    const parent = await issues.crud.create({ repoPath: '/r', title: 'Epic', startNow: false })
    await issues.crud.update(parent.id, { worktreePath: '/r/.worktrees/issue-1-epic' })
    const c1 = await issues.crud.create({
      repoPath: '/r',
      title: 'Child 1',
      parentId: parent.id,
      startNow: false,
    })
    await issues.crud.update(c1.id, { stage: 'review' }, { actorSessionId: asSessionId('causer') })
    await steward.tick()
    expect((await stewardComments(issues, parent.id)).length).toBe(1)
    const targets = sendNotice.mock.calls.map((c) => (c as [string, string])[0])
    expect(targets).toEqual(['other'])
  })
})

describe('StewardService child→needs_human parent nudge', () => {
  it('a child needing a human notifies the parent AND leaves a breadcrumb', async () => {
    const sessions = [
      fakeSession({ sessionId: asSessionId('plive'), cwd: '/r/.worktrees/issue-1-epic' }),
    ]
    const { store, issues, steward, sendNotice } = await harness({ sessions })
    const parent = await issues.crud.create({ repoPath: '/r', title: 'Epic', startNow: false })
    await issues.crud.update(parent.id, { worktreePath: '/r/.worktrees/issue-1-epic' })
    const c1 = await issues.crud.create({
      repoPath: '/r',
      title: 'Child 1',
      parentId: parent.id,
      startNow: false,
    })
    await issues.crud.setNeedsHuman(c1.id, 'which database?')
    await steward.tick()
    const posted = await stewardComments(issues, parent.id)
    expect(posted.length).toBe(1)
    expect(posted[0]!.body).toBe(`Child #${c1.seq} needs a human: which database?`)
    expect(sendNotice).toHaveBeenCalledTimes(1)
    expect((sendNotice.mock.calls[0] as [string, string])[1]).toContain('needs a human')
    // Breadcrumb still recorded (unchanged from before).
    expect((await store.events.listEventsSince(0, { kinds: ['steward.observed'] })).length).toBe(1)
  })
})

describe('StewardService needs-human handler', () => {
  it('P1: leaves only a steward.observed breadcrumb', async () => {
    const { store, issues, steward } = await harness()
    const a = await issues.crud.create({ repoPath: '/r', title: 'A', startNow: false })
    await issues.crud.setNeedsHuman(a.id, 'which key?')
    await steward.tick()
    const crumbs = await store.events.listEventsSince(0, { kinds: ['steward.observed'] })
    expect(crumbs.length).toBe(1)
    expect(crumbs[0]).toMatchObject({ subject: a.id, payload: { kind: 'issue.needs_human' } })
    // The breadcrumb itself is unmatched — the next tick consumes it silently.
    await steward.tick()
    expect((await store.events.listEventsSince(0, { kinds: ['steward.observed'] })).length).toBe(1)
  })
})

describe('StewardService gating and resilience', () => {
  it('disabled → tick consumes nothing, not even the cursor seed', async () => {
    const { store, issues, steward, sendNotice } = await harness({
      enabled: false,
      seedCursor: false,
    })
    const a = await issues.crud.create({ repoPath: '/r', title: 'A', startNow: false })
    const b = await issues.crud.create({ repoPath: '/r', title: 'B', startNow: false })
    await issues.hierarchy.addDep(b.id, a.id, 'blocks')
    await issues.crud.close(a.id)
    await steward.tick()
    expect(await store.events.getStewardState('cursor')).toBeUndefined()
    expect(sendNotice).not.toHaveBeenCalled()
    expect(await stewardComments(issues, b.id)).toEqual([])
  })

  it('a throwing durable handler holds the cursor and succeeds on replay', async () => {
    const { store, issues, steward } = await harness()
    const a = await issues.crud.create({ repoPath: '/r', title: 'A', startNow: false })
    const b = await issues.crud.create({ repoPath: '/r', title: 'B', startNow: false })
    await issues.hierarchy.addDep(b.id, a.id, 'blocks')
    await issues.crud.close(a.id)
    const addComment = vi.spyOn(issues.commentsMail, 'addComment').mockImplementation(async () => {
      throw new Error('boom')
    })
    const logs = captureLogs()
    await expect(steward.tick()).resolves.toBeUndefined()
    expect(await store.events.getStewardState('cursor')).toBe('0')
    expect(logs.at('warn')).toContainEqual(
      expect.objectContaining({
        ns: 'server:steward',
        err: expect.objectContaining({ name: 'Error' }),
      }),
    )
    addComment.mockRestore()
    await steward.tick()
    expect(Number(await store.events.getStewardState('cursor'))).toBeGreaterThan(0)
    logs.restore()
  })
})

describe('StewardService stored subscriptions (Phase B)', () => {
  const seedSub = (
    over: Partial<import('./store').Subscription>,
  ): import('./store').Subscription => ({
    id: 'sub_x',
    subscriberKind: 'issue',
    subscriberId: 'iss_p',
    event: 'issue.closed',
    sourceKind: 'issue',
    sourceRef: 'iss_x',
    deliverNudge: true,
    deliverNotify: false,
    origin: 'custom',
    enabled: true,
    createdAt: 't',
    ...over,
  })

  it('an issue-event subscription fires once and dedups on cursor-rewind replay', async () => {
    const sessions = [fakeSession({ sessionId: asSessionId('psess'), cwd: '/r/.worktrees/p' })]
    const { store, issues, steward, sendNotice } = await harness({ sessions })
    const p = await issues.crud.create({ repoPath: '/r', title: 'Watcher', startNow: false })
    await issues.crud.update(p.id, { worktreePath: '/r/.worktrees/p' })
    const x = await issues.crud.create({ repoPath: '/r', title: 'Target', startNow: false })
    await store.events.addSubscription(
      seedSub({ id: 'sub_1', subscriberId: p.id, sourceRef: x.id }),
    )
    await issues.crud.close(x.id)
    await steward.tick()
    expect(sendNotice).toHaveBeenCalledTimes(1)
    const [target, text] = sendNotice.mock.calls[0] as [string, string]
    expect(target).toBe('psess')
    expect(text).not.toContain('`')
    expect(text).not.toContain('\n')
    // Crash-replay: the same close event is re-read but never re-delivered.
    await store.events.setStewardState('cursor', '0')
    await steward.tick()
    expect(sendNotice).toHaveBeenCalledTimes(1)
  })

  it('routes an issue subscription only to its coordinator', async () => {
    const sessions = [
      fakeSession({ sessionId: asSessionId('worker'), cwd: '/r/.worktrees/p' }),
      fakeSession({ sessionId: asSessionId('coordinator'), cwd: '/r/.worktrees/p' }),
    ]
    const { store, issues, steward, sendNotice } = await harness({ sessions })
    const subscriber = await issues.crud.create({ repoPath: '/r', title: 'Watcher', startNow: false })
    await issues.crud.update(subscriber.id, { worktreePath: '/r/.worktrees/p' })
    await issues.crud.setCoordinator(subscriber.id, asSessionId('coordinator'))
    const source = await issues.crud.create({ repoPath: '/r', title: 'Target', startNow: false })
    await store.events.addSubscription(
      seedSub({
        id: 'sub_coord',
        subscriberId: subscriber.id,
        sourceRef: source.id,
      }),
    )

    await issues.crud.close(source.id)
    await steward.tick()

    expect(sendNotice.mock.calls.map((call) => call[0])).toEqual(['coordinator'])
  })

  it('already-communicated (§07b, POD-913): suppresses a subscription nudge when the source issue already messaged the subscriber directly', async () => {
    const sessions = [fakeSession({ sessionId: asSessionId('psess'), cwd: '/r/.worktrees/p' })]
    const { store, issues, steward, sendNotice } = await harness({ sessions })
    const p = await issues.crud.create({ repoPath: '/r', title: 'Watcher', startNow: false })
    await issues.crud.update(p.id, { worktreePath: '/r/.worktrees/p' })
    const x = await issues.crud.create({ repoPath: '/r', title: 'Target', startNow: false })
    await store.events.addSubscription(
      seedSub({ id: 'sub_1', subscriberId: p.id, sourceRef: x.id }),
    )
    // x already told the watcher's live session directly.
    await seedTold(store, x.id, { kind: 'session', id: 'psess' })
    await issues.crud.close(x.id)
    await steward.tick()
    expect(sendNotice).not.toHaveBeenCalled()
  })

  it('delivers terminal-fenced exits to session.exited-only subscribers', async () => {
    const sessions = [
      fakeSession({ sessionId: asSessionId('watcher'), cwd: '/w' }),
      fakeSession({ sessionId: asSessionId('worker'), cwd: '/x' }),
    ]
    const { store, steward, sendNotice } = await harness({ sessions })
    await store.events.addSubscription(
      seedSub({
        id: 'sub_exit',
        subscriberKind: 'session',
        subscriberId: 'watcher',
        event: 'session.exited',
        sourceKind: 'session',
        sourceRef: 'worker',
      }),
    )
    await store.events.appendEvent({
      ts: 't',
      kind: 'session.exited',
      subject: 'worker',
      payload: { code: 0, terminalFenceReported: true },
    })

    await steward.tick()

    expect(sendNotice).toHaveBeenCalledTimes(1)
    expect((sendNotice.mock.calls[0] as [string, string])[0]).toBe('watcher')
  })

  it('a session.finished subscription nudges the subscriber session', async () => {
    const sessions = [
      fakeSession({ sessionId: asSessionId('watcher'), cwd: '/w' }),
      fakeSession({ sessionId: asSessionId('worker'), cwd: '/x' }),
    ]
    const { store, steward, sendNotice } = await harness({ sessions })
    await store.events.addSubscription(
      seedSub({
        id: 'sub_s',
        subscriberKind: 'session',
        subscriberId: 'watcher',
        event: 'session.finished',
        sourceKind: 'session',
        sourceRef: 'worker',
      }),
    )
    // Non-finished phases are ignored; only idle+done derives session.finished.
    await store.events.appendEvent({
      ts: 't',
      kind: 'session.phase',
      subject: 'worker',
      payload: { phase: 'active' },
    })
    await store.events.appendEvent({
      ts: 't',
      kind: 'session.phase',
      subject: 'worker',
      payload: { phase: 'idle', verdict: 'done' },
    })
    await steward.tick()
    expect(sendNotice).toHaveBeenCalledTimes(1)
    expect((sendNotice.mock.calls[0] as [string, string])[0]).toBe('watcher')
    expect(sendNotice.mock.calls[0]?.[3]).toBe('wait')
  })

  it("resolves a 'my-children' relationship source for a child session.finished", async () => {
    const sessions: SessionMeta[] = []
    const { store, issues, steward, sendNotice } = await harness({ sessions })
    const epic = await issues.crud.create({ repoPath: '/r', title: 'Epic', startNow: false })
    await issues.crud.update(epic.id, { worktreePath: '/r/.worktrees/epic' })
    const child = await issues.crud.create({
      repoPath: '/r',
      title: 'Child',
      parentId: epic.id,
      startNow: false,
    })
    const outsider = await issues.crud.create({ repoPath: '/r', title: 'Outsider', startNow: false })
    // Sessions bound (issueId) to the child vs an unrelated issue; the parent's own
    // session receives the nudge. Pushed after creation so ids are known.
    sessions.push(
      fakeSession({ sessionId: asSessionId('psess'), cwd: '/r/.worktrees/epic', issueId: epic.id }),
      fakeSession({ sessionId: asSessionId('kid'), cwd: '/k', issueId: child.id }),
      fakeSession({ sessionId: asSessionId('stranger'), cwd: '/s', issueId: outsider.id }),
    )
    await store.events.addSubscription(
      seedSub({
        id: 'sub_rel',
        subscriberId: epic.id,
        event: 'session.finished',
        sourceKind: 'relationship',
        sourceRef: 'my-children',
      }),
    )
    // A non-child session finishing does NOT deliver.
    await store.events.appendEvent({
      ts: 't',
      kind: 'session.phase',
      subject: 'stranger',
      payload: { phase: 'idle', verdict: 'done' },
    })
    await steward.tick()
    expect(sendNotice).not.toHaveBeenCalled()
    // The child session finishing DOES — its bound issue's parent is the subscriber.
    await store.events.appendEvent({
      ts: 't',
      kind: 'session.phase',
      subject: 'kid',
      payload: { phase: 'idle', verdict: 'done' },
    })
    await steward.tick()
    expect(sendNotice).toHaveBeenCalledTimes(1)
    expect((sendNotice.mock.calls[0] as [string, string])[0]).toBe('psess')
  })

  it('a disabled subscription is silent', async () => {
    const sessions = [fakeSession({ sessionId: asSessionId('psess'), cwd: '/r/.worktrees/p' })]
    const { store, issues, steward, sendNotice } = await harness({ sessions })
    const p = await issues.crud.create({ repoPath: '/r', title: 'Watcher', startNow: false })
    await issues.crud.update(p.id, { worktreePath: '/r/.worktrees/p' })
    const x = await issues.crud.create({ repoPath: '/r', title: 'Target', startNow: false })
    await store.events.addSubscription(
      seedSub({ id: 'sub_off', subscriberId: p.id, sourceRef: x.id, enabled: false }),
    )
    await issues.crud.close(x.id)
    await steward.tick()
    expect(sendNotice).not.toHaveBeenCalled()
  })

  it('excludes a coordinator that caused the event and falls back to an eligible peer', async () => {
    const sessions = [
      fakeSession({ sessionId: asSessionId('causer'), cwd: '/r/.worktrees/p' }),
      fakeSession({ sessionId: asSessionId('other'), cwd: '/r/.worktrees/p' }),
    ]
    const { store, issues, steward, sendNotice } = await harness({ sessions })
    const p = await issues.crud.create({ repoPath: '/r', title: 'Watcher', startNow: false })
    await issues.crud.update(p.id, { worktreePath: '/r/.worktrees/p' })
    await issues.crud.setCoordinator(p.id, asSessionId('causer'))
    const x = await issues.crud.create({ repoPath: '/r', title: 'Target', startNow: false })
    await store.events.addSubscription(
      seedSub({ id: 'sub_c', subscriberId: p.id, sourceRef: x.id }),
    )
    await issues.crud.close(x.id, 'done', { actorSessionId: asSessionId('causer') })
    await steward.tick()
    const targets = sendNotice.mock.calls.map((c) => (c as [string, string])[0])
    expect(targets).toEqual(['other'])
  })

  it('deliverNotify appends a steward.notify breadcrumb AND pushes externally (#470)', async () => {
    const { store, issues, steward, sendNotice, notify } = await harness()
    const p = await issues.crud.create({ repoPath: '/r', title: 'Watcher', startNow: false })
    const x = await issues.crud.create({ repoPath: '/r', title: 'Target', startNow: false })
    await store.events.addSubscription(
      seedSub({
        id: 'sub_n',
        subscriberId: p.id,
        sourceRef: x.id,
        deliverNudge: false,
        deliverNotify: true,
      }),
    )
    await issues.crud.close(x.id)
    await steward.tick()
    expect(sendNotice).not.toHaveBeenCalled()
    // The breadcrumb stays — it is the durable audit record the dedup is keyed on.
    const crumbs = await store.events.listEventsSince(0, { kinds: ['steward.notify'] })
    expect(crumbs.length).toBe(1)
    expect(crumbs[0]).toMatchObject({
      subject: p.id,
      payload: { subscriptionId: 'sub_n', event: 'issue.closed' },
    })
    // …and the switch now does what its label says.
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify.mock.calls[0]![0]).toBe(firstAdminMemberId())
    expect(notify.mock.calls[0]![1]).toMatchObject({
      title: 'Podium: issue.closed',
      body: expect.stringContaining(x.id),
    })
    // Replay-safe with the breadcrumb: a cursor rewind re-matches but never re-pushes.
    await store.events.setStewardState('cursor', '0')
    await steward.tick()
    expect(notify).toHaveBeenCalledTimes(1)
  })

  it('a notify:false subscription never pushes', async () => {
    const sessions = [fakeSession({ sessionId: asSessionId('psess'), cwd: '/r/.worktrees/p' })]
    const { store, issues, steward, notify } = await harness({ sessions })
    const p = await issues.crud.create({ repoPath: '/r', title: 'Watcher', startNow: false })
    await issues.crud.update(p.id, { worktreePath: '/r/.worktrees/p' })
    const x = await issues.crud.create({ repoPath: '/r', title: 'Target', startNow: false })
    await store.events.addSubscription(
      seedSub({ id: 'sub_q', subscriberId: p.id, sourceRef: x.id }),
    )
    await issues.crud.close(x.id)
    await steward.tick()
    expect(notify).not.toHaveBeenCalled()
  })

  it('a throwing notifier costs neither the breadcrumb nor the cursor advance', async () => {
    const { store, issues, steward, deps, notify } = await harness()
    notify.mockImplementation(() => {
      throw new Error('ntfy exploded')
    })
    expect(deps.notify).toBe(notify)
    const p = await issues.crud.create({ repoPath: '/r', title: 'Watcher', startNow: false })
    const x = await issues.crud.create({ repoPath: '/r', title: 'Target', startNow: false })
    await store.events.addSubscription(
      seedSub({
        id: 'sub_boom',
        subscriberId: p.id,
        sourceRef: x.id,
        deliverNudge: false,
        deliverNotify: true,
      }),
    )
    await issues.crud.close(x.id)
    await expect(steward.tick()).resolves.toBeUndefined()
    expect(await store.events.listEventsSince(0, { kinds: ['steward.notify'] })).toHaveLength(1)
  })
})

describe('StewardService ack fallback (#237) [spec:SP-34d7 acks]', () => {
  it('maps settled session.phase events to ackfallback + sessionparentnudge (finished + errored only)', () => {
    const e = { id: 1, ts: 't', kind: 'session.phase', subject: 's9', repoPath: null, payload: {} }
    expect(
      TRIGGER_RULES['session.phase']!({ ...e, payload: { phase: 'idle', verdict: 'done' } }),
    ).toEqual(['ackfallback:s9', 'sessionparentnudge:done:s9'])
    expect(TRIGGER_RULES['session.phase']!({ ...e, payload: { phase: 'errored' } })).toEqual([
      'ackfallback:s9',
      'sessionparentnudge:errored:s9',
    ])
    expect(
      TRIGGER_RULES['session.phase']!({ ...e, payload: { phase: 'idle', verdict: 'needs_user' } }),
    ).toBeUndefined()
    expect(TRIGGER_RULES['session.phase']!({ ...e, payload: { phase: 'working' } })).toBeUndefined()
  })

  it('routes legacy and causal nonterminal exits but suppresses terminal-fenced duplicates', () => {
    const e = { id: 1, ts: 't', kind: 'session.exited', subject: 's9', repoPath: null, payload: {} }
    expect(TRIGGER_RULES['session.exited']!(e)).toBe('sessionparentnudge:exited:s9')
    const nonterminal = { ...e, payload: { terminalFenceReported: false } }
    expect(TRIGGER_RULES['session.exited']!(nonterminal)).toBe('sessionparentnudge:exited:s9')
    expect(subscriptionEventKinds(nonterminal)).toEqual(['session.exited'])

    const terminal = { ...e, payload: { terminalFenceReported: true } }
    expect(TRIGGER_RULES['session.exited']!(terminal)).toBeUndefined()
    expect(subscriptionEventKinds(terminal)).toEqual(['session.exited'])
  })

  it('invokes the messaging seam once per settled session with the outcome', async () => {
    const h = await harness()
    const ackFallback = vi.fn()
    h.deps.messaging = { ackFallback }
    const steward = new StewardService(h.deps)
    await h.store.events.appendEvent({
      ts: 't',
      kind: 'session.phase',
      subject: 's9',
      payload: { phase: 'idle', verdict: 'done' },
    })
    await h.store.events.appendEvent({
      ts: 't',
      kind: 'session.phase',
      subject: 's8',
      payload: { phase: 'errored' },
    })
    await steward.tick()
    expect(ackFallback).toHaveBeenCalledTimes(2)
    expect(ackFallback).toHaveBeenCalledWith('s9', 'finished', {
      factKey: 'settle:s9',
      target: 's9',
    })
    expect(ackFallback).toHaveBeenCalledWith('s8', 'errored', {
      factKey: 'settle:s8',
      target: 's8',
    })
    // Replays past the advanced cursor never re-fire.
    await steward.tick()
    expect(ackFallback).toHaveBeenCalledTimes(2)
  })

  it('coalesces and replay-suppresses repeated events for one settle transition', async () => {
    const h = await harness()
    const ackFallback = vi.fn()
    h.deps.messaging = { ackFallback }
    const steward = new StewardService(h.deps)
    for (let i = 0; i < 2; i++) {
      await h.store.events.appendEvent({
        ts: 't',
        kind: 'session.phase',
        subject: 's9',
        payload: { phase: 'idle', verdict: 'done' },
      })
    }

    await steward.tick()
    expect(ackFallback).toHaveBeenCalledTimes(1)

    await h.store.events.setStewardState('cursor', '0')
    await steward.tick()
    expect(ackFallback).toHaveBeenCalledTimes(1)
  })

  it('suppresses a second producer claiming the same settle fact and target', async () => {
    const h = await harness()
    const ackFallback = vi.fn()
    h.deps.messaging = { ackFallback }
    const steward = new StewardService(h.deps)

    expect(
      await h.arbiter.claim('settle:s9', 's9', {
        source: 'daemon.stop-hook',
      }),
    ).toBe(true)
    expect(
      await h.arbiter.claim('settle:s9', 's9', {
        source: 'subscription:session.finished',
      }),
    ).toBe(false)

    await h.store.events.appendEvent({
      ts: 't',
      kind: 'session.phase',
      subject: 's9',
      payload: { phase: 'idle', verdict: 'done' },
    })
    await steward.tick()
    expect(ackFallback).not.toHaveBeenCalled()
  })

  it('allows a replayed settle transition to re-fire after the fact TTL expires', async () => {
    const h = await harness()
    const ackFallback = vi.fn()
    h.deps.messaging = { ackFallback }
    const steward = new StewardService(h.deps)
    await h.store.events.appendEvent({
      ts: 't',
      kind: 'session.phase',
      subject: 's9',
      payload: { phase: 'idle', verdict: 'done' },
    })

    await steward.tick()
    expect(ackFallback).toHaveBeenCalledTimes(1)

    h.advanceTime(24 * 60 * 60 * 1000 + 1)
    await h.store.events.setStewardState('cursor', '0')
    await steward.tick()
    expect(ackFallback).toHaveBeenCalledTimes(2)
  })

  it('is inert without the seam (unwired deployments)', async () => {
    const h = await harness()
    await h.store.events.appendEvent({
      ts: 't',
      kind: 'session.phase',
      subject: 's9',
      payload: { phase: 'errored' },
    })
    await expect(h.steward.tick()).resolves.toBeUndefined()
  })
})

describe('StewardService notification fact retirement [spec:SP-ba61]', () => {
  it('retires facts scoped to an issue when issue.closed is consumed', async () => {
    const h = await harness()
    const issue = await h.issues.crud.create({ repoPath: '/r', title: 'Closing', startNow: false })

    expect(
      await h.arbiter.claim('sub:issue.ready:iss_source', 'target-session', {
        source: 'subscription:issue.ready',
        issueId: issue.id,
      }),
    ).toBe(true)
    expect(
      await h.arbiter.claim('sub:issue.ready:iss_source', 'target-session', {
        source: 'steward.unblock',
        issueId: issue.id,
      }),
    ).toBe(false)

    await h.issues.crud.close(issue.id)
    await h.steward.tick()

    expect(
      await h.arbiter.claim('sub:issue.ready:iss_source', 'target-session', {
        source: 'subscription:issue.ready',
        issueId: issue.id,
      }),
    ).toBe(true)
  })
})

/**
 * POD-890 / POD-908: retire arbiter facts when the underlying condition clears
 * so a later genuine edge re-fires without shortening the 24h TTL.
 */
describe('StewardService condition-clear fact retirement (POD-890)', () => {
  it('re-settling after leave-idle re-fires ackfallback (fact retired on leave; TTL unchanged)', async () => {
    const h = await harness()
    const ackFallback = vi.fn()
    h.deps.messaging = { ackFallback }
    const steward = new StewardService(h.deps)

    // First settle → claim settle:s9 + fire once.
    await h.store.events.appendEvent({
      ts: 't1',
      kind: 'session.phase',
      subject: 's9',
      payload: { phase: 'idle', verdict: 'done' },
    })
    await steward.tick()
    expect(ackFallback).toHaveBeenCalledTimes(1)

    // Still settled (no leave): same-condition re-tick must NOT re-fire, and
    // the fact remains live well before the 24h TTL ceiling.
    await h.store.events.setStewardState('cursor', '0')
    await steward.tick()
    expect(ackFallback).toHaveBeenCalledTimes(1)
    // A concurrent producer still loses while the fact is live (TTL not shortened).
    expect(await h.arbiter.claim('settle:s9', 's9', { source: 'daemon.stop-hook' })).toBe(false)

    // Leave idle (working) → condition-clear retires settle:s9 (not TTL expiry).
    await h.store.events.appendEvent({
      ts: 't2',
      kind: 'session.phase',
      subject: 's9',
      payload: { phase: 'working' },
    })
    await steward.tick()

    // Second genuine settle → re-fires.
    await h.store.events.appendEvent({
      ts: 't3',
      kind: 'session.phase',
      subject: 's9',
      payload: { phase: 'idle', verdict: 'done' },
    })
    await steward.tick()
    expect(ackFallback).toHaveBeenCalledTimes(2)
  })

  it('review→out→review re-fires the review parentnudge', async () => {
    const sessions = [
      fakeSession({ sessionId: asSessionId('plive'), cwd: '/r/.worktrees/issue-1-epic' }),
    ]
    const { issues, steward, sendNotice } = await harness({ sessions })
    const parent = await issues.crud.create({ repoPath: '/r', title: 'Epic', startNow: false })
    await issues.crud.update(parent.id, { worktreePath: '/r/.worktrees/issue-1-epic' })
    const c1 = await issues.crud.create({
      repoPath: '/r',
      title: 'Child 1',
      parentId: parent.id,
      startNow: false,
    })
    await issues.commentsMail.addComment(
      c1.id,
      'agent',
      '[completion-note] widget ready for review',
      AS_OPERATOR,
    )

    // Enter review → first parentnudge.
    await issues.crud.update(c1.id, { stage: 'review' })
    await steward.tick()
    expect(sendNotice).toHaveBeenCalledTimes(1)
    expect((sendNotice.mock.calls[0] as [string, string])[1]).toContain('moved to review')

    // Leave review (condition clear) without closing.
    await issues.crud.update(c1.id, { stage: 'in_progress' })
    await steward.tick()
    expect(sendNotice).toHaveBeenCalledTimes(1)

    // Re-enter review → must re-fire (fact was retired on leave).
    await issues.crud.update(c1.id, { stage: 'review' })
    await steward.tick()
    expect(sendNotice).toHaveBeenCalledTimes(2)
    expect((sendNotice.mock.calls[1] as [string, string])[0]).toBe('plive')
    expect((sendNotice.mock.calls[1] as [string, string])[1]).toContain('moved to review')
  })

  it('flapping within the same condition still dedups (no over-fire)', async () => {
    const h = await harness()
    const ackFallback = vi.fn()
    h.deps.messaging = { ackFallback }
    const steward = new StewardService(h.deps)

    // Two settle events in one poll (rapid re-tick / dual producer shape).
    await h.store.events.appendEvent({
      ts: 't',
      kind: 'session.phase',
      subject: 's9',
      payload: { phase: 'idle', verdict: 'done' },
    })
    await h.store.events.appendEvent({
      ts: 't',
      kind: 'session.phase',
      subject: 's9',
      payload: { phase: 'idle', verdict: 'done' },
    })
    await steward.tick()
    expect(ackFallback).toHaveBeenCalledTimes(1)

    // Cursor rewind: still the same settled condition — no leave-idle — no re-fire.
    await h.store.events.setStewardState('cursor', '0')
    await steward.tick()
    expect(ackFallback).toHaveBeenCalledTimes(1)

    // Review path: re-process the same review transition without leaving review.
    const sessions = [
      fakeSession({ sessionId: asSessionId('plive'), cwd: '/r/.worktrees/issue-1-epic' }),
    ]
    const rev = await harness({ sessions })
    const parent = await rev.issues.crud.create({ repoPath: '/r', title: 'Epic', startNow: false })
    await rev.issues.crud.update(parent.id, { worktreePath: '/r/.worktrees/issue-1-epic' })
    const c1 = await rev.issues.crud.create({
      repoPath: '/r',
      title: 'Child 1',
      parentId: parent.id,
      startNow: false,
    })
    await rev.issues.crud.update(c1.id, { stage: 'review' })
    await rev.steward.tick()
    expect(rev.sendNotice).toHaveBeenCalledTimes(1)
    await rev.store.events.setStewardState('cursor', '0')
    await rev.steward.tick()
    expect(rev.sendNotice).toHaveBeenCalledTimes(1)
  })

  it('preserves POD-907 exit-after-done silence within one completion cycle', async () => {
    const sessions = [
      fakeSession({ sessionId: asSessionId('parent'), status: 'hibernated', cwd: '/r/p' }),
      fakeSession({
        sessionId: asSessionId('child'),
        status: 'live',
        cwd: '/r/c',
        spawnedBy: 'session:parent',
      }),
    ]
    const { steward, sendNotice, store } = await harness({ sessions })
    await store.events.appendEvent({
      ts: 't',
      kind: 'session.phase',
      subject: 'child',
      payload: { phase: 'idle', verdict: 'done' },
    })
    await steward.tick()
    expect(sendNotice).toHaveBeenCalledTimes(1)
    // The session-parent notice is the one that WAKES a parked parent (POD-279).
    expect(sendNotice.mock.calls[0]?.[3]).toBe('wake')

    // Exit in the SAME completion cycle (no leave-idle) stays silent.
    await store.events.appendEvent({
      ts: 't',
      kind: 'session.exited',
      subject: 'child',
      payload: { code: 0, spawnedBy: 'session:parent' },
    })
    await steward.tick()
    expect(sendNotice).toHaveBeenCalledTimes(1)

    // Phantom leave-idle → re-settle WITHOUT parent ack (POD-917): sticky holds,
    // no second wake, and exit still suppressed.
    await store.events.appendEvent({
      ts: 't2',
      kind: 'session.phase',
      subject: 'child',
      payload: { phase: 'working' },
    })
    await steward.tick()
    await store.events.appendEvent({
      ts: 't3',
      kind: 'session.phase',
      subject: 'child',
      payload: { phase: 'idle', verdict: 'done' },
    })
    await steward.tick()
    expect(sendNotice).toHaveBeenCalledTimes(1)
    await store.events.appendEvent({
      ts: 't4',
      kind: 'session.exited',
      subject: 'child',
      payload: { code: 0, spawnedBy: 'session:parent' },
    })
    await steward.tick()
    expect(sendNotice).toHaveBeenCalledTimes(1)
  })

  it('needs_human clear→set re-fires the needs_human parentnudge', async () => {
    const sessions = [
      fakeSession({ sessionId: asSessionId('plive'), cwd: '/r/.worktrees/issue-1-epic' }),
    ]
    const { issues, steward, sendNotice } = await harness({ sessions })
    const parent = await issues.crud.create({ repoPath: '/r', title: 'Epic', startNow: false })
    await issues.crud.update(parent.id, { worktreePath: '/r/.worktrees/issue-1-epic' })
    const c1 = await issues.crud.create({
      repoPath: '/r',
      title: 'Child 1',
      parentId: parent.id,
      startNow: false,
    })

    await issues.crud.setNeedsHuman(c1.id, 'which database?')
    await steward.tick()
    expect(sendNotice).toHaveBeenCalledTimes(1)

    await issues.crud.clearNeedsHuman(c1.id)
    await steward.tick()
    expect(sendNotice).toHaveBeenCalledTimes(1)

    await issues.crud.setNeedsHuman(c1.id, 'which database again?')
    await steward.tick()
    expect(sendNotice).toHaveBeenCalledTimes(2)
  })
})

// The parent-session extraction this file used to test moved to
// `@podium/model` (POD-1133) and is covered by
// `packages/model/src/fields/session.spawned-by.test.ts`, which pins the whole
// arm set rather than just the session arm.

/**
 * M4 / POD-904: session-spawner edge wakes a parked parent when its child
 * settles (done/errored) or exits without a prior settle report. Distinct from
 * ISSUE parentnudge (needs_human/closed/review), which stays live-only.
 */
describe('StewardService session-parent wake (POD-904 / §07b)', () => {
  it.each([
    'hibernated',
    'exited',
  ] as const)('POD-4992: ignores fresh terminal phase events for an already %s child across every notice route', async (status) => {
    const child = fakeSession({
      sessionId: asSessionId('child'),
      status,
      spawnedBy: 'session:parent',
      stoppedAt: '2026-07-02T01:40:00.000Z',
    })
    const h = await harness({
      sessions: [fakeSession({ sessionId: asSessionId('parent'), status: 'hibernated' }), child],
    })
    const ackFallback = vi.fn()
    h.deps.messaging = { ackFallback }
    const steward = new StewardService(h.deps)
    await h.store.events.addSubscription({
      id: 'stopped-child-finished',
      subscriberKind: 'session',
      subscriberId: 'parent',
      sourceKind: 'session',
      sourceRef: 'child',
      event: 'session.finished',
      deliverNudge: true,
      deliverNotify: true,
      origin: 'custom',
      enabled: true,
      createdAt: '2026-07-02T00:00:00.000Z',
    })
    await h.store.events.appendEvent({
      ts: '2026-07-02T15:14:56.000Z',
      kind: 'session.phase',
      subject: 'child',
      payload: { phase: 'idle', verdict: 'done' },
    })
    await steward.tick()
    expect(h.sendNotice).not.toHaveBeenCalled()
    expect(h.notify).not.toHaveBeenCalled()
    expect(ackFallback).not.toHaveBeenCalled()
    expect(
      await h.arbiter.isClaimed('sessionparentnudge:phase-reported:child', asSessionId('parent')),
    ).toBe(false)
    expect(await h.arbiter.isClaimed('settle:child', asSessionId('child'))).toBe(false)
    expect(await h.store.events.getStewardState('cursor')).toBe(
      String(await h.store.events.maxEventId()),
    )
    await steward.tick()
    expect(h.sendNotice).not.toHaveBeenCalled()
  })

  it.each([
    undefined,
    '2026-07-02T15:14:56.000Z',
  ])('POD-4992: ignores an errored phase for a parked child with stop time %s', async (stoppedAt) => {
    const h = await harness({
      sessions: [
        fakeSession({ sessionId: asSessionId('parent'), status: 'hibernated' }),
        fakeSession({
          sessionId: asSessionId('child'),
          status: 'hibernated',
          spawnedBy: 'session:parent',
          stoppedAt,
        }),
      ],
    })
    const ackFallback = vi.fn()
    h.deps.messaging = { ackFallback }
    await h.store.events.appendEvent({
      ts: '2026-07-02T15:14:56.000Z',
      kind: 'session.phase',
      subject: 'child',
      payload: { phase: 'errored' },
    })
    await new StewardService(h.deps).tick()
    expect(h.sendNotice).not.toHaveBeenCalled()
    expect(ackFallback).not.toHaveBeenCalled()
  })

  it.each((['hibernated', 'exited'] as const).flatMap((status) =>
    (['legacy', 'causal'] as const).flatMap((source) =>
      (['idle', 'errored'] as const).map((phase) => ({ status, source, phase })),
    ),
  ))(
    'POD-5128: consumes a queued $source $phase phase after the child is $status without reporting settlement',
    async ({ status, source, phase }) => {
      const childId = asSessionId('child')
      const parentId = asSessionId('parent')
      const sessions = [
        fakeSession({ sessionId: parentId, status: 'hibernated' }),
        fakeSession({ sessionId: childId, status: 'live', spawnedBy: 'session:parent' }),
      ]
      const h = await harness({ sessions })
      const ackFallback = vi.fn()
      h.deps.messaging = { ackFallback }
      await h.store.events.addSubscription({
        id: 'queued-child-settled', subscriberKind: 'session', subscriberId: parentId,
        sourceKind: 'session', sourceRef: childId,
        event: phase === 'idle' ? 'session.finished' : 'session.errored',
        deliverNudge: true, deliverNotify: true, origin: 'custom', enabled: true,
        createdAt: '2026-07-02T00:00:00.000Z',
      })
      // The event was produced while live. A ten-hour backlog makes the
      // steward see it only after the parent explicitly stopped the child.
      const eventId = await h.store.events.appendEvent({
        ts: '2026-07-02T10:48:34.290Z', kind: 'session.phase', subject: childId,
        payload: {
          producer: 'notify.session.stateChanged', sessionStatus: 'live', phase,
          ...(phase === 'idle' ? { verdict: 'done' } : {}),
          ...(source === 'causal' ? {
            transitionId: 'terminal-before-stop', transitionKind: 'turn_terminal',
            provenance: 'live', observerGeneration: 3, turnEpoch: 2,
            providerCursor: { segmentId: 'child-rollout', components: { file: 42 } },
            priorPhase: 'working', nextPhase: phase,
          } : {}),
        },
      })
      sessions[1] = fakeSession({
        ...sessions[1], status, stoppedAt: '2026-07-02T12:19:13.703Z',
      })
      h.advanceTime(Date.parse('2026-07-02T22:05:27.495Z') - Date.parse('2026-07-02T00:00:00.000Z'))
      expect(await h.store.events.getStewardState('cursor')).toBe('0')
      const steward = new StewardService(h.deps)
      const logs = captureLogs()
      try {
        await steward.tick({ limit: JANITOR_STEWARD_EVENT_LIMIT })
        expect(logs.at('info')).toContainEqual(expect.objectContaining({
          ns: 'server:steward', eventSource: 'podium_events', cursor: 0,
          eventId, throughEventId: eventId, eventAt: '2026-07-02T10:48:34.290Z',
          sessionId: childId, sessionStatus: status, stoppedAt: '2026-07-02T12:19:13.703Z',
          producer: 'notify.session.stateChanged', producerSessionStatus: 'live',
          phase, disposition: 'ignored-stopped',
        }))
      } finally {
        logs.restore()
      }
      expect(h.sendNotice).not.toHaveBeenCalled()
      expect(h.notify).not.toHaveBeenCalled()
      expect(ackFallback).not.toHaveBeenCalled()
      expect(await h.arbiter.isClaimed(`settle:${childId}`, childId)).toBe(false)
      expect(await h.arbiter.isClaimed(`sessionparentnudge:phase-reported:${childId}`, parentId)).toBe(false)
      expect(await h.store.events.getStewardState('cursor')).toBe(String(eventId))
      // The historical row remains readable; only notification production is fenced.
      expect(await h.store.events.listEventsSince(0)).toHaveLength(1)
      await steward.tick()
      expect(h.sendNotice).not.toHaveBeenCalled()
    },
  )

  it.each(['idle', 'errored'] as const)(
    'POD-5128: attributes a queued %s phase and still reports a running child',
    async (phase) => {
      const childId = asSessionId('child')
      const parentId = asSessionId('parent')
      const h = await harness({ sessions: [
        fakeSession({ sessionId: parentId, status: 'hibernated' }),
        fakeSession({ sessionId: childId, status: 'live', spawnedBy: 'session:parent' }),
      ] })
      const ackFallback = vi.fn()
      h.deps.messaging = { ackFallback }
      const eventId = await h.store.events.appendEvent({
        ts: '2026-07-02T10:48:34.290Z', kind: 'session.phase', subject: childId,
        payload: { phase, ...(phase === 'idle' ? { verdict: 'done' } : {}) },
      })
      h.advanceTime(Date.parse('2026-07-02T22:05:27.495Z') - Date.parse('2026-07-02T00:00:00.000Z'))
      const logs = captureLogs()
      try {
        await new StewardService(h.deps).tick({ limit: JANITOR_STEWARD_EVENT_LIMIT })
        expect(logs.at('info')).toContainEqual(expect.objectContaining({
          ns: 'server:steward', eventSource: 'podium_events', cursor: 0,
          eventId, throughEventId: eventId, eventAt: '2026-07-02T10:48:34.290Z',
          sessionId: childId, sessionStatus: 'live', producer: 'legacy',
          producerSessionStatus: 'unknown', phase, disposition: 'eligible',
        }))
      } finally {
        logs.restore()
      }
      expect(h.sendNotice).toHaveBeenCalledExactlyOnceWith(
        parentId, expect.stringContaining(phase === 'idle' ? 'finished (done)' : 'errored'),
        noticeMessageId(`sessionparentnudge:phase-reported:${childId}`, parentId, eventId), 'wake',
      )
      expect(ackFallback).toHaveBeenCalledExactlyOnceWith(childId, phase === 'idle' ? 'finished' : 'errored', {
        factKey: `settle:${childId}`, target: childId,
      })
      expect(await h.store.events.getStewardState('cursor')).toBe(String(eventId))
    },
  )

  it('wakes a PARKED session parent when the child settles idle+done', async () => {
    const sessions = [
      // Parked parent — issue parentnudge would skip this; session-parent wake must not.
      fakeSession({
        sessionId: asSessionId('parent'),
        status: 'hibernated',
        cwd: '/r/parent',
        title: 'Coordinator',
      }),
      fakeSession({
        sessionId: asSessionId('child'),
        status: 'live',
        cwd: '/r/child',
        title: 'Worker',
        spawnedBy: 'session:parent',
      }),
    ]
    const { steward, sendNotice, store } = await harness({ sessions })
    await store.events.appendEvent({
      ts: 't',
      kind: 'session.phase',
      subject: 'child',
      payload: { phase: 'idle', verdict: 'done' },
    })
    await steward.tick()
    expect(sendNotice).toHaveBeenCalledTimes(1)
    const [target, text] = sendNotice.mock.calls[0] as [string, string]
    expect(target).toBe('parent')
    expect(text).toContain('child')
    expect(text).toMatch(/finished \(done\)/i)
    // Wake path = sendNotice (wired to queueText → resurrect), not a
    // breadcrumb-only steward.observed row.
    expect(await store.events.listEventsSince(0, { kinds: ['steward.observed'] })).toHaveLength(0)
  })

  it('already-communicated (§07b, POD-913) does NOT apply here: still wakes even if the child already messaged the parent', async () => {
    // This is the deliberate carve-out (see the handleSessionParentNudge doc
    // comment): a message in the ledger proves the parent was TOLD, not that
    // it was WOKEN. Suppressing here could strand a parked parent forever.
    const sessions: SessionMeta[] = []
    const { issues, steward, sendNotice, store } = await harness({ sessions })
    const childIssue = await issues.crud.create({
      repoPath: '/r',
      title: 'Child issue',
      startNow: false,
    })
    sessions.push(
      fakeSession({
        sessionId: asSessionId('parent'),
        status: 'hibernated',
        cwd: '/r/parent',
        title: 'Coordinator',
      }),
      fakeSession({
        sessionId: asSessionId('child'),
        status: 'live',
        cwd: '/r/child',
        title: 'Worker',
        spawnedBy: 'session:parent',
        issueId: childIssue.id,
      }),
    )
    await seedTold(store, childIssue.id, { kind: 'session', id: 'parent' })
    await store.events.appendEvent({
      ts: 't',
      kind: 'session.phase',
      subject: 'child',
      payload: { phase: 'idle', verdict: 'done' },
    })
    await steward.tick()
    expect(sendNotice).toHaveBeenCalledTimes(1)
    expect((sendNotice.mock.calls[0] as [string, string])[0]).toBe('parent')
  })

  it('wakes a parked session parent when the child errors', async () => {
    const sessions = [
      fakeSession({ sessionId: asSessionId('parent'), status: 'exited', cwd: '/r/p' }),
      fakeSession({
        sessionId: asSessionId('child'),
        status: 'live',
        cwd: '/r/c',
        spawnedBy: 'session:parent',
      }),
    ]
    const { steward, sendNotice, store } = await harness({ sessions })
    await store.events.appendEvent({
      ts: 't',
      kind: 'session.phase',
      subject: 'child',
      payload: { phase: 'errored' },
    })
    await steward.tick()
    expect(sendNotice).toHaveBeenCalledTimes(1)
    const [target, text] = sendNotice.mock.calls[0] as [string, string]
    expect(target).toBe('parent')
    expect(text).toMatch(/errored/i)
  })

  it('wakes a session parent on child exit-without-report (session.exited)', async () => {
    const sessions = [
      fakeSession({ sessionId: asSessionId('parent'), status: 'hibernated', cwd: '/r/p' }),
      fakeSession({
        sessionId: asSessionId('child'),
        status: 'exited',
        cwd: '/r/c',
        spawnedBy: 'session:parent',
      }),
    ]
    const { steward, sendNotice, store } = await harness({ sessions })
    await store.events.appendEvent({
      ts: 't',
      kind: 'session.exited',
      subject: 'child',
      payload: { code: 1, spawnedBy: 'session:parent' },
    })
    await steward.tick()
    expect(sendNotice).toHaveBeenCalledTimes(1)
    const [target, text] = sendNotice.mock.calls[0] as [string, string]
    expect(target).toBe('parent')
    expect(text).toMatch(/exited without reporting/i)
  })

  it('resolves parent from event payload spawnedBy when the child row is gone', async () => {
    // killSession removes the child before agentExit; payload carries spawnedBy.
    const sessions = [
      fakeSession({ sessionId: asSessionId('parent'), status: 'hibernated', cwd: '/r/p' }),
    ]
    const { steward, sendNotice, store } = await harness({ sessions })
    await store.events.appendEvent({
      ts: 't',
      kind: 'session.exited',
      subject: 'gone-child',
      payload: { code: -1, spawnedBy: 'session:parent' },
    })
    await steward.tick()
    expect(sendNotice).toHaveBeenCalledTimes(1)
    expect((sendNotice.mock.calls[0] as [string, string])[0]).toBe('parent')
  })

  it('is silent when the child has no session-spawner parent', async () => {
    const sessions = [
      fakeSession({ sessionId: asSessionId('parent'), status: 'hibernated', cwd: '/r/p' }),
      fakeSession({
        sessionId: asSessionId('child'),
        status: 'live',
        cwd: '/r/c',
        spawnedBy: 'issue:iss_x', // issue provenance — not the session edge
      }),
      fakeSession({ sessionId: asSessionId('orphan'), status: 'live', cwd: '/r/o' }),
    ]
    const { steward, sendNotice, store } = await harness({ sessions })
    await store.events.appendEvent({
      ts: 't',
      kind: 'session.phase',
      subject: 'child',
      payload: { phase: 'idle', verdict: 'done' },
    })
    await store.events.appendEvent({
      ts: 't',
      kind: 'session.phase',
      subject: 'orphan',
      payload: { phase: 'errored' },
    })
    await steward.tick()
    expect(sendNotice).not.toHaveBeenCalled()
  })

  it('a terminal child re-emitting settle each poll (fresh event id) wakes the parent ONCE (POD-921)', async () => {
    const sessions = [
      fakeSession({ sessionId: asSessionId('parent'), status: 'hibernated', cwd: '/r/p' }),
      fakeSession({
        sessionId: asSessionId('child'),
        status: 'live',
        cwd: '/r/c',
        spawnedBy: 'session:parent',
      }),
    ]
    const { steward, sendNotice, store } = await harness({ sessions })

    // The live storm: a terminal child yields a NEW durable session.phase event
    // (fresh id) on every poll. A per-EVENT fact key changes each tick and would
    // re-wake the parent forever; the sticky phase-reported fact dedups the whole
    // completion cycle down to ONE wake. Six distinct settle events, one wake.
    for (let i = 0; i < 6; i++) {
      await store.events.appendEvent({
        ts: `t${i}`,
        kind: 'session.phase',
        subject: 'child',
        payload: { phase: 'idle', verdict: 'done' },
      })
      await steward.tick()
    }
    expect(sendNotice).toHaveBeenCalledTimes(1)
    // First wake still delivered (M4 parked-parent resurrection, 8773cdbf).
    expect((sendNotice.mock.calls[0] as [string, string])[0]).toBe('parent')

    // Crash-replay of the whole log (cursor rewind) still does not re-wake.
    await store.events.setStewardState('cursor', '0')
    await steward.tick()
    expect(sendNotice).toHaveBeenCalledTimes(1)

    // Exit trailing a clean done is not exit-without-report — the same sticky
    // suppresses the exit wake within the cycle (POD-907).
    await store.events.appendEvent({
      ts: 'tx',
      kind: 'session.exited',
      subject: 'child',
      payload: { code: 0, spawnedBy: 'session:parent' },
    })
    await steward.tick()
    expect(sendNotice).toHaveBeenCalledTimes(1)
  })

  it('phantom leave-idle then re-settle (no parent ack) does NOT re-wake (POD-917)', async () => {
    // Acceptance (b): zombie / grok cwd-watch idle-cycle must not re-arm the
    // parent wake. Leave-idle retires ackfallback settle: only — not phase-reported.
    const sessions = [
      fakeSession({ sessionId: asSessionId('parent'), status: 'hibernated', cwd: '/r/p' }),
      fakeSession({
        sessionId: asSessionId('child'),
        status: 'live',
        cwd: '/r/c',
        spawnedBy: 'session:parent',
      }),
    ]
    const { steward, sendNotice, store } = await harness({ sessions })

    // First settle → wake once (a/d).
    await store.events.appendEvent({
      ts: 't1',
      kind: 'session.phase',
      subject: 'child',
      payload: { phase: 'idle', verdict: 'done' },
    })
    await steward.tick()
    expect(sendNotice).toHaveBeenCalledTimes(1)
    expect((sendNotice.mock.calls[0] as [string, string])[0]).toBe('parent')

    // Per-poll re-emit of the SAME completion must NOT re-fire.
    await store.events.appendEvent({
      ts: 't2',
      kind: 'session.phase',
      subject: 'child',
      payload: { phase: 'idle', verdict: 'done' },
    })
    await steward.tick()
    expect(sendNotice).toHaveBeenCalledTimes(1)

    // Phantom work cycle (leave idle → re-idle) WITHOUT parent ack — sticky holds.
    await store.events.appendEvent({
      ts: 't3',
      kind: 'session.phase',
      subject: 'child',
      payload: { phase: 'working' },
    })
    await steward.tick()
    await store.events.appendEvent({
      ts: 't4',
      kind: 'session.phase',
      subject: 'child',
      payload: { phase: 'idle', verdict: 'done' },
    })
    await steward.tick()
    expect(sendNotice).toHaveBeenCalledTimes(1)
  })

  it('parent ack (consume sticky) then genuine re-settle wakes ONCE more (POD-917)', async () => {
    // Acceptance (c): sticky cleared only by parent acknowledgment; then a later
    // settle re-claims and re-wakes exactly once.
    const sessions = [
      fakeSession({ sessionId: asSessionId('parent'), status: 'hibernated', cwd: '/r/p' }),
      fakeSession({
        sessionId: asSessionId('child'),
        status: 'live',
        cwd: '/r/c',
        spawnedBy: 'session:parent',
      }),
    ]
    const { steward, sendNotice, store, arbiter } = await harness({ sessions })

    await store.events.appendEvent({
      ts: 't1',
      kind: 'session.phase',
      subject: 'child',
      payload: { phase: 'idle', verdict: 'done' },
    })
    await steward.tick()
    expect(sendNotice).toHaveBeenCalledTimes(1)

    // Leave-idle alone must NOT re-arm (phantom cycle still suppressed).
    await store.events.appendEvent({
      ts: 't2',
      kind: 'session.phase',
      subject: 'child',
      payload: { phase: 'working' },
    })
    await steward.tick()
    await store.events.appendEvent({
      ts: 't3',
      kind: 'session.phase',
      subject: 'child',
      payload: { phase: 'idle', verdict: 'done' },
    })
    await steward.tick()
    expect(sendNotice).toHaveBeenCalledTimes(1)

    // Parent acknowledges (MessageGate awaitAgent → retireNotificationFact).
    // Simulated here via the arbiter (same store path the gate wires).
    await arbiter.retire('sessionparentnudge:phase-reported:child', 'parent')

    // Subsequent genuine settle → wakes once more.
    await store.events.appendEvent({
      ts: 't4',
      kind: 'session.phase',
      subject: 'child',
      payload: { phase: 'working' },
    })
    await steward.tick()
    await store.events.appendEvent({
      ts: 't5',
      kind: 'session.phase',
      subject: 'child',
      payload: { phase: 'idle', verdict: 'done' },
    })
    await steward.tick()
    expect(sendNotice).toHaveBeenCalledTimes(2)
    expect((sendNotice.mock.calls[1] as [string, string])[0]).toBe('parent')
    // The second wake is a new message: the first one's row is kept, so reusing
    // its id would answer this wake from that row and never send it (POD-4846).
    expect(sendNotice.mock.calls[1]?.[2]).not.toBe(sendNotice.mock.calls[0]?.[2])

    // And stays once until next ack (no storm on re-emit).
    await store.events.appendEvent({
      ts: 't6',
      kind: 'session.phase',
      subject: 'child',
      payload: { phase: 'idle', verdict: 'done' },
    })
    await steward.tick()
    expect(sendNotice).toHaveBeenCalledTimes(2)
  })

  it('issue needs_human parentnudge path is unchanged (issue parent, live targets)', async () => {
    const sessions = [
      fakeSession({ sessionId: asSessionId('plive'), cwd: '/r/.worktrees/issue-1-epic' }),
    ]
    const { store, issues, steward, sendNotice } = await harness({ sessions })
    const parent = await issues.crud.create({ repoPath: '/r', title: 'Epic', startNow: false })
    await issues.crud.update(parent.id, { worktreePath: '/r/.worktrees/issue-1-epic' })
    const c1 = await issues.crud.create({
      repoPath: '/r',
      title: 'Child 1',
      parentId: parent.id,
      startNow: false,
    })
    await issues.crud.setNeedsHuman(c1.id, 'which database?')
    await steward.tick()
    const posted = await stewardComments(issues, parent.id)
    expect(posted.length).toBe(1)
    expect(posted[0]!.body).toBe(`Child #${c1.seq} needs a human: which database?`)
    expect(sendNotice).toHaveBeenCalledTimes(1)
    expect((sendNotice.mock.calls[0] as [string, string])[1]).toContain('needs a human')
    expect((await store.events.listEventsSince(0, { kinds: ['steward.observed'] })).length).toBe(1)
  })

  it('keeps ackfallback alongside session-parent wake on the same settle', async () => {
    const sessions = [
      fakeSession({ sessionId: asSessionId('parent'), status: 'live', cwd: '/r/p' }),
      fakeSession({
        sessionId: asSessionId('child'),
        status: 'live',
        cwd: '/r/c',
        spawnedBy: 'session:parent',
      }),
    ]
    const h = await harness({ sessions })
    const ackFallback = vi.fn()
    h.deps.messaging = { ackFallback }
    const steward = new StewardService(h.deps)
    await h.store.events.appendEvent({
      ts: 't',
      kind: 'session.phase',
      subject: 'child',
      payload: { phase: 'idle', verdict: 'done' },
    })
    await steward.tick()
    expect(ackFallback).toHaveBeenCalledWith('child', 'finished', {
      factKey: 'settle:child',
      target: 'child',
    })
    expect(h.sendNotice).toHaveBeenCalledTimes(1)
    expect((h.sendNotice.mock.calls[0] as [string, string])[0]).toBe('parent')
  })
})

describe('noticeMessageId [POD-4763]', () => {
  it('is the same for every attempt at one notice, and a message id', () => {
    const id = noticeMessageId('unblock:iss_b:7', asSessionId('s1'), 41)
    expect(noticeMessageId('unblock:iss_b:7', asSessionId('s1'), 41)).toBe(id)
    expect(MessageId.safeParse(id).success).toBe(true)
  })

  it('differs per target, so one fact notifying two sessions stores two messages', () => {
    expect(noticeMessageId('unblock:iss_b:7', asSessionId('s1'), 41)).not.toBe(
      noticeMessageId('unblock:iss_b:7', asSessionId('s2'), 41),
    )
    expect(noticeMessageId('unblock:iss_b:7', asSessionId('s1'), 41)).not.toBe(
      noticeMessageId('unblock:iss_b:8', asSessionId('s1'), 41),
    )
  })

  // A notice is a message, and a message row is kept (POD-4846). A fact is
  // claimed again after it was retired or expired, so an id from the fact alone
  // would answer that later notice from the first one's row and never send it.
  it('differs per triggering event, so a fact that fires again is a new message', () => {
    expect(noticeMessageId('unblock:iss_b:7', asSessionId('s1'), 41)).not.toBe(
      noticeMessageId('unblock:iss_b:7', asSessionId('s1'), 97),
    )
  })
})
