import type { MobxPool } from '@podium/client-graph/pool'
import {
  MobileSectionsView,
  type MobileWorkRef,
  type MobileWorkSection as WorkSection,
} from '@podium/client-graph/worklist/mobile'
import { worklistGroups } from '@podium/client-graph/worklist/groups'
import { observable, runInAction } from 'mobx'
import { describe, expect, it } from 'vitest'
const source = (section: MobileWorkSection): WorkSection => ({ ...section, data: section.data.map(ref => ref.id) })

import { MobileNativeSections, MobileSearchSections, workGroupFoldKey, type MobileWorkSection } from './work-sections'

// Synthetic resident lanes; the band/fold logic under test is the actual pool
// projection. Waiting is an addressed fact, never a legacy row derivation.
type Row = { id: string; waiting: boolean }
type Group = { key: string; rows: Row[]; snoozedRows: Row[]; closedRows: Row[] }
const row = (id: string, over: { waiting?: boolean; pinned?: boolean } = {}): Row => ({
  id,
  waiting: over.waiting ?? false,
})
const group = (key: string, rows: Row[], over: Partial<Group> = {}): Group => ({
  key,
  rows,
  snoozedRows: [],
  closedRows: [],
  ...over,
})
function nativeSections(pinned: Row[], groups: Group[]) {
  const facts = new Map(
    [
      ...pinned,
      ...groups.flatMap((group) => [...group.rows, ...group.snoozedRows, ...group.closedRows]),
    ].map((row) => [row.id, row]),
  )
  // Screen views live in the pool source registry (their owner disposes
  // them): the fixture provides the same create-once seam.
  const views = new Map<string, unknown>()
  // knownIssue echoes back what the fixture files below: flat visible rows.
  const filed = new Map<
    string,
    { rank: Record<string, unknown>; placement: Record<string, unknown>; visible: boolean }
  >()
  const lane = (name: 'rows' | 'snoozedRows' | 'closedRows') => ({
    lane: (key: string) =>
      groups.find((group) => group.key === key)?.[name].map((row) => row.id) ?? [],
  })
  const pool = {
    sources: {
      view: (key: string, create: () => unknown) => {
        if (!views.has(key)) views.set(key, create())
        return views.get(key)
      },
    },
    // Screen views read known ranks, selection and worklist demand off the
    // pool; the fixture has no demand to record.
    knownIssue: (id: string) => filed.get(id),
    selection: {
      keys: (): IterableIterator<string> => [][Symbol.iterator](),
    },
    worklist: {
      need: () => {},
    },
    // The sidebar roster observes these; the fixture files nothing through
    // the kernel, so they stay empty and roster lanes resolve empty.
    clock: {
      current: 0,
      peekNow: () => 0,
      reached: () => true,
      passed: () => {},
    },
    tables: {
      session: observable.map<string, unknown>(),
      worktree: observable.map<string, unknown>(),
    },
    graph: {
      many: () => [],
      one: () => null,
    },
    groups: {
      pinnedRootIds: pinned.map((row) => row.id),
      rootOpen: lane('rows'),
      rootSnoozed: lane('snoozedRows'),
      rootClosed: lane('closedRows'),
    },
    sidebar: {
      bandKeys: () => groups.map((group) => group.key),
      band: (_state: unknown, key: string) => {
        const found = groups.find((group) => group.key === key)
        return found ? { key, label: key, worktreeIds: [] } : undefined
      },
    },
    issue: (id: string) =>
      facts.has(id)
        ? {
            issue: { finished: false },
            mobileWaitingCount: Number(facts.get(id)!.waiting),
            aggregate: {
              pending: 0,
              // Waiting is an addressed fact the product reads off
              // aggregate.railWaiting, never off mobileWaitingCount.
              ...(facts.get(id)!.waiting
                ? { railWaiting: { decisions: 1, open: 1, finished: 0 } }
                : {}),
            },
          }
        : undefined,
    row: () => undefined,
  } as unknown as MobxPool
  views.set('worklist.view', {
    selectedWasFolded: false,
    layout: {},
    knownRow: pool.issue,
    desktop: (pool as unknown as { sidebar: unknown }).sidebar,
    reference: (id: string, kind = 'issue', attention = false) => ({
      id, kind, listKey: attention ? `needs-you:${id}` : id,
    }),
  })
  // File every row into the groups view the mobile sections read: pinned to
  // the PINNED lane, open/snoozed/closed rows to their group lane with the
  // snooze band. Ranks are id-ordered; fixture rows carry no sort keys.
  const rank = (id: string, band: 0 | 1 | 2) => ({
    band,
    unkeyed: 1 as const,
    sortKey: '',
    createdMs: 0,
    seq: 0,
    id,
  })
  const file = (id: string, groupKey: string, lane: 'pinned' | 'rows' | 'snoozedRows' | 'closedRows') => {
    const placement = {
      pinned: lane === 'pinned',
      repoKey: groupKey,
      label: groupKey,
      closed: lane === 'closedRows',
      dismissed: false,
      foldMs: 0,
    }
    const rowRank = rank(id, lane === 'snoozedRows' ? 2 : 1)
    filed.set(id, { rank: rowRank as Record<string, unknown>, placement, visible: true })
    worklistGroups(pool as unknown as MobxPool).file(id, { placement, rank: rowRank })
  }
  runInAction(() => {
    for (const row of pinned) file(row.id, '', 'pinned')
    for (const group of groups) {
      for (const row of group.rows) file(row.id, group.key, 'rows')
      for (const row of group.snoozedRows) file(row.id, group.key, 'snoozedRows')
      for (const row of group.closedRows) file(row.id, group.key, 'closedRows')
    }
  })
  const sections = new MobileSectionsView(pool, {})
  ;(views.get('worklist.view') as { mobileSectionsView: MobileSectionsView }).mobileSectionsView = sections
  const value = sections.value
  return { ...value, sections: new MobileSearchSections().update(pool, value.sections, ''),
    orderingSections: new MobileSearchSections().update(pool, value.orderingSections, '') }
}
const bandKeys = (split: ReturnType<typeof nativeSections>) =>
  split.sections.map((section) => section.key)
