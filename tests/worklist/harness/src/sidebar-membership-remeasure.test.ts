import { mkdirSync, writeFileSync } from 'node:fs'
import { MobxPool } from '@podium/client-graph/pool'
import { worklistView } from '@podium/client-graph/worklist/view-model'
import { searchMobileSections, MobileSearchSections, MobileNativeSections } from '../../../../apps/mobile/src/lib/work-sections'
import { autorun, runInAction } from 'mobx'
import { expect, it } from 'vitest'
import { insideArm, insideReader, measureWork, type WorkCounts } from './work-meter'

// Evidence-only POD-5631 probe: no alternative implementation or new baseline.
// Canonical speed:structural lacks fold and reorder actions. These source
// readers keep the drawn prefix fixed while the member/group population grows.
const stamp = '2026-10-09T12:00:00Z'
const now = Date.parse(stamp)
const issue = (group: number, index: number, patch = {}) => ({
  id: `group-${group}-issue-${index}`, seq: group * 1000 + index + 1,
  title: `issue ${group}/${index}`, repoId: `repo-${group}`, repoPath: `/repo-${group}`,
  audience: 'human', stage: 'planning', createdAt: stamp, updatedAt: stamp,
  sortKey: `a${String(index).padStart(4, '0')}`, deps: [], ...patch,
})
const session = (id: string, owner: string | null, path: string, patch = {}) => ({
  sessionId: id, issueId: owner, cwd: path, agentKind: 'codex', archived: false,
  status: 'live', createdAt: stamp, lastActiveAt: stamp,
  agentState: { phase: 'working', since: stamp }, ...patch,
})
type Action = 'click' | 'fold' | 'reorder' | 'membership' | 'heartbeat' | 'roster-heartbeat'

