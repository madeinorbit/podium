import type { MissionProgress } from '@podium/client-core/values'
import { cleanup, render } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RowProgressMeter } from './row-progress'

const progress: MissionProgress = {
  total: 4,
  done: 1,
  run: 1,
  review: 0,
  stall: 0,
  block: 0,
  wait: 2,
}

class Observer {
  static instances: Observer[] = []
  observe = vi.fn()
  unobserve = vi.fn()
  disconnect = vi.fn()
  constructor(private readonly callback: IntersectionObserverCallback) {
    Observer.instances.push(this)
  }
  intersect(target: Element, visible: boolean, width = 100): void {
    this.callback(
      [
        {
          target,
          isIntersecting: visible,
          intersectionRect: { width, height: 3 },
        } as IntersectionObserverEntry,
      ],
      this as unknown as IntersectionObserver,
    )
  }
}

let visibility: DocumentVisibilityState
let originalVisibility: PropertyDescriptor | undefined
let originalObserver: PropertyDescriptor | undefined

beforeEach(() => {
  Observer.instances = []
  visibility = 'visible'
  originalVisibility = Object.getOwnPropertyDescriptor(document, 'visibilityState')
  originalObserver = Object.getOwnPropertyDescriptor(window, 'IntersectionObserver')
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility })
  Object.defineProperty(window, 'IntersectionObserver', { configurable: true, value: Observer })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  if (originalVisibility) Object.defineProperty(document, 'visibilityState', originalVisibility)
  else Reflect.deleteProperty(document, 'visibilityState')
  if (originalObserver) Object.defineProperty(window, 'IntersectionObserver', originalObserver)
  else Reflect.deleteProperty(window, 'IntersectionObserver')
})

function setVisibility(value: DocumentVisibilityState): void {
  visibility = value
  document.dispatchEvent(new Event('visibilitychange'))
}

describe('row progress sweep visibility', () => {
  it('pauses outside the viewport and in hidden tabs while preserving the progress segments', () => {
    const view = render(<RowProgressMeter progress={progress} working />)
    const sweep = view.container.querySelector<HTMLSpanElement>('.row-progress-sweep')!
    const segment = sweep.parentElement!
    const observer = Observer.instances[0]!
    const meter = view.container.querySelector('[data-testid="row-progress"]')!
    const label = meter.getAttribute('aria-label')
    expect(segment.style.width).toBe('25%')
    expect(sweep.style.animationPlayState).toBe('paused')
    expect(observer.observe).toHaveBeenCalledWith(segment)

    observer.intersect(segment, true)
    expect(sweep.style.animationPlayState).toBe('running')
    setVisibility('hidden')
    expect(sweep.style.animationPlayState).toBe('paused')
    setVisibility('visible')
    expect(sweep.style.animationPlayState).toBe('running')
    observer.intersect(segment, false)
    expect(sweep.style.animationPlayState).toBe('paused')
    setVisibility('hidden')
    setVisibility('visible')
    expect(sweep.style.animationPlayState).toBe('paused')
    observer.intersect(segment, true, 0)
    expect(sweep.style.animationPlayState).toBe('paused')
    expect(segment.style.width).toBe('25%')
    expect(meter.getAttribute('aria-label')).toBe(label)
  })

  it('keeps a newly mounted hidden-tab sweep paused even after intersection arrives', () => {
    setVisibility('hidden')
    const view = render(<RowProgressMeter progress={progress} working />)
    const sweep = view.container.querySelector<HTMLSpanElement>('.row-progress-sweep')!
    Observer.instances[0]!.intersect(sweep.parentElement!, true)
    expect(sweep.style.animationPlayState).toBe('paused')
    setVisibility('visible')
    expect(sweep.style.animationPlayState).toBe('running')
  })

  it('shares observation across rows and releases it after the last sweep unmounts', () => {
    const add = vi.spyOn(document, 'addEventListener')
    const remove = vi.spyOn(document, 'removeEventListener')
    const first = render(<RowProgressMeter progress={progress} working />)
    const second = render(<RowProgressMeter progress={progress} working />)
    const observer = Observer.instances[0]!
    expect(Observer.instances).toHaveLength(1)
    expect(observer.observe).toHaveBeenCalledTimes(2)
    expect(add.mock.calls.filter(([name]) => name === 'visibilitychange')).toHaveLength(1)
    first.unmount()
    expect(observer.unobserve).toHaveBeenCalledTimes(1)
    expect(observer.disconnect).not.toHaveBeenCalled()
    second.unmount()
    expect(observer.disconnect).toHaveBeenCalledTimes(1)
    expect(remove.mock.calls.filter(([name]) => name === 'visibilitychange')).toHaveLength(1)
  })

  it('remounts cleanly after StrictMode ref replay and changes to working/run state', () => {
    const view = render(
      <StrictMode>
        <RowProgressMeter progress={progress} working />
      </StrictMode>,
    )
    const sweep = view.container.querySelector<HTMLSpanElement>('.row-progress-sweep')!
    Observer.instances.at(-1)!.intersect(sweep.parentElement!, true)
    expect(sweep.style.animationPlayState).toBe('running')
    view.rerender(
      <StrictMode>
        <RowProgressMeter progress={progress} working={false} />
      </StrictMode>,
    )
    expect(view.container.querySelector('.row-progress-sweep')).toBeNull()
    expect(Observer.instances.at(-1)!.disconnect).toHaveBeenCalled()
    view.rerender(<RowProgressMeter progress={{ ...progress, run: 0, wait: 3 }} working />)
    expect(view.container.querySelector('.row-progress-sweep')).toBeNull()
    expect(view.container.querySelector('[data-testid="row-progress"]')).toBeTruthy()
    view.rerender(<RowProgressMeter progress={progress} working />)
    const restored = view.container.querySelector<HTMLSpanElement>('.row-progress-sweep')!
    Observer.instances.at(-1)!.intersect(restored.parentElement!, true)
    expect(restored.style.animationPlayState).toBe('running')
  })

  it('retains visible motion in older webviews without an observer and still pauses hidden tabs', () => {
    Object.defineProperty(window, 'IntersectionObserver', { configurable: true, value: undefined })
    const view = render(<RowProgressMeter progress={progress} working />)
    const sweep = view.container.querySelector<HTMLSpanElement>('.row-progress-sweep')!
    expect(sweep.style.animationPlayState).toBe('running')
    setVisibility('hidden')
    expect(sweep.style.animationPlayState).toBe('paused')
    setVisibility('visible')
    expect(sweep.style.animationPlayState).toBe('running')
  })
})
