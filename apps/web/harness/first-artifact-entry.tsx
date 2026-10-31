// First Flights moment 7 (POD-2202) in a stubbed shell. The moment, its
// anchors and the tip host are the real ones; the panel, strip and rail are
// layout stand-ins. Serve with `bunx vite --config vite.tips.config.ts` from
// apps/web and open /harness/first-artifact.html?scene=panel|closed|offer.
import '@fontsource-variable/geist'
import '@fontsource-variable/geist-mono'
import { CircleDot, FolderTree, GitBranch, Plus, Sparkles } from 'lucide-react'
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import {
  FIRST_ARTIFACT_NEW_PANEL_ANCHOR,
  FirstArtifactMoment,
  useFirstArtifactAnchor,
} from '@/features/issues/first-artifact-tip'
import { FirstFlightsBadge, TipHost } from '@/features/tips'
import { MemoryTipLog } from '@/features/tips/memory-tip-log'
import '@/index.css'
import './first-artifact.css'

const params = new URLSearchParams(location.search)
const scene = params.get('scene') ?? 'panel'
document.documentElement.dataset.theme = 'podium'
document.documentElement.classList.toggle('dark', params.get('theme') === 'dark')
const log = new MemoryTipLog()
if (scene !== 'offer') log.record('first-offer', 'finished')

const shot = (hue: number, label: string): string =>
  `data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><rect width="400" height="300" fill="hsl(${hue} 30% 92%)"/><rect x="24" y="24" width="352" height="34" rx="6" fill="hsl(${hue} 25% 80%)"/><rect x="24" y="76" width="220" height="12" rx="6" fill="hsl(${hue} 20% 72%)"/><rect x="24" y="100" width="300" height="12" rx="6" fill="hsl(${hue} 20% 78%)"/><rect x="24" y="150" width="160" height="110" rx="8" fill="hsl(${hue} 35% 70%)"/><rect x="200" y="150" width="176" height="110" rx="8" fill="hsl(${hue} 25% 84%)"/><text x="30" y="47" font-family="sans-serif" font-size="14" fill="hsl(${hue} 30% 30%)">${label}</text></svg>`,
  )}`

function Panel() {
  const anchor = useFirstArtifactAnchor('panel', 'iss_demo')
  return (
    <aside className="fa-panel">
      <div className="fa-panel-head">
        <CircleDot size={16} aria-hidden="true" />
        POD-12
      </div>
      <div className="fa-panel-body">
        <div className="fa-title">Dark mode for settings</div>
        <section>
          <div className="fa-section-head">
            <span>Artifacts 2</span>
            <span>View all</span>
          </div>
          <div className="fa-grid">
            {[
              ['Settings, dark', 210],
              ['Settings, light', 40],
            ].map(([label, hue], i) => (
              <figure key={label} style={{ margin: 0, minWidth: 0 }}>
                <button
                  type="button"
                  className="fa-thumb"
                  data-tip-anchor={i === 0 ? anchor : undefined}
                >
                  <img src={shot(Number(hue), String(label))} alt={String(label)} />
                </button>
                <figcaption className="fa-caption">{label}</figcaption>
              </figure>
            ))}
          </div>
        </section>
      </div>
    </aside>
  )
}

function Offer() {
  const anchor = useFirstArtifactAnchor('offer', 'iss_demo')
  return (
    <div className="fa-offer">
      <div className="fa-offer-head">Settings mockups ready for review</div>
      <div className="fa-offer-strip" data-tip-anchor={anchor}>
        {[210, 40].map((hue) => (
          <div key={hue} className="fa-offer-tile">
            <span className="fa-thumb">
              <img src={shot(hue, 'Settings')} alt="" />
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

function App() {
  const [panelOpen, setPanelOpen] = useState(scene === 'panel')
  return (
    <div className="fa-shell">
      <FirstArtifactMoment />
      <div style={{ width: 214, borderRight: '1px solid var(--border)', display: 'flex' }}>
        <div style={{ marginTop: 'auto', width: '100%' }}>
          <FirstFlightsBadge />
        </div>
      </div>
      <main className="fa-stage">
        <div className="fa-strip">
          <span className="fa-tab">Designer</span>
          <span className="fa-strip-space" />
          <button
            type="button"
            className="fa-icon-btn"
            aria-label="New panel"
            data-tip-anchor={FIRST_ARTIFACT_NEW_PANEL_ANCHOR}
          >
            <Plus size={13} aria-hidden="true" />
          </button>
        </div>
        <div className="fa-chat">
          <p>
            I attached two mockups of the settings page, one per theme. The contrast on the toggle
            rows is the thing to judge.
          </p>
          {scene === 'offer' && <Offer />}
        </div>
      </main>
      {panelOpen && <Panel />}
      <nav className="fa-rail" aria-label="Panels">
        <button
          type="button"
          className="fa-rail-cell"
          aria-label="Task"
          aria-pressed={panelOpen}
          onClick={() => setPanelOpen((v) => !v)}
        >
          <CircleDot size={17} strokeWidth={1.7} aria-hidden="true" />
          {!panelOpen && !log.isSeen('first-artifact') && (
            // The real dot's classes (FirstArtifactDot); its artifact read needs the pool.
            <span
              data-testid="first-artifact-dot"
              className="absolute top-1 right-1 size-1.5 rounded-full bg-primary"
              aria-hidden="true"
            />
          )}
        </button>
        {[Sparkles, GitBranch, FolderTree].map((Icon) => (
          <button key={Icon.displayName} type="button" className="fa-rail-cell" aria-label="Panel">
            <Icon size={17} strokeWidth={1.7} aria-hidden="true" />
          </button>
        ))}
      </nav>
    </div>
  )
}

const root = document.getElementById('root')
if (!root) throw new Error('Missing harness root')
createRoot(root).render(
  <TipHost log={log} gapMs={800}>
    <App />
  </TipHost>,
)
Object.assign(window, { tipHarness: { log } })