async function capture(domain: 'members' | 'groups', scale: number) {
  const groups = domain === 'groups' ? 4 * scale : 4
  const members = domain === 'members' ? 16 * scale : 16
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: now })
  const source = Array.from({ length: groups }, (_, g) => Array.from({ length: members }, (_, n) =>
    issue(g, n, n === members - 1 ? { stage: 'done', closedReason: 'done', closedAt: stamp, tuckedAt: stamp }
      : n === members - 2 ? { deferUntil: '2026-10-20T00:00:00Z' } : {}))).flat()
  const looseCount = domain === 'members' ? 16 * scale : 16
  const loose = Array.from({ length: looseCount }, (_, n) => session(`loose-${n}`, null, '/loose', {
    lastActiveAt: new Date(now - (24 + n) * 3600000).toISOString(),
    agentState: { phase: 'unknown', since: stamp },
  }))
  pool.apply({ type: 'replace', rows: [
    ...source.map(value => ({ kind: 'issue' as const, id: value.id, value: value as never })),
    { kind: 'session', id: 'unrelated', value: session('unrelated', 'group-3-issue-0', '/repo-3') as never },
    { kind: 'worktree', id: '/loose', value: { path: '/loose', repoId: 'repo-0', repoPath: '/repo-0', repoName: 'Repo 0', branch: 'loose' } as never },
    ...loose.map(value => ({ kind: 'session' as const, id: value.sessionId, value: value as never })),
  ] })
  const view = worklistView(pool)
  const tree = view.tree(pool.model('worktree', '/loose')!)
  const native = new MobileSearchSections()
  const foldedNative = new MobileNativeSections()
  const collapsed = new Set<string>()
  let nativeAnswer: ReturnType<typeof searchMobileSections> = []
  let foldedData: readonly unknown[] = []
  let desktopIds: readonly string[] = [], phoneIds: readonly string[] = []
  const stops = [
    autorun(() => insideReader('membership.desktop-source', () => {
      const band = view.sections().bands.find(band => band.key === 'repo-0')!
      desktopIds = band.rowIds
      // The visible prefix stays fixed; closed rows are not mounted.
      if (!band.collapsed) void band.rowIds.slice(0, 5)
    })),
    autorun(() => insideReader('membership.phone-native', () => {
      const sections = view.mobileSections()
      const answer = searchMobileSections(pool, sections.sectionKeys, '', native)
      phoneIds = sections.project('repo-0').openIds
      nativeAnswer = answer
      const display = foldedNative.update(answer, collapsed, false)
      foldedData = display.find(section => section.key === 'repo-0')?.data ?? []
      for (const section of display.slice(0, 3)) if (!section.collapsed) void section.data.slice(0, 5)
    })),
    autorun(() => insideReader('membership.worktree-source', () => {
      void tree.sessions; void tree.visible; void tree.stale
    })),
  ]
  try {
    expect(desktopIds).toContain('group-0-issue-1')
    expect(phoneIds).toContain('group-0-issue-1')
    expect(tree.sessions.length).toBe(looseCount)
    const closed = view.sections().bands.find(band => band.key === 'repo-0')!.closedIds
    expect(closed).toContain(`group-0-issue-${members - 1}`)
    const update = (kind: 'issue' | 'session', id: string, value: unknown) =>
      pool.apply({ type: 'update', rows: [{ kind, id, value: value as never }] })
    const actions: Record<Action, () => void> = {
      click: () => view.select('group-0-issue-1'),
      fold: () => {
        collapsed.add('repo-0')
        // WorkScreen's React memo folds the existing native source; it does
        // not rerun its pool projection when only collapsedKeys changes.
        const display = insideReader('membership.phone-fold', () => foldedNative.update(nativeAnswer, collapsed, false))
        foldedData = display.find(section => section.key === 'repo-0')!.data
      },
      reorder: () => update('issue', 'group-0-issue-1', issue(0, 1, { sortKey: 'z9999' })),
      membership: () => update('issue', 'group-0-issue-2', issue(0, 2, { deferUntil: '2026-10-20T00:00:00Z' })),
      heartbeat: () => update('session', 'unrelated', session('unrelated', 'group-3-issue-0', '/repo-3', { lastActiveAt: '2026-10-09T12:01:00Z' })),
      'roster-heartbeat': () => update('session', `loose-${looseCount - 1}`, { ...loose[looseCount - 1], lastActiveAt: '2026-10-09T12:01:00Z' }),
    }
    const cells: { action: Action; work: WorkCounts }[] = []
    for (const [action, change] of Object.entries(actions) as [Action, () => void][]) {
      const { work } = await measureWork(async () => insideArm(() => runInAction(change)), { pool })
      cells.push({ action, work })
      if (action === 'click') expect(view.selectedId).toBe('group-0-issue-1')
      if (action === 'fold') expect(foldedData).toEqual([])
      if (action === 'reorder') {
        expect(desktopIds.at(-1)).toBe('group-0-issue-1')
        expect(phoneIds.at(-1)).toBe('group-0-issue-1')
      }
      if (action === 'membership') {
        expect(desktopIds).not.toContain('group-0-issue-2')
        expect(phoneIds).not.toContain('group-0-issue-2')
      }
      if (action === 'heartbeat') expect(pool.sessionObject('unrelated').lastActivity).toBe('2026-10-09T12:01:00Z')
      if (action === 'roster-heartbeat') expect(tree.sessions[0]!.id).toBe(`loose-${looseCount - 1}`)
    }
    return { domain, scale, groups, members, looseCount, visiblePrefix: 5, cells }
  } finally { for (const stop of stops) stop(); pool.dispose() }
}

it('re-measures remaining membership work at a fixed shown prefix', async () => {
  const reports = []
  for (const domain of ['members', 'groups'] as const) for (const scale of [1, 4]) reports.push(await capture(domain, scale))
  mkdirSync('.artifacts/membership', { recursive: true })
  writeFileSync('.artifacts/membership/post-cleanup.json', JSON.stringify(reports, null, 2) + '\n')
  for (const report of reports) for (const cell of report.cells)
    console.info(`[membership] ${report.domain} ${report.scale}x ${cell.action}: rows=${cell.work.rows} derivations=${cell.work.derivations} elements=${cell.work.elements}`)
  // Growth is reported, not accepted as a new baseline or hidden as an allowance.
}, 120_000)
