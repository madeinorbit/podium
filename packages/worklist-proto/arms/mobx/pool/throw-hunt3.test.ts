/** SCRATCH (POD-4705): count never-computed computeds at bootstrap. DELETE BEFORE LANDING. */
import { writeFileSync } from 'node:fs'
import { _getAdministration as getAdministration } from 'mobx'
import { describe, expect, it } from 'vitest'
import { createReplaySource } from '../../../harness/src/count-harness'
import { buildCorpus } from '../../../harness/src/fixture/index'
import { DISABLED_READ_FENCE } from '../../../shared/src/instrument/reads'
import { settableLocals } from '../../../shared/src/locals-source'
import { mobxPoolArm } from './arm'

describe('placeholder hunt', () => {
  it('counts NOT_TRACKING computeds', () => {
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
    const keysOf = (node: object): string[] =>
      Object.getOwnPropertyNames(Object.getPrototypeOf(node)).filter(
        (key) => key !== 'constructor' && key !== 'id',
      )
    let neverComputed = 0
    let computed = 0
    let nonComputed = 0
    const perKeyNever = new Map<string, number>()
    for (const id of pool.worklist.heldIds()) {
      const node = pool.worklist.issue(id)
      if (node === undefined) continue
      for (const key of keysOf(node)) {
        let admin: { dependenciesState_?: number } | undefined
        try {
          admin = getAdministration(node, key) as unknown as { dependenciesState_?: number }
        } catch {
          nonComputed += 1
          continue
        }
        if (admin === undefined || admin.dependenciesState_ === undefined) {
          nonComputed += 1
          continue
        }
        if (admin.dependenciesState_ === -1) {
          neverComputed += 1
          perKeyNever.set(key, (perKeyNever.get(key) ?? 0) + 1)
        } else computed += 1
      }
    }
    const lines = [
      `issue nodes: ${pool.worklist.size('issue')}`,
      `never-computed: ${neverComputed}, computed: ${computed}, non-computed: ${nonComputed}`,
      ...[...perKeyNever.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([key, count]) => `never ${count}x IssueNode.${key}`),
    ]
    writeFileSync('/tmp/opencode/throw-hunt3.txt', lines.join('\n'))
    pool.dispose()
    expect(true).toBe(true)
  }, 300_000)
})
