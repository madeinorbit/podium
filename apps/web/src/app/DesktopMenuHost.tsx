import type { JSX } from 'react'
import { useEffect, useState } from 'react'
import { RepoScanFlow } from '@/features/setup/RepoScanFlow'
import { AboutPodium } from './AboutPodium'
import {
  ABOUT_EVENT,
  ADD_PROJECT_EVENT,
  installDesktopMenuHooks,
  openAboutPodium,
  openAddProject,
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
