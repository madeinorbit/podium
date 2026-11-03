/**
 * SETTINGS → REPOSITORIES, REAL, IN A BROWSER (POD-6267).
 *
 * Mounts the SHIPPING `ReposSection` inside the settings pane's own classes, at
 * the sheet's form width, on the sheet's card ground, so spacing and type read
 * as they do in the app. `?theme=light` opens the Paper appearance; `?width=`
 * narrows the pane to check the stacked layout.
 */
import type { JSX } from 'react'
import { createRoot } from 'react-dom/client'
import { ReposSection } from '@/features/settings/sections/repos'
import { sceneName } from './repos-settings-store'
import '@/index.css'
import '@/styles.css'

const params = new URLSearchParams(location.search)
const width = Number(params.get('width') ?? 940)

function Shell(): JSX.Element {
  return (
    // `.app-sheet-settings` carries the pane's padding and form-width variables.
    <div
      className="app-sheet-settings settings-pane"
      style={{ width, background: 'var(--card)', color: 'var(--text)', minHeight: '100vh' }}
      data-testid="repos-harness"
      data-scene={sceneName()}
    >
      <div className="settings-pane-scroll" style={{ overflow: 'visible' }}>
        <div className="settings-measure settings-section-enter">
          <ReposSection />
        </div>
      </div>
    </div>
  )
}

document.documentElement.setAttribute('data-theme', 'podium')
document.documentElement.classList.toggle('dark', params.get('theme') !== 'light')
createRoot(document.getElementById('root') as HTMLElement).render(<Shell />)
