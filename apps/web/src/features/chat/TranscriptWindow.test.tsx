import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { useMemo, useRef } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { TranscriptWindowRow, useTranscriptWindow } from './TranscriptWindow'

let host: HTMLDivElement, root: Root, top = 0
let frames: FrameRequestCallback[], rowHeight = 80
const rect = (y: number, height: number) => ({ top: y, bottom: y + height, height, width: 600, left: 0, right: 600, x: 0, y, toJSON() {} })
function Fixture({ count = 1000, operator = false, mode = '', boundary = '', prose = 'retained prose' }: { count?: number; operator?: boolean; mode?: string; boundary?: string; prose?: string }) {
  const scroll = useRef<HTMLDivElement | null>(null)
  const keys = useMemo(() => Array.from({ length: count }, (_, index) => `row-${index}`), [count])
  const windowing = useTranscriptWindow(keys, scroll, mode)
  return <div ref={scroll} data-scroller>
    {keys.map((key, index) => <TranscriptWindowRow key={key} rowKey={key} index={index} window={windowing} geometryKey={index === 600 ? boundary : undefined}>
      {remounted => <div data-message data-operator-prompt={operator && index === 0 ? 'true' : undefined} data-arrived={!remounted ? '' : undefined}><p>{key} {prose}</p><button aria-expanded="false">Details</button></div>}
    </TranscriptWindowRow>)}
  </div>
}
const paint = () => act(() => { const pending = frames; frames = []; pending.forEach(callback => callback(0)) })
const scroll = (value: number) => {
  top = value
  host.querySelector('[data-scroller]')!.dispatchEvent(new Event('scroll'))
  paint()
}
beforeEach(() => {
  top = 0; frames = []; rowHeight = 80
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function(this: HTMLElement) {
    const key = this.dataset.transcriptRow
    const index = key ? Number(key.slice(4)) : undefined
    const height = this.hasAttribute('data-transcript-placeholder') ? Number.parseFloat(this.style.height) : rowHeight
    return rect(index === undefined ? 0 : index * rowHeight - top, index === undefined ? 400 : height) as DOMRect
  })
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(400)
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(600)
  const style = getComputedStyle
  vi.spyOn(globalThis, 'getComputedStyle').mockImplementation(node => node.hasAttribute('data-transcript-row')
    ? { height: node.hasAttribute('data-transcript-placeholder') ? (node as HTMLElement).style.height : `${rowHeight}px` } as CSSStyleDeclaration : style(node))
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.push(callback); return frames.length })
  vi.stubGlobal('cancelAnimationFrame', () => {})
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  act(() => root.render(<Fixture />))
})
afterEach(() => {
  document.getSelection()?.removeAllRanges()
  act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals()
  vi.useRealTimers()
})
it('retains exact shells and only the viewport buffer of rich message DOM, even after large jumps', () => {
  expect(host.querySelectorAll('[data-message]').length).toBeLessThan(25)
  const shell = host.querySelector('[data-transcript-row="row-0"]')
  scroll(40_000)
  expect(host.querySelector('[data-transcript-row="row-500"] [data-message]')).not.toBeNull()
  expect(host.querySelectorAll('[data-message]').length).toBeLessThan(40)
  expect(host.querySelector('[data-transcript-row="row-0"]')).toBe(shell)
  expect((shell as HTMLElement).style.height).toBe('80px')
  expect(shell?.querySelector('[hidden="until-found"]')?.textContent).toContain('row-0 retained prose')
  scroll(0)
  expect(shell?.querySelector('[data-message]')).not.toBeNull()
  expect(shell?.querySelector('[data-arrived]')).toBeNull()
})
it('preserves the complete multirow selection and copy text when it leaves the viewport', () => {
  const first = host.querySelector('[data-transcript-row="row-1"] p')!.firstChild!
  const last = host.querySelector('[data-transcript-row="row-6"] p')!.firstChild!
  const range = document.createRange(); range.setStart(first, 0); range.setEnd(last, last.textContent!.length)
  const selection = document.getSelection()!; selection.removeAllRanges(); selection.addRange(range)
  const copied = selection.toString()
  scroll(40_000)
  expect(selection.toString()).toBe(copied)
  expect(first.isConnected && last.isConnected).toBe(true)
  expect(host.querySelector('[data-transcript-row="row-3"] [data-message]')).not.toBeNull()
  selection.removeAllRanges(); scroll(40_080)
  expect(host.querySelector('[data-transcript-row="row-3"] [data-message]')).toBeNull()
})
it('keeps focused and expanded controls alive while other distant rows unmount', () => {
  const focused = host.querySelector('[data-transcript-row="row-2"] button') as HTMLButtonElement
  focused.focus()
  host.querySelector('[data-transcript-row="row-4"] button')!.setAttribute('aria-expanded', 'true')
  scroll(40_000)
  expect(document.activeElement).toBe(focused)
  expect(host.querySelector('[data-transcript-row="row-4"] [data-message]')).not.toBeNull()
  expect(host.querySelector('[data-transcript-row="row-6"] [data-message]')).toBeNull()
})
it('materialises native Find and addressed search targets without discarding their text node', async () => {
  const shell = host.querySelector('[data-transcript-row="row-800"]')!
  const text = shell.querySelector('[hidden="until-found"]')!
  const range = document.createRange(); range.setStart(text.firstChild!, 0); range.setEnd(text.firstChild!, 7)
  document.getSelection()!.addRange(range)
  act(() => text.dispatchEvent(new Event('beforematch')))
  expect(shell.querySelector('[data-message]')).not.toBeNull()
  expect(text.isConnected).toBe(true)
  const other = host.querySelector('[data-transcript-row="row-600"]')!
  act(() => other.dispatchEvent(new Event('podium-transcript-reveal', { bubbles: true })))
  expect(other.querySelector('[data-message]')).not.toBeNull()
  await act(async () => { await Promise.resolve() })
})
it('makes Select All include every loaded message before native selection and copy', () => {
  act(() => root.render(<Fixture key="select-all" count={100} />))
  act(() => document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true })))
  expect(host.querySelectorAll('[data-message]')).toHaveLength(100)
  const range = document.createRange(); range.selectNodeContents(host)
  document.getSelection()!.addRange(range)
  scroll(6_000)
  expect(document.getSelection()!.toString()).toContain('row-99 retained prose')
  document.getSelection()!.removeAllRanges(); scroll(6_080)
  expect(host.querySelectorAll('[data-message]').length).toBeLessThan(40)
})

