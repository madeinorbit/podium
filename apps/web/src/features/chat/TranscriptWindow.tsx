import type { JSX, ReactNode, RefObject } from 'react'
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { flushSync } from 'react-dom'

/** Three viewports on either side cover compositor/wheel bursts (POD-5880).
 * Every row keeps a measured shell, not its message/menu/markdown tree. Heights
 * are never estimated or evicted: paging must not change the scrollbar's scale.
 * The inert text in a shell preserves native Find without retaining rich DOM. */
const BUFFER = 3
const layoutUnits = new WeakMap<Document, number>()
// Client rects lose subpixel precision at million-pixel document coordinates.
// The shell has no padding/border, so its resolved CSS height is its flow size.
const measuredHeight = (node: HTMLElement) => {
  const resolved = Number.parseFloat(getComputedStyle(node).height)
  let unit = layoutUnits.get(node.ownerDocument)
  if (!unit) {
    const probe = node.ownerDocument.createElement('div')
    probe.style.cssText = 'position:fixed;top:0;left:0;height:0.02px;width:0;padding:0;border:0;visibility:hidden'
    node.ownerDocument.body.append(probe)
    const measured = probe.getBoundingClientRect().height
    probe.remove()
    unit = measured > 0 && measured <= 0.02 ? measured : 1 / 64
    layoutUnits.set(node.ownerDocument, unit)
  }
  // CSSOM rounds its decimal string. Recover the layout-unit fraction before
  // writing it back, or thousands of spacers accumulate a 1/64px truncation.
  return resolved ? Math.round(resolved / unit) * unit : node.getBoundingClientRect().height
}
interface Entry {
  node: HTMLDivElement
  mounted: boolean
  height: number
  text: string
  publish: (mounted: boolean, finding?: boolean) => void
  finding: boolean
  revealing: boolean
  operator: boolean
}
interface TranscriptWindow {
  register: (key: string, entry: Entry) => () => void
  refresh: () => void
  schedule: () => void
  remeasure: (key: string) => void
}

