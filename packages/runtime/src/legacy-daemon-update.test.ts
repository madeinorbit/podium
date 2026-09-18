import { MachineUpdateExecutor, readMachineUpdateJournal } from './machine-update'
import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  confirmLegacyHealth,
  legacyBootDecision,
  legacyRollbackRefusal,
  legacyUpdateStatus,
  LEGACY_HEALTH_WINDOW_MS,
  restoreLegacyUpdate,
} from './legacy-daemon-update'
import { readPendingGrant, writePendingGrant, type PendingGrant } from './update-pending'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
const pending = (over: Partial<NonNullable<PendingGrant['legacyHealth']>> = {}): PendingGrant => ({
  grantId: 'grant',
  targetVersion: '2.0.0',
  previousVersion: '1.0.0',
  attempts: 1,
  startedAt: 100,
  legacyHealth: { boots: 0, ...over },
})
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'legacy-health-'))
  roots.push(root)
  return { root, runtime: join(root, 'runtime'), install: join(root, 'install') }
}

describe('legacy daemon health window', () => {
  it('bounds failed boots and elapsed time independently; it never resets an expired window', () => {
    expect(legacyBootDecision(pending(), 100)).toBe('boot')
    expect(legacyBootDecision(pending({ boots: 2, firstBootAt: 100 }), 101)).toBe('boot')
    expect(legacyBootDecision(pending({ boots: 3, firstBootAt: 100 }), 101)).toBe('restore')
    expect(
      legacyBootDecision(pending({ boots: 1, firstBootAt: 100 }), 100 + LEGACY_HEALTH_WINDOW_MS),
    ).toBe('restore')
    expect(
      legacyBootDecision(
        pending({ boots: 1, firstBootAt: 100 }),
        100 + 10 * LEGACY_HEALTH_WINDOW_MS,
      ),
    ).toBe('restore')
    expect(legacyBootDecision(pending({ boots: 3, firstBootAt: 100, healthyAt: 101 }), 1e9)).toBe(
      'settled',
    )
    expect(legacyBootDecision({ ...pending(), legacyHealth: undefined }, 100)).toBe('settled')
  })

  it('requires the exact version within the window and durably replays success', () => {
    const { runtime } = fixture()
    writePendingGrant(runtime, pending({ boots: 1, firstBootAt: 100 }))
    expect(confirmLegacyHealth(runtime, '1.0.0', 101)).toBe(false)
    expect(confirmLegacyHealth(runtime, '2.0.0', 100 + LEGACY_HEALTH_WINDOW_MS)).toBe(false)
    expect(confirmLegacyHealth(runtime, '2.0.0', 101)).toBe(true)
    expect(readPendingGrant(runtime)?.legacyHealth?.healthyAt).toBe(101)
    expect(legacyUpdateStatus(runtime, '2.0.0')?.state).toBe('current')
  })

  it('restores bytes, survives an interrupted restore, and retains the exit reason for the server', () => {
    const { runtime, install } = fixture()
    for (const [path, version] of [
      [install, '2.0.0'],
      [`${install}.old`, '1.0.0'],
    ]) {
      mkdirSync(path!, { recursive: true })
      writeFileSync(join(path!, 'VERSION'), version!)
    }
    const failed = pending({
      boots: 3,
      firstBootAt: 100,
      lastExit: 'exit 42 before acknowledgement',
    })
    restoreLegacyUpdate(runtime, install, failed)
    expect(readFileSync(join(install, 'VERSION'), 'utf8')).toBe('1.0.0')
    expect(existsSync(`${install}.old`)).toBe(false)
    const restored = readPendingGrant(runtime)!
    // Simulate death after the rename but before recording its completion.
    const interrupted = {
      ...restored,
      legacyHealth: { ...restored.legacyHealth!, restored: false },
    }
    writePendingGrant(runtime, interrupted)
    restoreLegacyUpdate(runtime, install, interrupted)
    expect(legacyBootDecision(readPendingGrant(runtime)!, 1e9)).toBe('settled')
    expect(legacyUpdateStatus(runtime, '1.0.0')).toMatchObject({
      state: 'stuck',
      targetVersion: '2.0.0',
      version: '1.0.0',
      detail: 'rolled back from 2.0.0: exit 42 before acknowledgement',
    })
    expect(legacyUpdateStatus(runtime, '1.0.0')).toEqual(legacyUpdateStatus(runtime, '1.0.0'))
    expect(legacyRollbackRefusal(restored, '2.0.0')).toContain('operator must re-apply')
    expect(legacyRollbackRefusal(restored, '2.0.0', true, 'new-grant')).toBeUndefined()
    expect(legacyRollbackRefusal(restored, '3.0.0')).toBeUndefined()
    expect(legacyRollbackRefusal(restored, '2.0.0', true, 'grant')).toContain(
      'operator must re-apply',
    )
  })

  it('restores a failed same-version repair by receipt rather than VERSION equality', () => {
    const { runtime, install } = fixture()
    for (const [path, payload] of [
      [install, 'broken'],
      [`${install}.old`, 'healthy'],
    ]) {
      mkdirSync(path!, { recursive: true })
      writeFileSync(join(path!, 'VERSION'), '2.0.0')
      writeFileSync(join(path!, 'payload'), payload!)
    }
    restoreLegacyUpdate(runtime, install, { ...pending({ boots: 3 }), previousVersion: '2.0.0' })
    expect(readFileSync(join(install, 'payload'), 'utf8')).toBe('healthy')
    expect(legacyUpdateStatus(runtime, '2.0.0')?.state).toBe('stuck')
  })

  it('settles the one-shot CLI journal so an operator can re-apply after restoration', async () => {
    const { runtime, install } = fixture()
    for (const [path, version] of [
      [install, '2.0.0'],
      [`${install}.old`, '1.0.0'],
    ]) {
      mkdirSync(path!, { recursive: true })
      writeFileSync(join(path!, 'VERSION'), version!)
    }
    const adapter = {
      runningVersion: () => '1.0.0',
      prepare: async () => ({ digest: 'candidate' }),
      activate: async () => {},
      discard: async () => {},
      restart: async () => 'handover-pending' as const,
    }
    const grant = {
      type: 'updateGrant' as const,
      grantId: 'grant',
      issuedAt: 100,
      target: { version: '2.0.0', critical: false, artifacts: {} },
    }
    const executor = new MachineUpdateExecutor({ runtimeDir: runtime, adapter, report: () => {} })
    await executor.accept(grant, true, false, { kind: 'local' })
    expect(readMachineUpdateJournal(runtime)?.phase).toBe('restarting')
    restoreLegacyUpdate(runtime, install, pending({ boots: 3, lastExit: 'exit 42' }))
    expect(readMachineUpdateJournal(runtime)).toMatchObject({
      phase: 'stuck',
      detail: 'rolled back from 2.0.0: exit 42',
      completed: { grant: { phase: 'stuck' } },
    })
    const restarted = new MachineUpdateExecutor({ runtimeDir: runtime, adapter, report: () => {} })
    await restarted.accept({ ...grant, grantId: 'operator-reapply', issuedAt: 101 }, true, false, {
      kind: 'local',
    })
    expect(readMachineUpdateJournal(runtime)?.grant.grantId).toBe('operator-reapply')
    expect(readMachineUpdateJournal(runtime)?.phase).toBe('restarting')
  })

  it('retains a version veto across other updates until that version is explicitly retried and healthy', () => {
    const { runtime } = fixture()
    writePendingGrant(
      runtime,
      pending({
        rejectedTargets: {
          '2.0.0': { grantId: 'failed', reason: 'rolled back from 2.0.0: exit 42' },
        },
      }),
    )
    writePendingGrant(runtime, {
      ...pending({ boots: 1, firstBootAt: 100 }),
      grantId: 'other',
      targetVersion: '3.0.0',
    })
    expect(confirmLegacyHealth(runtime, '3.0.0', 101)).toBe(true)
    expect(legacyRollbackRefusal(readPendingGrant(runtime), '2.0.0')).toContain(
      'operator must re-apply',
    )
    expect(legacyRollbackRefusal(readPendingGrant(runtime), '2.0.0', true, 'retry')).toBeUndefined()
    writePendingGrant(runtime, { ...pending({ boots: 1, firstBootAt: 200 }), grantId: 'retry' })
    expect(confirmLegacyHealth(runtime, '2.0.0', 201)).toBe(true)
    expect(legacyRollbackRefusal(readPendingGrant(runtime), '2.0.0')).toBeUndefined()
  })

  it('keeps recovery intent if the retained bundle is missing', () => {
    const { runtime, install } = fixture()
    mkdirSync(install)
    writeFileSync(join(install, 'VERSION'), '2.0.0')
    expect(() => restoreLegacyUpdate(runtime, install, pending({ boots: 3 }))).toThrow(
      'no .old bundle',
    )
    expect(readPendingGrant(runtime)?.legacyHealth).toMatchObject({
      boots: 3,
      rollbackReason: expect.stringContaining('rolled back from 2.0.0'),
    })
    expect(readPendingGrant(runtime)?.legacyHealth?.restored).toBeUndefined()
  })
})
