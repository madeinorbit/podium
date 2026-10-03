/** Pool paint retains row identity; only a changed visible row commits. */
import type { MissionProgress } from '@podium/client-core/viewmodels'
import type { MobileRowPaint } from '../lib/work-sections'
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(cleanup)

const pressCounts = vi.hoisted(() => new Map<string, number>())

vi.mock('react-native-svg', async () => {
  const { View } = await import('react-native')
  const Svg = ({ children }: { children?: React.ReactNode }) => <View>{children}</View>
  return { default: Svg, Svg, Circle: () => null }
})
vi.mock('../components/PressableScale', () => ({
  PressableScale: ({ children, accessibilityLabel }: never) => {
    const key = String((accessibilityLabel as string | undefined) ?? '?')
    pressCounts.set(key, (pressCounts.get(key) ?? 0) + 1)
    return <div data-label={key}>{children as never}</div>
  },
}))

const { WorkRow } = await import('./WorkListRow')

afterEach(() => {
  pressCounts.clear()
})

const PROG_A: MissionProgress = { total: 3, done: 1, run: 1, review: 0, stall: 0, block: 0, wait: 1 }
const PROG_B: MissionProgress = { total: 2, done: 0, run: 1, review: 0, stall: 0, block: 0, wait: 1 }
const PROG_C: MissionProgress = { total: 4, done: 2, run: 0, review: 0, stall: 0, block: 0, wait: 2 }
function paint(id: string, seq: number, label: string, progress: MissionProgress): MobileRowPaint {
  return { id, kind: 'issue', label, ref: `POD-${seq}`, color: null, internal: false, pinned: false,
    branch: null, progress, originSeq: id === 'b' ? 1 : null, statusLine: 'In progress', stamp: null,
    snoozed: false, unsnoozed: false, tuckable: false,
    display: { phase: 'queued', working: false, waitingCount: 0, decision: null, unread: false,
      draftOnly: false, fleet: { total: 0, parkedCount: 0, nativeCount: 0, tiles: [] },
      gitStamp: { kind: 'hidden', mismatch: false, merged: false, dirty: undefined, ahead: undefined } } }
}
const open = vi.fn(), longPress = vi.fn()
function List({ list }: { list: MobileRowPaint[] }) {
  return <>{list.map(paint => <WorkRow key={paint.id} paint={paint} navPending={false}
    onOpen={open} onLongPress={longPress} />)}</>
}

describe('mobile WorkRow memo (POD-4421)', () => {
  it('commits only the changed row and keeps the accepted visible titles', () => {
    const a = paint('a', 1, 'Alpha', PROG_A), b = paint('b', 2, 'Bravo', PROG_B), c = paint('c', 3, 'Charlie', PROG_C)
    const view = render(<List list={[a, b, c]} />)
    pressCounts.clear()
    view.rerender(<List list={[a, { ...b, label: 'Bravo!' }, c]} />)
    expect(pressCounts.get('POD-2 Bravo!')).toBe(1)
    expect(pressCounts.get('POD-1 Alpha') ?? 0).toBe(0)
    expect(pressCounts.get('POD-3 Charlie') ?? 0).toBe(0)
    for (const title of ['Alpha', 'Bravo!', 'Charlie']) expect(view.container.textContent).toContain(title)
  })
})
