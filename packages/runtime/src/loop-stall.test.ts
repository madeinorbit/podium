import { describe, expect, it } from 'vitest'
import {
  classifyStall,
  createStallClassifier,
  formatStallClassification,
  parseSchedstat,
} from './loop-stall'

describe('parseSchedstat', () => {
  it('parses the 2nd field (runqueue wait, ns)', () => {
    expect(parseSchedstat('123456789 987654321 4242\n')).toBe(987654321)
  })

  it('tolerates extra whitespace', () => {
    expect(parseSchedstat('  12   34   56  ')).toBe(34)
  })

  it('rejects malformed input', () => {
    expect(parseSchedstat('')).toBeUndefined()
    expect(parseSchedstat('12')).toBeUndefined()
    expect(parseSchedstat('12 garbage 34')).toBeUndefined()
    expect(parseSchedstat('12 -5 34')).toBeUndefined()
  })
})

describe('classifyStall', () => {
  it('verdicts starved when runqueue wait dominates', () => {
    // The POD-594 shape: 812ms stall, 90ms own CPU, 680ms runqueue wait.
    const c = classifyStall({ stallMs: 812, cpuDeltaUs: 90_000, waitDeltaNs: 680e6 })
    expect(c.ownCpuMs).toBeCloseTo(90)
    expect(c.runqueueWaitMs).toBeCloseTo(680)
    expect(c.verdict).toBe('starved')
  })

  it('verdicts busy when own CPU dominates (sync work / GC)', () => {
    const c = classifyStall({ stallMs: 300, cpuDeltaUs: 290_000, waitDeltaNs: 5e6 })
    expect(c.verdict).toBe('busy')
  })

  it('verdicts mixed when neither side doubles the other', () => {
    // cpu ≈ 200ms, wait ≈ 180ms of a 400ms stall: both matter.
    const c = classifyStall({ stallMs: 400, cpuDeltaUs: 200_000, waitDeltaNs: 180e6 })
    expect(c.verdict).toBe('mixed')
  })

  it('verdicts mixed when both are small relative to the stall', () => {
    // Neither covers half the stall — e.g. blocking I/O off-CPU and off-runqueue.
    const c = classifyStall({ stallMs: 500, cpuDeltaUs: 50_000, waitDeltaNs: 10e6 })
    expect(c.verdict).toBe('mixed')
  })

  it('never divides by zero on a degenerate stall', () => {
    const c = classifyStall({ stallMs: 0, cpuDeltaUs: 0, waitDeltaNs: 0 })
    expect(c.verdict).toBe('mixed')
  })
})

describe('formatStallClassification', () => {
  it('renders the log-line fragment', () => {
    expect(
      formatStallClassification({ ownCpuMs: 90.4, runqueueWaitMs: 680.2, verdict: 'starved' }),
    ).toBe('own-cpu=90ms runqueue-wait=680ms verdict=starved')
  })
})

describe('createStallClassifier', () => {
  const cpuAt = (totalUs: number): (() => NodeJS.CpuUsage) => {
    // The classifier calls cpuUsage(prev) for deltas; emulate node's contract.
    return () => ({ user: totalUs, system: 0 })
  }

  it('is absent when schedstat is unreadable (non-Linux)', () => {
    const c = createStallClassifier({
      readSchedstat: () => {
        throw new Error('ENOENT')
      },
      cpuUsage: cpuAt(0),
    })
    expect(c).toBeUndefined()
  })

  it('is absent when schedstat is malformed', () => {
    const c = createStallClassifier({ readSchedstat: () => 'bogus', cpuUsage: cpuAt(0) })
    expect(c).toBeUndefined()
  })

  it('computes deltas against the refreshed baseline', () => {
    let waitNs = 1_000e6
    let cpuUs = 500_000
    const classifier = createStallClassifier({
      readSchedstat: () => `1 ${waitNs} 2`,
      // Emulate process.cpuUsage(previous): absolute without an arg, delta with.
      cpuUsage: (previous) => ({
        user: cpuUs - (previous?.user ?? 0),
        system: 0,
      }),
    })
    expect(classifier).toBeDefined()

    // Advance both counters, re-anchor, then advance again — only the
    // post-refresh growth may count.
    waitNs += 400e6
    cpuUs += 300_000
    classifier?.refreshBaseline()
    waitNs += 700e6
    cpuUs += 90_000

    const c = classifier?.classify(812)
    expect(c?.runqueueWaitMs).toBeCloseTo(700)
    expect(c?.ownCpuMs).toBeCloseTo(90)
    expect(c?.verdict).toBe('starved')
  })

  it('clamps a runqueue-wait counter that moved backwards to zero', () => {
    let waitNs = 500e6
    const classifier = createStallClassifier({
      readSchedstat: () => `1 ${waitNs} 2`,
      // Absolute zero at creation; a 290ms CPU delta on the classify read.
      cpuUsage: (previous) => (previous ? { user: 290_000, system: 0 } : { user: 0, system: 0 }),
    })
    waitNs = 100e6 // counter regressed (shouldn't happen, but never go negative)
    const c = classifier?.classify(300)
    expect(c?.runqueueWaitMs).toBe(0)
    expect(c?.verdict).toBe('busy')
  })

  it('returns undefined from classify when schedstat vanishes mid-run', () => {
    let ok = true
    const classifier = createStallClassifier({
      readSchedstat: () => {
        if (!ok) throw new Error('EACCES')
        return '1 2 3'
      },
      cpuUsage: cpuAt(0),
    })
    ok = false
    expect(classifier?.classify(100)).toBeUndefined()
  })

  it('keeps the previous baseline when a refresh read fails', () => {
    let fail = false
    let waitNs = 100e6
    const classifier = createStallClassifier({
      readSchedstat: () => {
        if (fail) throw new Error('EIO')
        return `1 ${waitNs} 2`
      },
      cpuUsage: (previous) => ({ user: 10_000 - (previous?.user ?? 0), system: 0 }),
    })
    fail = true
    classifier?.refreshBaseline() // must not throw, must not clobber the baseline
    fail = false
    waitNs += 250e6
    const c = classifier?.classify(300)
    expect(c?.runqueueWaitMs).toBeCloseTo(250)
    expect(c?.verdict).toBe('starved')
  })

  it('reads the real /proc schedstat on Linux', () => {
    // Feature-detection sanity on the host this ships to; skip elsewhere.
    if (process.platform !== 'linux') return
    const classifier = createStallClassifier()
    expect(classifier).toBeDefined()
    const c = classifier?.classify(100)
    expect(c).toBeDefined()
    expect(c?.runqueueWaitMs).toBeGreaterThanOrEqual(0)
  })
})
