/**
 * SETTINGS → UPDATES, REAL, IN A BROWSER (POD-2511).
 *
 * The version rows are copy rules with a colour attached, and copy rules are
 * only reviewable at the size and weight they actually render at. So this
 * mounts the SHIPPING `UpdatesSection` — `@/app/store` swapped for the scene
 * stub in `vite.updates-harness.config.ts` — inside the settings measure the
 * pane really gives it.
 *
 * The page's own build stamp is injected the same way a built dist carries it,
 * because `pageBuildVersion()` reads the document rather than a prop: a harness
 * that passed the version in would be testing a different function.
 */
import { PRODUCT_VERSION_META } from '@podium/protocol'
import type { JSX } from 'react'
import { createRoot } from 'react-dom/client'
import { UpdatesSection } from '@/features/settings/sections/updates'
import { currentScene, currentSceneName } from './updates-store'
import '@/index.css'
import '@/styles.css'

const scene = currentScene()

const meta = document.createElement('meta')
meta.setAttribute('name', PRODUCT_VERSION_META)
meta.setAttribute('content', scene.pageVersion)
document.head.appendChild(meta)

if (scene.desktopVersion) {
  ;(globalThis as { __PODIUM_DESKTOP__?: unknown }).__PODIUM_DESKTOP__ = {
    platform: 'macos',
    launchMode: 'all-in-one',
    currentVersion: scene.desktopVersion,
    minimize: async () => {},
    toggleMaximize: async () => {},
    close: async () => {},
  }
}

function Shell(): JSX.Element {
  return (
    <div
      style={{
        width: 760,
        padding: 28,
        background: 'var(--background)',
        color: 'var(--text)',
      }}
      data-testid="updates-harness"
    >
      <p className="settings-micro mb-4">scene: {currentSceneName()}</p>
      <div className="settings-section-enter settings-measure">
        <UpdatesSection />
      </div>
    </div>
  )
}

document.documentElement.classList.add('dark')
createRoot(document.getElementById('root') as HTMLElement).render(<Shell />)
