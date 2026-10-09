import { mkdirSync, writeFileSync } from 'node:fs'
import { MobxPool } from '@podium/client-graph/pool'
import { requireHere } from '@podium/client-graph/lookup'
import { GroupNodeBefore } from '@podium/client-graph/worklist/groups-membership-before.test-helper'
import { worklistGroups } from '@podium/client-graph/worklist/groups'
import { MobileSectionsBefore } from '@podium/client-graph/worklist/mobile-before.test-helper'
import { LOADING } from '@podium/client-graph/worklist/rollup'
import { WorklistIssueBefore } from '@podium/client-graph/worklist/issue-before.test-helper'
import { worktreeBefore } from '@podium/client-graph/worklist/heartbeat-before.test-helper'
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

async function capture(domain: 'members' | 'groups', scale: number, proveParity = false) {
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
  const tree = view.tree(requireHere(pool.model('worktree', '/loose')))
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
  const parity = () => {
    const band = view.sections().bands.find(band => band.key === 'repo-0')!
    const oldGroup = new GroupNodeBefore('repo-0', worklistGroups(pool) as never)
    const old = oldGroup.sidebarRows
    for (const key of ['rowIds', 'snoozedIds', 'closedIds'] as const)
      expect.soft(process.env.POD5631_MUTATE === '1' ? ['wrong'] : [...band[key]], key).toEqual([...old[key]])
    const oldPhone = new MobileSectionsBefore(pool, {}).value.get()
    const sections = view.mobileSections()
    expect.soft(sections.sectionKeys).toEqual(oldPhone.sections.map(section => section.key))
    for (const section of oldPhone.orderingSections) {
      const row = sections.section(section.key)
      expect.soft(process.env.POD5631_MUTATE === '1' ? ['wrong'] : [...row.allIds], `phone ${section.key}`)
        .toEqual(section.data.map(ref => ref.id))
    }
    const oldTree = worktreeBefore(pool, '/loose')!
    for (const field of ['sessions', 'visible', 'stale'] as const)
      expect.soft(process.env.POD5631_MUTATE === '1' ? ['wrong'] : tree[field].map(row => row.id), field)
        .toEqual(oldTree[field].map(row => row.sessionId))
  }
  try {
    if (proveParity) parity()
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
      if (proveParity) parity()
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
  const first = reports.find(report => report.domain === 'members' && report.scale === 1)!
  const fourth = reports.find(report => report.domain === 'members' && report.scale === 4)!
  for (const [index, cell] of first.cells.entries()) for (const counter of ['rows', 'derivations', 'elements', 'visits'] as const)
    expect(fourth.cells[index]!.work[counter], `${cell.action}: ${counter}`).toBeLessThanOrEqual(cell.work[counter]!)
}, 120_000)

it('matches frozen membership and order before and after every action', async () => {
  for (const domain of ['members', 'groups'] as const) for (const scale of [1, 4]) await capture(domain, scale, true)
}, 120_000)

for (const [action, mechanism] of [
  ['reorder', 'GroupNode.sidebarRows'],
  ['reorder', 'MobileSection.allIds'],
  ['reorder', 'MobileSection.attentionIds'],
  ['reorder', 'MobileSection.liveIds'],
  ['roster-heartbeat', 'WorklistWorktree@/loose.visible'],
  ['roster-heartbeat', 'WorklistWorktree@/loose.waitingCount'],
] as const) {
  it(`keeps ${mechanism} flat on ${action}`, async () => {
    const first = await capture('members', 1), fourth = await capture('members', 4)
    const count = (report: Awaited<ReturnType<typeof capture>>) => {
      const cell = report.cells.find(cell => cell.action === action)!
      return Object.entries(cell.work.elementsBy).reduce((total, [name, value]) => {
        // Include replacement query/subset work, so removing a getter's name
        // cannot make its former walk disappear from this counter.
        const replacement = mechanism.startsWith('GroupNode.') ? /GroupNode\.sidebar|pool\.groups\.root/.test(name)
          : mechanism.startsWith('MobileSection.') ? /MobileSection\.|worklist\.phone|membership.phone-native/.test(name)
          : /worklist\.worktree@\/loose|WorklistWorktree@\/loose/.test(name)
        return total + (replacement || name === mechanism || name.endsWith(`/${mechanism}`) ? value : 0)
      }, 0)
    }
    console.info(`[membership counter] ${mechanism}: ${count(first)}→${count(fourth)}`)
    expect(count(fourth), mechanism).toBeLessThanOrEqual(count(first))
  })
}

