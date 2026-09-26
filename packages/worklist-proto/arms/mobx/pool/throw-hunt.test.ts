/** SCRATCH (POD-4705): which IssueNode/SessionNode computeds throw at bootstrap. DELETE BEFORE LANDING. */
import { writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createReplaySource } from '../../../harness/src/count-harness'
import { buildCorpus } from '../../../harness/src/fixture/index'
import { DISABLED_READ_FENCE } from '../../../shared/src/instrument/reads'
import { settableLocals } from '../../../shared/src/locals-source'
import { mobxPoolArm } from './arm'

describe('throw hunt', () => {
  it('reads every node getter', () => {
    const corpus = buildCorpus(1)
    const rows = {
      issues: corpus.sliceIssues.map((value) => ({ kind: 'issue', id: value.id, value })),
      sessions: corpus.sliceSessions.map((value) => ({
        kind: 'session',
        id: value.sessionId,
        value,
      })),
      worktrees: corpus.sliceWorktrees.map((value) => ({ kind: 'worktree', id: value.path, value })),
    }
    const replay = createReplaySource(rows as never)
    const locals = settableLocals({ selectedIssueId: null, coarseNow: corpus.fixedNow })
    const { pool } = mobxPoolArm.create(replay.source, locals.source, DISABLED_READ_FENCE, {
      schedule: () => () => {},
    })
    const tally = new Map<string, { count: number; stack: string }>()
    const readAll = (node: object, label: string) => {
      for (const key of Object.getOwnPropertyNames(Object.getPrototypeOf(node))) {
        if (key === 'constructor' || key === 'id') continue
        try {
          ;(node as Record<string, unknown>)[key]
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          const at = `${label}.${key}: ${message}`
          const entry = tally.get(at)
          if (entry === undefined) {
            tally.set(at, {
              count: 1,
              stack: error instanceof Error ? (error.stack ?? '') : '',
            })
          } else entry.count += 1
        }
      }
    }
    const ids = [...pool.worklist.heldIds()]
    for (const id of ids) {
      const node = pool.worklist.issue(id)
      if (node !== undefined) readAll(node, 'IssueNode')
    }
    const lines = [`issue nodes: ${ids.length}`]
    for (const [at, entry] of [...tally.entries()].sort((a, b) => b[1].count - a[1].count)) {
      lines.push(`${entry.count}x ${at}\n${entry.stack.split('\n').slice(0, 10).join('\n')}`)
    }
    writeFileSync('/tmp/opencode/throw-hunt.txt', lines.join('\n---\n'))
    pool.dispose()
    expect(true).toBe(true)
  }, 300_000)
})
