/**
 * MOBILE ROW-LEVEL RENDER COUNTS (POD-4421).
 *
 * The phone's `WorkRow` was memo'd but received the whole
 * `issues`/`sessions`/`allWorktreePaths` arrays plus `now` — in its own
 * author's words, "a snapshot tick still repaints everything (its arrays and
 * `now` are new)". It now receives its row object (stable across publishes
 * via `reuseUnifiedWorkRows`) plus narrow scalars, behind the same `memo`.
 *
 * This probe counts `PressableScale` renders per row (the row's main press
 * surface renders exactly once per row render, inside the memo boundary)
 * across an unrelated publish — row B changes while A and C keep their
 * object identities:
 *
 *   FIXED arm (stable row refs + stable callbacks): only B commits.
 *   LEGACY arm (the pre-fix data flow — all-new row identities + fresh
 *   closures, as every snapshot tick produced): A and C commit too, so it
 *   FAILS the fixed assertion.
 *
 * The control dimension is the visible output: both arms must render
 * byte-identical text after the publish.
 */
import type {
  IssueNavigationModel,
  MissionProgress,
  UnifiedWorkRow,
} from '@podium/client-core/viewmodels'
import { rowStatusLine } from '@podium/client-core/viewmodels'
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(cleanup)

const pressCounts = vi.hoisted(() => new Map<string, number>())

vi.mock('expo-router', () => ({
  useRouter: () => ({ push: vi.fn(), back: vi.fn(), replace: vi.fn() }),
  useFocusEffect: vi.fn(),
  usePathname: () => '/work',
  Stack: { SearchBar: () => null },
}))
vi.mock('expo-haptics', () => ({
  ImpactFeedbackStyle: { Light: 'light' },
  NotificationFeedbackType: { Success: 'success', Error: 'error' },
  impactAsync: vi.fn(async () => {}),
  notificationAsync: vi.fn(async () => {}),
}))
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 20, right: 0, bottom: 34, left: 0 }),
}))
vi.mock('react-native-svg', async () => {
  const { View } = await import('react-native')
  const Svg = ({ children }: { children?: React.ReactNode }) => <View>{children}</View>
  return { default: Svg, Svg, Circle: () => null }
})
vi.mock('expo-blur', async () => {
  const { View } = await import('react-native')
  return { BlurView: (props: object) => <View {...props} /> }
})
vi.mock('expo-linear-gradient', () => ({
  LinearGradient: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
}))
vi.mock('../hooks/useReduceMotion', () => ({ useReduceMotion: () => true }))
vi.mock('../hooks/useContentBottomInset', () => ({ useContentBottomInset: () => 72 }))
vi.mock('../client/hooks', () => ({
  useBooting: () => false,
  useIssues: () => [],
  useSessions: () => [],
  useStoreActions: () => ({ markIssueRead: vi.fn(), setIssueTucked: vi.fn() }),
}))
vi.mock('../components/PressableScale', () => ({
  PressableScale: ({ children, accessibilityLabel }: never) => {
    const key = String((accessibilityLabel as string | undefined) ?? '?')
    pressCounts.set(key, (pressCounts.get(key) ?? 0) + 1)
    return <div data-label={key}>{children as never}</div>
  },
}))

const { WorkRow } = await import('./WorkScreen')

afterEach(() => {
  pressCounts.clear()
})

const NOW = Date.parse('2026-08-12T12:00:00.000Z')

function issue(id: string, seq: number, title: string, over: Record<string, unknown> = {}) {
  return {
    id,
    repoPath: '/r',
    seq,
    displayRef: `POD-${seq}`,
    title,
    description: '',
    stage: 'in_progress',
    priority: 2,
    type: 'task',
    audience: 'human',
    origin: 'human',
    draft: false,
    archived: false,
    labels: [],
    deps: [],
    dependents: [],
    blockedByNotes: [],
    ready: true,
    blocked: false,
    deferred: false,
    pinned: false,
    needsHuman: false,
    unread: false,
    childCount: 0,
    childDoneCount: 0,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    ...over,
  } as unknown as IssueNavigationModel
}

const PROG_A: MissionProgress = { total: 3, done: 1, run: 1, review: 0, stall: 0, block: 0, wait: 1 }
const PROG_B: MissionProgress = { total: 2, done: 0, run: 1, review: 0, stall: 0, block: 0, wait: 1 }
const PROG_C: MissionProgress = { total: 4, done: 2, run: 0, review: 0, stall: 0, block: 0, wait: 2 }

