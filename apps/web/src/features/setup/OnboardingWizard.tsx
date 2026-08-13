import type { JSX } from 'react'
import type { Trpc } from '@/app/trpc'
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
  onComplete: () => void
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
      <RepoScanFlow
        onboarding
        onClose={() => onRouteChange('welcome')}
        onDone={() => onRouteChange('agent')}
      />
    )
  }

  return (
    <ActivationShell
      eyebrow="Activate Podium"
      title="How do you want to start?"
      description="Most people start with a project on this computer. You can also create an always-on VPS, or connect only if you already run Podium somewhere else."
      onExplore={onExplore}
    >
      <div className="max-w-[860px] divide-y divide-border/70">
        <LocalProjectChoice onSelect={() => onRouteChange('local-project')} />
        <AlwaysOnVpsChoice onSelect={() => void onEnterVps('welcome').catch(() => {})} />
        <ExistingPodiumChoice onSelect={() => onRouteChange('existing-podium')} />
      </div>
      {vps.error && (
        <p role="alert" className="settings-prose mt-3 text-destructive">
          {vps.error}
        </p>
      )}
    </ActivationShell>
  )
}
