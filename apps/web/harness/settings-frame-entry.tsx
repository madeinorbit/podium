import './settings-frame-store'
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { DensityProvider } from '@/app/density'
import { ThemeProvider } from '@/app/theme'
import { SettingsView } from '@/features/settings/SettingsView'
import {
  SettingsFrame,
  SettingsPageActions,
  useSettingsFrame,
} from '@/features/settings/settings-frame'
import { useSettingsShortcut } from '@/lib/hooks/use-settings-shortcut'
import '@/index.css'
import '@/styles.css'
const params = new URLSearchParams(location.search)
localStorage.setItem('podium.theme.mode', params.get('theme') === 'light' ? 'light' : 'dark')
document.documentElement.setAttribute('data-theme', 'podium')
document.documentElement.classList.toggle('dark', params.get('theme') !== 'light')
function FlowAction() {
  const { openTakeover } = useSettingsFrame()
  return (
    <SettingsPageActions>
      <button
        type="button"
        className="settings-prose"
        onClick={() =>
          openTakeover({
            title: 'Add project',
            description: 'Choose a repository.',
            content: (
              <input
                aria-label="Repository URL"
                placeholder="https://github.com/example/project"
                className="settings-prose"
              />
            ),
          })
        }
      >
        Add project
      </button>
    </SettingsPageActions>
  )
}
function Harness() {
  const [open, setOpen] = useState(true)
  useSettingsShortcut(() => setOpen(true))
  return (
    <ThemeProvider>
      <DensityProvider densityEnabled>
        <div style={{ padding: 20, color: 'var(--muted-foreground)' }}>Podium · Work</div>
        {open &&
          (params.has('flow') ? (
            <SettingsFrame
              page="projects"
              selectedPage
              viewer={{ status: 'ready', sections: [], retry() {} }}
              onClose={() => setOpen(false)}
              onPageChange={() => {}}
            >
              <FlowAction />
              <p className="settings-prose">Registered repositories and task defaults.</p>
            </SettingsFrame>
          ) : (
            <SettingsView onClose={() => setOpen(false)} />
          ))}
      </DensityProvider>
    </ThemeProvider>
  )
}
createRoot(document.getElementById('root')!).render(<Harness />)