export function useTranscriptWindow(
  keys: readonly string[],
  scrollRef: RefObject<HTMLDivElement | null>,
  layoutKey = '',
): TranscriptWindow {
  const entries = useRef(new Map<string, Entry>())
  const ordered = useRef<readonly string[]>(keys)
  const mounted = useRef(new Set<string>())
  const operators = useRef<readonly string[]>([])
  const previousLayoutKey = useRef(layoutKey)
  const frame = useRef<number | null>(null)
  const selectingAll = useRef(false)
  const armingSelectAll = useRef(false)
  const nativeFinding = useRef(false)
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
    // Some native Find paths scroll before beforematch. Capture a committed
    // range in the inert text before replacing that exact browser-owned node.
    const proxy = selection?.anchorNode?.parentElement?.closest<HTMLElement>('[data-transcript-find-proxy]')
    const foundKey = proxy?.parentElement?.dataset.transcriptRow
    const found = foundKey ? entries.current.get(foundKey) : undefined
    if (range && found && !found.mounted) {
      found.finding = true
      found.mounted = true
      mounted.current.add(foundKey!)
      found.publish(true, true)
    }
    if (!range && !armingSelectAll.current) selectingAll.current = false
    if (selectingAll.current || nativeFinding.current) for (const key of list) next.add(key)
    // The shelf needs the preceding prompt even across a scrollbar jump into
    // a long turn. Prompt shells are ordered and measured like every other row.
    let low = 0, high = operators.current.length
    while (low < high) {
      const mid = (low + high) >>> 1
      const node = entries.current.get(operators.current[mid]!)?.node
      if (node && node.getBoundingClientRect().bottom < viewport.top + 6) low = mid + 1
      else high = mid
    }
    const prompt = operators.current[low - 1]
    if (prompt) next.add(prompt)
    for (const key of mounted.current) {
      const entry = entries.current.get(key)
      if (!entry) continue
      const node = entry.node
      // Preserve both selection endpoints and the entire selected interval,
      // focused controls, and user-opened tool/detail state across scrolling.
      if (range?.intersectsNode(node) || node.contains(scroll.ownerDocument.activeElement) ||
          node.querySelector('[data-transcript-retain], [aria-expanded="true"]:not([data-transcript-run-toggle]), [data-open="true"]:not([data-transcript-run-view]), dialog[open], details[open]') ||
          [...node.querySelectorAll('img')].some(image => !image.complete)) next.add(key)
    }
    // A selection may span shells, including a Select All from the browser's
    // menu. Materialise the complete selected interval before native Copy.
    if (range?.intersectsNode(scroll)) {
      const endpoint = (node: Node) => (node instanceof Element ? node : node.parentElement)
        ?.closest<HTMLElement>('[data-transcript-row]')?.dataset.transcriptRow
      const a = endpoint(range.startContainer), b = endpoint(range.endContainer)
      const start = a ? list.indexOf(a) : 0
      const end = b ? list.indexOf(b) : list.length - 1
      for (let i = Math.max(0, start); i <= end; i++) if (list[i]) next.add(list[i]!)
    }
    for (const key of new Set([...mounted.current, ...next])) {
      const entry = entries.current.get(key)
      if (!entry) continue
      if (entry.mounted && entry.height <= 0 && !entry.node.hasAttribute('data-transcript-placeholder')) entry.height = measuredHeight(entry.node)
      if (next.has(key)) entry.revealing = false
      const show = next.has(key) || entry.revealing || entry.height <= 0
      if (show === entry.mounted) continue
      if (!show) {
        entry.height = measuredHeight(entry.node)
        if (!entry.finding) entry.text = entry.node.innerText ?? entry.node.textContent ?? ''
      }
      entry.mounted = show
      if (show) mounted.current.add(key)
      else mounted.current.delete(key)
      entry.publish(show)
    }
  }, [scrollRef])
  const schedule = useCallback(() => {
    if (frame.current !== null) return
    frame.current = requestAnimationFrame(() => {
      frame.current = null
      flushSync(refresh)
    })
  }, [refresh])
  const remeasure = useCallback((key: string) => {
    const entry = entries.current.get(key)
    if (!entry) return
    entry.height = 0
    entry.mounted = true
    mounted.current.add(key)
    entry.publish(true)
    schedule()
  }, [schedule])
  useLayoutEffect(() => {
    ordered.current = keys
    operators.current = keys.filter(key => entries.current.get(key)?.operator)
    if (previousLayoutKey.current !== layoutKey) {
      previousLayoutKey.current = layoutKey
      for (const [key, entry] of entries.current) {
        entry.height = 0
        entry.mounted = true
        mounted.current.add(key)
        entry.publish(true)
      }
      schedule()
      return
    }
    // New page rows are measured once before paint, then immediately reduced
    // to the viewport buffer. Existing shell/row identities survive prepends.
    for (const key of mounted.current) {
      const entry = entries.current.get(key)
      if (entry && !entry.node.hasAttribute('data-transcript-placeholder')) entry.height = measuredHeight(entry.node)
    }
    // The shared controller restores the reading anchor before we choose the
    // new buffer. Otherwise a large prepend folds the retained viewport away
    // using the old scrollTop, then paints shells at the corrected position.
    scrollRef.current?.dispatchEvent(new Event('podium-transcript-layout'))
    refresh()
  }, [keys, refresh, layoutKey, schedule, scrollRef])
  useLayoutEffect(() => {
    const scroll = scrollRef.current
    if (!scroll) return
    const update = schedule
    const selectAll = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'a' ||
          (event.target as Element | null)?.closest?.('input, textarea, [contenteditable="true"]')) return
      if (scroll.clientHeight <= 0) return
      selectingAll.current = true
      armingSelectAll.current = true
      flushSync(() => {
        for (const [key, entry] of entries.current) {
          entry.mounted = true
          mounted.current.add(key)
          entry.publish(true)
        }
      })
      armingSelectAll.current = false
    }
    const reveal = (event: Event) => {
      const shell = (event.target as HTMLElement).closest<HTMLElement>('[data-transcript-row]')
      const entry = shell ? entries.current.get(shell.dataset.transcriptRow!) : undefined
      if (!entry) return
      flushSync(() => {
        entry.mounted = true
        entry.revealing = true
        mounted.current.add(shell!.dataset.transcriptRow!)
        entry.publish(true)
      })
    }
    const resize = new ResizeObserver(update)
    resize.observe(scroll)
    // Width changes invalidate measured wrapping; remeasure all loaded rows
    // once at the new width instead of reusing heights from another layout.
    let width = scroll.clientWidth
    const remeasure = () => {
      for (const [key, entry] of entries.current) {
        entry.height = 0
        entry.mounted = true
        mounted.current.add(key)
        entry.publish(true)
      }
      update()
    }
    const measureWidth = new ResizeObserver(() => {
      if (scroll.clientWidth === width) return
      width = scroll.clientWidth
      remeasure()
    })
    measureWidth.observe(scroll)
    document.fonts?.addEventListener('loadingdone', remeasure)
    const copy = () => flushSync(refresh)
    let findTimer: ReturnType<typeof setTimeout> | undefined
    const beginNativeFind = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'f' || scroll.clientHeight <= 0) return
      if (findTimer !== undefined || nativeFinding.current) return
      // Let every app shortcut handler run and let the browser open its bar
      // before doing the full-row commit.
      findTimer = setTimeout(() => {
        findTimer = undefined
        if (event.defaultPrevented || !scroll.isConnected || scroll.clientHeight <= 0) return
        // Native Find owns its ranges and match count outside the document.
        // Give it the original rich rows for the session, just as Select All
        // needs them, then release everything except its committed selection.
        nativeFinding.current = true
        scroll.dispatchEvent(new Event('podium-transcript-find-start'))
        flushSync(() => {
          for (const [key, entry] of entries.current) {
            entry.mounted = true
            mounted.current.add(key)
            entry.publish(true)
          }
        })
      }, 0)
    }
    const finishNativeFind = () => {
      clearTimeout(findTimer)
      findTimer = undefined
      if (!nativeFinding.current) return
      nativeFinding.current = false
      update()
    }
    const findSelection = () => {
      const selection = document.getSelection()
      if (selection && !selection.isCollapsed) finishNativeFind()
    }
    const findKeyUp = (event: KeyboardEvent) => {
      if (event.key === 'Escape') finishNativeFind()
    }
    document.addEventListener('copy', copy, true)
    scroll.addEventListener('scroll', update, { passive: true })
    scroll.addEventListener('podium-transcript-reveal', reveal)
    scroll.addEventListener('load', update, true)
    document.addEventListener('selectionchange', update)
    document.addEventListener('keydown', selectAll, true)
    document.addEventListener('focusin', update)
    window.addEventListener('keydown', beginNativeFind)
    document.addEventListener('selectionchange', findSelection)
    document.addEventListener('keyup', findKeyUp)
    return () => {
      clearTimeout(findTimer)
      resize.disconnect()
      measureWidth.disconnect()
      document.fonts?.removeEventListener('loadingdone', remeasure)
      document.removeEventListener('copy', copy, true)
      scroll.removeEventListener('scroll', update)
      scroll.removeEventListener('podium-transcript-reveal', reveal)
      scroll.removeEventListener('load', update, true)
      document.removeEventListener('selectionchange', update)
      document.removeEventListener('keydown', selectAll, true)
      document.removeEventListener('focusin', update)
      window.removeEventListener('keydown', beginNativeFind)
      document.removeEventListener('selectionchange', findSelection)
      document.removeEventListener('keyup', findKeyUp)
      if (frame.current !== null) cancelAnimationFrame(frame.current)
      frame.current = null
    }
  }, [refresh, schedule, scrollRef])
  return useMemo(() => ({ register, refresh, schedule, remeasure }), [register, refresh, schedule, remeasure])
}

