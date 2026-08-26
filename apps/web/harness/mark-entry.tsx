/**
 * THE WORKING MARK, IN ITS REAL CONTEXTS, BESIDE THE ONE IT REPLACED.
 *
 * The mark is CSS + the app's own tokens, so a screenshot of the component in
 * isolation proves nothing about the thing that actually matters: whether the
 * cell sits right beside 9px mono in a sidebar row, inside a 13px corner badge,
 * and at the end of the feed. Every row below is the real component against the
 * real `styles.css`.
 *
 * The left column of the A/B is the PREVIOUS mark, reproduced here (the stepped
 * braille glyph, and the breathing canvas ring's cell size) so the comparison is
 * against what shipped rather than against memory — and so a harness that
 * rendered no animation at all would be visible as such.
 */
import { type JSX, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { PhaseTimer } from '@/lib/motion/PhaseTimer'
import { StatusBadge } from '@/lib/motion/StatusBadge'
import { WorkingMark } from '@/lib/motion/WorkingMark'
import '@/index.css'
import '@/styles.css'

/** The glyph the mark replaces, inlined — the old rule is gone from motion.css. */
function LegacySpinner({ size }: { size: number }): JSX.Element {
  return (
    <span
      aria-hidden
      style={{
        display: 'inline-block',
        minWidth: 8,
        fontFamily: 'var(--font-mono, ui-monospace, monospace)',
        fontSize: size,
        color: 'var(--motion-working)',
      }}
    >
      ⠹
    </span>
  )
}

function Panel({ title, children }: { title: string; children: JSX.Element }): JSX.Element {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div
        style={{
          fontFamily: 'var(--font-mono, monospace)',
          fontSize: 10,
          letterSpacing: '.1em',
          textTransform: 'uppercase',
          color: 'var(--muted-foreground)',
        }}
      >
        {title}
      </div>
      {children}
    </div>
  )
}

/** A sidebar row, at the density the real worklist uses. */
function Row({ mark }: { mark: JSX.Element }): JSX.Element {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        minHeight: 44,
        padding: '7px 11px',
        borderRadius: 8,
        background: 'var(--card)',
      }}
    >
      <span
        style={{
          width: 26,
          textAlign: 'right',
          fontFamily: 'var(--font-mono, monospace)',
          fontSize: 10,
          color: 'var(--muted-foreground)',
        }}
      >
        844
      </span>
      <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, color: 'var(--foreground)' }}>
        QR server pairing on mobile
      </span>
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 5,
          fontFamily: 'var(--font-mono, monospace)',
          fontSize: 9,
          color: 'var(--motion-working)',
        }}
      >
        {mark}
        4:53
      </span>
    </div>
  )
}

/** The end of the transcript, in the real tail chrome. */
function Tail({ mark, width }: { mark: JSX.Element; width: number }): JSX.Element {
  return (
    <div className="feed-tail" data-tail="working">
      <span className="feed-tail-body">
        <span className="feed-tail-mark" aria-hidden="true" style={{ width }}>
          {mark}
        </span>
        <span className="feed-tail-label">Working</span>
        <span className="feed-tail-figure">1:12</span>
      </span>
    </div>
  )
}

function Column({ legacy }: { legacy: boolean }): JSX.Element {
  const mark = (size: number, legacySize: number): JSX.Element =>
    legacy ? <LegacySpinner size={legacySize} /> : <WorkingMark size={size} />
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 22, width: 380 }}>
      <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--foreground)' }}>
        {legacy ? 'Before — braille spinner' : 'After — working mark'}
      </div>

      <Panel title="Sidebar row">
        <Row mark={mark(12, 9)} />
      </Panel>

      <Panel title="Timer (the real PhaseTimer)">
        {legacy ? (
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 5,
              fontFamily: 'var(--font-mono, monospace)',
              fontSize: 9,
              color: 'var(--motion-working)',
            }}
          >
            <LegacySpinner size={9} />
            6:30
          </span>
        ) : (
          <PhaseTimer phase="working" sinceMs={Date.now() - 390_000} />
        )}
      </Panel>

      <Panel title="Corner badge on an ID square">
        <span
          style={{
            position: 'relative',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 30,
            height: 30,
            borderRadius: 8,
            background: '#2b3350',
            color: 'var(--foreground)',
            fontFamily: 'var(--font-mono, monospace)',
            fontSize: 11,
          }}
        >
          844
          {legacy ? (
            <span
              style={{
                position: 'absolute',
                top: -5,
                right: -5,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                height: 13,
                minWidth: 13,
                borderRadius: 999,
                background: 'var(--motion-badge-bg)',
                border: '1px solid var(--motion-working)',
              }}
            >
              <LegacySpinner size={8} />
            </span>
          ) : (
            <StatusBadge kind="spinner" ringColor="#0d0e11" />
          )}
        </span>
      </Panel>

      <Panel title="Tab strip">
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 8,
            height: 30,
            padding: '0 11px',
            borderRadius: 8,
            background: 'var(--card)',
            fontSize: 12,
            fontWeight: 600,
            color: 'var(--foreground)',
          }}
        >
          {mark(15, 9)}
          POD-844 · pairing
        </span>
      </Panel>

      <Panel title="End of the feed">
        <Tail
          mark={legacy ? <LegacySpinner size={13} /> : <WorkingMark size={22} />}
          width={legacy ? 22 : 16}
        />
      </Panel>

      <Panel title="Pending button">
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            height: 32,
            padding: '0 12px',
            borderRadius: 8,
            background: 'var(--card)',
            fontSize: 13,
            color: 'var(--foreground)',
          }}
        >
          {mark(13, 11)}
          Working…
        </span>
      </Panel>
    </div>
  )
}

function App(): JSX.Element {
  const [light, setLight] = useState(false)
  // Podium light retunes --motion-working, so the mark has to be looked at
  // in both: the same blue that reads calm on near-black washes out on stone.
  useEffect(() => {
    const html = document.documentElement
    html.classList.toggle('dark', !light)
    html.setAttribute('data-theme', 'podium')
  }, [light])
  return (
    <div
      style={{
        minHeight: '100vh',
        padding: 28,
        display: 'flex',
        flexDirection: 'column',
        gap: 20,
        background: 'var(--background)',
        fontFamily: 'var(--font-sans, system-ui)',
      }}
    >
      <button type="button" data-testid="theme-toggle" onClick={() => setLight((v) => !v)}>
        {light ? 'to dark' : 'to light'}
      </button>
      <div style={{ display: 'flex', gap: 40 }}>
        <Column legacy />
        <Column legacy={false} />
      </div>
    </div>
  )
}

const root = document.getElementById('root')
if (root) createRoot(root).render(<App />)
