import { autorun, observable, runInAction } from 'mobx'
import { expect, it, vi } from 'vitest'
import { ROW_WINDOW_SIZE, RowWindow } from './row-window'

it('renders the top rows before any native cell reports appearing', () => {
  const rows = Array.from({ length: 100 }, (_, i) => `row-${i}`)
  const window = new RowWindow(
    () => rows,
    (id) => id,
  )
  const values = new Map<string, boolean>()
  const stops = rows.map((id) => autorun(() => values.set(id, window.has(id))))
  try {
    expect(values.get('row-0')).toBe(true)
    expect(values.get(`row-${ROW_WINDOW_SIZE - 1}`)).toBe(true)
    expect(values.get(`row-${ROW_WINDOW_SIZE}`)).toBe(false)
  } finally {
    for (const stop of stops) stop()
  }
})

it('keeps a row visible until every native presentation leaves it', () => {
  const rows = ['working', ...Array.from({ length: 100 }, (_, i) => `row-${i}`)]
  const window = new RowWindow(
    () => rows,
    (id) => id,
  )
  const workSlot = {},
    searchSlot = {}
  const values: boolean[] = []
  const stop = autorun(() => values.push(window.has('working')))
  try {
    window.appear('working', workSlot)
    window.appear('working', searchSlot)
    // The viewport moves on; 'working' stays only while a cell still shows it.
    window.appear('row-90', {})
    window.disappear('working', searchSlot)
    expect(values.at(-1)).toBe(true)
    window.disappear('working', searchSlot)
    expect(values.at(-1)).toBe(true)
    window.disappear('working', workSlot)
    expect(values.at(-1)).toBe(false)
  } finally {
    stop()
  }
})

it('never replaces a still-visible row with a placeholder when appearances arrive out of order', () => {
  const rows = Array.from({ length: 200 }, (_, i) => `row-${i}`)
  const window = new RowWindow(
    () => rows,
    (id) => id,
  )
  const visible: boolean[] = []
  const stop = autorun(() => visible.push(window.has('row-0')))
  try {
    window.appear('row-0')
    window.appear('row-150')
    expect(visible.at(-1)).toBe(true)
    window.disappear('row-0')
    expect(visible.at(-1)).toBe(false)
  } finally {
    stop()
  }
})

it.each([400, 1600])('notifies only entering/leaving slots among %i rows', (size) => {
  const rows = observable.array(Array.from({ length: size }, (_, i) => `row-${i}`))
  const identify = vi.fn((id: string) => id)
  const window = new RowWindow(() => rows.slice(), identify)
  const reads = Array.from({ length: size }, () => vi.fn())
  const stops = rows.map((id, index) => autorun(() => reads[index]!(window.has(id))))
  const list = vi.fn()
  const stopList = autorun(() => list(rows.slice()))
  try {
    window.appear('row-30')
    expect(reads.filter((read) => read.mock.lastCall?.[0])).toHaveLength(ROW_WINDOW_SIZE)
    for (const read of reads) read.mockClear()
    identify.mockClear()
    list.mockClear()

    // Positive control: a one-row shift really changes exactly two slots.
    window.appear('row-31')
    window.disappear('row-30')
    expect(reads.flatMap((read, i) => (read.mock.calls.length ? [i] : []))).toEqual([10, 50])
    expect(reads[10]).toHaveBeenCalledWith(false)
    expect(reads[50]).toHaveBeenCalledWith(true)
    expect(list).not.toHaveBeenCalled()
    expect(identify).toHaveBeenCalledTimes(ROW_WINDOW_SIZE)

    for (const read of reads) read.mockClear()
    window.appear('row-31')
    window.disappear('row-30')
    expect(reads.every((read) => read.mock.calls.length === 0)).toBe(true)

    // Backward and distant jumps retain the same bound.
    window.appear('row-30')
    expect(reads.flatMap((read, i) => (read.mock.calls.length ? [i] : []))).toEqual([10, 50])
    for (const read of reads) read.mockClear()
    runInAction(() => {
      window.disappear('row-30')
      window.disappear('row-31')
      window.appear(`row-${size - 30}`)
    })
    expect(reads.reduce((n, read) => n + read.mock.calls.length, 0)).toBe(2 * ROW_WINDOW_SIZE)
  } finally {
    for (const stop of stops) stop()
    stopList()
  }
  // Unmount releases appearances as well as the source subscription: back to the top window.
  expect(window.visibleRows).toEqual(rows.slice(0, ROW_WINDOW_SIZE))
  identify.mockClear()
  runInAction(() => rows.reverse())
  expect(identify).not.toHaveBeenCalled()
  const stop = autorun(() => window.has(rows[0]!))
  // A remount shows the top rows at once, before any native appearance.
  expect(window.has(rows[0]!)).toBe(true)
  expect(window.has(rows[ROW_WINDOW_SIZE]!)).toBe(false)
  window.appear(rows[ROW_WINDOW_SIZE]!)
  expect(window.has(rows[ROW_WINDOW_SIZE]!)).toBe(true)
  stop()
})

it('reindexes on source edits and ignores appearance callbacks for removed rows', () => {
  const rows = observable.array(Array.from({ length: 100 }, (_, i) => `row-${i}`))
  const window = new RowWindow(
    () => rows.slice(),
    (id) => id,
  )
  const values = new Map<string, boolean>()
  const stops = rows.map((id) => autorun(() => values.set(id, window.has(id))))
  try {
    window.appear('row-50')
    runInAction(() => rows.reverse())
    expect(
      [...values]
        .filter(([, active]) => active)
        .map(([id]) => id)
        .sort(),
    ).toEqual([...window.visibleRows].sort())
    runInAction(() => rows.remove('row-50'))
    expect(values.get('row-50')).toBe(false)
    window.appear('row-80')
    const before = [...window.visibleRows]
    window.appear('row-50')
    window.disappear('row-50')
    expect(window.visibleRows).toEqual(before)
    // Every cell leaving (a hidden tab) keeps the last window mounted for the return.
    window.disappear('row-80')
    expect([...values.values()].filter(Boolean)).toHaveLength(ROW_WINDOW_SIZE)
    expect(values.get('row-80')).toBe(true)
  } finally {
    for (const stop of stops) stop()
  }
})
