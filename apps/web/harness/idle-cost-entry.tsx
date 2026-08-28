/**
 * THE IDLE COST RIG (POD-1607).
 *
 * The operator's desktop app burns ~50% of a core with nobody touching it. The
 * app's perpetual motion is the suspect, but "perpetual motion" is four separate
 * mechanisms with wildly different costs, and reading CSS cannot rank them:
 *
 *   marks   — `.pod-mark circle`, eight infinitely animated SVG CHILDREN per
 *             working session. SVG children are not composited, so every frame
 *             is a main-thread repaint of the whole cell.
 *   timers  — `PhaseTimer`'s private `useNow(1_000)`, one interval PER TIMER,
 *             each landing its own React render + commit.
 *   gauge   — `.gauge-band-march`, a masked translating gradient in the
 *             always-visible header, on whenever any agent works.
 *   braille — `.status-strip-spinner::after`, which animates the `content`
 *             property and so re-runs text layout every step.
 *
 * Each variant below isolates ONE of them against the real stylesheet and the
 * real components, so the measurement script can charge a cost to each and the
 * fix can go where the cost actually is. `hog` is the positive control: a rig
 * that cannot see a deliberate busy loop cannot be trusted to see anything, and
 * `blank` is the floor the others are read against.
 *
 *   bunx vite --config vite.idle-cost.config.ts
 *   bun run e2e/pod1607-idle-cost.ts
 */
import type { JSX } from 'react'
import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { MissionGauge } from '@/app/MissionGauge'
import { PhaseTimer } from '@/lib/motion/PhaseTimer'
import { WorkingMark } from '@/lib/motion/WorkingMark'
import '@/index.css'
import '@/styles.css'

type Variant =
  | 'blank'
  | 'marks'
  | 'marks-html'
  | 'timers'
  | 'full'
  | 'gauge'
  | 'gauge-nomask'
  | 'braille'
  | 'sweep'
  | 'tick-memo'
  | 'tick-nomemo'
  | 'hog'

const params = new URLSearchParams(window.location.search)
const VARIANT = (params.get('variant') ?? 'blank') as Variant
const N = Number(params.get('n') ?? '24')

/** A working session's row, in the density the sidebar actually uses. */
function Row({ children }: { children: JSX.Element }): JSX.Element {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        minHeight: 28,
        padding: '4px 11px',
        background: 'var(--card)',
      }}
    >
      <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, color: 'var(--foreground)' }}>
        POD-1607 · a session that is working
      </span>
      {children}
    </div>
  )
}

function repeat(count: number, render: (i: number) => JSX.Element): JSX.Element[] {
  return Array.from({ length: count }, (_, i) => render(i))
}

/**
 * THE CANDIDATE (not yet the shipping component): the same eight dots, the same
 * geometry and the same keyframes, as HTML elements instead of SVG children.
 * WebKit does not give SVG children accelerated animations, so the shipping mark
 * repaints its whole cell every frame on the main thread; HTML elements running
 * a pure opacity+transform animation get a compositor layer and cost the main
 * thread nothing per frame. If this variant does not beat `marks` here, the
 * theory is wrong and the shipping component should not be touched.
 */
const DOTS: readonly (readonly [number, number])[] = [
  [17, 18],
  [49, 18],
  [17, 39],
  [49, 39],
  [17, 61],
  [49, 61],
  [17, 82],
  [49, 82],
]
const CANDIDATE_CSS = `
.pod-mark-html {
  position: relative;
  display: inline-block;
  flex: none;
  vertical-align: middle;
  color: var(--mark-color, var(--motion-working));
}
.pod-mark-html i {
  position: absolute;
  border-radius: 50%;
  background: currentColor;
  animation: podium-mark-wave 1.5s linear infinite;
}
.pod-mark-html i:nth-child(2) { animation-delay: 0.12s; }
.pod-mark-html i:nth-child(3) { animation-delay: 0.21s; }
.pod-mark-html i:nth-child(4) { animation-delay: 0.33s; }
.pod-mark-html i:nth-child(5) { animation-delay: 0.42s; }
.pod-mark-html i:nth-child(6) { animation-delay: 0.54s; }
.pod-mark-html i:nth-child(7) { animation-delay: 0.63s; }
.pod-mark-html i:nth-child(8) { animation-delay: 0.75s; }

[data-nomask] .gauge-band-march {
  -webkit-mask-image: none;
  mask-image: none;
}
`

function CandidateMark({ size = 12 }: { size?: number }): JSX.Element {
  const r = size >= 18 ? 9.5 : size >= 14 ? 10.5 : 11
  return (
    <span
      aria-hidden="true"
      className="pod-mark-html"
      style={{ width: size * 0.66, height: size }}
    >
      {DOTS.map(([cx, cy]) => (
        <i
          key={`${cx}-${cy}`}
          style={{
            left: `${((cx - r) / 66) * 100}%`,
            top: `${((cy - r) / 100) * 100}%`,
            width: `${((2 * r) / 66) * 100}%`,
            height: `${((2 * r) / 100) * 100}%`,
          }}
        />
      ))}
    </span>
  )
}

