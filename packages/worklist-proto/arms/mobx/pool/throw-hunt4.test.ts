/** SCRATCH (POD-4705): measure the lazy closure size at 1x. DELETE BEFORE LANDING. */
import { writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createReplaySource } from '../../../harness/src/count-harness'
import { buildCorpus } from '../../../harness/src/fixture/index'
import { settableLocals } from '../../../shared/src/locals-source'
import type { SliceIssue, SliceSession } from '../../../shared/src/slice-types'
import { scanRelations } from './enumerate'
import { createPlainTables, ingestOut, ingestRecord } from './tables'
import { directParts, type RepoRow, sessionActivityOf, type ViewInputs } from './views'
import {
  directNested,
  directSessionVisibility,
  directVisibility,
  type IssueVisibility,
  readAtOf,
  type SessionVisibility,
  type VisibleInputs,
} from './worklist/visible'

describe('closure measure', () => {
  it('sizes the lazy set', () => {
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
    const source = replay.source
    const locals = settableLocals({ selectedIssueId: null, coarseNow: corpus.fixedNow })
    const tables = createPlainTables()
    const target = { read: tables, write: tables }
    const out = ingestOut()
    const issues = source.snapshot('issue')
    for (const record of source.snapshot('session')) ingestRecord(target, record, out)
    for (const record of issues) ingestRecord(target, record, out)
    for (const record of source.snapshot('worktree')) ingestRecord(target, record, out)
    const { coarseNow } = locals.source.get()
    const inputs: ViewInputs = {
      relations: scanRelations(tables),
      issue: (id) => tables.issue.get(id) as SliceIssue | undefined,
      session: (id) => tables.session.get(id) as SliceSession | undefined,
      sessionActivity: (id) => sessionActivityOf(tables.session.get(id) as SliceSession | undefined),
      repo: (id) => tables.repo.get(id) as RepoRow | undefined,
      present: (entity, id) => tables[entity].has(id),
      loading: () => false,
      parts: (id) => (tables.issue.has(id) ? directParts(inputs, id) : undefined),
      rollup: (id) =>
        tables.issue.has(id) ? directVisibility(visibleInputs, id, memo).rollup : undefined,
      retainedSeats: (id) =>
        tables.issue.has(id) ? directVisibility(visibleInputs, id, memo).retainedSeatIds : [],
      seats: (id) => inputs.relations.many('issue', id, 'sessions'),
      seatList: (id) => [...inputs.relations.many('issue', id, 'sessions')].sort(),
      selected: () => false,
      reached: (t) => coarseNow >= t,
      passed: (t) => coarseNow > t,
    }
    const memo = new Map<string, IssueVisibility>()
    const sessions = new Map<string, SessionVisibility>()
    let nested: ReadonlyMap<string, readonly string[]> | null = null
    const visibleInputs: VisibleInputs = {
      relations: inputs.relations,
      issueRow: inputs.issue,
      sessionRow: inputs.session,
      issue: (id) => (tables.issue.has(id) ? directVisibility(visibleInputs, id, memo) : undefined),
      session: (id) => {
        let parts = sessions.get(id)
        if (parts === undefined) {
          parts = directSessionVisibility(visibleInputs, id)
          sessions.set(id, parts)
        }
        return parts
      },
      passed: inputs.passed,
      reached: inputs.reached,
      loadedIssue: inputs.issue,
      progressFacts: inputs.issue,
      issueRead: (id) => {
        const row = tables.issue.get(id) as SliceIssue | undefined
        return row === undefined ? undefined : readAtOf(row.readAt)
      },
      loadedSession: inputs.session,
      nested: (id) => {
        nested ??= directNested(
          issues.map((record) => record.id),
          (issueId) => directVisibility(visibleInputs, issueId, memo),
        )
        return nested.get(id) ?? []
      },
      formalChildren: (id) =>
        tables.issue.has(id) ? directVisibility(visibleInputs, id, memo).childIds : [],
      seats: (id) => inputs.relations.many('issue', id, 'sessions'),
      seatList: (id) => [...inputs.relations.many('issue', id, 'sessions')].sort(),
      counted: () => {},
    }
    const ids = issues.map((record) => record.id)
    const partsOf = (id: string): IssueVisibility => directVisibility(visibleInputs, id, memo)
    const visible = new Set(ids.filter((id) => partsOf(id).visible))
    const present = new Set(ids.filter((id) => partsOf(id).present))
    const keeps = new Set(ids.filter((id) => partsOf(id).keeps))
    // Ancestors (raw parentId chains, same field as formal parent) + nest parents.
    const ancestors = new Set<string>()
    const roots = new Set([...visible, ...present, ...keeps])
    for (const id of roots) {
      let parent = partsOf(id).standing?.parentId ?? null
      const seen = new Set([id])
      while (parent !== null && !seen.has(parent) && tables.issue.has(parent)) {
        seen.add(parent)
        ancestors.add(parent)
        parent = partsOf(parent).standing?.parentId ?? null
      }
      const nest = partsOf(id).nestParent
      if (nest !== null && tables.issue.has(nest)) {
        ancestors.add(nest)
        let up = partsOf(nest).standing?.parentId ?? null
        const seen2 = new Set([id, nest])
        while (up !== null && !seen2.has(up) && tables.issue.has(up)) {
          seen2.add(up)
          ancestors.add(up)
          up = partsOf(up).standing?.parentId ?? null
        }
      }
    }
    // Formal descendants under members so far.
    const closure = new Set([...roots, ...ancestors])
    const formalDesc = new Set<string>()
    const stack = [...closure]
    while (stack.length > 0) {
      const next = stack.pop() as string
      for (const child of partsOf(next).childIds) {
        if (closure.has(child) || formalDesc.has(child)) continue
        formalDesc.add(child)
        stack.push(child)
      }
    }
    for (const id of formalDesc) closure.add(id)
    const lines = [
      `known issues: ${ids.length}`,
      `visible: ${visible.size}`,
      `present: ${present.size}`,
      `keeps: ${keeps.size}`,
      `present|keeps|visible union: ${roots.size}`,
      `ancestors+nestParents added: ${[...ancestors].filter((id) => !roots.has(id)).length}`,
      `formal descendants added: ${[...formalDesc].filter((id) => !roots.has(id) && !ancestors.has(id)).length}`,
      `CLOSURE: ${closure.size}`,
      `hidden in closure: ${[...closure].filter((id) => !partsOf(id).visible).length}`,
    ]
    writeFileSync('/tmp/opencode/throw-hunt4.txt', lines.join('\n'))
    expect(true).toBe(true)
  }, 300_000)
})
