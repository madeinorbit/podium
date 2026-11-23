/**
 * When harness updates run (POD-7281, managed installs §5.5): once shortly after
 * start, then every six hours plus up to thirty minutes, and on request; one
 * check per harness at a time; the inventory reported after each round.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CheckForUpdateOptions, CheckForUpdateResult } from '@podium/harness/inventory'
import type { BuiltinHarnessKind } from '@podium/model'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  HarnessUpdater,
  type HarnessUpdaterOptions,
  UPDATE_CHECK_INTERVAL_MS,
  UPDATE_CHECK_JITTER_MS,
  UPDATE_CHECK_START_DELAY_MS,
} from './updater'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'podium-updater-'))
})

afterEach(() => {
  vi.useRealTimers()
  rmSync(root, { recursive: true, force: true })
})

const noUpdate = (kind: BuiltinHarnessKind): CheckForUpdateResult => ({
  outcome: 'no-update',
  kind,
  latest: '1.0.0',
  reason: 'not-newer',
  swept: [],
})

function updater(overrides: Partial<HarnessUpdaterOptions> = {}) {
  const calls: { kind: BuiltinHarnessKind; options: CheckForUpdateOptions }[] = []
  const report = vi.fn()
  const check = vi.fn(async (kind: BuiltinHarnessKind, options: CheckForUpdateOptions) => {
    calls.push({ kind, options })
    return noUpdate(kind)
  })
  const it = new HarnessUpdater({
    harnessesDir: join(root, 'harnesses'),
    commandEnv: async () => ({ PATH: '/usr/bin' }),
    managedKinds: () => ['claude-code', 'grok'],
    report,
    check,
    random: () => 0.5,
    ...overrides,
  })
  return { updater: it, calls, report, check }
}

describe('HarnessUpdater schedule', () => {
  it('checks every managed harness shortly after start, then every six hours plus jitter', async () => {
    vi.useFakeTimers()
    const { updater: u, calls, report } = updater()
    u.start()
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_START_DELAY_MS - 1)
    expect(calls).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(calls.map((c) => c.kind)).toEqual(['claude-code', 'grok'])
    expect(report).toHaveBeenCalledTimes(1)

    const next = UPDATE_CHECK_INTERVAL_MS + UPDATE_CHECK_JITTER_MS / 2
    await vi.advanceTimersByTimeAsync(next - 1)
    expect(calls).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(calls).toHaveLength(4)
    expect(report).toHaveBeenCalledTimes(2)
    u.stop()
  })

  it('stops scheduling on stop', async () => {
    vi.useFakeTimers()
    const { updater: u, calls } = updater()
    u.start()
    u.stop()
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_START_DELAY_MS + UPDATE_CHECK_INTERVAL_MS * 2)
    expect(calls).toEqual([])
  })

  it('adds between zero and thirty minutes to each six-hour interval', () => {
    expect(updater({ random: () => 0 }).updater.nextDelayMs()).toBe(UPDATE_CHECK_INTERVAL_MS)
    expect(updater({ random: () => 0.999999 }).updater.nextDelayMs()).toBeLessThan(
      UPDATE_CHECK_INTERVAL_MS + UPDATE_CHECK_JITTER_MS,
    )
    expect(UPDATE_CHECK_INTERVAL_MS).toBe(6 * 60 * 60_000)
    expect(UPDATE_CHECK_JITTER_MS).toBe(30 * 60_000)
  })

  it('starting is not waiting: start returns before any check runs', () => {
    vi.useFakeTimers()
    const { updater: u, check } = updater()
    u.start()
    expect(check).not.toHaveBeenCalled()
    u.stop()
  })

  it('a check that throws does not stop the schedule', async () => {
    vi.useFakeTimers()
    let first = true
    const { updater: u, report } = updater({
      check: async (kind) => {
        if (first) {
          first = false
          throw new Error('ledger is locked')
        }
        return noUpdate(kind)
      },
    })
    u.start()
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_START_DELAY_MS)
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS + UPDATE_CHECK_JITTER_MS)
    expect(report).toHaveBeenCalledTimes(2)
    u.stop()
  })
})

describe('HarnessUpdater.checkNow', () => {
  it('checks one harness with the machine command environment and reports', async () => {
    const {
      updater: u,
      calls,
      report,
    } = updater({
      currentFailed: async (kind) => (kind === 'grok' ? 3 : undefined),
    })
    expect(await u.checkNow('grok')).toEqual([noUpdate('grok')])
    expect(calls).toHaveLength(1)
    expect(calls[0]?.options).toMatchObject({
      harnessesDir: join(root, 'harnesses'),
      commandEnv: { PATH: '/usr/bin' },
      currentFailed: 3,
    })
    expect(report).toHaveBeenCalledTimes(1)
  })

  it('collapses concurrent checks of one harness into one', async () => {
    const pending: { finish?: () => void } = {}
    // Through a function, so the `undefined` reset below does not narrow the property.
    const finish = () => pending.finish?.()
    const check = vi.fn(
      (kind: BuiltinHarnessKind) =>
        new Promise<CheckForUpdateResult>((resolve) => {
          pending.finish = () => resolve(noUpdate(kind))
        }),
    )
    const { updater: u } = updater({ check })
    const a = u.checkNow('claude-code')
    const b = u.checkNow('claude-code')
    await vi.waitFor(() => expect(pending.finish).toBeDefined())
    finish()
    const [ra, rb] = await Promise.all([a, b])
    expect(ra).toEqual(rb)
    expect(check).toHaveBeenCalledTimes(1)

    // Once it settled, the next request is a new check.
    pending.finish = undefined
    const c = u.checkNow('claude-code')
    await vi.waitFor(() => expect(pending.finish).toBeDefined())
    finish()
    await c
    expect(check).toHaveBeenCalledTimes(2)
  })

  it('reports nothing when nothing is managed here', async () => {
    const { updater: u, report, check } = updater({ managedKinds: () => [] })
    expect(await u.checkNow()).toEqual([])
    expect(check).not.toHaveBeenCalled()
    expect(report).not.toHaveBeenCalled()
  })

  it('reads the managed harnesses from the ledger, and creates no ledger', async () => {
    const { existsSync } = await import('node:fs')
    const { managedKinds: _omit, ...rest } = {
      harnessesDir: join(root, 'harnesses'),
      commandEnv: async () => ({}),
      managedKinds: undefined,
    }
    const check = vi.fn(async (kind: BuiltinHarnessKind) => noUpdate(kind))
    const u = new HarnessUpdater({ ...rest, check })
    expect(await u.checkNow()).toEqual([])
    expect(check).not.toHaveBeenCalled()
    expect(existsSync(join(root, 'harnesses'))).toBe(false)
  })

  it('turns a throwing check into a recorded failure instead of rejecting', async () => {
    const { updater: u } = updater({
      check: async () => {
        throw new Error('disk full')
      },
    })
    expect(await u.checkNow('grok')).toEqual([
      { outcome: 'check-failed', kind: 'grok', error: 'disk full', swept: [] },
    ])
  })
})

describe('HarnessUpdater pause and go back', () => {
  it('keeps a pause in the ledger and reports it; a harness Podium does not manage is left alone', async () => {
    const { InstallLedger } = await import('@podium/harness/inventory')
    const harnessesDir = join(root, 'harnesses')
    const ledger = InstallLedger.open({ harnessesDir })
    try {
      ledger.requestInstall('grok', 'person')
    } finally {
      ledger.close()
    }
    const { updater: u, report } = updater({ harnessesDir })
    expect(u.setPaused('grok', true)).toEqual({ outcome: 'set', kind: 'grok', paused: true })
    expect(report).toHaveBeenCalledTimes(1)
    expect(u.setPaused('codex', true)).toEqual({ outcome: 'not-managed', kind: 'codex' })
    expect(report).toHaveBeenCalledTimes(1)

    const reopened = InstallLedger.open({ harnessesDir })
    try {
      expect(reopened.get('grok')?.paused).toBe(true)
    } finally {
      reopened.close()
    }
    expect(await u.goBack('grok')).toMatchObject({ outcome: 'nothing-to-go-back-to' })
    expect(report).toHaveBeenCalledTimes(1)
  })
})
