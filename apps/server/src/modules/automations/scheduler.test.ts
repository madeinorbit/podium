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

function harness(opts: { live?: string[]; spawnThrows?: boolean; queueOk?: boolean } = {}) {
  const store = new SessionStore(':memory:')
  let clock = NOW
  let n = 0
  const createSession = vi.fn((_input: { cwd: string }) => {
    if (opts.spawnThrows) throw new Error('no daemon for that machine')
    n += 1
    return { sessionId: `sess_${n}` }
  })
  const queueText = vi.fn(() => ({ ok: opts.queueOk ?? true, reason: 'no resume ref' }))
  const service = new AutomationsService({
    store: store.automations,
    createSession,
    queueText,
    liveSessionIds: () => new Set(opts.live ?? []),
    now: () => clock,
    homeDir: () => '/home/tester',
  })
  return {
    store,
    service,
    createSession,
    queueText,
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

  it('rejects an unparseable cron before it can be persisted', () => {
    const h = harness()
    expect(() =>
      h.service.create({ name: 'Bad', cron: 'every tuesday', agentKind: 'codex', prompt: 'x' }),
    ).toThrow(/5 fields/)
    expect(h.service.list()).toEqual([])
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
      createSession: live.createSession,
      queueText: live.queueText,
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
    expect(run!.outcome).toBe('error')
    expect(run!.detail).toContain('sess_1') // names the orphan session
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
