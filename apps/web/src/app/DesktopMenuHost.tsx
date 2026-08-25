import type { JSX } from 'react'
import { lazy, Suspense, useEffect, useState } from 'react'
import { nativeDesktopBridge } from '@/lib/nativeDesktop'
import { AboutPodium } from './AboutPodium'
import { desktopCommandForEvent, runDesktopCommand, terminalOwnsChord } from './desktop-commands'
import {
  ABOUT_EVENT,
  ADD_PROJECT_EVENT,
  installDesktopMenuHooks,
  openAboutPodium,
  openAddProject,
} from './desktop-menu'
import { DesktopCloseTab } from './use-desktop-close-tab'

const RepoScanFlow = lazy(() =>
  import('@/features/setup/RepoScanFlow').then((module) => ({ default: module.RepoScanFlow })),
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
    })
  })

  // THE KEYBOARD FOR EVERY SHELL WITHOUT A MENU BAR (POD-1532).
  //
  // On macOS these chords arrive as menu accelerators and never reach the
  // webview at all — an accelerator no menu item claims is swallowed, which is
  // why the menu exists. Linux and Windows build no menu, so the same commands
  // have to be claimed here or they do not exist: before this, Ctrl+, Ctrl+W,
  // Ctrl+Alt+F, Ctrl+L and Shift+Ctrl+L did nothing at all off macOS.
  //
  // It stays bound on macOS too. The chords are already spoken for there, so
  // this listener normally never fires — but a shell older than the rebuilt
  // menu has no item claiming them, and this is what keeps that build working.
  //
  // BROWSER TABS ARE LEFT ALONE. ⌘W closes the tab, ⌘N opens a window, ⌘B is
  // bookmarks: none of them are ours to take, and a page that swallowed them
  // would be breaking the browser to advertise a shortcut.
  useEffect(() => {
    if (!nativeDesktopBridge()) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.defaultPrevented) return
      const command = desktopCommandForEvent(event)
      // A command with no hook is answered by its own owner (the palette is
      // AppShell state), and a focused terminal keeps the whole Ctrl range.
      if (!command?.hook || terminalOwnsChord(event.target)) return
      // preventDefault only once something answered: an unowned command — no
      // session focused for ⌘L, no tab open for ⌘W — leaves the keystroke to
      // whoever else wants it rather than swallowing it into silence.
      if (runDesktopCommand(command.id)) event.preventDefault()
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
