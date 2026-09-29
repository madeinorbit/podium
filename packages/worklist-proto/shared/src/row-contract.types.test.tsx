// @vitest-environment happy-dom
/**
 * POD-4547 (L1b) — the capability rule, proved at compile time and at run time.
 *
 * COMPILE TIME. Every `// @ts-expect-error` below is a negative control: if the
 * contract ever stops rejecting that component, the directive is unused and
 * `bun run typecheck -- --filter @podium/worklist-proto` fails. The positive
 * controls (plain function, `memo`, MobX `observer`) must keep compiling.
 * The two shapes planted in round two's K exercises (a row with a `store`
 * prop — the deleted round-two row took `{ model, store }`) are the
 * first negatives.
 *
 * RUN TIME. `RowShell` renders the component with exactly `{ row }`, counts
 * its commits under the harness log, and throws when component identity
 * changes between renders (the inline-closure channel).
 *
 * LIVE ROWS (POD-4756). A pool may hand the shell a live object that
 * implements `RowView` (the MobX arm's issue) instead of a plain view; the
 * row is then an `observer` that redraws itself on a field it reads. The
 * shell's counter sees that commit too, exactly per row: a field change
 * commits its own row, a sibling's commits nothing, and a change the row
 * does not read commits nothing.
 */
import { act, memo, type ReactElement } from 'react'
import { createRoot } from 'react-dom/client'
import { observable, runInAction } from 'mobx'
import { observer } from 'mobx-react-lite'
import { describe, expect, it } from 'vitest'
import {
  CommitLogContext,
  createCommitLog,
  RowActionsContext,
  RowShell,
  useRowActions,
  type RowActions,
  type RowComponent,
  type RowProps,
} from './row-shell'
import type { RowView } from './row-view'
import type { SliceIssue, SliceSession } from './slice-types'

// A stand-in for any substrate's store handle.
interface StoreHandle {
  issues: Map<string, SliceIssue>
  sessions: Map<string, SliceSession>
}

const row: RowView = {
  id: 'A',
  displayRef: 'POD-10',
  title: 'First',
  phase: 'working',
  progressDone: 0,
  progressTotal: 1,
  working: true,
  asking: false,
  band: 1,
  repoKey: 'r1',
  closed: false,
  selected: false,
  originTick: { id: 'O', seq: 3, title: 'Origin', ref: 'POD-3' },
  activityAt: 0,
  workingSince: null,
  pinned: false,
  sortKey: 'a0',
  createdAt: '2026-09-18T09:00:00Z',
  seq: 10,
  foldAt: '2026-09-18T09:00:00Z',
  dismissed: false,
}

// ---------------------------------------------------------------------------
// Positive controls: these are row components.
// ---------------------------------------------------------------------------

function PlainRow({ row }: RowProps): ReactElement {
  return <span data-row={row.id}>{`${row.displayRef} ${row.title}${row.originTick ? ` ⤷${row.originTick.ref}` : ''}`}</span>
}
const MemoRow = memo(PlainRow)
const ObserverRow = observer(PlainRow)
const _asAlias: RowComponent = PlainRow

// ---------------------------------------------------------------------------
// Negative controls: none of these may compile against RowShell.
// ---------------------------------------------------------------------------

// The round-two F shape: the row holds the store.
function StoreRow({ row, store }: { row: RowView; store: StoreHandle }): ReactElement {
  let n = 0
  for (const _ of store.issues.values()) n += 1
  return <span>{`${row.id} ${n}`}</span>
}
// The same, optional — "only when the arm passes it" is still a store channel.
function OptionalStoreRow({ row, store }: { row: RowView; store?: StoreHandle }): ReactElement {
  return <span>{`${row.id} ${store?.issues.size ?? 0}`}</span>
}
// Whole-array props (methodology §6.1).
function ArrayRow({ row, sessions }: { row: RowView; sessions: SliceSession[] }): ReactElement {
  return <span>{`${row.id} ${sessions.length}`}</span>
}
// A callback prop: callbacks come from RowActionsContext, never props.
function CallbackRow({ row, onSelect }: { row: RowView; onSelect: (id: string) => void }): ReactElement {
  return <button type="button" onClick={() => onSelect(row.id)} />
}
// A row wider than RowView: it would read fields the view does not carry.
function WideRow({ row }: { row: RowView & { sessions: SliceSession[] } }): ReactElement {
  return <span>{`${row.id} ${row.sessions.length}`}</span>
}
// No row at all: the component takes the store instead.
function StoreOnlyRow({ store }: { store: StoreHandle }): ReactElement {
  return <span>{store.issues.size}</span>
}

export function compileTimeControls(store: StoreHandle): ReactElement[] {
  return [
    <RowShell key="plain" row={row} component={PlainRow} />,
    <RowShell key="memo" row={row} component={MemoRow} />,
    <RowShell key="observer" row={row} component={ObserverRow} />,
    <RowShell key="alias" row={row} component={_asAlias} />,
    // @ts-expect-error — a row component may not take a store handle.
    <RowShell key="store" row={row} component={StoreRow} />,
    // @ts-expect-error — not even an optional one.
    <RowShell key="optional-store" row={row} component={OptionalStoreRow} />,
    // @ts-expect-error — nor a memo-wrapped one.
    <RowShell key="memo-store" row={row} component={memo(StoreRow)} />,
    // @ts-expect-error — nor an entity array.
    <RowShell key="array" row={row} component={ArrayRow} />,
    // @ts-expect-error — nor a callback prop.
    <RowShell key="callback" row={row} component={CallbackRow} />,
    // @ts-expect-error — nor a row wider than RowView.
    <RowShell key="wide" row={row} component={WideRow} />,
    // @ts-expect-error — nor no row at all.
    <RowShell key="store-only" row={row} component={StoreOnlyRow} />,
    // @ts-expect-error — the shell itself takes no store prop to forward.
    <RowShell key="shell-store" row={row} component={PlainRow} store={store} />,
    // @ts-expect-error — and no children to smuggle a subtree through.
    <RowShell key="shell-children" row={row} component={PlainRow}>
      <StoreRow row={row} store={store} />
    </RowShell>,
  ]
}

