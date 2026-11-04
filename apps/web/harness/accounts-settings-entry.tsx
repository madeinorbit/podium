/**
 * SETTINGS → ACCOUNTS, REAL, IN A BROWSER (POD-6300). Mounts the shipping
 * `AccountsSection` inside the settings pane's own classes. `?theme=light`
 * opens the Paper appearance; `?width=` narrows the pane.
 */
import type { JSX } from 'react'
import { createRoot } from 'react-dom/client'
import { AccountsSection } from '@/features/settings/sections/accounts'
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
