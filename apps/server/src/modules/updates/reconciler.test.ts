import { addSink, resetLogging, setLogLevel } from '@podium/logger'
import { asMachineId } from '@podium/model'
import type { UpdateTarget } from '@podium/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OperationRow } from '../operations/store'
import { updateOperationObserver } from './operation-observer'
import { UpdateReconciler } from './reconciler'
import type { UpdateRecoverySnapshot } from './recovery-store'
import { UpdatesService } from './service'
import { fleetSnapshot } from './trpc'

const target = { version: '0.4.2', critical: false, artifacts: {} } as UpdateTarget

function harness() {
  const machines = ['canary', 'flatblock', 'laptop'].map((id) => ({
    id, version: '0.4.1', state: 'current' as const, online: true, busy: false,
  }))
  const send = vi.fn()
  let saved: UpdateRecoverySnapshot | undefined
  const resolveTarget = vi.fn(async (): Promise<UpdateTarget> => target)
  const deps = {
    resolveTarget,
    machines: async () => machines,
    send, now: () => 1000, nextGrantId: () => 'grant', concurrency: 3,
    fleetChannel: () => 'dev' as const,
    approvedTarget: async () => target,
    recovery: { read: () => saved, write: (value: UpdateRecoverySnapshot) => { saved = structuredClone(value) } },
  }
  const updates = new UpdatesService(deps)
  updates.setTarget('dev', target)
  const authorize = vi.spyOn(updates, 'authorizeMachine')
  const reconciler = new UpdateReconciler({ updates, operationActive: async () => false })
  const observe = updateOperationObserver(updates, () => reconciler)
  const row = (state: string) => ({
    id: 'op_failed_canary', kind: 'update', state,
    operation: { details: { channel: 'dev', target }, error: { code: 'canary-failed', message: 'Mac canary rejected the update.' } },
  }) as unknown as OperationRow
  return { machines, send, resolveTarget, updates, authorize, reconciler, observe, row, restart: () => new UpdatesService(deps) }
}

afterEach(() => resetLogging())