function rows() {
  const a: UnifiedWorkRow = {
    kind: 'issue',
    issue: issue('a', 1, 'Alpha'),
    sessions: [],
    activityAt: 1,
    missionRollup: { progress: PROG_A, fromChildren: false },
  }
  const b: UnifiedWorkRow = {
    kind: 'issue',
    issue: issue('b', 2, 'Bravo', { deps: [{ id: 'a', type: 'discovered-from' }] }),
    sessions: [],
    activityAt: 2,
    missionRollup: { progress: PROG_B, fromChildren: false },
  }
  const c: UnifiedWorkRow = {
    kind: 'issue',
    issue: issue('c', 3, 'Charlie'),
    sessions: [],
    activityAt: 3,
    missionRollup: { progress: PROG_C, fromChildren: false },
  }
  return { a, b, c }
}

const statusOf = (row: UnifiedWorkRow): string => rowStatusLine(row, NOW, 0)

const stableOpen = vi.fn()
const stableOpenSession = vi.fn()
const stableLongPress = vi.fn()

/** Fixed data flow: stable refs for unchanged rows, stable callbacks. */
function FixedList({ list }: { list: UnifiedWorkRow[] }) {
  return (
    <>
      {list.map((row) => {
        const id = row.kind === 'issue' ? row.issue.id : 'wt'
        return (
          <WorkRow
            key={id}
            row={row}
            label={row.kind === 'issue' ? row.issue.title : ''}
            progress={
              (id === 'a' ? PROG_A : id === 'b' ? PROG_B : PROG_C) as MissionProgress
            }
            originSeq={id === 'b' ? 1 : null}
            statusLine={statusOf(row)}
            stamp={null}
            snoozed={false}
            unsnoozed={false}
            onTuck={undefined}
            navPending={false}
            onOpenIssue={stableOpen}
            onOpenSession={stableOpenSession}
            onLongPress={stableLongPress}
          />
        )
      })}
    </>
  )
}

/** Legacy data flow: all-new row identities and fresh closures per publish. */
function LegacyList({ list }: { list: UnifiedWorkRow[] }) {
  return (
    <>
      {list.map((row) => {
        const id = row.kind === 'issue' ? row.issue.id : 'wt'
        return (
          <WorkRow
            key={id}
            row={{ ...row } as UnifiedWorkRow}
            label={row.kind === 'issue' ? row.issue.title : ''}
            progress={{ ...(id === 'a' ? PROG_A : id === 'b' ? PROG_B : PROG_C) }}
            originSeq={id === 'b' ? 1 : null}
            statusLine={statusOf(row)}
            stamp={null}
            snoozed={false}
            unsnoozed={false}
            onTuck={undefined}
            navPending={false}
            onOpenIssue={(i) => void i}
            onOpenSession={(sid, key) => void [sid, key]}
            onLongPress={(i) => void i}
          />
        )
      })}
    </>
  )
}

describe('mobile WorkRow memo (POD-4421)', () => {
  it('commits only the changed row on an unrelated publish; legacy repaints all', () => {
    // ---- LEGACY arm ----
    const first = rows()
    const legacy = render(<LegacyList list={[first.a, first.b, first.c]} />)
    pressCounts.clear()
    const second = rows()
    const b2: UnifiedWorkRow = {
      ...second.b,
      issue: issue('b', 2, 'Bravo!'),
      activityAt: 4,
    }
    legacy.rerender(<LegacyList list={[{ ...second.a }, b2, { ...second.c }]} />)
    const legacyAfter = new Map(pressCounts)
    const legacyText = legacy.container.textContent ?? ''
    legacy.unmount()

    // The control must FAIL the new assertion: unchanged rows committed.
    expect(legacyAfter.get('POD-1 Alpha')).toBeGreaterThan(0)
    expect(legacyAfter.get('POD-3 Charlie')).toBeGreaterThan(0)

    // ---- FIXED arm ----
    pressCounts.clear()
    const f1 = rows()
    const fixed = render(<FixedList list={[f1.a, f1.b, f1.c]} />)
    pressCounts.clear()
    const f2b: UnifiedWorkRow = { ...f1.b, issue: issue('b', 2, 'Bravo!'), activityAt: 4 }
    fixed.rerender(<FixedList list={[f1.a, f2b, f1.c]} />)
    const fixedAfter = new Map(pressCounts)
    const fixedText = fixed.container.textContent ?? ''
    fixed.unmount()

    // Only the changed row committed.
    expect(fixedAfter.get('POD-2 Bravo!')).toBe(1)
    expect(fixedAfter.get('POD-1 Alpha') ?? 0).toBe(0)
    expect(fixedAfter.get('POD-3 Charlie') ?? 0).toBe(0)

    // Control dimension: identical visible output in both arms.
    expect(fixedText).toBe(legacyText)
    for (const title of ['Alpha', 'Bravo!', 'Charlie']) {
      expect(fixedText).toContain(title)
    }
  })
})
