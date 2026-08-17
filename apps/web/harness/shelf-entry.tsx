/**
 * THE SHELF, REAL, IN A BROWSER (POD-1192).
 *
 * `PinnedBrief` takes plain props and reads no store, so it can be rendered
 * exactly as it ships — real `useLayoutEffect`, real `setSize`, real
 * ResizeObserver, real render-phase `setPin`, against the real `styles.css`.
 * That is the one thing every harness before this lacked, and the reason their
 * negative results could not be trusted.
 *
 * It also renders a LEGACY shelf beside it, reproducing the measurement that
 * POD-993 replaced (`scrollHeight > clientHeight + 2`). That is the positive
 * control: the historical flicker was transition-driven, so a control that does
 * not move cannot prove anything, and if the legacy shelf does not oscillate
 * here then this harness is blind and its silence means nothing.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { PinnedBrief } from '@/features/chat/PinnedBrief'
import '@/index.css'
import '@/styles.css'

declare global {
  interface Window {
    shelf: {
      setBrief: (html: string) => void
      setWidth: (px: number) => void
      setDensity: (d: 'default' | 'compact') => void
      /** Click the real toggle, which is what runs the height transition. */
      toggle: () => void
      /** Flip counts since the last reset, per shelf. */
      read: () => { real: number; legacy: number }
      reset: () => void
    }
  }
}

const flips = { real: 0, legacy: 0 }
const lastSeen = { real: null as boolean | null, legacy: null as boolean | null }

function countFrom(which: 'real' | 'legacy', clipped: boolean): void {
  if (lastSeen[which] !== clipped) {
    lastSeen[which] = clipped
    flips[which]++
  }
}

/** The measurement POD-993 replaced, kept verbatim as the control. */
function LegacyShelf({ html, open }: { html: string; open: boolean }): JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null)
  const [clipped, setClipped] = useState(false)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = (): void => setClipped(el.scrollHeight > el.clientHeight + 2)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [html])
  useEffect(() => countFrom('legacy', clipped), [clipped])
  return (
    <div
      className="brief-shelf"
      data-open={open ? 'true' : undefined}
      data-clipped={clipped && !open ? 'true' : undefined}
    >
      {/* THE CONTROL HAS TO MOVE. The historical flicker was `clientHeight`
          sampled mid-animation, so the control opens and shuts with a height
          transition on it — a static control proves nothing, which is the
          mistake that wasted three earlier rigs. */}
      <div
        className="chat-md brief-shelf-text"
        ref={ref}
        style={{
          transition: 'max-height 280ms cubic-bezier(0.22,1,0.36,1)',
          maxHeight: open ? '320px' : undefined,
          overflowY: open ? 'auto' : undefined,
        }}
        // biome-ignore lint/security/noDangerouslySetInnerHtml: harness-authored
        dangerouslySetInnerHTML={{ __html: html }}
      />
      <div className="brief-shelf-side">
        <span className="brief-shelf-time">14:02</span>
        <button type="button" className="brief-shelf-toggle" data-idle={clipped ? undefined : 'true'}>
          Show full
        </button>
      </div>
    </div>
  )
}

function Harness(): JSX.Element {
  const [html, setHtml] = useState('<p>a brief</p>')
  const [width, setWidth] = useState(640)
  const [legacyOpen, setLegacyOpen] = useState(false)
  const scrollerRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    window.shelf = {
      setBrief: (h) => setHtml(h),
      setWidth: (px) => setWidth(px),
      setDensity: (d) => {
        if (d === 'compact') document.documentElement.dataset.density = 'compact'
        else document.documentElement.removeAttribute('data-density')
      },
      toggle: () => {
        document.querySelector<HTMLButtonElement>('[data-testid="prompt-expand-toggle"]')?.click()
        // ...and the control, or it never animates and can never prove anything.
        setLegacyOpen((v) => !v)
      },
      read: () => ({ ...flips }),
      reset: () => {
        flips.real = 0
        flips.legacy = 0
        lastSeen.real = null
        lastSeen.legacy = null
      },
    }
  }, [])

  // Watch the SHIPPING shelf the only way an outsider can: the attribute its
  // answer drives. Counting inside the component would mean forking it.
  useEffect(() => {
    const obs = new MutationObserver(() => {
      const el = document.querySelector('[data-testid="pinned-brief"] .brief-shelf')
      if (el) countFrom('real', el.getAttribute('data-clipped') === 'true')
    })
    obs.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['data-clipped'] })
    return () => obs.disconnect()
  }, [])

  return (
    <div style={{ padding: 24, width, display: 'flex', flexDirection: 'column', gap: 32 }}>
      <div style={{ position: 'relative' }}>
        <div ref={scrollerRef} style={{ height: 1 }} />
        <PinnedBrief
          brief={{ key: 'k', html, time: '14:02' }}
          scrollerRef={scrollerRef}
          onBodyClick={() => {}}
        />
      </div>
      <div data-testid="legacy">
        <LegacyShelf html={html} open={legacyOpen} />
      </div>
    </div>
  )
}

createRoot(document.getElementById('root') as HTMLElement).render(<Harness />)
