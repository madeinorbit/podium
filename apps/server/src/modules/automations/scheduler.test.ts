import { Ledger } from '@podium/sync'
import { describe, expect, it, vi } from 'vitest'
import { SessionStore } from '../../store'
import { type AutomationDecision, decideTick, GRACE_MS, type Schedulable } from './decide'
import { AutomationsService } from './service'

const NOW = new Date(2026, 6, 14, 9, 0, 0) // local time — cron is server-local
const iso = (d: Date): string => d.toISOString()
const minutesAgo = (n: number): Date => new Date(NOW.getTime() - n * 60_000)
const minutesAhead = (n: number): Date => new Date(NOW.getTime() + n * 60_000)

const schedulable = (over: Partial<Schedulable> = {}): Schedulable => ({
  id: 'aut_1',
  enabled: true,
  scheduleKind: 'cron',
  cron: '0 * * * *', // hourly, on the hour
  nextRunAt: iso(NOW),
  lastSessionId: null,
  ...over,
})

const decide = (
  automations: Schedulable[],
  liveSessionIds: string[] = [],
  now: Date = NOW,
): AutomationDecision[] => decideTick({ now, automations, liveSessionIds: new Set(liveSessionIds) })

// ---------------------------------------------------------------------------
// The decision function: a pure function of (now, automations, liveSessionIds).
// ---------------------------------------------------------------------------

describe('decideTick', () => {
  const cases: Array<{
    name: string
    automation: Partial<Schedulable>
    live?: string[]
    expect: AutomationDecision['kind'] | 'none'
  }> = [
    { name: 'due exactly now → spawn', automation: { nextRunAt: iso(NOW) }, expect: 'spawn' },
    {
      name: 'due a minute ago → spawn',
      automation: { nextRunAt: iso(minutesAgo(1)) },
      expect: 'spawn',
    },
    {
      name: 'not due yet → no decision',
      automation: { nextRunAt: iso(minutesAhead(1)) },
      expect: 'none',
    },
    {
      name: 'disabled (even if armed and due) → no decision',
      automation: { enabled: false, nextRunAt: iso(minutesAgo(5)) },
      expect: 'none',
    },
    { name: 'unarmed → no decision', automation: { nextRunAt: null }, expect: 'none' },
    {
      name: 'exactly GRACE_MS late → still spawns (the boundary is inclusive)',
      automation: { nextRunAt: iso(new Date(NOW.getTime() - GRACE_MS)) },
      expect: 'spawn',
    },
    {
      name: 'one ms past GRACE_MS → missed',
      automation: { nextRunAt: iso(new Date(NOW.getTime() - GRACE_MS - 1)) },
      expect: 'missed',
    },
    {
      name: 'previous run still live → skipped_overlap',
      automation: { lastSessionId: 'sess_prev' },
      live: ['sess_prev'],
      expect: 'skipped_overlap',
    },
    {
      name: 'previous run finished → spawn',
      automation: { lastSessionId: 'sess_prev' },
      live: ['sess_other'],
      expect: 'spawn',
    },
    {
      name: 'unparseable cron → error (disarmed, never re-decided)',
      automation: { cron: 'not a cron' },
      expect: 'error',
    },
    {
      name: 'corrupt next_run_at → error rather than a silent NaN wedge',
      automation: { nextRunAt: 'yesterday-ish' },
      expect: 'error',
    },
  ]

  for (const c of cases) {
    it(c.name, () => {
      const decisions = decide([schedulable(c.automation)], c.live)
      if (c.expect === 'none') {
        expect(decisions).toEqual([])
        return
      }
      expect(decisions).toHaveLength(1)
      expect(decisions[0]!.kind).toBe(c.expect)
    })
  }

  it('re-arms strictly past now in every branch — no tight-loop re-fire', () => {
    const branches: Schedulable[] = [
      schedulable({ id: 'spawn' }),
      schedulable({ id: 'missed', nextRunAt: iso(new Date(NOW.getTime() - 5 * GRACE_MS)) }),
      schedulable({ id: 'overlap', lastSessionId: 'sess_live' }),
    ]
    for (const d of decide(branches, ['sess_live'])) {
      expect(new Date(d.nextRunAt!).getTime()).toBeGreaterThan(NOW.getTime())
    }
  })

  it('an error decision disarms (next_run_at = null) so a poison row cannot spin', () => {
    const [d] = decide([schedulable({ cron: '99 * * * *' })])
    expect(d!.kind).toBe('error')
    expect(d!.nextRunAt).toBeNull()
  })

  it('an overlap-skipped occurrence still advances — it is dropped, not deferred', () => {
    const [d] = decide([schedulable({ lastSessionId: 'sess_live' })], ['sess_live'])
    expect(d!.kind).toBe('skipped_overlap')
    expect(d!.nextRunAt).toBe(iso(new Date(2026, 6, 14, 10, 0)))
  })

  it('one-off decisions are terminal for both delivered and missed occurrences', () => {
    const oneOff = { scheduleKind: 'once' as const, cron: null }
    const [delivered] = decide([schedulable(oneOff)])
    expect(delivered).toMatchObject({ kind: 'spawn', nextRunAt: null })

    const [missed] = decide([
      schedulable({
        ...oneOff,
        nextRunAt: iso(new Date(NOW.getTime() - GRACE_MS - 1)),
      }),
    ])
    expect(missed).toMatchObject({ kind: 'missed', nextRunAt: null })
  })

  it('decides only the automations that are due, leaving the rest alone', () => {
    const decisions = decide([
      schedulable({ id: 'due' }),
      schedulable({ id: 'later', nextRunAt: iso(minutesAhead(30)) }),
      schedulable({ id: 'off', enabled: false }),
    ])
    expect(decisions.map((d) => d.automationId)).toEqual(['due'])
  })
})

