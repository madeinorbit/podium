import { describe, expect, it, vi } from 'vitest'
import type { OperationRow } from '../operations/store'
import { updateOperationObserver } from './operation-observer'
import type { UpdateReconciler } from './reconciler'
import type { UpdatesService } from './service'

describe('update operation transition effects', () => {
  it('ignores terminal restatement and running metadata, and settles only update transitions', () => {
    const updates = {
      withdrawAuthorization: vi.fn(),
      publishNextTargets: vi.fn(),
      releaseInFlightGrants: vi.fn(),
      approvedTarget: vi.fn(),
    }
    const reconciler = { onOperationStarted: vi.fn(), onOperationSettled: vi.fn() }
    const observe = updateOperationObserver(
      updates as unknown as UpdatesService,
      () => reconciler as unknown as UpdateReconciler,
    )
    const target = { version: 'A' }
    const row = {
      id: 'op_a',
      kind: 'update',
      state: 'done',
      operation: { details: { channel: 'dev', target } },
    } as unknown as OperationRow
    observe(row, 'done')
    observe({ ...row, state: 'running' }, 'running')
    observe({ ...row, kind: 'other' }, 'running')
    expect(updates.withdrawAuthorization).not.toHaveBeenCalled()
    expect(updates.publishNextTargets).not.toHaveBeenCalled()
    expect(reconciler.onOperationStarted).not.toHaveBeenCalled()
    expect(reconciler.onOperationSettled).not.toHaveBeenCalled()
    observe({ ...row, state: 'running' }, undefined)
    expect(reconciler.onOperationStarted).toHaveBeenCalledOnce()
    observe(row, 'running')
    expect(updates.withdrawAuthorization).toHaveBeenCalledOnce()
    expect(updates.publishNextTargets).toHaveBeenCalledOnce()
    expect(reconciler.onOperationSettled).toHaveBeenCalledExactlyOnceWith('dev', target, 'done')
    expect(updates.withdrawAuthorization.mock.invocationCallOrder[0]).toBeLessThan(
      updates.publishNextTargets.mock.invocationCallOrder[0]!,
    )
  })
})
