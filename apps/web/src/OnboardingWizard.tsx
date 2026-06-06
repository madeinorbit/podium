import type { JSX } from 'react'
import { RepoScanFlow } from './RepoScanFlow'

/**
 * First-run experience, shown when the repo registry is empty. It's the scan flow
 * with a welcome line; closing it (or finishing) drops the user into the empty
 * workspace, where "+ Add repo" reopens the same flow.
 */
export function OnboardingWizard({ onDismiss }: { onDismiss: () => void }): JSX.Element {
  return (
    <RepoScanFlow
      onClose={onDismiss}
      onDone={onDismiss}
      intro="Welcome to Podium. Choose a folder and scan it to find your git repositories, then pick the ones you want to add."
    />
  )
}
