import { asMachineId } from '@podium/model'
import type { AgentQuotaWire, MachineQuotaWire, QuotaWindowWire } from '@podium/model'
import { describe, expect, it } from 'vitest'
import type { AccountQuotaGroup } from './quota'
import {
  agentLabel,
  agentShortLabel,
  formatReset,
  groupQuotaByAccount,
  modelLimitNote,
  paceHint,
  paceLabel,
  percentTone,
  quotaPace,
  quotaPoolVerdict,
  quotaVerdict,
  spentModels,
  splitQuotaWindows,
  statusNote,
  windowElapsedPercent,
  windowPace,
  windowScopeModel,
  windowShortLabel,
} from './quota'

const now = Date.parse('2026-06-19T18:00:00.000Z')

describe('formatReset', () => {
  it('renders m / h m / d h, and edge cases', () => {
    expect(formatReset(new Date(now + 40 * 60_000).toISOString(), now)).toBe('resets in 40m')
    expect(formatReset(new Date(now + 134 * 60_000).toISOString(), now)).toBe('resets in 2h 14m')
    expect(formatReset(new Date(now + (28 * 60 + 5) * 60_000).toISOString(), now)).toBe(
      'resets in 1d 4h',
    )
    expect(formatReset(new Date(now - 5_000).toISOString(), now)).toBe('resetting…')
    expect(formatReset('', now)).toBe('')
  })
})

describe('percentTone', () => {
  it('buckets at 75 and 90', () => {
    expect(percentTone(74)).toBe('ok')
    expect(percentTone(75)).toBe('warn')
    expect(percentTone(90)).toBe('warn')
    expect(percentTone(90.1)).toBe('crit')
  })
})

describe('agentLabel / statusNote', () => {
  it('labels known agents and notes non-ok statuses', () => {
    expect(agentLabel('claude-code')).toBe('Claude Code')
    expect(agentShortLabel('claude-code')).toBe('CC')
    expect(agentLabel('codex')).toBe('Codex')
    expect(agentShortLabel('codex')).toBe('CX')
    expect(statusNote({ status: 'unauthenticated' })).toBe('Not signed in')
    expect(statusNote({ status: 'ok' })).toBe('')
  })
})

describe('quotaPace early-window guard', () => {
  it('does not flag hot in a fresh window unless usage is substantial', () => {
    expect(quotaPace(14, 1)).toBe('on-pace')
    expect(quotaPace(60, 1)).toBe('hot')
    expect(quotaPace(30, 12)).toBe('hot')
  })
})

describe('windowShortLabel', () => {
  it('compacts window labels for the mono column', () => {
    expect(windowShortLabel('5-hour')).toBe('5h')
    expect(windowShortLabel('Weekly')).toBe('wk')
    expect(windowShortLabel('Session')).toBe('Session')
  })
})