// ---------------------------------------------------------------------------
// The service: applies the decisions, spawns, records the runs.
// ---------------------------------------------------------------------------

function harness(
  opts: {
    live?: string[]
    spawnThrows?: boolean
    queueOk?: boolean
    resumeOk?: boolean
    resumeReason?: string
  } = {},
) {
  const store = new SessionStore(':memory:')
  let clock = NOW
  let n = 0
  let issueN = 0
  const ledger = new Ledger({
    repo: store.sync,
    now: () => clock.getTime(),
    transact: (fn) => store.transact(fn),
  })
  const funnel = { publishComputed: vi.fn() }
  const createSession = vi.fn((_input: { cwd: string }) => {
    if (opts.spawnThrows) throw new Error('no daemon for that machine')
    n += 1
    return { sessionId: `sess_${n}` }
  })
  const queueText = vi.fn(() => ({ ok: opts.queueOk ?? true, reason: 'no resume ref' }))
  const resumeAndSend = vi.fn(() => ({
    ok: opts.resumeOk ?? true,
    ...(opts.resumeReason ? { reason: opts.resumeReason } : {}),
  }))
  const createIssue = vi.fn(() => ({ id: `iss_${++issueN}` }))
  const service = new AutomationsService({
    store: store.automations,
    ledger,
    funnel,
    createSession,
    queueText,
    resumeAndSend,
    createIssue,
    liveSessionIds: () => new Set(opts.live ?? []),
    now: () => clock,
    homeDir: () => '/home/tester',
  })
  return {
    store,
    service,
    ledger,
    funnel,
    createSession,
    queueText,
    resumeAndSend,
    createIssue,
    setNow: (d: Date) => {
      clock = d
    },
  }
}

/** A daily-at-09:00 automation, enabled and armed for today's 09:00. */
function daily(h: ReturnType<typeof harness>, over: { repoPath?: string | null } = {}) {
  const created = h.service.create({
    name: 'Nightly sweep',
    cron: '0 9 * * *',
    agentKind: 'claude-code',
    prompt: 'Run the test suite and report.',
    enabled: true,
    ...(over.repoPath !== undefined ? { repoPath: over.repoPath } : { repoPath: '/repos/podium' }),
  })
  return created
}

