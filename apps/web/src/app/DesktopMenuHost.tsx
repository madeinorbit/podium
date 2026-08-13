import type { JSX } from 'react'
import { useEffect, useState } from 'react'
import { RepoScanFlow } from '@/features/setup/RepoScanFlow'
import { nativeDesktopBridge } from '@/lib/nativeDesktop'
import { AboutPodium } from './AboutPodium'
import {
  ABOUT_EVENT,
  ADD_PROJECT_EVENT,
  installDesktopMenuHooks,
  openAboutPodium,
  openAddProject,
  sidebarToggleFromEvent,
} from './desktop-menu'
import { DesktopCloseTab } from './use-desktop-close-tab'

export function DesktopMenuHost({
  toggleLeftSidebar,
  toggleFlightDeck,
  toggleRightSidebar,
}: {
  toggleLeftSidebar: () => void
  toggleFlightDeck: () => void
  toggleRightSidebar: () => void
}): JSX.Element {
  const [aboutOpen, setAboutOpen] = useState(false)
  const [addProjectOpen, setAddProjectOpen] = useState(false)

  useEffect(() => {
    const onAbout = (): void => setAboutOpen(true)
    const onAdd = (): void => setAddProjectOpen(true)
    window.addEventListener(ABOUT_EVENT, onAbout)
    window.addEventListener(ADD_PROJECT_EVENT, onAdd)
    return () => {
      window.removeEventListener(ABOUT_EVENT, onAbout)
      window.removeEventListener(ADD_PROJECT_EVENT, onAdd)
    }
  }, [])

  useEffect(() => {
    return installDesktopMenuHooks({
      about: openAboutPodium,
      addProject: openAddProject,
      toggleLeftSidebar,
      toggleFlightDeck,
      toggleRightSidebar,
    })
  })

  // ⌘B / ⇧⌘B — same chords as View > Toggle Left/Right Sidebar. The rebuilt
  // macOS menu owns them (an unclaimed accelerator never reaches the webview)
  // and evals the hooks above. This keydown covers Linux/Windows and a macOS
  // binary old enough that no menu item claimed them yet. Browser tabs are
  // left alone: ⌘B is bookmarks there.
  useEffect(() => {
    if (!nativeDesktopBridge()) return
    const onKey = (event: KeyboardEvent): void => {
      const which = sidebarToggleFromEvent(event)
      if (!which) return
      event.preventDefault()
      if (which === 'left') toggleLeftSidebar()
      else toggleRightSidebar()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  return (
    <>
      <DesktopCloseTab />
      <AboutPodium open={aboutOpen} onClose={() => setAboutOpen(false)} />
      {addProjectOpen && (
        <RepoScanFlow
          onClose={() => setAddProjectOpen(false)}
          onDone={() => setAddProjectOpen(false)}
        />
      )}
    </>
  )
}
