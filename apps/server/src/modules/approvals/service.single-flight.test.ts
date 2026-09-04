import { asIssueId, asSessionId } from '@podium/model'
import type { LiveServerMessage } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import { ApprovalsRepository } from '../../store/approvals'
import { createBunStoreExecutor } from '../../store/executor'
import { openMigratedTestDatabase } from '../../test-support/migrated-database'
import { ApprovalService } from './service'

/**
 * THE RE-ENTRY POINT IS INSIDE THE LOOP (POD-3258). `hasDaemon` is consulted per
 * executing row, part-way through the pass and after `stallClock` has begun to
 * be written — which is exactly where an awaited store call will park once the
 * store is async. Re-entering there produces a genuine overlapping pass rather
 * than a second sequential one.
 *
 * The count that matters is `listExecuting`: it is the pass's first act, so one
 * call means the overlapping pass was refused at the door.
 */
describe('ApprovalService.sweepStalledExecutions single-flight (POD-3258)', () => {
  function harness() {
    const db = openMigratedTestDatabase()
    const stage = createBunStoreExecutor({ database: db }).syncQueries
    if (!stage) throw new Error('the test database is not bun-backed')
    const store = new ApprovalsRepository(stage)
    let listExecutingCalls = 0
    const clock = { ms: 1_000_000 }
    /** Swapped by the test once a row is executing, so only the sweep re-enters. */
    let onHasDaemon: () => void = () => {}
    const svc = new ApprovalService({
      store: new Proxy(store, {
        get(target, prop, receiver) {
          if (prop === 'listExecuting') {
            return (...args: unknown[]) => {
              listExecutingCalls += 1
              return (target.listExecuting as (...a: unknown[]) => unknown)(...args)
            }
          }
          return Reflect.get(target, prop, receiver)
        },
      }),
      now: () => '2026-07-13T00:00:00.000Z',
      toMachine: () => {},
      hasDaemon: () => {
        onHasDaemon()
        return true
      },
      nowMs: () => clock.ms,
      clients: () => [{ send: (_m: LiveServerMessage) => {} }],
      sessionIssueId: () => asIssueId('iss_1'),
      issueInfo: () => ({ seq: 410, title: 'Approval broker' }),
      machineName: () => 'ludovico',
      logEvent: () => {},
      notifyIssue: () => {},
    })
    const executing = () => {
      const { id } = svc.request({
        op: { kind: 'update' },
        sessionId: asSessionId('s1'),
        machineId: 'm1',
      })
      svc.approve(id)
      return id
    }
    return {
      svc,
      executing,
      calls: () => listExecutingCalls,
      reset: () => {
        listExecutingCalls = 0
      },
      setOnHasDaemon: (fn: () => void) => {
        onHasDaemon = fn
      },
    }
  }

  it('skips a sweep that lands on a pass already running', () => {
    const h = harness()
    h.executing()
    h.reset()

    let reentered = false
    h.setOnHasDaemon(() => {
      if (reentered) return
      reentered = true
      h.svc.sweepStalledExecutions()
    })
    h.svc.sweepStalledExecutions()

    expect(reentered).toBe(true)
    expect(h.calls()).toBe(1)
  })

  it('a later, non-overlapping sweep runs normally', () => {
    const h = harness()
    h.executing()
    h.reset()

    h.svc.sweepStalledExecutions()
    h.svc.sweepStalledExecutions()

    expect(h.calls()).toBe(2)
  })
})
