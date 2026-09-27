/**
 * POD-4705 addendum 2 — the closure's membership work is counted, not hidden.
 * Boots the lazy pool at 1x with `Array.prototype.includes` patched to count
 * scanned elements (calls whose stack runs through the pool's own closure
 * code, never the test's), and holds the total to O(closure): at most four
 * scanned elements per built node. A membership check that scans an array
 * per visit is O(closure²) — the verbatim `closure.includes` version fails
 * this bound by two orders of magnitude (proven red, restored with cp).
 */

import { describe, expect, it } from 'vitest'
import { createReplaySource } from '../../../../harness/src/count-harness'
import { buildCorpus } from '../../../../harness/src/fixture/index'
import { DISABLED_READ_FENCE } from '../../../../shared/src/instrument/reads'
import { settableLocals } from '../../../../shared/src/locals-source'
import type { RowRecord } from '../../../../shared/src/stats'
import { mobxPoolArm } from '../arm'
import { installMobxWarnTrap } from '../mobx-trap'

installMobxWarnTrap()

const THIS_FILE = 'visible-closure-count.test'

describe('closure membership is counted (POD-4705 addendum 2)', () => {
  it('scans O(closure) elements, not O(closure^2)', () => {
    let calls = 0
    let scanned = 0
    const original = Array.prototype.includes
    const readingStack = { active: false }
    function calledByPool(): boolean {
      if (readingStack.active) return false
      readingStack.active = true
      try {
        const stack = new Error().stack ?? ''
        for (const frame of stack.split('\n').slice(1)) {
          if (frame.includes(THIS_FILE) || frame.includes('(native)')) continue
          if (frame.includes('arms/mobx/pool/pool.ts')) return true
        }
        return false
      } finally {
        readingStack.active = false
      }
    }
    Array.prototype.includes = function <T>(this: T[], ...args: [T]): boolean {
      if (calledByPool()) {
        calls += 1
        scanned += this.length
      }
      return original.apply(this, args as never) as boolean
    }
    try {
      const corpus = buildCorpus(1)
      const rows: { issues: RowRecord[]; sessions: RowRecord[]; worktrees: RowRecord[] } = {
        issues: corpus.sliceIssues.map((value) => ({ kind: 'issue', id: value.id, value })),
        sessions: corpus.sliceSessions.map((value) => ({
          kind: 'session',
          id: value.sessionId,
          value,
        })),
        worktrees: corpus.sliceWorktrees.map((value) => ({
          kind: 'worktree',
          id: value.path,
          value,
        })),
      }
      const replay = createReplaySource(rows as never)
      const locals = settableLocals({ selectedIssueId: null, coarseNow: corpus.fixedNow })
      const handle = mobxPoolArm.create(replay.source, locals.source, DISABLED_READ_FENCE, {
        schedule: () => () => {},
      })
      try {
        const nodes = handle.pool.stats.counters.issueNodes
        expect(nodes).toBeGreaterThan(0)
        expect(
          scanned,
          `closure membership scanned ${scanned} elements for ${nodes} nodes (${calls} includes calls): O(n^2), not O(n)`,
        ).toBeLessThanOrEqual(4 * nodes)
      } finally {
        handle.dispose()
      }
    } finally {
      Array.prototype.includes = original
    }
  })
})