it('unmounts automatically unfolded runs while preserving deliberate user-opened state', () => {
  const automatic = host.querySelector('[data-transcript-row="row-4"] [data-message]')!
  automatic.setAttribute('data-transcript-run-view', '')
  automatic.setAttribute('data-open', 'true')
  automatic.querySelector('button')!.setAttribute('data-transcript-run-toggle', '')
  automatic.querySelector('button')!.setAttribute('aria-expanded', 'true')
  host.querySelector('[data-transcript-row="row-6"] [data-message]')!.setAttribute('data-transcript-retain', '')
  scroll(40_000)
  expect(host.querySelector('[data-transcript-row="row-4"] [data-message]')).toBeNull()
  expect(host.querySelector('[data-transcript-row="row-6"] [data-message]')).not.toBeNull()
})

it('transfers a native Find range committed in inert text to the restored message', async () => {
  const shell = host.querySelector('[data-transcript-row="row-600"]')!
  const text = shell.querySelector('[data-transcript-find-proxy]')!.firstChild!
  const range = document.createRange(); range.setStart(text, 0); range.setEnd(text, 7)
  const selection = document.getSelection()!; selection.addRange(range)
  const matched = selection.toString()
  scroll(48_000)
  await act(async () => { await Promise.resolve() })
  expect(selection.toString()).toBe(matched)
  expect(selection.anchorNode?.parentElement?.closest('[data-message]')).not.toBeNull()
})

it('keeps the preceding prompt mounted after a jump deep into one long turn', () => {
  act(() => root.render(<Fixture key="operator" operator />))
  scroll(72_000)
  expect(host.querySelector('[data-transcript-row="row-0"] [data-message]')).not.toBeNull()
  expect(host.querySelector('[data-transcript-row="row-900"] [data-message]')).not.toBeNull()
  expect(host.querySelectorAll('[data-message]').length).toBeLessThan(40)
})
it('remeasures changed display geometry once and returns to the buffer', () => {
  scroll(40_000)
  rowHeight = 120
  act(() => root.render(<Fixture mode="expanded" />))
  paint()
  expect((host.querySelector('[data-transcript-row="row-0"]') as HTMLElement).style.height).toBe('120px')
  expect(host.querySelectorAll('[data-message]').length).toBeLessThan(40)
})

