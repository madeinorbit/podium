import type { JSX, ReactNode, RefObject } from 'react'
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { flushSync } from 'react-dom'

/** Three viewports on either side cover compositor/wheel bursts (POD-5880).
 * Every row keeps a measured shell, not its message/menu/markdown tree. Heights
 * are never estimated or evicted: paging must not change the scrollbar's scale.
 * The inert text in a shell preserves native Find without retaining rich DOM. */
const BUFFER = 3
interface Entry {
  node: HTMLDivElement
  mounted: boolean
  height: number
  text: string
  publish: (mounted: boolean) => void
  finding: boolean
}
interface TranscriptWindow {
  register: (key: string, entry: Entry) => () => void
  refresh: () => void
}

export function useTranscriptWindow(
  keys: readonly string[],
  scrollRef: RefObject<HTMLDivElement | null>,
): TranscriptWindow {
  const entries = useRef(new Map<string, Entry>())
  const ordered = useRef<readonly string[]>(keys)
  const mounted = useRef(new Set<string>())
  const frame = useRef<number | null>(null)
  const selectingAll = useRef(false)
  const sticky = useRef<string | undefined>(undefined)
  const register = useCallback((key: string, entry: Entry) => {
    entries.current.set(key, entry)
    mounted.current.add(key)
    return () => {
      entries.current.delete(key)
      mounted.current.delete(key)
    }
  }, [])
  const refresh = useCallback(() => {
    const scroll = scrollRef.current
    if (!scroll || scroll.clientHeight <= 0) return
    const viewport = scroll.getBoundingClientRect()
    const buffer = scroll.clientHeight * BUFFER
    const list = ordered.current
    // Shells stay in normal flow. Read only the logarithmic boundary probes and
    // the mounted buffer; a scroll never walks the loaded transcript's DOM.
    const boundary = (edge: number, bottom: boolean) => {
      let low = 0, high = list.length
      while (low < high) {
        const mid = (low + high) >>> 1
        const box = entries.current.get(list[mid]!)?.node.getBoundingClientRect()
        if (box && (bottom ? box.bottom : box.top) < edge) low = mid + 1
        else high = mid
      }
      return low
    }
    const first = boundary(viewport.top - buffer, true)
    const last = boundary(viewport.bottom + buffer, false)
    const next = new Set(list.slice(first, last))
    const selection = scroll.ownerDocument.getSelection()
    const range = selection && !selection.isCollapsed && selection.rangeCount ? selection.getRangeAt(0) : null
    if (!range) selectingAll.current = false
    if (selectingAll.current) for (const key of list) next.add(key)
    let previousPrompt: string | undefined
    let previousPromptTop = -Infinity
    for (const key of mounted.current) {
      const entry = entries.current.get(key)
      if (!entry) continue
      const node = entry.node
      // Preserve both selection endpoints and the entire selected interval,
      // focused controls, and user-opened tool/detail state across scrolling.
      if (range?.intersectsNode(node) || node.contains(scroll.ownerDocument.activeElement) ||
          node.querySelector('[aria-expanded="true"], [data-open="true"], dialog[open]') ||
          [...node.querySelectorAll('img')].some(image => !image.complete)) next.add(key)
      const prompt = node.querySelector<HTMLElement>('[data-operator-prompt="true"][data-pinnable="true"]')
      const top = prompt?.getBoundingClientRect().bottom
      if (top !== undefined && top < viewport.top + 6 && top > previousPromptTop) {
        previousPrompt = key
        previousPromptTop = top
      }
    }
    sticky.current = previousPrompt
    if (previousPrompt && entries.current.has(previousPrompt)) next.add(previousPrompt)
    // A range can span shells after Shift-click or Select All. Materialise its
    // intervening messages before Copy reads the browser's native selection.
    if (range && (selection?.anchorNode && scroll.contains(selection.anchorNode) || selection?.focusNode && scroll.contains(selection.focusNode))) {
      const endpoint = (node: Node | null) => node?.parentElement?.closest<HTMLElement>('[data-transcript-row]')?.dataset.transcriptRow
      const a = endpoint(selection!.anchorNode), b = endpoint(selection!.focusNode)
      if (a && b && a !== b) {
        const start = list.indexOf(a), end = list.indexOf(b)
        for (let i = Math.min(start, end); i <= Math.max(start, end); i++) if (list[i]) next.add(list[i]!)
      }
    }
    for (const key of new Set([...mounted.current, ...next])) {
      const entry = entries.current.get(key)
      if (!entry) continue
      if (entry.mounted && entry.height <= 0) entry.height = entry.node.getBoundingClientRect().height
      const show = next.has(key) || entry.finding || entry.height <= 0
      if (show === entry.mounted) continue
      if (!show) {
        entry.height = entry.node.getBoundingClientRect().height
        entry.text = entry.node.innerText ?? entry.node.textContent ?? ''
      }
      entry.mounted = show
      if (show) mounted.current.add(key)
      else mounted.current.delete(key)
      entry.publish(show)
    }
  }, [scrollRef])
  useLayoutEffect(() => {
    ordered.current = keys
    // New page rows are measured once before paint, then immediately reduced
    // to the viewport buffer. Existing shell/row identities survive prepends.
    for (const key of mounted.current) {
      const entry = entries.current.get(key)
      if (entry) entry.height = entry.node.getBoundingClientRect().height
    }
    refresh()
  }, [keys, refresh])
  useLayoutEffect(() => {
    const scroll = scrollRef.current
    if (!scroll) return
    const update = () => {
      if (frame.current !== null) return
      frame.current = requestAnimationFrame(() => {
        frame.current = null
        flushSync(refresh)
      })
    }
    const selectAll = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'a' ||
          (event.target as Element | null)?.closest?.('input, textarea, [contenteditable="true"]')) return
      if (scroll.clientHeight <= 0) return
      selectingAll.current = true
      flushSync(() => {
        for (const [key, entry] of entries.current) {
          entry.mounted = true
          mounted.current.add(key)
          entry.publish(true)
        }
      })
    }
    const reveal = (event: Event) => {
      const shell = (event.target as HTMLElement).closest<HTMLElement>('[data-transcript-row]')
      const entry = shell ? entries.current.get(shell.dataset.transcriptRow!) : undefined
      if (!entry) return
      flushSync(() => {
        entry.mounted = true
        mounted.current.add(shell!.dataset.transcriptRow!)
        entry.publish(true)
      })
    }
    const resize = new ResizeObserver(update)
    resize.observe(scroll)
    // Width changes invalidate measured wrapping; remeasure all loaded rows
    // once at the new width instead of reusing heights from another layout.
    let width = scroll.clientWidth
    const measureWidth = new ResizeObserver(() => {
      if (scroll.clientWidth === width) return
      width = scroll.clientWidth
      for (const [key, entry] of entries.current) {
        entry.height = 0
        entry.mounted = true
        mounted.current.add(key)
        entry.publish(true)
      }
      update()
    })
    measureWidth.observe(scroll)
    scroll.addEventListener('scroll', update, { passive: true })
    scroll.addEventListener('podium-transcript-reveal', reveal)
    scroll.addEventListener('load', update, true)
    document.addEventListener('selectionchange', update)
    document.addEventListener('keydown', selectAll, true)
    document.addEventListener('focusin', update)
    return () => {
      resize.disconnect()
      measureWidth.disconnect()
      scroll.removeEventListener('scroll', update)
      scroll.removeEventListener('podium-transcript-reveal', reveal)
      scroll.removeEventListener('load', update, true)
      document.removeEventListener('selectionchange', update)
      document.removeEventListener('keydown', selectAll, true)
      document.removeEventListener('focusin', update)
      if (frame.current !== null) cancelAnimationFrame(frame.current)
      frame.current = null
    }
  }, [refresh, scrollRef])
  return useMemo(() => ({ register, refresh }), [register, refresh])
}

