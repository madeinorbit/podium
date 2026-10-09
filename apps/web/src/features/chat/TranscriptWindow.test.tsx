import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { useMemo, useRef } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { TranscriptWindowRow, useTranscriptWindow } from './TranscriptWindow'

let host: HTMLDivElement, root: Root, top = 0
let frames: FrameRequestCallback[]
const rect = (y: number, height: number) => ({ top: y, bottom: y + height, height, width: 600, left: 0, right: 600, x: 0, y, toJSON() {} })
function Fixture({ count = 1000 }: { count?: number }) {
  const scroll = useRef<HTMLDivElement | null>(null)
  const keys = useMemo(() => Array.from({ length: count }, (_, index) => `row-${index}`), [count])
  const windowing = useTranscriptWindow(keys, scroll)
  return <div ref={scroll} data-scroller>
    {keys.map((key, index) => <TranscriptWindowRow key={key} rowKey={key} index={index} window={windowing}>
      <div data-message><p>{key} retained prose</p><button aria-expanded="false">Details</button></div>
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
  top = 0; frames = []
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function(this: HTMLElement) {
    const key = this.dataset.transcriptRow
    const index = key ? Number(key.slice(4)) : undefined
    return rect(index === undefined ? 0 : index * 80 - top, index === undefined ? 400 : 80) as DOMRect
  })
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(400)
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(600)
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.push(callback); return frames.length })
  vi.stubGlobal('cancelAnimationFrame', () => {})
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  act(() => root.render(<Fixture />))
})
afterEach(() => {
  document.getSelection()?.removeAllRanges()
  act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals()
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
it('materialises native Find and addressed search targets without discarding their text node', () => {
  const shell = host.querySelector('[data-transcript-row="row-800"]')!
  const text = shell.querySelector('[hidden="until-found"]')!
  act(() => text.dispatchEvent(new Event('beforematch')))
  expect(shell.querySelector('[data-message]')).not.toBeNull()
  expect(text.isConnected).toBe(true)
  const other = host.querySelector('[data-transcript-row="row-600"]')!
  act(() => other.dispatchEvent(new Event('podium-transcript-reveal', { bubbles: true })))
  expect(other.querySelector('[data-message]')).not.toBeNull()
})
it('makes Select All include every loaded message before native selection and copy', () => {
  act(() => document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true })))
  expect(host.querySelectorAll('[data-message]')).toHaveLength(1000)
  const range = document.createRange(); range.selectNodeContents(host)
  document.getSelection()!.addRange(range)
  scroll(40_000)
  expect(document.getSelection()!.toString()).toContain('row-999 retained prose')
  document.getSelection()!.removeAllRanges(); scroll(40_080)
  expect(host.querySelectorAll('[data-message]').length).toBeLessThan(40)
})