describe('observation-only update reconciliation', () => {
  it('a failed canary withdraws the channel before settlement can grant any other machine', async () => {
    const h = harness()
    h.updates.setTarget('stable', { ...target, version: '1.0.0' })
    await h.updates.authorize('dev')
    expect(h.send).toHaveBeenCalledTimes(1)
    expect(h.send.mock.calls[0]?.[0]).toBe('canary')
    await h.updates.onStatus(asMachineId('canary'), {
      type: 'updateStatus', state: 'rejected', version: '0.4.1', targetVersion: target.version,
      detail: 'Mac canary rejected the update.',
    })
    h.send.mockClear()
    await h.observe(h.row('failed'), 'running')
    await h.reconciler.onMachineConnected('flatblock')
    await h.updates.fleet()
    await h.updates.tick('dev')
    expect(h.authorize).not.toHaveBeenCalled()
    expect(h.send).not.toHaveBeenCalled()
    expect(h.updates.target('dev')).toBeUndefined()
    expect(h.updates.target('stable')?.version).toBe('1.0.0')
    expect(h.updates.targetUnavailableReasonForChannel('dev')).toContain('update-withdrawn')
    expect(h.updates.targetUnavailableReasonForChannel('dev')).toContain('Mac canary rejected')
    const fleet = await fleetSnapshot(h.updates, { kind: 'external' })
    expect(fleet.targetVersion).toBeNull()
    expect(fleet.channelChecks).toContainEqual(expect.objectContaining({
      channel: 'dev', outcome: { status: 'unavailable', reason: expect.stringContaining('Mac canary rejected') },
    }))
  })

  it('reports reconnect drift behind a withdrawn target without calling a grant path', async () => {
    const h = harness()
    await h.observe(h.row('failed'), 'running')
    const records: unknown[] = []
    resetLogging()
    setLogLevel('info')
    addSink({ name: 'drift-test', write: (record) => records.push(record) })
    await h.reconciler.onMachineConnected('laptop')
    expect(records).toContainEqual(expect.objectContaining({
      machineId: 'laptop', targetVersion: target.version, withdrawn: true,
      reason: expect.stringContaining('Mac canary rejected'),
    }))
    expect(h.authorize).not.toHaveBeenCalled()
    expect(h.send).not.toHaveBeenCalled()
  })

  it.each(['done', 'failed', 'canceled'])('never grants after %s, reconnect, or boot', async (outcome) => {
    const h = harness()
    await h.reconciler.onOperationSettled('dev', target, outcome)
    await h.reconciler.onMachineConnected('flatblock')
    await h.reconciler.onBoot()
    expect(h.authorize).not.toHaveBeenCalled()
    expect(h.send).not.toHaveBeenCalled()
  })

  it('does not continue an authorized wave while observing a healthy canary reconnect', async () => {
    const h = harness()
    await h.updates.authorize('dev')
    h.machines[0]!.version = target.version
    h.send.mockClear()
    await h.reconciler.onMachineConnected('canary')
    await h.reconciler.onBoot()
    expect(h.authorize).not.toHaveBeenCalled()
    expect(h.send).not.toHaveBeenCalled()
  })

  it('keys persisted withdrawal to the failed version and allows human reapproval', async () => {
    const h = harness()
    await h.observe(h.row('failed'), 'running')
    const restored = h.restart()
    restored.setTarget('dev', target)
    restored.publishNextTargets()
    expect(restored.target('dev')).toBeUndefined()
    expect(restored.targetUnavailableReasonForChannel('dev')).toContain('Mac canary rejected')
    await restored.reapproveTarget('dev')
    expect(restored.target('dev')).toEqual(target)
    expect(restored.targetUnavailableReasonForChannel('dev')).toBeUndefined()
    expect(h.send).not.toHaveBeenCalled()
    expect(h.restart().target('dev')).toEqual(target)

    await restored.withdrawFailedTarget('dev', target, 'failed again')
    restored.setTarget('dev', { ...target, version: '0.4.3' })
    expect(restored.target('dev')?.version).toBe('0.4.3')
    expect(restored.withdrawnTarget('dev')).toBeUndefined()
    expect(restored.targetUnavailableReasonForChannel('dev')).toBeUndefined()
    expect(h.restart().withdrawnTarget('dev')).toBeUndefined()
    await restored.reapproveTarget('dev')
    expect(restored.target('dev')?.version).toBe('0.4.3')
  })

  it('does not reapprove a failed version that the feed no longer offers', async () => {
    const h = harness()
    await h.observe(h.row('failed'), 'running')
    h.resolveTarget.mockResolvedValue({ ...target, version: '0.4.3' })
    await h.updates.reapproveTarget('dev')
    expect(h.updates.target('dev')).toBeUndefined()
    expect(h.updates.withdrawnTarget('dev')).toEqual(target)
    expect(h.updates.targetUnavailableReasonForChannel('dev')).toContain('Mac canary rejected')
    expect(h.send).not.toHaveBeenCalled()
  })

  it.each(['stuck', 'rejected'] as const)('clears an old %s row when a different version is published', async (state) => {
    const h = harness()
    await h.updates.authorize('dev')
    await h.updates.onStatus(asMachineId('canary'), {
      type: 'updateStatus', state, version: '0.4.1', targetVersion: target.version, detail: 'failed canary',
    })
    await h.observe(h.row('failed'), 'running')
    h.send.mockClear()
    h.updates.setTarget('dev', { ...target, version: '0.4.3' })
    expect(h.updates.withdrawnTarget('dev')).toBeUndefined()
    expect((await h.updates.fleet()).find((machine) => machine.id === 'canary')?.state).toBe('current')
    expect(h.send).not.toHaveBeenCalled()
  })

  it.each(['stuck', 'rejected'] as const)('preserves %s while behind and accepts arrival at the target', async (state) => {
    const h = harness()
    await h.updates.authorize('dev')
    await h.updates.onStatus(asMachineId('canary'), {
      type: 'updateStatus', state, version: '0.4.1', targetVersion: target.version, detail: 'failed canary',
    })
    await h.observe(h.row('failed'), 'running')
    h.send.mockClear()
    await h.updates.reapproveTarget('dev')
    await h.reconciler.onMachineConnected('canary')
    expect((await h.updates.fleet()).find((machine) => machine.id === 'canary')?.state).toBe(state)
    h.machines[0]!.version = target.version
    await h.reconciler.onMachineConnected('canary')
    expect((await h.updates.fleet()).find((machine) => machine.id === 'canary')?.state).toBe('current')
    expect(h.send).not.toHaveBeenCalled()
    h.updates.setTarget('dev', { ...target, version: '0.4.3' })
    expect((await h.updates.fleet()).find((machine) => machine.id === 'canary')?.state).toBe('current')
  })
})
