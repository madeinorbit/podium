import { autorun } from 'mobx'
import { expect, it, vi } from 'vitest'
import { shellFixture } from '../../../tests/worklist/diagnostics/shell-fixture'
import { shellViews } from './shell-views'
import { LOADING } from './worklist/rollup'

it.each([128, 512])('does not rebuild idle shell issue projections per unrelated live message (%s issues)', count => {
  const f = shellFixture(count), views = shellViews(f.pool)
  const answers: unknown[] = []
  const counts = vi.spyOn(f.pool.queries, 'issueChildCounts')
  const questions = vi.spyOn(f.pool.queries, 'ids')
  const projections = vi.spyOn(Object, 'fromEntries')
  const stop = autorun(() => {
    const chrome = views.chrome()
    if (chrome && chrome !== LOADING) {
      // Read the same keyed color scalars the shell consumes, including its parent.
      chrome.colorIssue?.color
      const parentId = chrome.colorIssue?.parentId
      if (parentId) chrome.colorById(parentId)?.color
    }
    answers.push(chrome)
  })
  try {
    expect(answers[0]).not.toBe(LOADING)
    counts.mockClear()
    questions.mockClear()
    projections.mockClear()
    for (let message = 1; message <= 3; message++) {
      f.pool.apply({ type: 'update', rows: [0, 1, count - 1].map(index => ({
        kind: 'issue', id: f.issues[index]!.id,
        value: { ...f.issues[index]!, branch: `issue/live-${message}`,
          gitState: { ahead: message, merged: false },
          updatedAt: `2026-10-08T14:00:0${message}Z` },
      })) as never })
      expect(answers, `chrome runs after message ${message}`).toHaveLength(1)
    }
    expect(counts, 'mission projection body runs').not.toHaveBeenCalled()
    expect(questions.mock.calls.some(([question]) => question.kind === 'shellIssues')).toBe(false)
    const copies = projections.mock.calls.filter(([entries]) =>
      Array.isArray(entries) && entries.some(([key]) => key === 'gitState'))
    expect(copies, 'issue summary materializations').toHaveLength(0)
    // Live values still reach the mounted shell after the unrelated messages.
    f.pool.apply({ type: 'update', rows: [{ kind: 'issue', id: f.issues[0]!.id,
      value: { ...f.issues[0]!, color: 'violet' } }] as never })
    expect(answers).toHaveLength(2)
    const chrome = views.chrome()
    expect(chrome && chrome !== LOADING ? chrome.colorById(f.issues[0]!.id)?.color : null)
      .toBe('violet')
  } finally {
    stop()
    counts.mockRestore()
    questions.mockRestore()
    projections.mockRestore()
    f.pool.dispose()
  }
})