// RowView carries no arrays and no store-shaped fields. A field whose type is
// an array, a Map/Set or a function makes this `true` and fails typecheck
// (`-?`: an optional field is checked too, not read as `undefined`).
type Leaky<T> = T extends readonly unknown[] | ReadonlyMap<unknown, unknown> | ReadonlySet<unknown> | ((...args: never[]) => unknown)
  ? true
  : false
type LeakyFields = { [K in keyof RowView]-?: Leaky<RowView[K]> extends false ? never : K }[keyof RowView]
const _noLeakyFields: [LeakyFields] extends [never] ? true : never = true

// ---------------------------------------------------------------------------
// Run time.
// ---------------------------------------------------------------------------

function mount(): { el: HTMLDivElement; root: ReturnType<typeof createRoot> } {
  const el = document.createElement('div')
  return { el, root: createRoot(el) }
}

describe('RowShell capability rule', () => {
  it('keeps the compile-time controls referenced', () => {
    expect(typeof compileTimeControls).toBe('function')
    expect(_noLeakyFields).toBe(true)
  })

  it('renders the component with exactly { row }', async () => {
    const seen: string[][] = []
    function SpyRow(props: RowProps): ReactElement {
      seen.push(Object.keys(props))
      return <PlainRow row={props.row} />
    }
    const { el, root } = mount()
    await act(async () => root.render(<RowShell row={row} component={SpyRow} />))
    expect(el.textContent).toBe('POD-10 First ⤷POD-3')
    expect(seen.at(-1)).toEqual(['row'])
    await act(async () => root.unmount())
  })

  it('counts non-mount commits per row id under the harness log', async () => {
    const log = createCommitLog()
    const { root } = mount()
    const tree = (r: RowView) => (
      <CommitLogContext.Provider value={log}>
        <RowShell row={r} component={MemoRow} />
      </CommitLogContext.Provider>
    )
    await act(async () => root.render(tree(row)))
    expect(log.total()).toBe(0)
    await act(async () => root.render(tree({ ...row, title: 'Renamed' })))
    expect(Object.fromEntries(log.counts)).toEqual({ A: 1 })
    await act(async () => root.unmount())
  })

  it('counts a live row object exactly: its own field change commits it, a sibling or an unread change nothing', async () => {
    // Two live rows (observable objects implementing RowView, plus a member
    // the row does not read), each drawn by an observer row through the shell.
    const a = observable({ ...row, id: 'A', unshown: 0 })
    const b = observable({ ...row, id: 'B', unshown: 0 })
    const log = createCommitLog()
    const { el, root } = mount()
    await act(async () =>
      root.render(
        <CommitLogContext.Provider value={log}>
          <RowShell row={a} component={ObserverRow} />
          <RowShell row={b} component={ObserverRow} />
        </CommitLogContext.Provider>,
      ),
    )
    expect(log.total()).toBe(0)
    await act(async () => runInAction(() => (a.title = 'Renamed')))
    expect(Object.fromEntries(log.counts)).toEqual({ A: 1 })
    expect(el.textContent).toContain('POD-10 Renamed')
    log.reset()
    await act(async () => runInAction(() => (b.title = 'Sibling renamed')))
    expect(Object.fromEntries(log.counts)).toEqual({ B: 1 })
    log.reset()
    await act(async () => runInAction(() => (a.unshown += 1)))
    expect(log.total()).toBe(0)
    await act(async () => root.unmount())
  })

  it('throws when the component identity changes (inline closure over a store)', async () => {
    const store: StoreHandle = { issues: new Map(), sessions: new Map() }
    const { root } = mount()
    const errors: unknown[] = []
    const onError = (e: ErrorEvent) => {
      errors.push(e.error)
      e.preventDefault()
    }
    window.addEventListener('error', onError)
    const render = () =>
      root.render(
        <RowShell row={row} component={({ row: r }: RowProps) => <StoreRow row={r} store={store} />} />,
      )
    try {
      await act(async () => render())
      await expect(act(async () => render())).rejects.toThrow(/component identity changed/)
    } finally {
      window.removeEventListener('error', onError)
      await act(async () => root.unmount())
    }
  })

  it('delivers stable callbacks through RowActionsContext, not props', async () => {
    const clicked: string[] = []
    const actions: RowActions = { select: (id) => clicked.push(id) }
    function ClickRow({ row }: RowProps): ReactElement {
      const { select } = useRowActions()
      return (
        <button type="button" onClick={() => select(row.id)}>
          {row.displayRef}
        </button>
      )
    }
    const { el, root } = mount()
    await act(async () =>
      root.render(
        <RowActionsContext.Provider value={actions}>
          <RowShell row={row} component={ClickRow} />
        </RowActionsContext.Provider>,
      ),
    )
    await act(async () => el.querySelector('button')?.click())
    expect(clicked).toEqual(['A'])
    await act(async () => root.unmount())
  })

  it('useRowActions throws outside a provider instead of silently no-oping', () => {
    function Bare({ row }: RowProps): ReactElement {
      useRowActions()
      return <span>{row.id}</span>
    }
    const { root } = mount()
    expect(() => act(() => root.render(<RowShell row={row} component={Bare} />))).toThrow(/no RowActionsContext/)
  })
})
