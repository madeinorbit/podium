// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DomViewportSource } from './dom-viewport'
import type { ViewportSize } from './viewport'

const sources: DomViewportSource[] = []
afterEach(() => {
  for (const source of sources.splice(0)) source.dispose()
  document.body.replaceChildren()
  vi.unstubAllGlobals()
})

function fixture() {
  let notify: (contentWidth: number, contentHeight: number) => void = () => {}
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(cb: ResizeObserverCallback) {
        notify = (width, height) =>
          cb(
            [{ contentRect: { width, height } } as ResizeObserverEntry],
            this as unknown as ResizeObserver,
          )
      }
      observe() {}
      disconnect() {}
    },
  )
  vi.stubGlobal('devicePixelRatio', 1)
  const vv = Object.assign(new EventTarget(), { height: 900 })
  vi.stubGlobal('visualViewport', vv)
  const el = document.createElement('div')
  el.style.padding = '12px 13px 20px'
  document.body.append(el)
  const rect = { width: 1055.265625, height: 824 }
  el.getBoundingClientRect = () => ({ ...rect }) as DOMRect
  const source = new DomViewportSource(el)
  sources.push(source)
  const changes: ViewportSize[] = []
  source.onChange((size) => changes.push(size))
  return { el, rect, vv, changes, notify }
}

describe('terminal viewport sizing triggers', () => {
  it('ignores scrollbar content-box flips inside the same measured viewport', () => {
    const f = fixture()
    f.notify(1029.265625, 792)
    // POD-5560: a server resize changes the screen, toggling both scrollbars.
    // The outer box stays fixed while the observer's content box loses 15px.
    for (let i = 0; i < 8; i++) {
      f.notify(1014.265625, 777)
      f.notify(1029.265625, 792)
      f.vv.dispatchEvent(new Event('resize'))
    }
    expect(f.changes).toEqual([{ width: 1055.265625, height: 824, dpr: 1 }])
  })

  it('reports real box, keyboard, density, and padding changes once each', () => {
    const f = fixture()
    f.notify(1029.265625, 792)
    f.rect.width += 0.015625
    f.notify(1029.28125, 792)
    f.rect.height = 700
    f.notify(1029.28125, 668)
    f.vv.height = 500
    f.vv.dispatchEvent(new Event('resize'))
    vi.stubGlobal('devicePixelRatio', 1.25)
    f.vv.dispatchEvent(new Event('resize'))
    f.el.style.paddingLeft = '20px'
    f.notify(1022.28125, 468)
    f.notify(1022.28125, 468)
    expect(f.changes).toEqual([
      { width: 1055.265625, height: 824, dpr: 1 },
      { width: 1055.28125, height: 824, dpr: 1 },
      { width: 1055.28125, height: 700, dpr: 1 },
      { width: 1055.28125, height: 500, dpr: 1 },
      { width: 1055.28125, height: 500, dpr: 1.25 },
      { width: 1055.28125, height: 500, dpr: 1.25 },
    ])
  })

  it('reports hiding and revealing even when the revealed dimensions are unchanged', () => {
    const f = fixture()
    f.notify(1029.265625, 792)
    f.rect.width = 0
    f.rect.height = 0
    f.notify(0, 0)
    f.rect.width = 1055.265625
    f.rect.height = 824
    f.notify(1029.265625, 792)
    expect(f.changes).toEqual([
      { width: 1055.265625, height: 824, dpr: 1 },
      { width: 0, height: 0, dpr: 1 },
      { width: 1055.265625, height: 824, dpr: 1 },
    ])
  })
})
