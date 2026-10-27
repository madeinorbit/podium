import '@fontsource-variable/geist'
import '@fontsource-variable/geist-mono'
import { observer } from '@podium/client-graph/react'
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { FirstFlightsBadge, TipHost, useTipMoment } from '@/features/tips'
import { MemoryTipLog } from '@/features/tips/memory-tip-log'
import { TIP_IDS, type TipId, type TipOutcome } from '@/features/tips/types'
import '@/index.css'
import './tips-harness.css'

const params = new URLSearchParams(location.search)
document.documentElement.dataset.theme = 'podium'
document.documentElement.classList.toggle('dark', params.get('theme') === 'dark')
const events: { id: TipId; outcome: TipOutcome }[] = []
class HarnessLog extends MemoryTipLog {
  override record(id: TipId, outcome: TipOutcome) {
    events.push({ id, outcome })
    super.record(id, outcome)
  }
}
// The optional fast gap makes manual queue exploration quick. Default is the real 20 seconds.
const log = new HarnessLog()
const gapMs = params.has('fast') ? 800 : undefined
const App = observer(function App() {
  const [scenario, setScenario] = useState(params.get('scenario') ?? 'two')
  const [mounted, setMounted] = useState(true)
  useTipMoment('first-prompt', {
    active: scenario === 'two' || scenario === 'queue',
    cards: [
      {
        anchor: 'demo-composer',
        title: 'Aim high.',
        body: 'Say what you want and how to run it. Agents follow your plan.',
        extra: (
          <div className="demo-legend">
            <span>What</span>
            <span>Who does it</span>
            <span>When to ask you</span>
          </div>
        ),
      },
      {
        anchor: 'demo-composer',
        title: 'Or start small.',
        body: 'One line is enough. Shape it in the chat as you go.',
        cta: {
          label: 'Write my task',
          onClick: () => document.querySelector<HTMLTextAreaElement>('#demo-draft')?.focus(),
        },
      },
    ],
  })
  useTipMoment('first-offer', {
    active: scenario === 'one' || scenario === 'queue',
    cards: [
      {
        anchor: 'demo-offer',
        title: 'Your next move.',
        body: 'When an agent is done, it suggests what comes next. One tap sends it.',
      },
    ],
  })
  useTipMoment('first-artifact', {
    active: scenario === 'missing',
    cards: [
      {
        anchor: 'intentionally-absent',
        title: 'Your agent made something.',
        body: 'This card should never appear.',
      },
    ],
  })
  return (
    <div className="demo-page">
      <header className="demo-heading">
        <span className="demo-wordmark">Podium</span>
        <span>FIRST FLIGHTS / ENGINE PREVIEW</span>
        <a href={`?theme=${params.get('theme') === 'dark' ? 'light' : 'dark'}`}>Switch theme</a>
      </header>
      <div className="demo-controls">
        <strong>Try a moment</strong>
        {[
          ['two', 'Two cards'],
          ['one', 'One card'],
          ['queue', 'Queue two'],
          ['missing', 'Missing anchor'],
        ].map(([value, title]) => (
          <a
            key={value}
            href={`?theme=${params.get('theme') ?? 'light'}&scenario=${value}${params.has('fast') ? '&fast=1' : ''}`}
          >
            {title}
          </a>
        ))}
        <button type="button" onClick={() => setMounted((v) => !v)}>
          Toggle anchor
        </button>
        <button type="button" onClick={() => log.setEnabled(!log.enabled)}>
          Tips {log.enabled ? 'off' : 'on'}
        </button>
        <button
          type="button"
          onClick={() => {
            setScenario('none')
            for (const id of TIP_IDS) log.record(id, 'finished')
          }}
        >
          Retire badge
        </button>
      </div>
      <div className="demo-workspace">
        <aside className="demo-sidebar">
          <div className="demo-sidebar-title">
            Your tasks <span>＋</span>
          </div>
          <div className="demo-task">
            <span className="demo-task-dot" />A quieter workspace<small>Planning</small>
          </div>
          <div className="demo-task muted">
            Make search feel instant<small>Working</small>
          </div>
          <div className="demo-sidebar-space" />
          <FirstFlightsBadge />
        </aside>
        <main className="demo-main">
          <div className="demo-breadcrumb">
            A QUIETER WORKSPACE <span>·</span> NEW TASK
          </div>
          <section className="demo-composition">
            <div className="demo-kicker">ROOM FOR YOUR NEXT IDEA</div>
            <h1>What would you like to do?</h1>
            <p className="demo-intro">
              Start with the outcome. Your agents can work out the steps.
            </p>
            {mounted && (
              <div className="demo-composer" data-tip-anchor="demo-composer">
                <textarea id="demo-draft" aria-label="Task prompt" placeholder="Add a dark mode…" />
                <div>
                  <span>Choose your crew</span>
                  <button type="button" aria-label="Send task">
                    ↑
                  </button>
                </div>
              </div>
            )}
            <div className="demo-offer" data-tip-anchor="demo-offer">
              <span>READY WHEN YOU ARE</span>
              <p>The first draft is ready to review.</p>
              <button type="button">Open the draft ↗</button>
            </div>
          </section>
        </main>
      </div>
      <footer className="demo-notes">
        <span>One tip at a time. The workspace stays usable.</span>
        <span>
          {gapMs ? 'Preview gap: 0.8s' : 'Queue gap: 20s'} · Typing pause: 3s ·{' '}
          <span className="motion-standard">Motion enabled</span>
          <span className="motion-reduced">Reduced motion</span>
        </span>
      </footer>
      <p className="demo-help">
        Finish a moment, then open First flights to replay it. Use your browser's reduced-motion
        emulation to disable the beacon pulse and stamp flight.
      </p>
    </div>
  )
})
const root = document.getElementById('root')
if (!root) throw new Error('Missing harness root')
createRoot(root).render(
  <TipHost log={log} gapMs={gapMs}>
    <App />
  </TipHost>,
)
Object.assign(window, { tipHarness: { events, log } })