it('an unrelated heartbeat runs no section projection or session order query', async () => {
  for (const scale of [1, 4]) {
    const report = await capture('members', scale)
    const work = report.cells.find(cell => cell.action === 'heartbeat')!.work
    const sections = Object.entries(work.derivationsBy).filter(([name]) =>
      /MobileSection|MobileSectionsView|GroupNode|pool\.sidebar|worklist\.phone|worklist\.worktree/.test(name))
    expect(sections).toEqual([])
  }
})

it('matches folded and cold membership without mounting their row bodies', () => {
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: now }, undefined, {
    load: () => undefined, schedule: () => () => {},
  })
  const cold = issue(0, 99, { stage: 'done', updatedAt: '2026-01-01T00:00:00Z', closedAt: '2026-01-01T00:00:00Z' })
  pool.apply({ type: 'replace', rows: [
    { kind: 'issue', id: cold.id, value: cold },
    { kind: 'issue', id: 'group-0-issue-0', value: issue(0, 0) },
    { kind: 'issue', id: 'group-0-issue-1', value: issue(0, 1, { stage: 'done', closedReason: 'done', closedAt: stamp, tuckedAt: stamp }) },
    { kind: 'issue', id: 'group-0-issue-2', value: issue(0, 2, { deferUntil: '2026-10-20T00:00:00Z' }) },
  ] })
  const view = worklistView(pool), row = view.row(pool.issueObject(cold.id))
  const stop = autorun(() => { void view.sections(); void view.mobileSections().sectionKeys })
  try {
    expect(row.ready).toBe(LOADING)
    expect(new WorklistIssueBefore(row.issue, view).mobile).toBe(LOADING)
    expect(pool.tables.issue.has(cold.id)).toBe(false)
    for (const searching of [false, true]) {
      view.setLayout({ searching, collapsed: { 'podium:sidebar:work-group-fold:repo-0': true,
        'podium:sidebar:project-fold:repo-0': true } } as never)
      const band = view.sections().bands.find(band => band.key === 'repo-0')!
      const oldGroup = new GroupNodeBefore('repo-0', worklistGroups(pool) as never).sidebarRows
      for (const field of ['rowIds', 'snoozedIds', 'closedIds'] as const)
        expect(process.env.POD5631_MUTATE === '1' ? ['wrong'] : [...band[field]]).toEqual([...oldGroup[field]])
      const oldPhone = new MobileSectionsBefore(pool, { ...view.layout, searching }).value.get()
      const sections = view.mobileSections()
      expect(sections.sectionKeys).toEqual(oldPhone.sections.map(section => section.key))
      for (const oldSection of oldPhone.sections) {
        const section = sections.section(oldSection.key)
        expect(process.env.POD5631_MUTATE === '1' ? ['wrong'] : [...section.data]).toEqual(oldSection.data.map(ref => ref.id))
      }
      expect(view.mobileRow({ id: cold.id, kind: 'issue' })).toBe(LOADING)
      expect(pool.tables.issue.has(cold.id)).toBe(false)
    }
  } finally { stop(); pool.dispose() }
})


it('phone membership omits pending and gone worktrees and counts only pending issues', () => {
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: now }, undefined, {
    load: () => undefined, schedule: () => () => {},
    exitKind: (_entity, id) => id === 'removed' ? 'removed' : undefined,
  })
  const sections = worklistView(pool).mobileSections()
  try {
    expect(sections.sectionAsking('removed', true)).toBe(false)
    expect(sections.pendingFor('removed', false)).toBe(0)
    expect(pool.hydrate()).toBe(0)
    expect(sections.sectionAsking('unknown', true)).toBe(false)
    expect(sections.pendingFor('unknown', false)).toBe(1)
    pool.hydrate()
    expect(sections.sectionAsking('unknown', true)).toBe(false)
    expect(sections.pendingFor('unknown', false)).toBe(0)
  } finally { pool.dispose() }
})