const ids = (rows: readonly MobileWorkRef[] = []) => rows.map((row) => row.id)
const listKey = (row: MobileWorkRef) => row.listKey
const foldedSections = (
  sections: readonly MobileWorkSection[],
  collapsed: ReadonlySet<string>,
  searching: boolean,
) => new MobileNativeSections().update(sections, collapsed, searching)

describe('nativeSections', () => {
  it('puts Pinned first, above Needs you, above the project bands', () => {
    const split = nativeSections(
      [row('pin', { pinned: true })],
      [group('repo', [row('ask', { waiting: true }), row('calm')])],
    )
    expect(bandKeys(split)).toEqual(['pinned', 'needs-you', 'repo'])
    expect(ids(split.sections[0]?.data)).toEqual(['pin'])
    expect(ids(split.sections[1]?.data)).toEqual(['ask'])
    expect(ids(split.sections[2]?.data)).toEqual(['calm'])
  })

  it('shows a waiting pinned row in BOTH Pinned and Needs you, pinned asks first', () => {
    const split = nativeSections(
      [row('pin-ask', { pinned: true, waiting: true })],
      [group('repo', [row('ask', { waiting: true })])],
    )
    // It never leaves Pinned…
    expect(ids(split.sections.find((s) => s.key === 'pinned')?.data)).toEqual(['pin-ask'])
    // …and it ALSO answers "where am I needed", ahead of the group asks.
    expect(ids(split.sections.find((s) => s.key === 'needs-you')?.data)).toEqual(['pin-ask', 'ask'])
    // The subtitle's count still owns every ask ONCE, wherever it is banded.
    expect(split.attentionCount).toBe(2)
  })

  it('gives the duplicated pinned ask a distinct list key per band', () => {
    const split = nativeSections(
      [row('pin-ask', { pinned: true, waiting: true })],
      [group('repo', [row('ask', { waiting: true })])],
    )
    const keys = split.sections.flatMap((s) => s.data.map(listKey))
    // SectionList flattens its sections, so the WHOLE list must be key-unique.
    expect(new Set(keys).size).toBe(keys.length)
    // The Pinned copy keeps the canonical id; the Needs-you copy is the marked one.
    expect(keys).toContain('pin-ask')
    expect(keys).toContain('needs-you:pin-ask')
  })

  it('keeps a calm pinned row out of Needs you', () => {
    const split = nativeSections(
      [row('pin', { pinned: true })],
      [group('repo', [row('ask', { waiting: true })])],
    )
    expect(ids(split.sections.find((s) => s.key === 'needs-you')?.data)).toEqual(['ask'])
  })

  it('lifts asks out of their project band without duplicating them', () => {
    const split = nativeSections(
      [],
      [group('repo', [row('a'), row('ask', { waiting: true }), row('b')])],
    )
    expect(bandKeys(split)).toEqual(['needs-you', 'repo'])
    expect(ids(split.sections[1]?.data)).toEqual(['a', 'b'])
    const everywhere = split.sections.flatMap((s) => ids(s.data))
    expect(everywhere.filter((id) => id === 'ask')).toHaveLength(1)
  })

  it('drops the empty bands but keeps a band that is only folds', () => {
    const closed = row('done')
    const split = nativeSections(
      [],
      [group('empty', []), group('folded', [], { closedRows: [closed] })],
    )
    expect(bandKeys(split)).toEqual(['folded'])
    expect(split.sections[0]?.data).toEqual([])
    expect(split.sections[0]?.closedIds).toEqual([closed.id])
  })

  it('scopes reordering to pinned and the FULL project groups, never Needs you', () => {
    const split = nativeSections(
      [row('pin', { pinned: true })],
      [group('repo', [row('ask', { waiting: true }), row('calm')])],
    )
    expect(split.orderingSections.map((s) => s.key)).toEqual(['pinned', 'repo'])
    // The ordering copy of the project keeps the lifted ask: sortKey patches
    // only mean anything against the scope's complete row set [POD-168].
    expect(ids(split.orderingSections[1]?.data)).toEqual(['ask', 'calm'])
  })

  it('counts issues, pinned rows and asks over the whole open set', () => {
    const split = nativeSections(
      [row('pin', { pinned: true, waiting: true })],
      [group('repo', [row('ask', { waiting: true }), row('calm')])],
    )
    expect(split.issueCount).toBe(3)
    expect(split.pinnedCount).toBe(1)
    expect(split.attentionCount).toBe(2)
    // The band header's count survives folding via `total`. Needs-you counts
    // the pinned ask's second rendering: the header states what the band shows.
    expect(split.sections.map((s) => [s.key, s.total])).toEqual([
      ['pinned', 1],
      ['needs-you', 2],
      ['repo', 1],
    ])
  })
})

