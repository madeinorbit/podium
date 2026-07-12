import { type JSX, type RefObject, useEffect, useRef, useState } from 'react'

/**
 * Terminal-style block caret for the CLI-flavoured composers — the mock speccs
 * an 8×16px primary block blinking at `1.1s step-end` instead of the native
 * hairline caret. A native caret can't be widened, so the textarea hides its
 * own (`caret-transparent`) and this overlay mirrors the text into an
 * offscreen clone to locate the caret's x/y (the standard textarea-mirror
 * measurement trick). Must be rendered inside the textarea's nearest
 * `position: relative` ancestor; shown only while the textarea has focus.
 */
export function BlockCaret({
  taRef,
  value,
}: {
  taRef: RefObject<HTMLTextAreaElement | null>
  /** The controlled draft — re-measures on programmatic value changes
   *  (@-mention insertion, voice input) that fire no `input` event. */
  value: string
}): JSX.Element | null {
  const [pos, setPos] = useState<{ left: number; top: number; height: number } | null>(null)
  const caretRef = useRef<HTMLSpanElement | null>(null)
  const updateRef = useRef<() => void>(() => {})

  useEffect(() => {
    const ta = taRef.current
    if (!ta) return
    const mirror = document.createElement('div')
    const marker = document.createElement('span')
    marker.textContent = '​'
    document.body.appendChild(mirror)

    const update = () => {
      if (document.activeElement !== ta) {
        setPos(null)
        return
      }
      const cs = getComputedStyle(ta)
      mirror.style.position = 'absolute'
      mirror.style.visibility = 'hidden'
      mirror.style.left = '-9999px'
      mirror.style.top = '0'
      // Match the textarea's wrapping so line breaks land identically.
      mirror.style.whiteSpace = 'pre-wrap'
      mirror.style.overflowWrap = 'break-word'
      mirror.style.boxSizing = 'border-box'
      for (const p of [
        'fontFamily',
        'fontSize',
        'fontWeight',
        'letterSpacing',
        'lineHeight',
        'paddingTop',
        'paddingRight',
        'paddingBottom',
        'paddingLeft',
        'textTransform',
        'textIndent',
      ] as const) {
        mirror.style[p] = cs[p]
      }
      mirror.style.width = `${ta.clientWidth}px`
      const caretIdx = ta.selectionStart ?? ta.value.length
      mirror.textContent = ta.value.slice(0, caretIdx)
      mirror.appendChild(marker)
      const lineH = Number.parseFloat(cs.lineHeight) || 18
      const height = Math.min(16, lineH)
      setPos({
        left: ta.offsetLeft + marker.offsetLeft - ta.scrollLeft,
        top: ta.offsetTop + marker.offsetTop - ta.scrollTop + (lineH - height) / 2,
        height,
      })
      // Restart the blink phase on every caret move so the block reads solid
      // while typing (matches how native carets behave). getAnimations is
      // absent in jsdom.
      for (const a of caretRef.current?.getAnimations?.() ?? []) a.currentTime = 0
    }
    updateRef.current = update

    const hide = () => setPos(null)
    ta.addEventListener('input', update)
    ta.addEventListener('focus', update)
    ta.addEventListener('blur', hide)
    ta.addEventListener('scroll', update, { passive: true })
    // Covers arrow-key/click caret moves that change no text.
    document.addEventListener('selectionchange', update)
    const ro = new ResizeObserver(update)
    ro.observe(ta)
    update()
    return () => {
      ta.removeEventListener('input', update)
      ta.removeEventListener('focus', update)
      ta.removeEventListener('blur', hide)
      ta.removeEventListener('scroll', update)
      document.removeEventListener('selectionchange', update)
      ro.disconnect()
      mirror.remove()
    }
  }, [taRef])

  // biome-ignore lint/correctness/useExhaustiveDependencies: value is the re-measure trigger
  useEffect(() => {
    updateRef.current()
  }, [value])

  if (!pos) return null
  return (
    <span
      ref={caretRef}
      aria-hidden="true"
      className="pointer-events-none absolute z-[1] w-2 bg-primary [animation:cursor-blink_1.1s_step-end_infinite]"
      style={{ left: pos.left, top: pos.top, height: pos.height }}
    />
  )
}
