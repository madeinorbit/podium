/** Working-mark layout review using the app's row, badge, tab glyph and feed tail. */
import type { SessionView } from '@podium/client-core/session-values'
import { pauseWorkingMarksWhenIdle } from '@podium/working-mark'
import { type JSX, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { TranscriptTail } from '@/features/chat/TranscriptTail'
import { WorkRowShell } from '@/features/worklist/WorkRowShell'
import { AgentStatusGlyph } from '@/lib/motion/AgentStatusGlyph'
import { PhaseTimer } from '@/lib/motion/PhaseTimer'
import { StatusBadge } from '@/lib/motion/StatusBadge'
import { WorkingMark } from '@/lib/motion/WorkingMark'
import '@/index.css'
import '@/styles.css'

const stopIdlePause = pauseWorkingMarksWhenIdle()
import.meta.hot?.dispose(stopIdlePause)
const since = new Date(Date.now() - 390_000).toISOString()
const working = { agentState: { phase: 'working', since, nativeSubagentCount: 0 } } as SessionView

function Panel({ title, children }: { title: string; children: JSX.Element }): JSX.Element {
  return (
    <section data-context={title} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <h2 style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--muted-foreground)' }}>
        {title}
      </h2>
      {children}
    </section>
  )
}

function Row({ asking = false }: { asking?: boolean }): JSX.Element {
  return (
    <WorkRowShell
      idNumber="844"
      idLabel="POD-844"
      label="QR server pairing on mobile with a long title"
      statusLine={
        asking ? <><WorkingMark size={12} className="mr-1" />Waiting on you</> : 'Working'
      }
      hex={undefined}
      phase={asking ? 'waiting' : 'working'}
      timeMeta={<PhaseTimer phase={asking ? 'waiting' : 'working'} sinceMs={Date.parse(since)} size={10.5} mutedWorking />}
      active={false}
      onSelect={() => {}}
      testId={asking ? 'asking-row' : 'working-row'}
    />
  )
}

function App(): JSX.Element {
  const [light, setLight] = useState(new URLSearchParams(location.search).get('light') === '1')
  useEffect(() => {
    document.documentElement.classList.toggle('dark', !light)
    document.documentElement.setAttribute('data-theme', 'podium')
  }, [light])
  return (
    <main style={{ minHeight: '100vh', padding: 28, background: 'var(--background)', fontFamily: 'var(--font-sans)' }}>
      <button type="button" data-testid="theme-toggle" onClick={() => setLight(v => !v)}>
        {light ? 'Use dark theme' : 'Use light theme'}
      </button>
      <div style={{ display: 'flex', gap: 36, marginTop: 24 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 24, width: 320 }}>
          <Panel title="Rows"><div><Row /><Row asking /></div></Panel>
          <Panel title="Badge">
            <span style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 30, height: 30, borderRadius: 8, background: 'var(--card)', color: 'var(--foreground)', fontFamily: 'var(--font-mono)', fontSize: 11 }}>
              844<StatusBadge kind="spinner" />
            </span>
          </Panel>
          <Panel title="Tab">
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, height: 30, padding: '0 11px', background: 'var(--card)', color: 'var(--foreground)', fontSize: 12 }}>
              <AgentStatusGlyph session={working} variant="tab" />POD-844 · pairing
            </div>
          </Panel>
          <Panel title="Menu row">
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--foreground)', fontSize: 12 }}>
              <AgentStatusGlyph session={working} variant="row" />QR server pairing
            </div>
          </Panel>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 24, width: 380 }}>
          <Panel title="Feed">
            <TranscriptTail activity={{ label: 'Working', tone: 'working' }} since={since} session={working} />
          </Panel>
          <Panel title="Sending">
            <TranscriptTail activity={{ label: 'Sending', tone: 'idle', transient: 'just-sent' }} />
          </Panel>
          <Panel title="Timer">
            <PhaseTimer phase="working" sinceMs={Date.parse(since)} mutedWorking />
          </Panel>
          <Panel title="Pending button">
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, height: 32, padding: '0 12px', background: 'var(--card)', color: 'var(--foreground)', fontSize: 13 }}>
              <WorkingMark size={13} />Working…
            </div>
          </Panel>
        </div>
      </div>
    </main>
  )
}

const root = document.getElementById('root')
if (root) createRoot(root).render(<App />)