/** A stable shell also lets the existing minimap and scroll controller address
 * off-window rows. Rich content is mounted only while needed by the reader. */
export function TranscriptWindowRow({ window: windowing, rowKey, index, children }: {
  window: TranscriptWindow; rowKey: string; index: number; children: ReactNode
}): JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null)
  const proxy = useRef<HTMLDivElement | null>(null)
  const [mounted, setMounted] = useState(true)
  const [finding, setFinding] = useState(false)
  const entry = useRef<Entry | null>(null)
  const wasMounted = useRef(true)
  useLayoutEffect(() => {
    const value: Entry = { node: ref.current!, mounted: true, height: 0, text: '', publish: setMounted, finding: false }
    entry.current = value
    return windowing.register(rowKey, value)
  }, [rowKey, windowing])
  useLayoutEffect(() => {
    if (!mounted || !entry.current) { wasMounted.current = mounted; return }
    entry.current.height = ref.current!.getBoundingClientRect().height
    if (!wasMounted.current) windowing.refresh()
    wasMounted.current = mounted
  }, [mounted, children, windowing])
  useLayoutEffect(() => {
    const node = proxy.current
    if (!node) return
    if (!finding) node.setAttribute('hidden', 'until-found')
    const found = () => {
      // Preserve the exact text node owned by native Find while it is open.
      // Draw the real message beneath it immediately, without a blank jump.
      entry.current!.finding = true
      flushSync(() => setFinding(true))
      ref.current!.dispatchEvent(new Event('podium-transcript-reveal', { bubbles: true }))
    }
    node.addEventListener('beforematch', found)
    return () => node.removeEventListener('beforematch', found)
  }, [mounted, finding])
  useLayoutEffect(() => {
    if (!finding) return
    const finish = () => {
      entry.current!.finding = false
      setFinding(false)
      requestAnimationFrame(windowing.refresh)
    }
    const transfer = () => {
      const selection = document.getSelection()
      if (!selection?.anchorNode || !proxy.current?.contains(selection.anchorNode) || selection.isCollapsed) return
      const text = selection.toString()
      const body = ref.current!
      const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT)
      const parts: Text[] = []
      let content = ''
      while (walker.nextNode()) {
        const part = walker.currentNode as Text
        if (proxy.current.contains(part)) continue
        parts.push(part)
        content += part.data
      }
      const start = content.toLocaleLowerCase().indexOf(text.toLocaleLowerCase())
      if (start < 0) return
      const range = document.createRange()
      let offset = 0
      for (const part of parts) {
        if (start >= offset && start < offset + part.length) range.setStart(part, start - offset)
        if (start + text.length > offset && start + text.length <= offset + part.length) {
          range.setEnd(part, start + text.length - offset)
          break
        }
        offset += part.length
      }
      selection.removeAllRanges()
      selection.addRange(range)
      finish()
    }
    document.addEventListener('selectionchange', transfer)
    document.addEventListener('pointerdown', finish, true)
    document.addEventListener('keydown', finish, true)
    return () => {
      document.removeEventListener('selectionchange', transfer)
      document.removeEventListener('pointerdown', finish, true)
      document.removeEventListener('keydown', finish, true)
    }
  }, [finding, windowing])
  return <div ref={ref} data-transcript-row={rowKey}
    data-transcript-placeholder={!mounted ? '' : undefined}
    data-block={!mounted ? index : undefined} data-row-key={!mounted ? rowKey : undefined}
    style={{ flexShrink: 0, display: 'flow-root', position: 'relative', height: mounted ? undefined : entry.current?.height, minWidth: 0 }}>
    {mounted && children}
    {(!mounted || finding) && <div ref={proxy} aria-hidden="true"
      style={{ position: 'absolute', inset: 0, opacity: finding ? 0 : undefined, pointerEvents: 'none', whiteSpace: 'pre-wrap' }}>{entry.current?.text}</div>}
    {!mounted && <button type="button" className="sr-only" aria-label={entry.current?.text}
      onFocus={(event) => {
        const reverse = event.relatedTarget instanceof Node && Boolean(ref.current!.compareDocumentPosition(event.relatedTarget) & Node.DOCUMENT_POSITION_FOLLOWING)
        ref.current!.dispatchEvent(new Event('podium-transcript-reveal', { bubbles: true }))
        const controls = [...ref.current!.querySelectorAll<HTMLElement>('button, input, textarea, a[href], [tabindex]')]
          .filter(control => control.tabIndex >= 0 && !control.matches(':disabled') && control.getClientRects().length > 0)
        ;(reverse ? controls.at(-1) : controls[0])?.focus({ preventScroll: true })
      }} />}
  </div>
}
