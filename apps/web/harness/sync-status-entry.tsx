/**
 * THE SYNC ITEM, IN A BROWSER (POD-6852).
 *
 * The real `SyncStatusItem`, `SyncPanel`, review rows and `styles.css`, in a
 * bare shell frame whose bottom edge is the real `.status-strip`. Pool readers
 * and the store handle come from `sync-status-store.ts`; `?state=` picks the
 * fixture (idle, catching, sending, review, offline, offline-review, paused,
 * slow, wake) and `?theme=light` the light appearance.
 *
 *   cd apps/web && bunx vite --config vite.sync-status-harness.config.ts
 *   bun harness/sync-status-shots.ts <outDir>
 */
import type { JSX } from 'react'
import { createRoot } from 'react-dom/client'
import { SyncStatusItem } from '@/features/sync/SyncStatusItem'
import { SyncProgressStore } from '@/lib/sync-progress'
import '@/index.css'
import '@/styles.css'

const params = new URLSearchParams(location.search)
const state = params.get('state') ?? 'idle'
document.documentElement.setAttribute('data-theme', 'podium')
document.documentElement.classList.toggle('dark', params.get('theme') !== 'light')

const progress = new SyncProgressStore()
progress.begin('live')
if (state === 'catching' || state === 'wake') {
  progress.beginAttempt()
  progress.noteCommitted(4, state === 'wake' ? 134 : 162, 200, 100)
}
if (state === 'paused') {
  progress.beginAttempt()
  progress.noteError('network')
}

function Frame(): JSX.Element {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100vh',
        background: 'var(--background)',
      }}
    >
      <div
        style={{
          flex: '0 0 40px',
          borderBottom: '1px solid var(--border)',
          background: 'var(--bar)',
        }}
      />
      <div style={{ flex: 1 }} />
      <footer className="status-strip">
        <span className="status-strip-live">3 working</span>
        <span className="status-strip-seam" aria-hidden="true" />
        <span>412k tok/h</span>
        <span className="status-strip-spacer" aria-hidden="true" />
        <SyncStatusItem progress={progress} />
        <span className="status-strip-issue">POD-6852</span>
      </footer>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<Frame />)