describe('foldedSections', () => {
  const split = nativeSections(
    [row('pin', { pinned: true })],
    [
      group('repo', [row('ask', { waiting: true }), row('calm')], {
        closedRows: [row('done')],
      }),
    ],
  )

  it('empties a collapsed band — rows AND its Snoozed/Closed folds — but keeps the count', () => {
    const folded = foldedSections(split.sections, new Set(['repo']), false)
    const repo = folded.find((s) => s.key === 'repo')
    expect(repo?.data).toEqual([])
    expect(repo?.closedIds).toEqual([])
    expect(repo?.total).toBe(1)
    // Untouched bands keep their rows.
    expect(ids(folded.find((s) => s.key === 'needs-you')?.data)).toEqual(['ask'])
  })

  it('ignores every fold while a search is active, so a match can never hide', () => {
    const folded = foldedSections(split.sections, new Set(['repo', 'pinned']), true)
    expect(ids(folded.find((s) => s.key === 'repo')?.data)).toEqual(['calm'])
    expect(ids(folded.find((s) => s.key === 'pinned')?.data)).toEqual(['pin'])
  })
})

describe('workGroupFoldKey', () => {
  it('stays inside the replicated podium:sidebar: namespace — an invented one throws in ui-state', () => {
    expect(workGroupFoldKey('needs-you')).toBe('podium:sidebar:work-group-fold:needs-you')
  })
})