/**
 * THE MEMO A/B, both arms in ONE batch (POD-1607).
 *
 * Absolute CPU on this host drifts by a factor of two between batches minutes
 * apart, so "207% before, 96% after" measured in separate runs proves nothing.
 * These two variants are identical except that one renders the SHIPPING
 * (memoised) mark and the other renders the same component's render function
 * directly, which is what the mark was before the memo — so a batch that
 * contains both cancels whatever the host was doing.
 *
 * The row re-renders once a second, which is exactly what `PhaseTimer`'s
 * `useNow(1_000)` does to the mark it wraps.
 */
const PreMemoMark = (WorkingMark as unknown as { type: (p: { size?: number }) => JSX.Element }).type

function TickingRow({ memoised }: { memoised: boolean }): JSX.Element {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(id)
  }, [])
  const seconds = Math.floor(now / 1000) % 3600
  return (
    <Row>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
        {memoised ? <WorkingMark size={12} /> : <PreMemoMark size={12} />}
        <span style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: 9 }}>
          {`${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`}
        </span>
      </span>
    </Row>
  )
}

/** The positive control: a frame loop that provably costs CPU. */
function Hog(): JSX.Element {
  useEffect(() => {
    let raf = 0
    const loop = (): void => {
      // ~4ms of arithmetic per frame — visible in any honest sampler.
      const until = performance.now() + 4
      let x = 0
      while (performance.now() < until) x += Math.sqrt(x + 1)
      if (x === Number.POSITIVE_INFINITY) console.log(x)
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [])
  return <div>hog</div>
}

function Body(): JSX.Element {
  // Stagger the mount epoch so the timers do not all tick on the same edge —
  // the shipping app never has them phase-aligned either.
  const [since] = useState(() => Date.now())
  switch (VARIANT) {
    case 'marks':
      return <>{repeat(N, (i) => <Row key={i}><WorkingMark size={12} /></Row>)}</>
    case 'marks-html':
      return <>{repeat(N, (i) => <Row key={i}><CandidateMark size={12} /></Row>)}</>
    case 'timers':
      return (
        <>
          {repeat(N, (i) => (
            <Row key={i}>
              <PhaseTimer phase="working" sinceMs={since - i * 1_000} showSpinner={false} />
            </Row>
          ))}
        </>
      )
    case 'full':
      return (
        <>
          {repeat(N, (i) => (
            <Row key={i}>
              <PhaseTimer phase="working" sinceMs={since - i * 1_000} />
            </Row>
          ))}
        </>
      )
    case 'gauge':
    case 'gauge-nomask':
      // `gauge-nomask` is the SAME gauge with the cell mask dropped (see the
      // stylesheet injected below). The march is a composited translate3d with
      // `will-change`, so if the mask is what forces WebKit off the compositor
      // the two readings separate; if they do not, the mask is innocent.
      return (
        <div style={{ width: 420 }} data-nomask={VARIANT === 'gauge-nomask' ? '' : undefined}>
          <MissionGauge
            progress={{ total: 12, done: 3, run: 4, review: 2, stall: 0, block: 1, wait: 2 }}
            live={6}
            working={4}
          />
        </div>
      )
    case 'braille':
      return (
        <>
          {repeat(N, (i) => (
            <Row key={i}>
              <span className="status-strip-spinner" aria-hidden="true" />
            </Row>
          ))}
        </>
      )
    case 'sweep':
      return (
        <>
          {repeat(N, (i) => (
            <Row key={i}>
              <span style={{ position: 'relative', width: 120, height: 14 }}>
                <span className="row-progress-sweep" aria-hidden="true" />
              </span>
            </Row>
          ))}
        </>
      )
    case 'tick-memo':
      return <>{repeat(N, (i) => <TickingRow key={i} memoised />)}</>
    case 'tick-nomemo':
      return <>{repeat(N, (i) => <TickingRow key={i} memoised={false} />)}</>
    case 'hog':
      return <Hog />
    default:
      return <div>blank</div>
  }
}

function App(): JSX.Element {
  useEffect(() => {
    const style = document.createElement('style')
    style.textContent = CANDIDATE_CSS
    document.head.appendChild(style)
    return () => style.remove()
  }, [])
  return (
    <div
      style={{
        minHeight: '100vh',
        padding: 12,
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
        background: 'var(--background)',
        fontFamily: 'var(--font-sans, system-ui)',
      }}
    >
      <Body />
    </div>
  )
}

const root = document.getElementById('root')
if (root) createRoot(root).render(<App />)

// The measurement script flips this to prove the cost belongs to ANIMATION
// rather than to the DOM merely existing.
declare global {
  interface Window {
    idleCost: { ready: boolean; stopAnimations: () => void }
  }
}
window.idleCost = {
  ready: true,
  stopAnimations: () => {
    const style = document.createElement('style')
    style.textContent = '*, *::before, *::after { animation: none !important; }'
    document.head.appendChild(style)
  },
}