describe('AutomationsService.create', () => {
  it('arms an enabled automation strictly in the future; a disabled one is unarmed', () => {
    const h = harness()
    h.setNow(new Date(2026, 6, 14, 9, 0, 0)) // exactly on an occurrence
    const armed = daily(h)
    expect(armed.nextRunAt).toBe(iso(new Date(2026, 6, 15, 9, 0)))
    const off = h.service.create({
      name: 'Off',
      cron: '0 9 * * *',
      agentKind: 'claude-code',
      prompt: 'x',
    })
    expect(off.enabled).toBe(false)
    expect(off.nextRunAt).toBeNull()
  })

  it('arms a one-off at its exact future timestamp and rejects past timestamps', () => {
    const h = harness()
    const runAt = iso(minutesAhead(2))
    const created = h.service.create({
      name: 'Wake this session',
      scheduleKind: 'once',
      runAt,
      agentKind: 'codex',
      prompt: 'Continue overnight.',
      enabled: true,
      sessionMode: 'resume',
      targetSessionId: 'sess_sleeping',
    })
    expect(created).toMatchObject({
      scheduleKind: 'once',
      cron: null,
      runAt,
      nextRunAt: runAt,
      targetSessionId: 'sess_sleeping',
    })

    expect(() =>
      h.service.create({
        name: 'Too late',
        scheduleKind: 'once',
        runAt: iso(minutesAgo(1)),
        agentKind: 'codex',
        prompt: 'x',
        enabled: true,
      }),
    ).toThrow(/future/)
  })

  it('rejects an unparseable cron before it can be persisted', () => {
    const h = harness()
    expect(() =>
      h.service.create({ name: 'Bad', cron: 'every tuesday', agentKind: 'codex', prompt: 'x' }),
    ).toThrow(/5 fields/)
    expect(h.service.list()).toEqual([])
  })

  it('accepts an every-minute cron and defaults to a fresh session per run', () => {
    const h = harness()
    const created = h.service.create({
      name: 'Every minute',
      cron: '* * * * *',
      agentKind: 'codex',
      prompt: 'x',
    })
    expect(created).toMatchObject({ cron: '* * * * *', sessionMode: 'fresh' })
  })

  it('an update can change both cron and session mode', () => {
    const h = harness()
    const created = daily(h)
    expect(
      h.service.update(created.id, { cron: '* * * * *', sessionMode: 'resume' }),
    ).toMatchObject({
      cron: '* * * * *',
      sessionMode: 'resume',
    })
  })

  it('setEnabled arms and disarms', () => {
    const h = harness()
    const a = h.service.create({
      name: 'A',
      cron: '0 9 * * *',
      agentKind: 'claude-code',
      prompt: 'x',
    })
    expect(h.service.setEnabled(a.id, true).nextRunAt).not.toBeNull()
    expect(h.service.setEnabled(a.id, false).nextRunAt).toBeNull()
  })

  it('editing the cron re-arms — the old expression keeps no pending fire', () => {
    const h = harness()
    const a = daily(h)
    const updated = h.service.update(a.id, { cron: '0 * * * *' })
    expect(updated.nextRunAt).toBe(iso(new Date(2026, 6, 14, 10, 0)))
  })
})