describe('MobileSearchSections', () => {
  const worktree = (id: string, label: string) => ({
    id,
    kind: 'worktree',
    label,
    branch: null,
    sessions: [],
    activityAt: 0,
    timing: { phase: 'idle', sinceMs: 0 },
    fleet: { total: 0, parkedCount: 0, nativeCount: 0, tiles: [] },
  })
  const rows = new Map([
    ['a', worktree('a', 'alpha')],
    ['b', worktree('b', 'beta')],
  ])
  const pool = () =>
    ({
      clock: { current: 0, reached: () => true, passed: () => {} },
      inputs: { reached: () => true, passed: () => {} },
      selection: {
        keys: (): IterableIterator<string> => [][Symbol.iterator](),
        size: 0,
      },
      tables: { worktree: new Map([...rows.keys()].map(id => [id, {}])) },
      queries: { localTextIds: () => new Set<string>() },
      // Worktree labels resolve through the sidebar view now: lane rows by
      // path plus a session roster per lane. The seat id only opens the
      // roster gate; it resolves to no session and contributes nothing.
      row: (entity: string, id: string) => {
        if (entity !== 'worktree') return undefined
        const row = rows.get(id)
        return row === undefined
          ? undefined
          : { repoName: row.label, repoPath: `/${row.id}`, branch: row.branch }
      },
      model: (entity: string) =>
        entity === 'worktree' ? { roster: { ids: ['search-seat'], pending: 0 } } : undefined,
      sources: {
        view: (() => {
          const views = new Map<string, unknown>([['worklist.view', {
            mobileRow: ({ id }: { id: string }) => { const row = rows.get(id); return row ? { ...row, title: row.label } : undefined },
          }]])
          return (key: string, create: () => unknown) => {
            if (!views.has(key)) views.set(key, create())
            return views.get(key)
          }
        })(),
      },
    }) as unknown as MobxPool
  const band: MobileWorkSection = {
    key: 'project:/r',
    label: 'r',
    kind: 'project',
    total: 2,
    data: [
      { id: 'a', kind: 'worktree', listKey: 'a' },
      { id: 'b', kind: 'worktree', listKey: 'b' },
    ] as unknown as MobileWorkSection['data'],
    snoozedIds: [],
    closedIds: [],
    foldKey: 'fold:/r',
    collapsed: false,
  }

  it('keeps an unchanged match, and drops its bands when the search ends or the pool changes', () => {
    const cache = new MobileSearchSections()
    const graph = pool()
    const first = cache.update(graph, [source(band)], 'alpha')
    expect(first.map((section) => section.data.map((ref) => ref.id))).toEqual([['a']])
    expect(cache.update(graph, [source(band)], 'alpha')[0]).toBe(first[0])

    expect(cache.update(graph, [source(band)], '')).toEqual([band])
    const restarted = cache.update(graph, [source(band)], 'alpha')[0]
    expect(restarted).not.toBe(first[0])
    expect(restarted?.data.map((ref) => ref.id)).toEqual(['a'])

    expect(cache.update(pool(), [source(band)], 'alpha')[0]).not.toBe(restarted)
  })

  it('matches one shared id-set pass with zero issue row reads, flat at 1x/4x', () => {
    // The legacy arm painted every candidate: one mobileWork.row + paint per
    // row across data, snoozed and closed per keystroke (S+I → 4(S+I)). It
    // reads every issue here and fails the zero-issue-reads assertion below.
    const cells: {
      scale: number
      issues: number
      textPasses: number
      issueRows: number
      treeRows: number
    }[] = []
    for (const scale of [1, 4]) {
      const issueCount = 300 * scale
      const titles = new Map<string, string>()
      for (let at = 0; at < issueCount; at++) {
        titles.set(`issue-${at}`, at === 71 ? 'unique phone target' : `routine task ${at}`)
      }
      // Snoozed/closed lanes scale with the corpus; worktrees do not.
      const snoozed = Array.from({ length: 25 * scale }, (_, at) => `issue-snoozed-${at}`)
      for (const id of snoozed) titles.set(id, `snoozed routine ${id}`)
      const closed = Array.from({ length: 25 * scale }, (_, at) => `issue-closed-${at}`)
      for (const id of closed) titles.set(id, `closed routine ${id}`)
      const trees = [
        { id: 'tree-a', label: 'phone · feature-a' },
        { id: 'tree-b', label: 'phone · feature-b' },
      ]
      const calls = { textPasses: 0, issueRows: 0, treeRows: 0 }
      const graph = {
        clock: { current: 0, reached: () => {} },
        selection: {
          keys: (): IterableIterator<string> => [][Symbol.iterator](),
          size: 0,
        },
        // Worktree labels resolve through the sidebar view now, so the
        // bounded reads are pool.row calls: one per worktree ref, never an
        // issue row. This fixture has no shared worktree model to paint.
        row: (entity: string, id: string) => {
          if (entity === 'issue') {
            calls.issueRows++
            return undefined
          }
          if (entity !== 'worktree') return undefined
          calls.treeRows++
          const tree = trees.find((t) => t.id === id)
          return tree === undefined
            ? undefined
            : { repoName: tree.label, repoPath: `/${tree.id}`, branch: null }
        },
        model: () => undefined,
        sources: {
          view: (() => {
            const views = new Map<string, unknown>()
            return (key: string, create: () => unknown) => {
              if (!views.has(key)) views.set(key, create())
              return views.get(key)
            }
          })(),
        },
        tables: { worktree: new Map(trees.map(tree => [tree.id, {}])) },
        queries: {
          localTextIds: (needle: string) => {
            calls.textPasses++
            const n = needle.trim().toLowerCase()
            const out = new Set<string>()
            for (const [id, title] of titles) if (title.includes(n)) out.add(id)
            return out
          },
        },
      } as unknown as MobxPool
      const section: MobileWorkSection = {
        key: 'project:/r',
        label: 'r',
        kind: 'project',
        total: issueCount + trees.length,
        data: [
          ...[...titles.keys()]
            .filter((id) => !id.startsWith('issue-snoozed-') && !id.startsWith('issue-closed-'))
            .map((id) => ({ id, kind: 'issue', listKey: id })),
          ...trees.map((t) => ({ id: t.id, kind: 'worktree', listKey: t.id })),
        ] as unknown as MobileWorkSection['data'],
        snoozedIds: snoozed,
        closedIds: closed,
        foldKey: 'fold:/r',
        collapsed: false,
      }
      const found = new MobileSearchSections().update(graph, [source(section)], 'unique phone target')
      expect(found.map((s) => s.data.map((ref) => ref.id))).toEqual([[`issue-71`]])
      expect(found[0]?.snoozedIds).toEqual([])
      expect(found[0]?.closedIds).toEqual([])
      // One shared title/ref pass per keystroke, not one pass per band/lane.
      expect(calls.textPasses).toBe(1)
      // No issue row is read or painted while matching — matched or not.
      expect(calls.issueRows).toBe(0)
      // One readiness read per missing worktree model, independent of the
      // issue corpus. A missing model does not request a second row copy.
      expect(calls.treeRows).toBe(trees.length)
      cells.push({
        scale,
        issues: issueCount + snoozed.length + closed.length,
        textPasses: calls.textPasses,
        issueRows: calls.issueRows,
        treeRows: calls.treeRows,
      })
    }
    const [oneX, fourX] = cells
    expect(fourX?.issues).toBe((oneX?.issues ?? 0) * 4)
    expect(fourX?.textPasses).toBe(oneX?.textPasses)
    expect(fourX?.issueRows).toBe(0)
    expect(fourX?.treeRows).toBe(oneX?.treeRows)
  })
})
