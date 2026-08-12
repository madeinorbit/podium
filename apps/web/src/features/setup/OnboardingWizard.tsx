import { ArrowRight } from 'lucide-react'
import type { JSX } from 'react'
import { Button } from '@/components/ui/button'
import { ActivationShell, AlwaysOnVpsChoice, LocalProjectChoice } from './ActivationShell'
import type { ActivationRoute } from './activation-route'
import { GuidedVpsActivation } from './GuidedVpsActivation'
import { RepoScanFlow } from './RepoScanFlow'
import type { ConfirmedVpsActivation } from './use-vps-activation'
import { isVpsActivationRoute, type VpsReturnRoute } from './vps-activation'

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
  onEnterVps,
  vps,
}: {
  route: ActivationRoute
  onRouteChange: (route: ActivationRoute) => void
  onExplore: () => void
  onComplete: () => void
  onEnterVps: (returnRoute: VpsReturnRoute) => Promise<void>
  vps: ConfirmedVpsActivation
}): JSX.Element {
  if (isVpsActivationRoute(route)) {
    return (
      <GuidedVpsActivation
        route={route}
        vps={vps}
        onRouteChange={onRouteChange}
        onExplore={onExplore}
      />
    )
  }

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
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void onEnterVps('local-project').catch(() => {})}
                >
                  Set up an always-on VPS
                </Button>
                <Button type="button" variant="outline" size="sm" onClick={onExplore}>
                  Explore Podium
                  <ArrowRight data-icon="inline-end" aria-hidden="true" />
                </Button>
              </div>
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
      <div className="grid gap-3 lg:grid-cols-2">
        <LocalProjectChoice onSelect={() => onRouteChange('local-project')} />
        <AlwaysOnVpsChoice onSelect={() => void onEnterVps('welcome').catch(() => {})} />
      </div>
      {vps.error && (
        <p role="alert" className="settings-prose mt-3 text-destructive">
          {vps.error}
        </p>
      )}
    </ActivationShell>
  )
}