/** A stable shell also lets the existing minimap and scroll controller address
 * off-window rows. Rich content is mounted only while needed by the reader. */
export function TranscriptWindowRow({ window: windowing, rowKey, index, geometryKey, children }: {
  window: TranscriptWindow; rowKey: string; index: number; geometryKey?: string; children: ReactNode | ((remounted: boolean) => ReactNode)
}): JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null)
  const proxy = useRef<HTMLDivElement | null>(null)
  const [mounted, setMounted] = useState(true)
  const [finding, setFinding] = useState(false)
  const entry = useRef<Entry | null>(null)
  const wasMounted = useRef(true)
  const remounted = useRef(false)
  const previousGeometryKey = useRef(geometryKey)
  if (mounted && !wasMounted.current) remounted.current = true
  const publish = useCallback((show: boolean, found?: boolean) => {
    setMounted(show)
    if (found !== undefined) setFinding(found)
  }, [])
  useLayoutEffect(() => {
    const value: Entry = { node: ref.current!, mounted: true, height: 0, text: '', publish, finding: false, revealing: false, operator: Boolean(ref.current!.querySelector('[data-operator-prompt="true"]')) }
    entry.current = value
    return windowing.register(rowKey, value)
  }, [rowKey, windowing, publish])
  useLayoutEffect(() => {
    if (previousGeometryKey.current === geometryKey) return
    previousGeometryKey.current = geometryKey
    // A prepend can remove the old leading day mark or change its turn seam.
    // Remeasure that boundary row, even while its rich content is offscreen.
    windowing.remeasure(rowKey)
  }, [geometryKey, rowKey, windowing])
  useLayoutEffect(() => {
    if (!mounted || !entry.current) { wasMounted.current = mounted; return }
    entry.current.height = measuredHeight(ref.current!)
    if (!wasMounted.current) windowing.schedule()
    wasMounted.current = mounted
  }, [mounted, children, windowing])
  useLayoutEffect(() => {
    const node = proxy.current
    if (!node) return
    if (!finding) node.setAttribute('hidden', 'until-found')
    const found = () => {
      // A committed selection owns this text node until its range transfers.
      // Otherwise replace the proxy at the start of the shell: native Find
      // retries a removed match from that position in the restored rich row.
      const selection = document.getSelection()
      if (selection?.anchorNode && !selection.isCollapsed && node.contains(selection.anchorNode)) {
        entry.current!.finding = true
        flushSync(() => setFinding(true))
      }
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
      windowing.schedule()
    }
    const transfer = () => {
      const selection = document.getSelection()
      if (!ref.current || !proxy.current) return
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
      const source = selection.getRangeAt(0)
      const prefix = source.cloneRange()
      prefix.selectNodeContents(proxy.current)
      prefix.setEnd(source.startContainer, source.startOffset)
      const needle = text.toLocaleLowerCase()
      const occurrence = prefix.toString().toLocaleLowerCase().split(needle).length - 1
      const haystack = content.toLocaleLowerCase()
      let start = -needle.length
      for (let match = 0; match <= occurrence; match++) {
        start = haystack.indexOf(needle, start + needle.length)
        if (start < 0) return
      }
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
    queueMicrotask(transfer)
    document.addEventListener('selectionchange', transfer)
    document.addEventListener('pointerdown', finish, true)
    document.addEventListener('keydown', finish, true)
    return () => {
      document.removeEventListener('selectionchange', transfer)
      document.removeEventListener('pointerdown', finish, true)
      document.removeEventListener('keydown', finish, true)
    }
  }, [finding, mounted, windowing])
  return <div ref={ref} data-transcript-row={rowKey}
    data-transcript-placeholder={!mounted ? '' : undefined}
    data-block={!mounted ? index : undefined} data-row-key={!mounted ? rowKey : undefined}
    style={{ flexShrink: 0, display: 'flow-root', position: 'relative', height: mounted ? undefined : entry.current?.height, minWidth: 0 }}>
    {(!mounted || finding) && <div key="find-proxy" ref={proxy} data-transcript-find-proxy="" aria-hidden="true"
      style={{ position: 'absolute', inset: 0, opacity: finding ? 0 : undefined, pointerEvents: 'none', whiteSpace: 'pre-wrap' }}>{entry.current?.text}</div>}
    {mounted && (typeof children === 'function' ? children(remounted.current) : children)}
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
