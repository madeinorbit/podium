import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryTipLog } from './memory-tip-log'
import { TipHost } from './TipHost'
import { useTipMoment } from './tip-context'
import { TIP_QUIET_MS } from './tip-engine'

let container: HTMLDivElement
let root: Root
let box: DOMRect
let clipped = false
function Moment() {
  useTipMoment('first-prompt', {
    active: true,
    cards: [
      { anchor: 'row', title: 'First card', body: 'First body' },
      { anchor: 'row', title: 'Second card', body: 'Second body' },
    ],
  })
  return (
    <div style={{ overflowY: 'auto' }} data-scroller="">
      <button type="button" data-tip-anchor="row">
        Task
      </button>
    </div>
  )
}
const advance = async (ms: number) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}
beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.body.appendChild(document.createElement('div'))
  root = createRoot(container)
  box = new DOMRect(20, 20, 200, 100)
  clipped = false
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ) {
    if (this.hasAttribute('data-scroller')) return box
    if (this.hasAttribute('data-tip-anchor')) return new DOMRect(30, clipped ? 110 : 30, 100, 30)
    return new DOMRect(0, 0, 100, 50)
  })
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockImplementation(function (
    this: HTMLElement,
  ) {
    return [this.getBoundingClientRect()] as unknown as DOMRectList
  })
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (
    this: HTMLElement,
  ) {
    return this.getBoundingClientRect().width
  })
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (
    this: HTMLElement,
  ) {
    return this.getBoundingClientRect().height
  })
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
    setTimeout(() => callback(0), 16),
  )
  vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id))
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})
describe('tip host boundaries', () => {
  it('remembers typing before the first registration mounts', async () => {
    const log = new MemoryTipLog()
    const record = vi.spyOn(log, 'record')
    await act(async () =>
      root.render(
        <TipHost log={log}>
          <input aria-label="Composer" />
        </TipHost>,
      ),
    )
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }))
    await act(async () =>
      root.render(
        <TipHost log={log}>
          <Moment />
        </TipHost>,
      ),
    )
    await advance(TIP_QUIET_MS - 1)
    expect(record).not.toHaveBeenCalled()
    await advance(1)
    expect(record).toHaveBeenCalledWith('first-prompt', 'shown')
  })
  it('announces card changes, keeps keyboard focus, and restores the composer on Escape', async () => {
    const log = new MemoryTipLog()
    await act(async () =>
      root.render(
        <TipHost log={log}>
          <div>
            <input aria-label="Composer" />
          </div>
        </TipHost>,
      ),
    )
    const composer = container.querySelector('input')
    composer?.focus()
    await act(async () =>
      root.render(
        <TipHost log={log}>
          <div>
            <input aria-label="Composer" />
            <Moment />
          </div>
        </TipHost>,
      ),
    )
    await advance(20)
    expect(document.activeElement).toBe(composer)
    expect(document.querySelector('[role="status"]')?.textContent).toContain('First card')
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'F6', bubbles: true }))
    })
    expect(document.activeElement).toBe(document.querySelector('.tip-close'))
    const next = document.querySelector<HTMLButtonElement>('.tip-next')
    await act(async () => {
      next?.focus()
      next?.click()
    })
    expect(document.querySelector('.tip-next')).toBe(next)
    expect(document.activeElement).toBe(next)
    expect(document.querySelector('[role="status"]')?.textContent).toContain('Second card')
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(document.activeElement).toBe(composer)
    expect(document.querySelector('.tip-card')).toBeNull()
  })
  it('does not record shown for an anchor clipped by a scroll ancestor', async () => {
    const log = new MemoryTipLog()
    const record = vi.spyOn(log, 'record')
    clipped = true
    await act(async () =>
      root.render(
        <TipHost log={log}>
          <Moment />
        </TipHost>,
      ),
    )
    await advance(20)
    expect(record).not.toHaveBeenCalled()
    expect(document.querySelector('.tip-card')).toBeNull()
  })
  it('dismisses a shown tip when its row scrolls beneath the clipping boundary', async () => {
    const log = new MemoryTipLog()
    const record = vi.spyOn(log, 'record')
    await act(async () =>
      root.render(
        <TipHost log={log}>
          <Moment />
        </TipHost>,
      ),
    )
    await advance(20)
    expect(record).toHaveBeenCalledWith('first-prompt', 'shown')
    clipped = true
    document.querySelector('[data-scroller]')?.dispatchEvent(new Event('scroll'))
    await advance(20)
    expect(record).toHaveBeenLastCalledWith('first-prompt', 'dismissed')
    expect(document.querySelector('.tip-card')).toBeNull()
  })
})
