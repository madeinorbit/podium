import type { IssueId } from '@podium/model'
import { ArrowRight } from 'lucide-react'
import type { JSX } from 'react'
import type { Trpc } from '@/app/trpc'
import { Button } from '@/components/ui/button'
import {
  ActivationShell,
  AlwaysOnVpsChoice,
  ExistingPodiumChoice,
  LocalProjectChoice,
} from './ActivationShell'
import type { ActivationRoute } from './activation-route'
import { ExistingPodiumActivation, isExistingPodiumRoute } from './ExistingPodiumActivation'
import { GuidedVpsActivation } from './GuidedVpsActivation'
import { FirstTaskActivation } from './FirstTaskActivation'
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
  onConnectionConfigured,
  onEnterVps,
  trpc,
  vps,
}: {
  route: ActivationRoute
  onRouteChange: (route: ActivationRoute) => void
  onExplore: () => void
  onComplete: (issueId: IssueId) => void
  onConnectionConfigured: () => Promise<void>
  onEnterVps: (returnRoute: VpsReturnRoute) => Promise<void>
  trpc: Trpc
  vps: ConfirmedVpsActivation
}): JSX.Element {
  if (isExistingPodiumRoute(route)) {
    return (
      <ExistingPodiumActivation
        route={route}
        trpc={trpc}
        onRouteChange={onRouteChange}
        onExplore={onExplore}
        onConfigured={onConnectionConfigured}
      />
    )
  }

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

  if (route === 'agent' || route === 'first-task') {
    return (
      <FirstTaskActivation
        route={route}
        onRouteChange={onRouteChange}
        onExplore={onExplore}
        onComplete={onComplete}
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
          onDone={() => onRouteChange('agent')}
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
                  onClick={() => onRouteChange('existing-podium')}
                >
                  Connect to existing Podium
                </Button>
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
      title="Start locally, or connect to a Podium you already run."
      description="Add a project, connect this device to an existing installation, or look around first. Activation will keep your place until you choose."
      onExplore={onExplore}
    >
      <div className="max-w-[860px] divide-y divide-border/70">
        <LocalProjectChoice onSelect={() => onRouteChange('local-project')} />
        <ExistingPodiumChoice onSelect={() => onRouteChange('existing-podium')} />
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
