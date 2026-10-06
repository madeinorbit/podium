import { afterEach, describe, expect, it } from 'vitest'
import { type AsyncLedger, installAsyncLedger } from './async-ledger'
import { insideArm, measureWork } from './work-meter'

const START = Date.parse('2026-09-20T12:00:00Z')
let ledger: AsyncLedger | undefined

afterEach(() => {
  ledger?.dispose()
  ledger = undefined
})

const settle = (tag: string | null) => ledger!.settle(tag, { maxDelayMs: 1_000, deadlineMs: 5_000 })

describe('async ledger (POD-5466)', () => {
  it('counts the scheduled callback while excluding ledger stack formatting', async () => {
    ledger = installAsyncLedger({ holdBeyondMs: 1_000, startAt: START })
    ledger.open('measured')
    const { work } = await measureWork(async () => {
      insideArm(() => queueMicrotask(() => {
        for (const row of ['addressed-row']) void row
      }))
      await settle('measured')
    })
    ledger.close()
    expect(work.elements).toBe(1)
    expect(work.visits).toBe(1)
    expect(ledger.takeForeign()).toEqual([])
  })

  it("settles a window only after its own microtasks and short timers ran, and their children's", async () => {
    ledger = installAsyncLedger({ holdBeyondMs: 1_000, startAt: START })
    const ran: string[] = []
    ledger.open('w1')
    queueMicrotask(() => {
      ran.push('micro')
      setTimeout(() => ran.push('child timer'), 20)
    })
    setTimeout(() => ran.push('timer'), 30)
    await settle('w1')
    ledger.close()
    expect(ran.sort()).toEqual(['child timer', 'micro', 'timer'])
    expect(ledger.takeForeign()).toEqual([])
  })

  it('records a callback that runs in a window it was not scheduled in as foreign', async () => {
    ledger = installAsyncLedger({ holdBeyondMs: 1_000, startAt: START })
    ledger.open('w1')
    setTimeout(() => {}, 30)
    ledger.close()
    ledger.open('w2')
    await settle('w1')
    ledger.close()
    const foreign = ledger.takeForeign()
    expect(foreign).toHaveLength(1)
    expect(foreign[0]).toMatchObject({ window: 'w2', scheduledIn: 'w1', kind: 'timeout' })
  })

  it('holds a timer longer than the bound: it never runs, can be cleared, and owes nothing', async () => {
    ledger = installAsyncLedger({ holdBeyondMs: 1_000, startAt: START })
    let ran = false
    ledger.open('w1')
    const handle = setTimeout(() => {
      ran = true
    }, 60_000)
    const interval = setInterval(() => {
      ran = true
    }, 60_000)
    await settle('w1')
    ledger.close()
    expect(ran).toBe(false)
    expect(ledger.held()).toHaveLength(2)
    clearTimeout(handle)
    clearInterval(interval)
    expect(ledger.held()).toHaveLength(0)
  })

  it('reads a virtual clock that stands still inside a window and moves only between windows', async () => {
    ledger = installAsyncLedger({ holdBeyondMs: 1_000, startAt: START })
    expect(Date.now()).toBe(START)
    expect(new Date().getTime()).toBe(START)
    ledger.open('w1')
    await new Promise<void>((resolve) => setTimeout(resolve, 20))
    expect(Date.now()).toBe(START)
    expect(() => ledger!.advance(1)).toThrow('inside w1')
    ledger.close()
    ledger.advance(5_000)
    expect(Date.now()).toBe(START + 5_000)
    expect(new Date('2026-01-01T00:00:00Z').toISOString()).toBe('2026-01-01T00:00:00.000Z')
  })

  it('fails a settle that does not finish, naming what is still owed', async () => {
    ledger = installAsyncLedger({ holdBeyondMs: 10_000, startAt: START })
    ledger.open('w1')
    setTimeout(() => {}, 5_000)
    await expect(ledger.settle('w1', { maxDelayMs: 10_000, deadlineMs: 50 })).rejects.toThrow(
      /w1 did not settle in 50 ms: timeout\(5000 ms\) from /,
    )
    ledger.close()
  })

  it('restores every global on dispose', () => {
    const before = [Date, setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask]
    ledger = installAsyncLedger({ holdBeyondMs: 1_000, startAt: START })
    ledger.dispose()
    ledger = undefined
    expect([Date, setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask]).toEqual(
      before,
    )
  })
})
