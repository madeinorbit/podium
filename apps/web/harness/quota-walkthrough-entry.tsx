/**
 * A RECORDED TOUR OF WHERE THE QUOTA LEDGER PUT NEW DATA (POD-1571).
 *
 * Every scene that shows UI shows the REAL `QuotaLedger` against the real
 * `styles.css` — the point of a walkthrough is undermined the moment it becomes a
 * drawing of the thing rather than the thing. What the harness adds is narration:
 * a scene title, and callouts that MEASURE their target element and draw a leader
 * to it, so an annotation cannot drift away from what it is annotating.
 *
 * Driven from outside: Playwright calls `window.__walkthroughStep(n)` and records
 * the frames. Nothing here animates on a timer, so the recording's pace is the
 * recorder's business and a still frame is always reproducible.
 */
import { quotaLedger } from '@podium/client-core/viewmodels'
import type { QuotaWindowHistoryWire } from '@podium/model'
import { type JSX, useEffect, useLayoutEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { QuotaLedger } from '@/features/usage/QuotaLedger'
import '@/index.css'
import '@/styles.css'

const WEEK_MS = 7 * 24 * 3_600_000
const ANCHOR = Date.parse('2026-08-24T07:00:00.000Z')
const week = (n: number) => new Date(ANCHOR - n * WEEK_MS).toISOString()

function row(over: Partial<QuotaWindowHistoryWire> = {}): QuotaWindowHistoryWire {
  const resetsAtMs = Date.parse(over.resetsAt ?? new Date(ANCHOR).toISOString())
  return {
    accountKey: 'codex::you@example.com',
    agent: 'codex',
    windowKey: 'weekly',
    label: 'Weekly',
    windowMinutes: 10080,
    startedAt: new Date(resetsAtMs - WEEK_MS).toISOString(),
    firstSeenAt: new Date(resetsAtMs - WEEK_MS).toISOString(),
    lastSeenAt: new Date(resetsAtMs).toISOString(),
    firstPercent: 0,
    peakPercent: 71,
    lastPercent: 71,
    sampleCount: 400,
    closed: true,
    partial: false,
    source: 'live',
    ...over,
    resetsAt: new Date(resetsAtMs).toISOString(),
  }
}

const FULL = quotaLedger([
  ...[97, 100, 89, 100, 32, 71].map((peakPercent, i) =>
    row({
      resetsAt: week(5 - i),
      peakPercent,
      plan: i < 4 ? 'prolite' : 'pro',
      partial: i === 0,
    }),
  ),
  row({ resetsAt: week(-1), peakPercent: 1, closed: false, plan: 'pro' }),
  ...[74, 46].map((peakPercent, i) =>
    row({
      accountKey: 'claude-code::you@example.com',
      agent: 'claude-code',
      windowKey: 'weekly-all',
      resetsAt: week(1 - i),
      peakPercent,
      partial: i === 0,
      closed: i === 0,
    }),
  ),
  ...[93, 41].map((peakPercent, i) =>
    row({
      accountKey: 'grok::you@example.com',
      agent: 'grok',
      resetsAt: week(1 - i),
      peakPercent,
      closed: i === 0,
      source: i === 0 ? 'backfill' : 'live',
    }),
  ),
])

// ---------------------------------------------------------------------------
// Callouts that measure what they point at
// ---------------------------------------------------------------------------

interface Note {
  /** Which element on screen this is about. Nth match, so a single column can be
   *  singled out of a strip without giving it a bespoke class. */
  target: string
  nth?: number
  text: string
  /** Which side of the target the box sits on. */
  side: 'left' | 'right' | 'above' | 'below'
  /** Nudge, for the cases where two notes would otherwise collide. */
  dy?: number
}

interface Placed extends Note {
  box: { left: number; top: number }
  line: { left: number; top: number; width: number; height: number }
}

const NOTE_W = 240
const MARGIN = 18
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

/**
 * A NOTE MUST NOT COVER WHAT IT EXPLAINS. Side notes are anchored to the edge of
 * the STAGE rather than to the target, so the leader crosses the gutter and the
 * box always lands beside the panel instead of on top of it; above/below notes
 * are clamped into the viewport so a target near an edge cannot push its own
 * caption off-screen.
 */
function place(note: Note): Placed | null {
  const el = document.querySelectorAll(note.target)[note.nth ?? 0]
  if (!el) return null
  const r = el.getBoundingClientRect()
  const stage = document.querySelector('[data-wt-stage]')?.getBoundingClientRect()
  const dy = note.dy ?? 0
  const midY = r.top + r.height / 2
  const maxTop = window.innerHeight - 92
  if (note.side === 'left' || note.side === 'right') {
    const edge = note.side === 'left' ? (stage?.left ?? r.left) : (stage?.right ?? r.right)
    const boxLeft =
      note.side === 'left'
        ? clamp(edge - NOTE_W - 30, MARGIN, window.innerWidth - NOTE_W - MARGIN)
        : clamp(edge + 30, MARGIN, window.innerWidth - NOTE_W - MARGIN)
    const lineLeft = note.side === 'left' ? boxLeft + NOTE_W : edge
    return {
      ...note,
      box: { left: boxLeft, top: clamp(midY - 26 + dy, MARGIN, maxTop) },
      line: {
        left: Math.min(lineLeft, note.side === 'left' ? r.left : edge + 30),
        top: midY,
        width: Math.max(8, Math.abs((note.side === 'left' ? r.left : boxLeft) - lineLeft)),
        height: 1,
      },
    }
  }
  const GAP = 30
  const boxLeft = clamp(
    r.left + r.width / 2 - NOTE_W / 2,
    MARGIN,
    window.innerWidth - NOTE_W - MARGIN,
  )
  if (note.side === 'above') {
    return {
      ...note,
      box: { left: boxLeft, top: clamp(r.top - GAP - 62 + dy, MARGIN, maxTop) },
      line: { left: r.left + r.width / 2, top: r.top - GAP, width: 1, height: GAP },
    }
  }
  return {
    ...note,
    box: { left: boxLeft, top: clamp(r.bottom + GAP + dy, MARGIN, maxTop) },
    line: { left: r.left + r.width / 2, top: r.bottom, width: 1, height: GAP },
  }
}

/** Shared empty list, so a note-less scene does not hand the effect a fresh array
 *  every render — which would re-measure, set state, and re-render forever. */
const NO_NOTES: Note[] = []

function Callouts({ notes }: { notes: Note[] }): JSX.Element {
  const [placed, setPlaced] = useState<Placed[]>([])
  useLayoutEffect(() => {
    // Two frames: one for the scene's own layout to settle, one to measure it.
    const id = requestAnimationFrame(() =>
      requestAnimationFrame(() =>
        setPlaced(notes.map(place).filter((p): p is Placed => p !== null)),
      ),
    )
    return () => cancelAnimationFrame(id)
  }, [notes])
  return (
    <>
      {placed.map((p) => (
        <div key={p.text}>
          <div
            style={{
              position: 'fixed',
              left: p.line.left,
              top: p.line.top,
              width: p.line.width,
              height: p.line.height,
              background: 'var(--primary)',
              opacity: 0.85,
            }}
          />
          <div
            style={{
              position: 'fixed',
              left: p.box.left,
              top: p.box.top,
              width: NOTE_W,
              padding: '9px 12px',
              borderLeft: '2px solid var(--primary)',
              borderRadius: '0 6px 6px 0',
              background: 'color-mix(in srgb, var(--primary) 13%, var(--background))',
              color: 'var(--text-strong)',
              font: '400 13.5px/1.45 var(--font-sans)',
              boxShadow: 'var(--shadow-popover)',
            }}
          >
            {p.text}
          </div>
        </div>
      ))}
    </>
  )
}

// ---------------------------------------------------------------------------
// Scenes
// ---------------------------------------------------------------------------

function Slab({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <div
      className="usage-body"
      data-wt-stage=""
      style={{
        // `.usage-body` is a flex child in the real sheet and grows there; in this
        // column it stretched to the viewport and left the short scenes with a
        // panel two-thirds empty.
        flex: '0 0 auto',
        width: 760,
        padding: '18px 20px',
        border: '1px solid var(--border-strong)',
        borderRadius: 10,
        background: 'var(--card)',
        color: 'var(--foreground)',
      }}
    >
      {children}
    </div>
  )
}

/** A field of the new row, typeset as the record it is. */
function Field({ k, v, note }: { k: string; v: string; note?: string }): JSX.Element {
  return (
    <tr>
      <td
        style={{
          padding: '5px 16px 5px 0',
          color: 'var(--text-strong)',
          font: '500 13px var(--font-mono)',
          whiteSpace: 'nowrap',
        }}
      >
        {k}
      </td>
      <td
        style={{
          padding: '5px 16px 5px 0',
          color: 'var(--live)',
          font: '400 13px var(--font-mono)',
          whiteSpace: 'nowrap',
        }}
      >
        {v}
      </td>
      <td
        style={{ padding: '5px 0', color: 'var(--text-dim)', font: '400 12.5px var(--font-sans)' }}
      >
        {note ?? ''}
      </td>
    </tr>
  )
}

interface Scene {
  eyebrow: string
  title: string
  body?: string
  render: () => JSX.Element
  notes?: Note[]
  paper?: boolean
}

const SCENES: Scene[] = [
  {
    eyebrow: 'Before',
    title: 'Quota was read live and never written down',
    body: 'The daemon fetched each provider, memoised it for two minutes, and served it. Nothing polled on a schedule, so a window that reset overnight left no trace — and none of it could be recomputed later.',
    render: () => (
      <Slab>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <span className="quota-pool-window">The old path</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            {['provider', 'daemon · 120s memo', 'server', 'your screen'].map((s, i) => (
              <span key={s} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span
                  style={{
                    padding: '7px 13px',
                    borderRadius: 6,
                    border: '1px solid var(--usage-rule)',
                    color: 'var(--muted-foreground)',
                    font: '400 13px var(--font-mono)',
                  }}
                >
                  {s}
                </span>
                {i < 3 && <span style={{ color: 'var(--text-faint)' }}>→</span>}
              </span>
            ))}
          </div>
          <div
            id="wt-gone"
            style={{
              marginTop: 4,
              padding: '10px 13px',
              borderRadius: 6,
              border: '1px dashed var(--usage-rule)',
              color: 'var(--text-dim)',
              font: '400 13px var(--font-sans)',
            }}
          >
            …and then discarded. No table, no event, no history.
          </div>
        </div>
      </Slab>
    ),
    notes: [
      {
        target: '#wt-gone',
        side: 'below',
        text: 'This is the gap. Every number the meter showed you was thrown away the moment it went stale.',
      },
    ],
  },
  {
    eyebrow: 'New data · 1 of 3',
    title: 'A row per window instance, on disk',
    body: 'The first quota number Podium keeps. One row per run of a pool, folded as samples arrive — about fifteen rows a day, not a sample stream.',
    render: () => (
      <Slab>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <span className="quota-pool-window">new table · quota_windows</span>
          <table style={{ borderCollapse: 'collapse' }}>
            <tbody>
              <Field
                k="account_key"
                v="'codex::you@example.com'"
                note="the pool, not the machine"
              />
              <Field k="window_key" v="'weekly'" />
              <Field k="resets_at_ms" v="1787814000000" note="latest reading — it jitters" />
              <Field k="started_at_ms" v="1787209200000" note="derived; no provider reports one" />
              <Field k="peak_percent" v="71" note="the answer the chart draws" />
              <Field k="first_percent" v="0" />
              <Field k="sample_count" v="400" />
              <Field k="partial" v="0" note="was the start observed?" />
              <Field k="source" v="'live'" note="live | backfill" />
              <Field k="trail_json" v="[[0,0],[41,3],…]" note="the burn curve, kept for later" />
            </tbody>
          </table>
        </div>
      </Slab>
    ),
    notes: [
      {
        target: 'td',
        nth: 13,
        side: 'right',
        text: 'PEAK, not last. The closing sample is always stale by up to one interval, so a window still climbing when it rolled over would be understated.',
      },
    ],
  },
  {
    eyebrow: 'New data · 2 of 3',
    title: 'Two writers, one row',
    body: 'A 15-minute sampler runs whether or not a tab is open. Every quota.summary a client asks for is folded in on the way out. A one-shot boot import recovers what Grok already wrote to disk.',
    render: () => (
      <Slab>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <span className="quota-pool-window">who writes</span>
          {[
            ['sampler · every 15 min', 'server timer — runs with no client open', 'wt-w1'],
            ['quota.summary', 'folds the payload it already fetched', 'wt-w2'],
            ['backfill · once at boot', 'Grok’s billing log, read on the daemon', 'wt-w3'],
          ].map(([a, b, id]) => (
            <div
              key={id}
              id={id}
              style={{
                display: 'flex',
                gap: 14,
                alignItems: 'baseline',
                padding: '9px 13px',
                borderRadius: 6,
                background: 'color-mix(in srgb, var(--live) 9%, transparent)',
              }}
            >
              <span
                style={{
                  color: 'var(--text-strong)',
                  font: '500 13px var(--font-mono)',
                  minWidth: 210,
                }}
              >
                {a}
              </span>
              <span style={{ color: 'var(--muted-foreground)', font: '400 13px var(--font-sans)' }}>
                {b}
              </span>
            </div>
          ))}
        </div>
      </Slab>
    ),
    notes: [
      {
        target: '#wt-w3',
        side: 'below',
        text: 'Codex is deliberately NOT backfilled: its recorded series empties three times an afternoon, which is not a weekly window whatever the field says.',
      },
    ],
  },
  {
    eyebrow: 'New data · 3 of 3',
    title: 'Where you actually see it',
    body: 'A new region at the foot of Usage & analytics. One strip per pool, one column per reset.',
    render: () => (
      <Slab>
        <QuotaLedger ledger={FULL} cold={false} />
      </Slab>
    ),
    notes: [
      {
        target: '.quota-groove',
        nth: 2,
        side: 'above',
        text: 'The groove is the capacity you paid for. What is left empty is what you never spent.',
      },
      {
        target: '.quota-readings',
        side: 'left',
        text: 'Three readings, inside this section — the sheet still leads with one figure.',
      },
    ],
  },
  {
    eyebrow: 'Reading it',
    title: 'Every mark carries one fact',
    render: () => (
      <Slab>
        <QuotaLedger ledger={FULL} cold={false} />
      </Slab>
    ),
    notes: [
      {
        target: '.quota-mark',
        nth: 1,
        side: 'left',
        text: 'Harness identity is the mark, never colour — Podium has no codex or grok hue by design.',
      },
      {
        target: '.quota-gridline[data-target]',
        nth: 1,
        side: 'right',
        text: 'A hairline at 85%: “well used”. The only reference on the figure.',
      },
      {
        // Below would drop it onto the next strip; the left gutter is empty here.
        target: '.quota-groove[data-now]',
        nth: 1,
        side: 'left',
        dy: 125,
        text: 'Outlined — still running, so it has no final answer yet and is left out of the average.',
      },
    ],
  },
  {
    eyebrow: 'A deliberate omission',
    title: 'No red, no amber, anywhere',
    body: 'The live meter escalates past 75% and 90% because there, near-full means you are about to be cut off. In a history chart the meaning inverts: a window that ended at 95% is the best outcome there is. Reusing that ramp would state the opposite of the truth.',
    render: () => (
      <Slab>
        <QuotaLedger ledger={FULL} cold={false} />
      </Slab>
    ),
    notes: [
      {
        target: '.quota-groove',
        nth: 4,
        side: 'above',
        text: '100% spent. On the live meter this would be red. Here it is the best week on the strip.',
      },
    ],
  },
  {
    eyebrow: 'The honest states',
    title: 'Empty is a fact about time, not a fault',
    body: 'History has to be collected. Until a pool rolls over there is nothing to draw — and the region says so rather than showing an empty chart or a fabricated zero.',
    render: () => (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        <Slab>
          <QuotaLedger ledger={quotaLedger([])} cold={false} />
        </Slab>
        <Slab>
          <QuotaLedger ledger={null} cold />
        </Slab>
      </div>
    ),
    notes: [
      {
        target: '.quota-empty',
        nth: 0,
        side: 'right',
        text: 'Loaded and nil — a dash, because the answer is known and it is nothing.',
      },
      {
        target: '.usage-unfilled',
        nth: 1,
        side: 'right',
        text: 'Still reading — a rule on the baseline the digits will sit on. Never a zero.',
      },
    ],
  },
  {
    eyebrow: 'Both themes',
    title: 'One set of declarations',
    body: 'Every colour is a mix over --live or --foreground, so Paper needs no overrides of its own.',
    paper: true,
    render: () => (
      <Slab>
        <QuotaLedger ledger={FULL} cold={false} />
      </Slab>
    ),
  },
]

// ---------------------------------------------------------------------------

declare global {
  interface Window {
    __walkthroughStep?: (n: number) => void
    __walkthroughCount?: number
  }
}

function Walkthrough(): JSX.Element {
  const [step, setStep] = useState(0)
  useEffect(() => {
    window.__walkthroughStep = (n: number) => setStep(Math.max(0, Math.min(SCENES.length - 1, n)))
    window.__walkthroughCount = SCENES.length
  }, [])
  const scene = SCENES[step]
  if (!scene) return <div />
  return (
    <div
      {...(scene.paper ? { 'data-theme': 'podium' } : {})}
      style={{
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 26,
        width: '100vw',
        minHeight: '100vh',
        padding: '46px 40px',
        background: 'var(--background)',
        boxSizing: 'border-box',
      }}
    >
      <header style={{ width: 760, display: 'flex', flexDirection: 'column', gap: 9 }}>
        <span
          style={{
            color: 'var(--primary)',
            font: '500 11.5px var(--font-mono)',
            letterSpacing: '0.16em',
            textTransform: 'uppercase',
          }}
        >
          {scene.eyebrow}
        </span>
        <h1
          style={{
            margin: 0,
            color: 'var(--text-strong)',
            font: '600 27px/1.2 var(--font-sans)',
            letterSpacing: '-0.02em',
          }}
        >
          {scene.title}
        </h1>
        {scene.body && (
          <p
            style={{
              margin: 0,
              maxWidth: '74ch',
              color: 'var(--muted-foreground)',
              font: '400 14.5px/1.6 var(--font-sans)',
            }}
          >
            {scene.body}
          </p>
        )}
      </header>
      {scene.render()}
      <Callouts notes={scene.notes ?? NO_NOTES} />
      <footer
        style={{
          position: 'fixed',
          right: 26,
          bottom: 20,
          color: 'var(--text-faint)',
          font: '400 11.5px var(--font-mono)',
          letterSpacing: '0.1em',
        }}
      >
        {String(step + 1).padStart(2, '0')} / {String(SCENES.length).padStart(2, '0')} · QUOTA RESET
        LEDGER
      </footer>
    </div>
  )
}

const root = document.getElementById('root')
if (root) createRoot(root).render(<Walkthrough />)
