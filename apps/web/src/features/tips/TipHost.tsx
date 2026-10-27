import { Popover } from '@base-ui/react/popover'
import { observer } from '@podium/client-graph/react'
import { Send, X } from 'lucide-react'
import {
  type CSSProperties,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'
import { useReducedMotion } from '@/lib/use-reduced-motion'
import { findTipAnchor, isTipAnchorVisible } from './anchors'
import { TipContext } from './tip-context'
import { type ShowingTip, TipEngine } from './tip-engine'
import { useTipLogSource } from './tip-log-source'
import type { TipLog } from './types'
import './tips.css'

/** Mount once around the shell. An explicit log is only needed by isolated harnesses. */
export function TipHost({
  children,
  log,
  gapMs,
}: {
  children: ReactNode
  log?: TipLog
  gapMs?: number
}) {
  return log ? (
    <HostWithLog log={log} gapMs={gapMs}>
      {children}
    </HostWithLog>
  ) : (
    <SourceHost>{children}</SourceHost>
  )
}
function SourceHost({ children }: { children: ReactNode }) {
  const log = useTipLogSource()
  return <HostWithLog log={log}>{children}</HostWithLog>
}
function HostWithLog({
  children,
  log,
  gapMs,
}: {
  children: ReactNode
  log: TipLog
  gapMs?: number
}) {
  const engine = useMemo(
    () => new TipEngine(log, (name) => !!findTipAnchor(name), Date.now, gapMs),
    [log, gapMs],
  )
  useEffect(() => engine.connect(), [engine])
  return (
    <TipContext.Provider value={engine}>
      {children}
      <TipLayer engine={engine} />
    </TipContext.Provider>
  )
}

const TipLayer = observer(function TipLayer({ engine }: { engine: TipEngine }) {
  const current = engine.current
  useEffect(() => {
    const input = () => engine.input()
    const wake = () => engine.wake()
    window.addEventListener('keydown', input, true)
    window.addEventListener('focus', wake)
    document.addEventListener('visibilitychange', wake)
    return () => {
      window.removeEventListener('keydown', input, true)
      window.removeEventListener('focus', wake)
      document.removeEventListener('visibilitychange', wake)
    }
  }, [engine])
  const reducedMotion = useReducedMotion()
  const [stamp, setStamp] = useState<CSSProperties | null>(null)
  const finish = (element: HTMLElement | null) => {
    const target = document.querySelector('[data-first-flights-badge]')
    if (reducedMotion || !target || !element) return
    const from = element.getBoundingClientRect()
    const to = target.getBoundingClientRect()
    setStamp({
      left: from.x + from.width / 2,
      top: from.y + from.height / 2,
      '--tip-flight-x': `${to.x + 14 - from.x - from.width / 2}px`,
      '--tip-flight-y': `${to.y + to.height / 2 - from.y - from.height / 2}px`,
    } as CSSProperties)
  }
  return (
    <>
      <div className="tip-announcement" role="status" aria-live="polite" aria-atomic="true">
        {current &&
          `First flights. Card ${current.index + 1} of ${Math.min(2, current.registration.read().cards.length)}. ${current.card.title} ${current.card.body} Press F6 to reach the tip controls, and F6 again to return.`}
      </div>
      {current && (
        <AnchoredTip
          key={current.registration.id}
          engine={engine}
          current={current}
          onFinish={finish}
        />
      )}
      {stamp &&
        !reducedMotion &&
        createPortal(
          <Send
            aria-hidden="true"
            className="tip-stamp"
            style={stamp}
            onAnimationEnd={() => setStamp(null)}
          />,
          document.body,
        )}
    </>
  )
})

const AnchoredTip = observer(function AnchoredTip({
  engine,
  current,
  onFinish,
}: {
  engine: TipEngine
  current: ShowingTip
  onFinish(element: HTMLElement | null): void
}) {
  const anchor = findTipAnchor(current.card.anchor)
  const popup = useRef<HTMLDivElement>(null)
  const returnFocus = useRef<HTMLElement | null>(null)
  useLayoutEffect(() => {
    returnFocus.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
  }, [])
  const restoreFocus = () => {
    if (returnFocus.current?.isConnected) returnFocus.current.focus({ preventScroll: true })
  }
  const dismiss = (keyboard: boolean) => {
    engine.close('dismissed')
    if (keyboard) restoreFocus()
  }
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        engine.close('dismissed')
        if (returnFocus.current?.isConnected) returnFocus.current.focus({ preventScroll: true })
      } else if (event.key === 'F6' && !event.altKey && !event.ctrlKey && !event.metaKey) {
        if (popup.current?.contains(document.activeElement)) {
          if (returnFocus.current?.isConnected) returnFocus.current.focus({ preventScroll: true })
        } else {
          if (document.activeElement instanceof HTMLElement)
            returnFocus.current = document.activeElement
          popup.current?.querySelector('button')?.focus({ preventScroll: true })
        }
      } else return
      event.preventDefault()
      event.stopPropagation()
    }
    window.addEventListener('keydown', key, true)
    return () => window.removeEventListener('keydown', key, true)
  }, [engine])
  const [beacon, setBeacon] = useState<CSSProperties>()
  useEffect(() => {
    if (!anchor) {
      engine.close('dismissed')
      return
    }
    let frame = 0
    const measure = () => {
      // Another copy of the name coming into view is no reason to close; this one leaving is.
      if (
        anchor.getAttribute('data-tip-anchor') !== current.card.anchor ||
        !isTipAnchorVisible(anchor)
      ) {
        engine.close('dismissed')
        return
      }
      const rect = anchor.getBoundingClientRect()
      setBeacon({
        left: rect.left - 4,
        top: rect.top - 4,
        width: rect.width + 8,
        height: rect.height + 8,
        borderRadius: `max(8px, ${getComputedStyle(anchor).borderRadius})`,
      })
    }
    const schedule = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(measure)
    }
    measure()
    const resize = new ResizeObserver(schedule)
    for (let element: HTMLElement | null = anchor; element; element = element.parentElement)
      resize.observe(element)
    const mutations = new MutationObserver(schedule)
    mutations.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'style', 'hidden', 'data-tip-anchor'],
    })
    window.addEventListener('resize', schedule)
    window.addEventListener('scroll', schedule, true)
    return () => {
      cancelAnimationFrame(frame)
      resize.disconnect()
      mutations.disconnect()
      window.removeEventListener('resize', schedule)
      window.removeEventListener('scroll', schedule, true)
    }
  }, [anchor, current.card.anchor, engine])
  if (!anchor) return null
  const count = Math.min(2, current.registration.read().cards.length)
  const last = current.index === count - 1
  return (
    <>
      {beacon &&
        createPortal(
          <div className="tip-beacon" style={beacon} aria-hidden="true" />,
          document.body,
        )}
      <Popover.Root
        open
        modal={false}
        onOpenChange={(open) => {
          if (!open) engine.close('dismissed')
        }}
      >
        <Popover.Portal>
          <Popover.Positioner
            anchor={anchor}
            side="right"
            align="center"
            sideOffset={14}
            positionMethod="fixed"
            collisionPadding={12}
            collisionAvoidance={{ side: 'flip', align: 'shift', fallbackAxisSide: 'end' }}
            className="tip-positioner"
          >
            <Popover.Popup
              ref={popup}
              className="tip-card"
              aria-keyshortcuts="F6"
              initialFocus={false}
              finalFocus={false}
            >
              <Popover.Arrow className="tip-arrow">
                <svg width="16" height="8" viewBox="0 0 16 8" aria-hidden="true">
                  <path d="M0 8L8 0L16 8" />
                </svg>
              </Popover.Arrow>
              <div className="tip-card-scroll">
                <div className="tip-eyebrow">
                  <Send size={13} aria-hidden="true" />
                  <span>First flights</span>
                  <button
                    type="button"
                    className="tip-close"
                    aria-label="Dismiss tip"
                    onClick={(event) => dismiss(event.detail === 0)}
                  >
                    <X size={14} />
                  </button>
                </div>
                <Popover.Title className="tip-title">{current.card.title}</Popover.Title>
                <Popover.Description className="tip-body">{current.card.body}</Popover.Description>
                {current.card.extra && <div className="tip-extra">{current.card.extra}</div>}
                <div className="tip-footer">
                  {count === 2 && (
                    <span
                      className="tip-pages"
                      role="img"
                      aria-label={`Card ${current.index + 1} of 2`}
                    >
                      <i data-active={current.index === 0} />
                      <i data-active={current.index === 1} />
                    </span>
                  )}
                  <button
                    type="button"
                    className="tip-skip"
                    onClick={(event) => {
                      engine.close('skipped-all')
                      if (event.detail === 0) restoreFocus()
                    }}
                  >
                    Skip tips
                  </button>
                  <button
                    type="button"
                    className="tip-next"
                    onClick={(event) => {
                      if (last) onFinish(popup.current)
                      engine.next()
                      if (last && event.detail === 0) restoreFocus()
                      current.card.cta?.onClick()
                    }}
                  >
                    {current.card.cta?.label ?? (last ? 'Got it' : 'Next')}
                  </button>
                </div>
              </div>
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
    </>
  )
})
