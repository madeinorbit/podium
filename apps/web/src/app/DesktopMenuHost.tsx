import type { JSX } from 'react'
import { lazy, Suspense, useEffect, useState } from 'react'
import { throughRestarts } from '@/lib/chunk-recovery'
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

const RepoScanFlow = lazy(() =>
  throughRestarts(() => import('@/features/setup/RepoScanFlow')).then((module) => ({
    default: module.RepoScanFlow,
  })),
)

export function DesktopMenuHost({
  openSettings,
  toggleLeftSidebar,
  toggleFlightDeck,
  toggleRightSidebar,
}: {
  openSettings: () => void
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
      // Podium ADE > Settings… (⌘,). The sheet layers over whichever mode is
      // held, so this is a plain view change, not an event other surfaces
      // listen for.
      settings: openSettings,
      addProject: openAddProject,
      toggleLeftSidebar,
      toggleFlightDeck,
      toggleRightSidebar,
      // Tauri's predefined Undo/Redo items are unsupported outside macOS. The
      // shell owns only the native accelerator; the shared document performs
      // the edit command.
      undo: () => document.execCommand('undo'),
      redo: () => document.execCommand('redo'),
    })
  })

  // ⌘B / ⇧⌘B — same chords as View > Toggle Right/Left Sidebar. The rebuilt
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
        <Suspense fallback={null}>
          <RepoScanFlow
            onClose={() => setAddProjectOpen(false)}
            onDone={() => setAddProjectOpen(false)}
          />
        </Suspense>
      )}
    </>
  )
}
