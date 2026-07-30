/**
 * The framework idempotency implementation (POD-382). These cases were
 * characterized against `SessionsService.withMutation` BEFORE the relocation and
 * assert the same semantics after it — the relocation's whole claim is that
 * nothing about the behaviour moved with the code.
 *
 * The store double is deliberately a real map rather than a mock: every case here
 * turns on what was DURABLY RECORDED, and a mock that only counts calls would pass
 * while recording `'{}'` for an async body — the one bug in this file's history.
 */

import { describe, expect, it, vi } from 'vitest'
import { type AppliedMutationStore, MutationLedger } from './mutation-ledger'

function fakeStore(): AppliedMutationStore & { rows: Map<string, { proc: string; result: string }> } {
  const rows = new Map<string, { proc: string; result: string }>()
  return {
    rows,
    getAppliedMutation: (id) => rows.get(id)?.result,
    recordAppliedMutation: (id, proc, result) => {
      // INSERT OR IGNORE, like the real repository: the first write wins.
      if (!rows.has(id)) rows.set(id, { proc, result })
    },
  }
}

function ledger(): { led: MutationLedger; store: ReturnType<typeof fakeStore> } {
  const store = fakeStore()
  return { led: new MutationLedger(store, () => 1_000), store }
}

describe('MutationLedger', () => {
  it('runs the body once per id; a duplicate delivery returns the recorded result', () => {
    const { led, store } = ledger()
    let runs = 0

    const first = led.apply('m-1', 'sessions.rename', () => {
      runs += 1
      return { ok: true, ids: ['a', 'b'] }
    })
    const replay = led.apply('m-1', 'sessions.rename', () => {
      runs += 1
      return { ok: true, ids: ['DIFFERENT'] }
    })

    expect(runs).toBe(1)
    expect(first.outcome).toBe('applied')
    expect(replay.outcome).toBe('replayed')
    // Deep-equal, not identical: the replay comes back through JSON.
    expect(replay.value).toEqual(first.value)
    expect(store.rows.get('m-1')?.proc).toBe('sessions.rename')
  })

  it('is keyed on the mutationId ALONE — the same id under a different proc still dedupes', () => {
    // The counterfactual that matters: if the key were (mutationId, proc), a
    // queued write arriving on two transports under two proc spellings would apply
    // TWICE. The second call names a different proc and must still be refused.
    const { led } = ledger()
    let runs = 0
    led.once('m-same', 'sessions.sendText', () => {
      runs += 1
      return 'first'
    })
    const second = led.once('m-same', 'sessions.resumeAndSend', () => {
      runs += 1
      return 'second'
    })
    expect(runs).toBe(1)
    expect(second).toBe('first')
  })

  it('a DIFFERENT id re-applies the same input', () => {
    const { led } = ledger()
    let runs = 0
    const run = (id: string) =>
      led.once(id, 'sessions.rename', () => {
        runs += 1
        return id
      })
    expect(run('m-a')).toBe('m-a')
    expect(run('m-b')).toBe('m-b')
    expect(runs).toBe(2)
  })

  it('no mutationId means NO dedup and NOTHING recorded', () => {
    const { led, store } = ledger()
    let runs = 0
    const run = () =>
      led.apply(undefined, 'sessions.rename', () => {
        runs += 1
        return 1
      })
    expect(run().outcome).toBe('applied')
    expect(run().outcome).toBe('applied')
    expect(runs).toBe(2)
    expect(store.rows.size).toBe(0)
  })

  it('records the RESOLVED value of an async body, never the pending Promise', async () => {
    // JSON.stringify(promise) === '{}', which would poison every replay of an
    // async proc with an empty object. The assertion is on the RECORDED STRING,
    // because a test that only compared return values passes either way.
    const { led, store } = ledger()
    let runs = 0
    const body = async () => {
      runs += 1
      return { id: 'issue-1', title: 'once' }
    }

    const first = await led.once('m-async', 'issues.create', body)
    const replay = await led.once('m-async', 'issues.create', body)

    expect(runs).toBe(1)
    expect(first).toEqual({ id: 'issue-1', title: 'once' })
    expect(replay).toEqual(first)
    expect(store.rows.get('m-async')?.result).toBe('{"id":"issue-1","title":"once"}')
  })

  it('a replay arriving BEFORE the original resolves joins the same promise', async () => {
    // The shipped case: both calls in one tRPC HTTP batch. Nothing is recorded yet
    // when the second arrives, so only the in-flight map can catch it.
    const { led } = ledger()
    let runs = 0
    let release: (v: string) => void = () => {}
    const body = () => {
      runs += 1
      return new Promise<string>((resolve) => {
        release = resolve
      })
    }

    const a = led.apply('m-batch', 'issues.create', body)
    const b = led.apply('m-batch', 'issues.create', body)
    expect(runs).toBe(1)
    expect(b.outcome).toBe('replayed')

    release('done')
    await expect(a.value).resolves.toBe('done')
    await expect(b.value).resolves.toBe('done')
  })

  it('a REJECTED async body records nothing, so the mutation stays retryable', async () => {
    const { led, store } = ledger()
    let runs = 0
    const body = async () => {
      runs += 1
      if (runs === 1) throw new Error('daemon offline')
      return 'second attempt'
    }

    await expect(led.once('m-retry', 'sessions.create', body)).rejects.toThrow('daemon offline')
    expect(store.rows.size).toBe(0)

    // The retry is a fresh apply, not a replay of the failure.
    await expect(led.once('m-retry', 'sessions.create', body)).resolves.toBe('second attempt')
    expect(runs).toBe(2)
  })

  it('records the applied-at stamp from the injected clock', () => {
    const now = vi.fn(() => 4_242)
    const store = fakeStore()
    const record = vi.spyOn(store, 'recordAppliedMutation')
    new MutationLedger(store, now).once('m-clock', 'sessions.rename', () => 'x')
    expect(record).toHaveBeenCalledWith('m-clock', 'sessions.rename', '"x"', 4_242)
  })

  it('a body returning undefined records null, and its replay does not re-run', () => {
    // Every presence write returns void. If `undefined` recorded nothing, the
    // whole presence class would silently lose its dedup — the exact regression
    // POD-379's per-route oracle was written to catch.
    const { led, store } = ledger()
    let runs = 0
    const body = () => {
      runs += 1
    }
    expect(led.apply('m-void', 'sessions.setArchived', body).outcome).toBe('applied')
    expect(led.apply('m-void', 'sessions.setArchived', body).outcome).toBe('replayed')
    expect(runs).toBe(1)
    expect(store.rows.get('m-void')?.result).toBe('null')
  })
})