it('measures a changed offscreen paging seam after its real content mounts', () => {
  scroll(40_000)
  rowHeight = 120
  act(() => root.render(<Fixture count={1001} boundary="new day/turn" />))
  paint()
  expect((host.querySelector('[data-transcript-row="row-600"]') as HTMLElement).style.height).toBe('120px')
  expect(host.querySelectorAll('[data-message]').length).toBeLessThan(40)
})

it('retains the resolved subpixel flow size rather than rounded deep-document rectangles', () => {
  const style = getComputedStyle
  vi.spyOn(globalThis, 'getComputedStyle').mockImplementation(node => node.hasAttribute('data-transcript-row')
    ? { height: '80.328' } as CSSStyleDeclaration : style(node))
  act(() => root.render(<Fixture mode="subpixel" />))
  paint()
  expect((host.querySelector('[data-transcript-row="row-600"]') as HTMLElement).style.height).toBe('80.328125px')
})

it('preserves the matched occurrence when native Find repeats a word in one message', async () => {
  act(() => root.render(<Fixture key="repeated" prose="retained prose retained prose" />))
  const shell = host.querySelector('[data-transcript-row="row-600"]')!
  const text = shell.querySelector('[data-transcript-find-proxy]')!.firstChild!
  const start = text.textContent!.lastIndexOf('retained')
  const range = document.createRange(); range.setStart(text, start); range.setEnd(text, start + 8)
  const selection = document.getSelection()!; selection.addRange(range)
  scroll(48_000)
  await act(async () => { await Promise.resolve() })
  expect(selection.toString()).toBe('retained')
  expect(selection.anchorOffset).toBe(15)
})

it('keeps only the buffer drawn across repeated native Find jumps without duplicate search text', () => {
  const earlier = host.querySelector('[data-transcript-row="row-600"]')!
  const text = earlier.querySelector('[data-transcript-find-proxy]')!.firstChild!
  act(() => text.parentElement!.dispatchEvent(new Event('beforematch')))
  scroll(48_000)
  const next = host.querySelector('[data-transcript-row="row-900"]')!
  act(() => next.querySelector('[data-transcript-find-proxy]')!.dispatchEvent(new Event('beforematch')))
  scroll(72_000)
  expect(earlier.querySelector('[data-message]')).toBeNull()
  expect(text.isConnected).toBe(false)
  expect(host.querySelectorAll('[data-message]').length).toBeLessThan(40)
})

it('preserves native Find ranges for its session, then returns to the buffer around the committed selection', () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  act(() => root.render(<Fixture key="native-find" count={100} />))
  act(() => document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true })))
  act(() => vi.runAllTimers())
  expect(host.querySelectorAll('[data-message]')).toHaveLength(100)
  scroll(4_000)
  expect(host.querySelectorAll('[data-message]')).toHaveLength(100)
  const text = host.querySelector('[data-transcript-row="row-50"] p')!.firstChild!
  const range = document.createRange(); range.setStart(text, 0); range.setEnd(text, text.textContent!.length)
  const selection = document.getSelection()!; selection.addRange(range)
  const matched = selection.toString()
  act(() => document.dispatchEvent(new Event('selectionchange')))
  paint()
  expect(host.querySelectorAll('[data-message]').length).toBeLessThan(40)
  expect(selection.toString()).toBe(matched)
})

it('leaves app-handled Find in the buffer and releases an empty native Find on Escape', () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  act(() => root.render(<Fixture key="empty-find" count={100} />))
  const handled = new KeyboardEvent('keydown', { key: 'f', metaKey: true, bubbles: true, cancelable: true })
  const prevent = (event: KeyboardEvent) => event.preventDefault()
  window.addEventListener('keydown', prevent)
  act(() => document.body.dispatchEvent(handled))
  window.removeEventListener('keydown', prevent)
  act(() => vi.runAllTimers())
  expect(host.querySelectorAll('[data-message]').length).toBeLessThan(25)
  act(() => document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', metaKey: true, bubbles: true })))
  act(() => vi.runAllTimers())
  expect(host.querySelectorAll('[data-message]')).toHaveLength(100)
  act(() => document.body.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape', bubbles: true })))
  paint()
  expect(host.querySelectorAll('[data-message]').length).toBeLessThan(25)
})
