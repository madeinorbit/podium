import { act, cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { MobxPool } from '@podium/client-graph'
import { here } from '@podium/client-graph/lookup'
import { ingestMessageRecords } from '@podium/client-graph/message-models'
import { asSessionId, type MessageRecordWire } from '@podium/model'
import { relativeTime } from '@podium/client-core/focus'
import { PanelVisible } from '@/app/panel-visible'
import { LedgerAge } from './LedgerAge'

afterEach(() => { cleanup(); vi.useRealTimers() })

function fixture() {
  const pool = new MobxPool({ selectedIssueId: null })
  const wire: MessageRecordWire = {
    id: 'ledger-clock', sessionId: asSessionId('seat'), senderUserId: 'user',
    body: 'Message', status: 'stored', createdAt: new Date(41_000).toISOString(),
  }
  ingestMessageRecords(pool, [wire])
  return { pool, wire, message: here(pool.model('messageRecord', wire.id))! }
}

it('matches the old relative-time answer, advances only the age leaf, and follows the shared timestamp', () => {
  vi.useFakeTimers(); vi.setSystemTime(100_000)
  const { pool, wire, message } = fixture()
  let draws = 0
  function Row() { draws++; return <LedgerAge message={message} /> }
  const view = render(<Row />)
  try {
    const expected = relativeTime(wire.createdAt, 100_000)
    expect(view.container.textContent).toBe(expected)
    expect(() => expect('wrong').toBe(expected)).toThrow()
    expect(vi.getTimerCount()).toBe(1)
    act(() => vi.advanceTimersByTime(1000))
    expect(view.container.textContent).toBe(relativeTime(wire.createdAt, 101_000))
    expect(view.container.textContent).not.toBe(expected)
    expect(draws).toBe(1)
    const changed = { ...wire, createdAt: new Date(91_000).toISOString() }
    act(() => ingestMessageRecords(pool, [changed]))
    expect(view.container.textContent).toBe(relativeTime(changed.createdAt, 101_000))
    expect(draws).toBe(1)
  } finally { view.unmount(); pool.dispose() }
  expect(vi.getTimerCount()).toBe(0)
})

it('observes no clock while its panel is hidden and releases the visible observer on hide', () => {
  vi.useFakeTimers(); vi.setSystemTime(100_000)
  const { pool, wire, message } = fixture()
  const content = (visible: boolean) => <PanelVisible visible={visible}><LedgerAge message={message} /></PanelVisible>
  const view = render(content(false))
  try {
    expect(vi.getTimerCount()).toBe(0)
    act(() => vi.advanceTimersByTime(60_000))
    view.rerender(content(true))
    expect(view.container.textContent).toBe(relativeTime(wire.createdAt, 160_000))
    expect(vi.getTimerCount()).toBe(1)
    view.rerender(content(false))
    expect(vi.getTimerCount()).toBe(0)
  } finally { view.unmount(); pool.dispose() }
  expect(vi.getTimerCount()).toBe(0)
})