describe('AutomationsService.tick — spawn', () => {
  it('wakes an explicit existing session through resume-and-send exactly once', () => {
    const h = harness()
    const runAt = minutesAhead(2)
    const a = h.service.create({
      name: 'Overnight continuation',
      scheduleKind: 'once',
      runAt: iso(runAt),
      targetSessionId: 'sess_sleeping',
      agentKind: 'codex',
      prompt: 'Continue the queued work.',
      enabled: true,
      sessionMode: 'resume',
    })

    h.setNow(new Date(runAt.getTime() + 1_000))
    h.service.tick()
    h.service.tick()

    expect(h.resumeAndSend).toHaveBeenCalledTimes(1)
    expect(h.resumeAndSend).toHaveBeenCalledWith({
      sessionId: 'sess_sleeping',
      text: 'Continue the queued work.',
      mutationId: expect.stringMatching(/^arun_/),
    })
    expect(h.createIssue).not.toHaveBeenCalled()
    expect(h.createSession).not.toHaveBeenCalled()
    expect(h.queueText).not.toHaveBeenCalled()
    expect(h.service.runs(a.id)).toHaveLength(1)
    expect(h.service.runs(a.id)[0]).toMatchObject({
      outcome: 'spawned',
      sessionId: 'sess_sleeping',
      firedAt: iso(runAt),
    })
    expect(h.store.automations.get(a.id)).toMatchObject({
      enabled: false,
      nextRunAt: null,
      lastRunAt: iso(runAt),
    })
    expect(() => h.service.setEnabled(a.id, true)).toThrow(/new runAt/)
  })

  it('records a terminal error instead of replacing a lost explicit target', () => {
    const h = harness({ resumeOk: false, resumeReason: 'no resume ref' })
    const runAt = minutesAhead(2)
    const a = h.service.create({
      name: 'Strict targeted wake',
      scheduleKind: 'once',
      runAt: iso(runAt),
      targetSessionId: 'sess_deleted',
      agentKind: 'codex',
      prompt: 'Continue.',
      enabled: true,
      sessionMode: 'resume',
    })

    h.setNow(new Date(runAt.getTime() + 1_000))
    h.service.tick()

    expect(h.createIssue).not.toHaveBeenCalled()
    expect(h.createSession).not.toHaveBeenCalled()
    expect(h.service.runs(a.id)[0]).toMatchObject({
      outcome: 'error',
      sessionId: 'sess_deleted',
      detail: expect.stringContaining('no resume ref'),
    })
    expect(h.store.automations.get(a.id)).toMatchObject({ enabled: false, nextRunAt: null })
  })

  it('spawns at the due time with automation provenance and the prompt via queueText', () => {
    const h = harness()
    const a = daily(h)
    h.setNow(new Date(2026, 6, 15, 9, 0, 30)) // 30s after tomorrow's occurrence
    h.service.tick()

    expect(h.createSession).toHaveBeenCalledTimes(1)
    const spawn = h.createSession.mock.calls[0]![0] as Record<string, unknown>
    expect(spawn.cwd).toBe('/repos/podium')
    expect(spawn.spawnedBy).toBe(`automation:${a.id}`)
    expect(spawn.agentKind).toBe('claude-code')
    expect(spawn.title).toBe('Nightly sweep')
    expect(spawn.issueId).toBe('iss_1')
    expect(h.createIssue).toHaveBeenCalledWith({
      repoPath: '/repos/podium',
      title: 'Nightly sweep',
      description: 'Run the test suite and report.',
      defaultAgent: 'claude-code',
      defaultModel: 'auto',
      defaultEffort: 'auto',
      type: 'automation',
    })
    // The prompt is NEVER handed to createSession: initialPrompt is argv-only and
    // silently becomes a draft on opencode/cursor [spec:SP-17db].
    expect(spawn.initialPrompt).toBeUndefined()
    expect(h.queueText).toHaveBeenCalledWith({
      sessionId: 'sess_1',
      text: 'Run the test suite and report.',
      // Replay-safe: the run id doubles as the outbox mutation id.
      mutationId: expect.stringMatching(/^arun_/),
    })

    const [run] = h.service.runs(a.id)
    expect(run).toMatchObject({ outcome: 'spawned', sessionId: 'sess_1' })
    expect(run!.firedAt).toBe(iso(new Date(2026, 6, 15, 9, 0)))
    // Re-armed for the day after, and stamped with the fire it just did.
    const stored = h.store.automations.get(a.id)!
    expect(stored.nextRunAt).toBe(iso(new Date(2026, 6, 16, 9, 0)))
    expect(stored.lastRunAt).toBe(iso(new Date(2026, 6, 15, 9, 0)))
  })

  it('records the definition, run, and re-arm as ordered durable metadata', () => {
    const h = harness()
    const a = daily(h)
    h.setNow(new Date(2026, 6, 15, 9, 0, 10))
    h.service.tick()

    const changes = h.ledger.changesSince(0)
    expect(changes?.map((change) => [change.entity, change.id, change.op])).toEqual([
      ['automation', a.id, 'upsert'],
      ['automationRun', expect.stringMatching(/^arun_/), 'upsert'],
      ['automation', a.id, 'upsert'],
    ])
    expect(changes?.map((change) => change.seq)).toEqual([1, 2, 3])
    expect(h.funnel.publishComputed).toHaveBeenCalledWith({
      type: 'automationRunsChanged',
      automationRuns: [expect.objectContaining({ automationId: a.id, outcome: 'spawned' })],
    })
  })

  it('resume mode reuses the previous successful session on later fires', () => {
    const h = harness()
    const a = h.service.create({
      name: 'Continuing sweep',
      cron: '0 9 * * *',
      agentKind: 'codex',
      prompt: 'Continue the sweep.',
      enabled: true,
      repoPath: '/repos/podium',
      sessionMode: 'resume',
    })

    h.setNow(new Date(2026, 6, 15, 9, 0, 10))
    h.service.tick()
    h.setNow(new Date(2026, 6, 16, 9, 0, 10))
    h.service.tick()

    expect(h.createIssue).toHaveBeenCalledTimes(1)
    expect(h.createSession).toHaveBeenCalledTimes(1)
    expect(h.queueText).toHaveBeenCalledTimes(1)
    expect(h.resumeAndSend).toHaveBeenCalledWith({
      sessionId: 'sess_1',
      text: 'Continue the sweep.',
      mutationId: expect.stringMatching(/^arun_/),
    })
    expect(h.service.runs(a.id)).toHaveLength(2)
    expect(h.service.runs(a.id).every((run) => run.sessionId === 'sess_1')).toBe(true)
  })

  it('resume mode safely falls back to a fresh issue and session when the ref is gone', () => {
    const h = harness({ resumeOk: false, resumeReason: 'no resume ref' })
    const a = h.service.create({
      name: 'Continuing sweep',
      cron: '0 9 * * *',
      agentKind: 'codex',
      prompt: 'Continue the sweep.',
      enabled: true,
      repoPath: '/repos/podium',
      sessionMode: 'resume',
    })

    h.setNow(new Date(2026, 6, 15, 9, 0, 10))
    h.service.tick()
    h.setNow(new Date(2026, 6, 16, 9, 0, 10))
    h.service.tick()

    expect(h.resumeAndSend).toHaveBeenCalledTimes(1)
    expect(h.createIssue).toHaveBeenCalledTimes(2)
    expect(h.createSession).toHaveBeenCalledTimes(2)
    expect(h.service.runs(a.id).map((run) => run.sessionId)).toEqual(['sess_2', 'sess_1'])
  })

  it('a GLOBAL automation (repo_path NULL) runs in the home directory', () => {
    const h = harness()
    daily(h, { repoPath: null })
    h.setNow(new Date(2026, 6, 15, 9, 1))
    h.service.tick()
    expect((h.createSession.mock.calls[0]![0] as { cwd: string }).cwd).toBe('/home/tester')
  })

  it('does nothing when nothing is due', () => {
    const h = harness()
    daily(h)
    h.setNow(new Date(2026, 6, 14, 23, 0))
    h.service.tick()
    expect(h.createSession).not.toHaveBeenCalled()
    expect(h.service.runs(h.service.list()[0]!.id)).toEqual([])
  })
})

