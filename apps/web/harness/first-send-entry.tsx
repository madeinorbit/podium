import '@fontsource-variable/geist'
import '@fontsource-variable/geist-mono'
import { createRoot } from 'react-dom/client'
import { TipHost, useTipMoment } from '@/features/tips'
import { MemoryTipLog } from '@/features/tips/memory-tip-log'
import { FLIGHT_DECK_ANCHOR, firstSendCards } from '@/features/worklist/first-send-tip'
import type { RowTone } from '@/features/worklist/pool-row-data'
import { WorkRowShell } from '@/features/worklist/WorkRowShell'
import '@/index.css'
import '@/styles.css'

// ?theme=dark, ?folded=1 (the deck's collapsed strip). Moment 2 shows at once.
const params = new URLSearchParams(location.search)
document.documentElement.dataset.theme = 'podium'
document.documentElement.classList.toggle('dark', params.get('theme') === 'dark')
const folded = params.has('folded')

const rows: { id: string; label: string; tone: RowTone; word: string; active?: boolean }[] = [
  { id: 'POD-12', label: 'Add a dark mode', tone: 'working', word: 'Working', active: true },
  { id: 'POD-9', label: 'Fix the flaky login test', tone: 'needs', word: 'Waiting on you' },
  { id: 'POD-7', label: 'Draft the release notes', tone: 'done', word: 'Done' },
]

function App() {
  useTipMoment('first-send', { active: true, cards: firstSendCards('iss_12') })
  return (
    <div style={{ display: 'flex', height: '100vh', background: 'var(--background)' }}>
      <aside
        style={{ width: 280, borderRight: '1px solid var(--border)', paddingTop: 48 }}
        className="flex flex-col"
      >
        {rows.map((row) => (
          <WorkRowShell
            key={row.id}
            testId="unified-issue-row"
            idLabel={row.id}
            label={row.label}
            tone={row.tone}
            phase="idle"
            statusLine={row.word}
            active={Boolean(row.active)}
            muted={row.tone === 'done'}
            timeMeta="2m"
            onSelect={() => {}}
            domMark={row.active ? 'iss_12' : undefined}
          />
        ))}
      </aside>
      {folded ? (
        <div style={{ width: 44, display: 'flex' }}>
          <aside
            className="folded-superagent"
            aria-label="Folded Flight Deck"
            data-tip-anchor={FLIGHT_DECK_ANCHOR}
          />
        </div>
      ) : (
        <aside
          className="engraved-column"
          aria-label="Flight Deck"
          data-tip-anchor={FLIGHT_DECK_ANCHOR}
          style={{
            width: 340,
            padding: 16,
            gap: 8,
            color: 'var(--muted-foreground)',
            fontSize: 12,
          }}
        >
          <strong style={{ color: 'var(--foreground)', fontSize: 15 }}>Add a dark mode</strong>
          <span>1 agent working</span>
        </aside>
      )}
      <main style={{ flex: 1 }} />
    </div>
  )
}

const root = document.getElementById('root')
if (!root) throw new Error('Missing harness root')
createRoot(root).render(
  <TipHost log={new MemoryTipLog()}>
    <App />
  </TipHost>,
)