describe('quotaVerdict', () => {
  const group = (
    windows: AccountQuotaGroup['windows'],
    status: AccountQuotaGroup['status'] = 'ok',
  ): AccountQuotaGroup => ({
    key: 'k',
    agent: 'claude-code',
    machineNames: ['podium-host'],
    status,
    windows,
    fetchedAt: '2026-06-19T00:00:00.000Z',
  })
  const window = (usedPercent: number, minutesLeft: number) => ({
    key: '5h' as const,
    label: '5-hour',
    usedPercent,
    resetsAt: new Date(now + minutesLeft * 60_000).toISOString(),
    windowMinutes: 300,
  })

  it('says quota lasts when every window paces at or below time', () => {
    // 40% used with 50% elapsed — comfortable.
    expect(quotaVerdict([group([window(40, 150)])], now)).toEqual({
      tone: 'ok',
      label: 'lasts until reset',
      mixed: false,
      tones: ['ok'],
    })
  })

  it("warns with the hot window's label when usage outruns time", () => {
    // 70% used with only 50% elapsed — hot.
    expect(quotaVerdict([group([window(70, 150)])], now)).toEqual({
      tone: 'warn',
      label: "5h window won't last",
      mixed: false,
      tones: ['warn'],
    })
  })

  it('escalates to crit when a window is effectively spent', () => {
    expect(quotaVerdict([group([window(95, 150)])], now)).toEqual({
      tone: 'crit',
      label: '5h nearly spent',
      mixed: false,
      tones: ['crit'],
    })
  })

  // POD-271: the live shape of the bug — session 7%, weekly 54%, Fable 100%.
  it('does not let a spent model bucket speak for the harness', () => {
    const g = group([
      { ...window(7, 150), key: 'session', label: '5-hour' },
      { ...window(54, 3400), key: 'weekly-all', label: 'Weekly', windowMinutes: 10080 },
      {
        ...window(100, 3400),
        key: 'weekly-scoped:model:fable',
        label: 'Fable',
        scopeModel: 'Fable',
      },
    ])
    expect(quotaVerdict([g], now)).toEqual({
      tone: 'ok',
      label: 'Fable spent · rest lasts',
      mixed: true,
      tones: ['crit', 'ok'],
    })
  })

  it('counts spent models instead of naming them once there are several', () => {
    const g = group([
      window(20, 150),
      { ...window(100, 150), key: 'k1', label: 'Fable', scopeModel: 'Fable' },
      { ...window(94, 150), key: 'k2', label: 'Opus', scopeModel: 'Opus' },
    ])
    expect(quotaVerdict([g], now).label).toBe('2 models spent · rest lasts')
  })

  it('keeps the gating verdict as the headline when the gate is also in trouble', () => {
    const g = group([
      window(95, 150),
      { ...window(100, 150), key: 'k1', label: 'Fable', scopeModel: 'Fable' },
    ])
    expect(quotaVerdict([g], now)).toMatchObject({ tone: 'crit', label: '5h nearly spent' })
  })

  it('treats a pool of only scoped windows as gating — nothing left to fall back to', () => {
    const g = group([{ ...window(95, 150), key: 'k1', label: 'Fable', scopeModel: 'Fable' }])
    expect(quotaVerdict([g], now)).toMatchObject({ tone: 'crit', label: 'Fable nearly spent' })
  })

  it('ignores non-ok accounts and reads ok with no data', () => {
    expect(quotaVerdict([group([window(99, 10)], 'expired')], now).tone).toBe('ok')
  })

  it('summarizes mixed pools without making the worst one speak for every pool', () => {
    const constrained = group([window(98, 150)])
    const healthy = { ...group([window(10, 150)]), key: 'healthy', agent: 'codex' as const }
    expect(quotaPoolVerdict([constrained, healthy], now)).toEqual({
      tone: 'crit',
      label: '1 constrained · 1 healthy',
      mixed: true,
      tones: ['crit', 'ok'],
    })
  })

  it('keeps the specific window verdict for a single usable pool', () => {
    expect(quotaPoolVerdict([group([window(95, 150)])], now)).toEqual({
      tone: 'crit',
      label: '5h nearly spent',
      mixed: false,
      tones: ['crit'],
    })
  })

  it('counts a pool that only lost a scoped model as healthy', () => {
    const claude = group([
      window(20, 150),
      { ...window(100, 150), key: 'fable', label: 'Fable', scopeModel: 'Fable' },
    ])
    const codex = { ...group([window(10, 150)]), key: 'codex', agent: 'codex' as const }
    expect(quotaPoolVerdict([claude, codex], now)).toMatchObject({
      tone: 'ok',
      label: '2 healthy',
    })
  })
})

describe('splitQuotaWindows / windowScopeModel', () => {
  const w = (over: Partial<QuotaWindowWire> & { key: string }): QuotaWindowWire => ({
    label: '5-hour',
    usedPercent: 10,
    resetsAt: '',
    windowMinutes: 300,
    ...over,
  })

  it('splits gating windows from model-scoped ones', () => {
    const split = splitQuotaWindows([
      w({ key: 'session' }),
      w({ key: 'weekly-all', label: 'Weekly' }),
      w({ key: 'weekly-scoped:model:fable', label: 'Fable', scopeModel: 'Fable' }),
    ])
    expect(split.gating.map((x) => x.key)).toEqual(['session', 'weekly-all'])
    expect(split.models.map((x) => x.key)).toEqual(['weekly-scoped:model:fable'])
  })

  it('reads the scope from the key when a daemon predates scopeModel', () => {
    expect(windowScopeModel(w({ key: 'weekly-scoped:model:fable', label: 'Fable' }))).toBe('Fable')
    expect(windowScopeModel(w({ key: 'weekly-scoped:surface:code', label: 'Claude Code' }))).toBe(
      undefined,
    )
    expect(windowScopeModel(w({ key: 'session' }))).toBe(undefined)
  })

  it('prefers the explicit scope over the label', () => {
    expect(
      windowScopeModel(w({ key: 'k', label: 'Fable · Claude Code', scopeModel: 'Fable' })),
    ).toBe('Fable')
  })

  it('names the spent models and explains the fallback', () => {
    const windows = [
      w({ key: 'session' }),
      w({ key: 'm1', label: 'Fable', scopeModel: 'Fable', usedPercent: 100 }),
      w({ key: 'm2', label: 'Opus', scopeModel: 'Opus', usedPercent: 30 }),
    ]
    expect(spentModels(windows)).toEqual(['Fable'])
    expect(modelLimitNote('claude-code', windows)).toBe(
      'Fable is spent — Claude Code falls back to the models the shared pool covers.',
    )
    expect(modelLimitNote('claude-code', [w({ key: 'session' })])).toContain('falls back')
  })
})