describe('AutomationsService.tick — the missed / overlap / error policy', () => {
  it('an outage spanning many occurrences collapses into exactly ONE late fire', () => {
    // Hourly automation, armed for 09:00; the server comes back at 09:30 THREE DAYS
    // later. A backfill would spawn ~72 sessions. [spec:SP-17db]
    const h = harness()
    const a = h.service.create({
      name: 'Hourly',
      cron: '0 * * * *',
      agentKind: 'claude-code',
      prompt: 'sweep',
      enabled: true,
      repoPath: '/repos/podium',
    })
    expect(a.nextRunAt).toBe(iso(new Date(2026, 6, 14, 10, 0)))

    h.setNow(new Date(2026, 6, 17, 9, 30))
    h.service.tick()
    // The overdue occurrence is > 1h late → recorded as missed, NOT spawned.
    expect(h.createSession).not.toHaveBeenCalled()
    expect(h.service.runs(a.id).map((r) => r.outcome)).toEqual(['missed'])
    // …and it is re-armed to the very next occurrence (10:00 the same day).
    expect(h.store.automations.get(a.id)!.nextRunAt).toBe(iso(new Date(2026, 6, 17, 10, 0)))

    // The next tick, once that occurrence comes due, spawns exactly once.
    h.setNow(new Date(2026, 6, 17, 10, 0, 5))
    h.service.tick()
    expect(h.createSession).toHaveBeenCalledTimes(1)
    expect(h.service.runs(a.id).map((r) => r.outcome)).toEqual(['spawned', 'missed'])
  })

  it('a still-running previous session skips the occurrence instead of piling up', () => {
    const h = harness()
    const a = daily(h)
    h.setNow(new Date(2026, 6, 15, 9, 0, 10))
    h.service.tick()
    expect(h.service.runs(a.id)[0]!.sessionId).toBe('sess_1')

    // sess_1 is still going a day later, when the next occurrence comes due.
    const live = harness({ live: ['sess_1'] })
    const service = new AutomationsService({
      store: h.store.automations,
      ledger: h.ledger,
      funnel: h.funnel,
      createSession: live.createSession,
      queueText: live.queueText,
      resumeAndSend: live.resumeAndSend,
      createIssue: live.createIssue,
      liveSessionIds: () => new Set(['sess_1']),
      now: () => new Date(2026, 6, 16, 9, 0, 10),
    })
    service.tick()
    expect(live.createSession).not.toHaveBeenCalled()
    const runs = service.runs(a.id)
    expect(runs[0]).toMatchObject({ outcome: 'skipped_overlap', sessionId: null })
    expect(runs[0]!.detail).toContain('sess_1')
    // Skipped, not deferred: the automation is armed for the NEXT day.
    expect(h.store.automations.get(a.id)!.nextRunAt).toBe(iso(new Date(2026, 6, 17, 9, 0)))
  })

  it('a throwing spawn records an error run, and the next tick still proceeds', () => {
    const h = harness({ spawnThrows: true })
    const a = daily(h)
    h.setNow(new Date(2026, 6, 15, 9, 0, 10))
    expect(() => h.service.tick()).not.toThrow()
    const [run] = h.service.runs(a.id)
    expect(run).toMatchObject({ outcome: 'error', sessionId: null })
    expect(run!.detail).toContain('no daemon')
    // Still armed for tomorrow — an erroring run never disables the automation.
    expect(h.store.automations.get(a.id)!.nextRunAt).toBe(iso(new Date(2026, 6, 16, 9, 0)))
  })

  it('a session that spawns but rejects the prompt is an error, not a silent success', () => {
    const h = harness({ queueOk: false })
    const a = daily(h)
    h.setNow(new Date(2026, 6, 15, 9, 0, 10))
    h.service.tick()
    const [run] = h.service.runs(a.id)
    expect(run).toMatchObject({ outcome: 'error', sessionId: 'sess_1' })
    expect(run!.detail).toContain('sess_1')
  })
})

describe('AutomationsService.remove', () => {
  it('deletes the automation and cascades its run history', () => {
    const h = harness()
    const a = daily(h)
    h.setNow(new Date(2026, 6, 15, 9, 0, 10))
    h.service.tick()
    expect(h.service.runs(a.id)).toHaveLength(1)
    expect(h.service.remove(a.id)).toEqual({ removed: true })
    expect(h.service.list()).toEqual([])
    expect(h.service.runs(a.id)).toEqual([])
    expect(h.service.remove(a.id)).toEqual({ removed: false })
  })
})
