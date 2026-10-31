import { runInAction } from 'mobx'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryTipLog } from './memory-tip-log'
import { TIP_GAP_MS, TIP_QUIET_MS, TipEngine } from './tip-engine'
import { TIP_IDS, type TipCard, type TipId, type TipMoment } from './types'

const card = (anchor = 'present'): TipCard => ({
  anchor,
  title: 'A tip',
  body: 'A useful pointer.',
})
let stop: () => void
beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  stop?.()
  vi.useRealTimers()
})
function fixture() {
  const log = new MemoryTipLog()
  const record = vi.spyOn(log, 'record')
  const engine = new TipEngine(log, (name) => name !== 'missing')
  stop = engine.connect()
  return { log, record, engine }
}
describe('First Flights queue', () => {
  it('shows only one moment, pairs card hooks, and waits twenty seconds after finish', () => {
    const { engine, record, log } = fixture()
    const show = vi.fn()
    const hide = vi.fn()
    engine.register('first-prompt', () => ({
      active: true,
      cards: [{ ...card(), onShow: show, onHide: hide }, card()],
    }))
    engine.register('first-send', () => ({ active: true, cards: [card()] }))
    vi.advanceTimersByTime(0)
    expect(show).toHaveBeenCalledOnce()
    expect(record.mock.calls).toEqual([['first-prompt', 'shown']])
    engine.next()
    expect(hide).toHaveBeenCalledOnce()
    expect(engine.current?.index).toBe(1)
    expect(log.isSeen('first-prompt')).toBe(false)
    engine.next()
    expect(record.mock.calls).toEqual([
      ['first-prompt', 'shown'],
      ['first-prompt', 'finished'],
    ])
    expect(engine.progress).toBe(1)
    vi.advanceTimersByTime(TIP_GAP_MS - 1)
    expect(engine.current).toBeNull()
    vi.advanceTimersByTime(1)
    expect(engine.current?.registration.id).toBe('first-send')
  })
  it('postpones the first queued tip until keyboard input has been quiet for three seconds', () => {
    const { engine } = fixture()
    engine.input()
    engine.register('first-prompt', () => ({ active: true, cards: [card()] }))
    vi.advanceTimersByTime(TIP_QUIET_MS - 1)
    engine.input()
    vi.advanceTimersByTime(TIP_QUIET_MS - 1)
    expect(engine.current).toBeNull()
    vi.advanceTimersByTime(1)
    expect(engine.current).not.toBeNull()
  })
  it('does not show before readiness, or while disabled', () => {
    const { log, engine, record } = fixture()
    runInAction(() => {
      log.ready = false
    })
    engine.register('first-prompt', () => ({ active: true, cards: [card()] }))
    vi.runOnlyPendingTimers()
    expect(record).not.toHaveBeenCalled()
    log.setEnabled(false)
    runInAction(() => {
      log.ready = true
    })
    vi.runOnlyPendingTimers()
    expect(record).not.toHaveBeenCalled()
    log.setEnabled(true)
    vi.advanceTimersByTime(0)
    expect(record).toHaveBeenCalledWith('first-prompt', 'shown')
  })
  it('preserves activation while an unhydrated account reports every moment seen', () => {
    class HydratingLog extends MemoryTipLog {
      override isSeen(id: TipId): boolean {
        return !this.ready || super.isSeen(id)
      }
    }
    const log = new HydratingLog()
    runInAction(() => {
      log.ready = false
    })
    const record = vi.spyOn(log, 'record')
    const engine = new TipEngine(log, () => true)
    stop = engine.connect()
    engine.register('first-prompt', () => ({ active: true, cards: [card()] }))
    engine.refresh()
    vi.advanceTimersByTime(10_000)
    expect(record).not.toHaveBeenCalled()
    runInAction(() => {
      log.ready = true
    })
    vi.advanceTimersByTime(0)
    expect(record.mock.calls).toEqual([['first-prompt', 'shown']])
  })
  it('skips a missing anchor without recording or blocking the next moment', () => {
    const { engine, record, log } = fixture()
    engine.register('first-prompt', () => ({ active: true, cards: [card('missing')] }))
    engine.register('first-send', () => ({ active: true, cards: [card()] }))
    vi.advanceTimersByTime(0)
    expect(record.mock.calls).toEqual([['first-send', 'shown']])
    expect(log.isSeen('first-prompt')).toBe(false)
  })
  it('records dismissed once and pairs cleanup when the anchor registration disappears', () => {
    const { engine, record } = fixture()
    const hide = vi.fn()
    const unregister = engine.register('first-prompt', () => ({
      active: true,
      cards: [{ ...card(), onHide: hide }],
    }))
    vi.advanceTimersByTime(0)
    unregister()
    engine.close('dismissed')
    expect(record.mock.calls).toEqual([
      ['first-prompt', 'shown'],
      ['first-prompt', 'dismissed'],
    ])
    expect(hide).toHaveBeenCalledOnce()
  })
  it('dismisses a shown moment when its second anchor is missing', () => {
    const { engine, record } = fixture()
    engine.register('first-prompt', () => ({ active: true, cards: [card(), card('missing')] }))
    vi.advanceTimersByTime(0)
    engine.next()
    expect(record).toHaveBeenLastCalledWith('first-prompt', 'dismissed')
  })
  it('replays seen inactive moments without bypassing the quiet gap', () => {
    const { engine, log, record } = fixture()
    log.record('first-prompt', 'finished')
    engine.register('first-prompt', () => ({ active: false, cards: [card()] }))
    engine.register('first-send', () => ({ active: true, cards: [card()] }))
    vi.advanceTimersByTime(0)
    engine.close('dismissed')
    engine.replay('first-prompt')
    vi.advanceTimersByTime(TIP_GAP_MS - 1)
    expect(engine.current).toBeNull()
    vi.advanceTimersByTime(1)
    expect(record).toHaveBeenLastCalledWith('first-prompt', 'shown')
    engine.next()
    expect(record).toHaveBeenLastCalledWith('first-prompt', 'finished')
  })
  it('skip-all marks every moment seen, disables tips and drops queued work', () => {
    const { engine, log, record } = fixture()
    engine.register('first-prompt', () => ({ active: true, cards: [card()] }))
    engine.register('first-send', () => ({ active: true, cards: [card()] }))
    vi.advanceTimersByTime(0)
    engine.close('skipped-all')
    expect(record).toHaveBeenLastCalledWith('first-prompt', 'skipped-all')
    expect(TIP_IDS.every((id) => log.isSeen(id))).toBe(true)
    expect(log.enabled).toBe(false)
    log.setEnabled(true)
    vi.advanceTimersByTime(TIP_GAP_MS)
    expect(engine.current).toBeNull()
    expect(engine.badgeVisible).toBe(false)
  })
  it('does not requeue on render and retries a missing anchor on a new activation', () => {
    const { engine, record } = fixture()
    let moment: TipMoment = { active: true, cards: [card('missing')] }
    engine.register('first-prompt', () => moment)
    vi.advanceTimersByTime(0)
    moment = { active: true, cards: [card()] }
    engine.refresh()
    vi.advanceTimersByTime(0)
    expect(record).not.toHaveBeenCalled()
    moment = { ...moment, active: false }
    engine.refresh()
    moment = { ...moment, active: true }
    engine.refresh()
    vi.advanceTimersByTime(0)
    expect(record).toHaveBeenCalledWith('first-prompt', 'shown')
  })
  it('cancels queued inactive registrations and hides all chrome with no registrations', () => {
    const { engine } = fixture()
    expect(engine.badgeVisible).toBe(false)
    let active = true
    const unregister = engine.register('first-prompt', () => ({ active, cards: [card()] }))
    expect(engine.badgeVisible).toBe(true)
    active = false
    engine.refresh()
    vi.advanceTimersByTime(0)
    expect(engine.current).toBeNull()
    unregister()
    expect(engine.badgeVisible).toBe(false)
  })
  it('replays the registration whose anchor is on screen when one moment is mounted twice', () => {
    const { engine, log } = fixture()
    log.record('first-offer', 'finished')
    engine.register('first-offer', () => ({ active: false, cards: [card('missing')] }))
    engine.register('first-offer', () => ({ active: false, cards: [card('present')] }))
    engine.replay('first-offer')
    vi.advanceTimersByTime(TIP_GAP_MS)
    expect(engine.current?.card.anchor).toBe('present')
  })
})
