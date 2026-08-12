import { ArrowRight } from 'lucide-react'
import type { JSX } from 'react'
import { Button } from '@/components/ui/button'
import { ActivationShell, LocalProjectChoice } from './ActivationShell'
import type { ActivationRoute } from './activation-route'
import { RepoScanFlow } from './RepoScanFlow'

/**
 * Routed first-run experience inside the desktop shell. The route belongs to the
 * caller so AppShell can persist it independently of any step implementation.
 * Future activation paths (such as guided VPS setup) can join this switch without
 * owning shell lifecycle or duplicating the existing local repo flow.
 */
export function OnboardingWizard({
  route,
  onRouteChange,
  onExplore,
  onComplete,
}: {
  route: ActivationRoute
  onRouteChange: (route: ActivationRoute) => void
  onExplore: () => void
  onComplete: () => void
}): JSX.Element {
  if (route === 'local-project') {
    return (
      <>
        <ActivationShell
          eyebrow="Local activation"
          title="Find the projects you want to run."
          description="The machine-aware repository browser is open. Your place here is saved if you explore Podium or reload."
        >
          <p className="text-[12px] text-muted-foreground">Choose a folder in the browser.</p>
        </ActivationShell>
        <RepoScanFlow
          onClose={() => onRouteChange('welcome')}
          onDone={onComplete}
          intro={
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="max-w-[52ch] text-muted-foreground">
                Choose a folder and scan it for Git repositories, then pick what to add.
              </span>
              <Button type="button" variant="outline" size="sm" onClick={onExplore}>
                Explore Podium
                <ArrowRight data-icon="inline-end" aria-hidden="true" />
              </Button>
            </div>
          }
        />
      </>
    )
  }

  return (
    <ActivationShell
      eyebrow="Activate Podium"
      title="Start with a project, or look around first."
      description="Podium is ready to explore. Add a project when you want to start real work; activation will keep your place until then."
      onExplore={onExplore}
    >
      <LocalProjectChoice onSelect={() => onRouteChange('local-project')} />
    </ActivationShell>
  )
}
