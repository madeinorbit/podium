import { autorun } from 'mobx'
import { expect, it, vi } from 'vitest'
import { legacyShellSnapshot } from '../../../tests/worklist/diagnostics/shell-check'
import { effectiveIssueColorHex } from '../../../apps/web/src/lib/issueColors'
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
      // Read the same keyed color and mission scalars the shell consumes.
      chrome.missionRoot?.id
      if (chrome.missionRoot && chrome.missionRoot.type !== 'epic') chrome.missionRoot.childCount
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
          title: `Live issue title ${index}/${message}`,
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
    f.pool.apply({ type: 'update', rows: [{ kind: 'issue', id: f.issues[0]!.id,
      value: { ...f.issues[0]!, color: 'violet', type: 'epic' } }] as never })
    expect(answers, 'live mission complexity change').toHaveLength(3)
  } finally {
    stop()
    counts.mockRestore()
    questions.mockRestore()
    projections.mockRestore()
    f.pool.dispose()
  }
})


it('preserves live shell color and mission answers through keyed ancestry changes', () => {
  const f = shellFixture(), views = shellViews(f.pool)
  let issues = [...f.issues]
  const patch = (index: number, values: Partial<typeof issues[number]>) => {
    issues = issues.map((issue, i) => i === index ? { ...issue, ...values } : issue)
    f.issues[index] = issues[index]! // The cold fixture loader reads these same source rows.
    f.pool.apply({ type: 'update', rows: [{ kind: 'issue', id: issues[index]!.id,
      value: issues[index]! }] as never })
  }
  const check = (mission = true) => {
    let chrome = views.chrome()
    for (let batch = 0; chrome === LOADING && batch < 8; batch++) {
      f.pool.hydrate()
      chrome = views.chrome()
    }
    expect(chrome).not.toBe(LOADING)
    if (!chrome || chrome === LOADING) throw new Error('shell did not settle')
    const selected = issues.find(issue => issue.id === f.state().selectedIssueId &&
      !issue.archived && !issue.deletedAt)
    expect(effectiveIssueColorHex(chrome.colorIssue, chrome.colorById)).toBe(
      effectiveIssueColorHex(selected, id => issues.find(issue => issue.id === id)),
    )
    if (!mission) return // Cyclic mission roots already differ in the landed mission reader.
    const expected = legacyShellSnapshot(f.state(), issues).sections.find(section => section.key === 'chrome')!.fields
    expect(chrome.missionRoot?.id ?? null).toBe(expected.missionRootId)
    expect(Boolean(chrome.missionRoot && (chrome.missionRoot.type === 'epic' ||
      chrome.missionRoot.childCount >= 6))).toBe(expected.missionExpanded)
  }
  try {
    check()
    patch(0, { color: 'violet', type: 'epic' })
    check()
    patch(1, { color: 'teal' })
    check()
    // A stale synced color must retain the legacy ancestor fallback.
    patch(1, { color: 'unknown-slot' as never })
    check()
    patch(1, { parentId: issues[2]!.id })
    check()
    patch(2, { color: 'rose', parentId: issues[1]!.id })
    check(false)
    patch(1, { archived: true })
    check()
    patch(1, { archived: false, deletedAt: '2026-10-08T14:00:00Z' })
    check()
    f.change({ selectedIssueId: null })
    check()
  } finally {
    f.pool.dispose()
  }
})


it('keeps an archived selected child summary-only while its mission stays visible', () => {
  const f = shellFixture(), views = shellViews(f.pool)
  const archived = { ...f.issues[1]!, archived: true, stage: 'done' as const }
  f.issues[1] = archived
  try {
    f.pool.apply({ type: 'update', rows: [{ kind: 'issue', id: archived.id,
      value: archived }] as never })
    const chrome = views.chrome()
    expect(chrome).not.toBe(LOADING)
    expect(chrome).toHaveProperty('colorIssue', undefined)
    expect(chrome).toHaveProperty('missionRoot.id', f.issues[0]!.id)
    expect(f.pool.hydrate()).toBe(0)
    expect(f.loads).toEqual([])
  } finally {
    f.pool.dispose()
  }
})