describe('windowElapsedPercent', () => {
  it('derives elapsed share from reset time and window length', () => {
    const resetsAt = new Date(now + 150 * 60_000).toISOString() // 2.5h left in 5h window
    expect(windowElapsedPercent(resetsAt, 300, now)).toBeCloseTo(50, 1)
    expect(windowElapsedPercent('', 300, now)).toBeNull()
    expect(windowElapsedPercent(resetsAt, 0, now)).toBeNull()
  })
})

describe('quotaPace / windowPace', () => {
  it('classifies comfortable, on-pace, and hot windows', () => {
    expect(quotaPace(30, 50)).toBe('comfortable')
    expect(quotaPace(48, 50)).toBe('on-pace')
    expect(quotaPace(52, 50)).toBe('on-pace')
    expect(quotaPace(70, 50)).toBe('hot')
    expect(quotaPace(10, 0)).toBeNull()
  })

  it('labels and hints pace for UI copy', () => {
    expect(paceLabel('comfortable')).toBe('Headroom')
    expect(paceLabel('on-pace')).toBe('On pace')
    expect(paceLabel('hot')).toBe("Won't last")
    expect(paceHint('hot', 70, 50)).toContain('70%')
    expect(paceHint('hot', 70, 50)).toContain('50%')
  })

  it('composes window pace from wire fields', () => {
    const pace = windowPace(
      {
        key: '5h',
        label: '5-hour',
        usedPercent: 70,
        resetsAt: new Date(now + 150 * 60_000).toISOString(),
        windowMinutes: 300,
      },
      now,
    )
    expect(pace).toBe('hot')
  })
})

describe('groupQuotaByAccount', () => {
  const win = (usedPercent: number) => ({
    key: '5h' as const,
    label: '5-hour',
    usedPercent,
    resetsAt: '',
    windowMinutes: 300,
  })
  const agent = (over: Partial<AgentQuotaWire> = {}): AgentQuotaWire => ({
    agent: 'claude-code',
    status: 'ok',
    windows: [win(40)],
    fetchedAt: '2026-07-07T00:00:00.000Z',
    ...over,
  })
  const machine = (
    machineId: string,
    machineName: string,
    agents: AgentQuotaWire[],
  ): MachineQuotaWire => ({
    machineId: asMachineId(machineId),
    machineName,
    hostname: machineName,
    agents,
  })

  it('keeps distinct accounts as separate cards, each labeled with its machine', () => {
    const groups = groupQuotaByAccount([
      machine('m1', 'podium-host', [agent({ account: { email: 'a@x.com', plan: 'max' } })]),
      machine('m2', 'vmi', [agent({ account: { email: 'b@x.com', plan: 'pro' } })]),
    ])
    expect(groups).toHaveLength(2)
    expect(groups.map((g) => g.account?.email)).toEqual(['a@x.com', 'b@x.com'])
    expect(groups[0]?.machineNames).toEqual(['podium-host'])
    expect(groups[1]?.machineNames).toEqual(['vmi'])
  })

  it('dedupes the same account across machines into one card listing both', () => {
    const groups = groupQuotaByAccount([
      machine('m1', 'podium-host', [agent({ account: { email: 'shared@x.com', plan: 'max' } })]),
      machine('m2', 'vmi', [agent({ account: { email: 'shared@x.com', plan: 'max' } })]),
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0]?.machineNames).toEqual(['podium-host', 'vmi'])
    expect(groups[0]?.account?.email).toBe('shared@x.com')
  })

  it('drops agents a machine is not signed into (unauthenticated)', () => {
    const groups = groupQuotaByAccount([
      machine('m1', 'podium-host', [
        agent({ account: { email: 'a@x.com' } }),
        agent({ agent: 'codex', status: 'unauthenticated', windows: [] }),
      ]),
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0]?.agent).toBe('claude-code')
  })

  it('does not merge two machines when neither reports an email (per-machine fallback)', () => {
    const groups = groupQuotaByAccount([
      machine('m1', 'podium-host', [agent()]),
      machine('m2', 'vmi', [agent()]),
    ])
    expect(groups).toHaveLength(2)
  })

  it('prefers a healthy read when one machine is ok and another expired for the same account', () => {
    const groups = groupQuotaByAccount([
      machine('m1', 'podium-host', [
        agent({
          status: 'expired',
          windows: [],
          account: { email: 'a@x.com' },
          error: 'token expired',
        }),
      ]),
      machine('m2', 'vmi', [
        agent({ status: 'ok', windows: [win(55)], account: { email: 'a@x.com' } }),
      ]),
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0]?.status).toBe('ok')
    expect(groups[0]?.windows[0]?.usedPercent).toBe(55)
    expect(groups[0]?.machineNames).toEqual(['podium-host', 'vmi'])
  })
})
