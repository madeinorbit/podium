/**
 * SETTINGS → ACCOUNTS & KEYS, REAL, IN A BROWSER (POD-6390).
 *
 * Mounts the SHIPPING `AccountsSection` inside the settings pane's own classes,
 * at the sheet's form width, on the sheet's card ground. `?scene=admin` (default)
 * or `member` picks who is looking; `?theme=light` opens the Paper appearance.
 */
import type { JSX } from 'react'
import { createRoot } from 'react-dom/client'
import { AccountsSection } from '@/features/settings/sections/accounts'
import { sceneName } from './accounts-settings-store'
import '@/index.css'
import '@/styles.css'

const params = new URLSearchParams(location.search)
const width = Number(params.get('width') ?? 940)

function Shell(): JSX.Element {
  return (
    <div
      className="app-sheet-settings settings-pane"
      style={{ width, background: 'var(--card)', color: 'var(--text)', minHeight: '100vh' }}
      data-testid="accounts-harness"
      data-scene={sceneName()}
    >
      <div className="settings-pane-scroll" style={{ overflow: 'visible' }}>
        <div className="settings-measure settings-section-enter">
          <AccountsSection />
        </div>
      </div>
    </div>
  )
}

document.documentElement.setAttribute('data-theme', 'podium')
document.documentElement.classList.toggle('dark', params.get('theme') !== 'light')
createRoot(document.getElementById('root') as HTMLElement).render(<Shell />)
